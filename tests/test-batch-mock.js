// tests/test-batch-mock.js · BatchRunner 并发调度 mock 测试（无需真实浏览器，node 直接跑）
// 覆盖：8 并发调度正确性 / 验证码换牌 / 不可重试失败 / 预算熔断全队停止 / 停止语义 /
//       Google 专线探活失败不启动 / 预筛抖动恢复 / keepOpen 成功保留窗口失败照常关窗 / keepOpen 默认关闭行为不变
// 运行：node tests/test-batch-mock.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { BatchRunner } = require('../main/batchRunner');
const { AccountStore } = require('../main/accountStore');
const EnvStore = require('../main/envStore');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dbk-batch-'));
}

// 用真实 AccountStore/EnvStore（fs 落盘到临时目录），顺带验证 claim 在并发 worker 下不重复发号
function makeAccounts(accountStore, n, prefix = 'user') {
  const emails = [];
  const lines = [];
  for (let i = 1; i <= n; i += 1) {
    const email = `${prefix}${String(i).padStart(3, '0')}@test.com`;
    emails.push(email);
    lines.push(`${email}----pw${i}----rec${i}@test.com`);
  }
  accountStore.importFromText(lines.join('\n'));
  return emails;
}

function makeFakeLauncher() {
  const running = new Set();
  return {
    DOLA_URL: 'https://www.dola.com/chat/',
    launchEnv: async (env) => { running.add(env.id); return { ok: true }; },
    closeEnv: async (envId) => { running.delete(envId); return true; },
    isRunning: (id) => running.has(id),
    getRunningContext: (id) => (running.has(id) ? { id } : null),
    listRunning: () => [...running],
    _running: running,
  };
}

// scripts: email -> 'ok' | 'fail'(不可重试) | 'captcha-then-ok'(首轮验证码，换牌后成功) | 'captcha-always'
function makeFakeRegisterer(scripts = {}, { registerMs = 15 } = {}) {
  const captchaSeen = new Set();
  let concurrent = 0;
  const stat = { maxConcurrent: 0, calls: 0, keepOpenSeen: [] };
  return {
    stat,
    registerDola: async (opts) => {
      const { account } = opts;
      stat.calls += 1;
      stat.keepOpenSeen.push(Boolean(opts.keepOpen)); // 记录 keepOpen 透传值（回归用）
      concurrent += 1;
      stat.maxConcurrent = Math.max(stat.maxConcurrent, concurrent);
      const mode = scripts[account.email] || 'ok';
      try {
        await sleep(registerMs);
        if (mode === 'fail') throw new Error('密码错误（模拟不可重试失败）');
        if (mode === 'captcha-then-ok' && !captchaSeen.has(account.email)) {
          captchaSeen.add(account.email);
          const e = new Error('人机验证（模拟，首轮）');
          e.code = 'CAPTCHA';
          throw e;
        }
        if (mode === 'captcha-always') {
          const e = new Error('人机验证（始终）');
          e.code = 'CAPTCHA';
          throw e;
        }
        return { ok: true, localStorage: [{ k: 'sid', v: 'x' }] };
      } finally {
        concurrent -= 1;
      }
    },
  };
}

// 预算语义与真实 proxy.js 一致：consume 时 used+1，used>max 抛 BUDGET_EXHAUSTED
function makeFakeProxyService({ screenFailFirst = 0 } = {}) {
  let calls = 0;
  const budget = { max: 1000, used: 0 };
  const seenConfigs = [];
  return {
    resetExtractBudget: () => { budget.used = 0; },
    setExtractBudget: (m) => { budget.max = Math.floor(m); },
    getExtractUsage: () => ({ used: budget.used, max: budget.max, left: Math.max(0, budget.max - budget.used) }),
    probeGoogleLine: async () => ({ ok: true, host: 'mock:7897' }),
    screenStickyExit: async (config) => {
      seenConfigs.push(config);
      calls += 1;
      budget.used += 1;
      if (budget.used > budget.max) {
        const e = new Error('代理提取预算已耗尽（模拟）');
        e.code = 'BUDGET_EXHAUSTED';
        throw e;
      }
      if (calls <= screenFailFirst) throw new Error('预筛失败（模拟）');
      await sleep(5);
      return {
        host: 'gw.mock', port: 3010, username: 'u-hk-sid-x', password: 'p',
        region: 'hk', sid: `s${calls}`,
        exit: { ok: true, ip: `10.0.0.${(calls % 200) + 1}`, country: '香港', region: '', city: '香港', isp: 'HKT' },
      };
    },
    _calls: () => calls,
    _seenConfigs: seenConfigs,
  };
}

const fakeExport = async () => ({ count: 6, lsCount: 4, missingCore: [] });

function makeRunner({ accountCount = 12, concurrency = 8, scripts = {}, proxyOpts = {}, maxExtractBudget = 0, registerMs = 15, keepOpenAfterRegister = false } = {}) {
  const dir = tmpDir();
  const store = new EnvStore(dir);
  const accountStore = new AccountStore(dir);
  makeAccounts(accountStore, accountCount);
  const launcher = makeFakeLauncher();
  const registerer = makeFakeRegisterer(scripts, { registerMs });
  const proxyService = makeFakeProxyService(proxyOpts);
  const events = [];
  const runner = new BatchRunner({
    store,
    accountStore,
    proxyConfig: { extractUrl: 'http://mock/extract' },
    launcher,
    registerer,
    proxyService,
    exportCookies: fakeExport,
    emit: (event, payload) => events.push({ event, payload, t: Date.now() }),
    concurrency,
    keepOpenAfterRegister,
    region: 'HK',
    googleProxy: 'http://127.0.0.1:7897',
    maxExtractBudget,
  });
  return { runner, store, accountStore, launcher, registerer, proxyService, events };
}

function findDone(events) {
  return events.find((e) => e.event === 'batch:done');
}

// ---------- 测试用例 ----------

// 测试 1：8 并发 12 账号全成功——调度正确、无重复、事件字段齐全
async function testAllSuccess() {
  const ctx = makeRunner({ accountCount: 12, concurrency: 8, registerMs: 30 });
  await ctx.runner.start();
  const done = findDone(ctx.events);
  assert(done, '必须触发 batch:done');
  assert.strictEqual(done.payload.ok.length, 12, '12 个号全部成功');
  assert.strictEqual(done.payload.fail.length, 0, '无失败');
  assert.strictEqual(new Set(done.payload.ok.map((x) => x.email)).size, 12, '无重复处理');
  assert.strictEqual(done.payload.stopped, false);
  assert(ctx.registerer.stat.maxConcurrent <= 8, `并发不超 8（实际 ${ctx.registerer.stat.maxConcurrent}）`);
  assert(ctx.registerer.stat.maxConcurrent >= 2, `确实发生了并发（max=${ctx.registerer.stat.maxConcurrent}）`);

  // 账号状态与环境：全部 used、环境保留
  for (const a of ctx.accountStore.list()) assert.strictEqual(a.status, 'used', `${a.email} 应为 used`);
  assert.strictEqual(ctx.store.list().length, 12, '成功环境全部保留');
  assert.strictEqual(ctx.launcher._running.size, 0, '批量结束后浏览器全部关闭');

  // 事件序列：每号 pending 开局、最终 success、无 failed
  const byEmail = new Map();
  for (const e of ctx.events) {
    if (e.event !== 'batch:account') continue;
    assert(e.payload.email && e.payload.state, 'batch:account 必带 email/state');
    for (const k of ['state', 'step', 'attempt', 'maxAttempt', 'startedAt', 'elapsedMs']) {
      assert(k in e.payload, `batch:account 缺字段 ${k}`);
    }
    if (!byEmail.has(e.payload.email)) byEmail.set(e.payload.email, []);
    byEmail.get(e.payload.email).push(e.payload.state);
  }
  assert.strictEqual(byEmail.size, 12, '每号都有卡片事件');
  for (const [email, states] of byEmail) {
    assert.strictEqual(states[0], 'pending', `${email} 首个状态为 pending`);
    assert(states.includes('success'), `${email} 最终到达 success`);
    assert(!states.includes('failed'), `${email} 不应有 failed`);
  }

  // batch:stats 字段齐全且预算符合 10×12+20=140
  const stats = ctx.events.filter((e) => e.event === 'batch:stats');
  assert(stats.length > 0, '有 batch:stats 事件');
  for (const s of stats) {
    for (const k of ['pending', 'running', 'success', 'failed', 'extractUsage', 'extractBudget']) {
      assert(k in s.payload, `stats 缺字段 ${k}`);
    }
  }
  const lastStats = stats[stats.length - 1].payload;
  assert.strictEqual(lastStats.extractBudget, 140, '预算=10×12+20');
  assert.strictEqual(lastStats.extractUsage, 12, '成功 12 号各消耗 1 次提取');
  console.log(`✅ test1 8并发全成功 通过（maxConcurrent=${ctx.registerer.stat.maxConcurrent}）`);
}

// 测试 1.5：传给 screenStickyExit 的配置必须剔除 extractBudget（防止静态 15 覆盖批量共享预算，E2E 实测回归）
async function testBudgetNotOverridden() {
  const ctx = makeRunner({ accountCount: 1, concurrency: 1, registerMs: 5 });
  await ctx.runner.start();
  assert(ctx.proxyService._seenConfigs.length > 0, 'screenStickyExit 被调用过');
  for (const cfg of ctx.proxyService._seenConfigs) {
    assert(!('extractBudget' in cfg) || cfg.extractBudget === undefined, '批量预筛配置不得携带静态 extractBudget');
    assert(cfg.extractUrl, 'extractUrl 必须保留');
  }
  console.log('✅ test1.5 批量共享预算不被静态配置覆盖 通过');
}

// 测试 2：验证码换牌成功 / 不可重试失败 / 始终验证码 3 轮耗尽
async function testCaptchaRotateAndFail() {
  const ctx = makeRunner({
    accountCount: 6,
    concurrency: 3,
    scripts: {
      'user001@test.com': 'captcha-then-ok',
      'user002@test.com': 'fail',
      'user003@test.com': 'captcha-always',
    },
  });
  await ctx.runner.start();
  const done = findDone(ctx.events);
  const okEmails = done.payload.ok.map((x) => x.email);
  const failMap = new Map(done.payload.fail.map((x) => [x.email, x.reason]));
  assert(okEmails.includes('user001@test.com'), '验证码换牌后成功');
  assert(failMap.has('user002@test.com'), '不可重试失败入失败列表');
  assert(failMap.has('user003@test.com'), '始终验证码 3 轮耗尽后失败');
  assert.strictEqual(okEmails.length, 4, '其余 3 个 + user001 成功');
  assert.strictEqual(ctx.store.list().length, 4, '失败环境已删除，成功环境保留');
  const acc = new Map(ctx.accountStore.list().map((a) => [a.email, a.status]));
  assert.strictEqual(acc.get('user002@test.com'), 'failed');
  assert.strictEqual(acc.get('user003@test.com'), 'failed');
  assert.strictEqual(acc.get('user001@test.com'), 'used');
  // user003 应尝试满 3 轮（换 IP + 换指纹）
  const u3 = ctx.events.filter((e) => e.event === 'batch:account' && e.payload.email === 'user003@test.com');
  const attempts = new Set(u3.map((e) => e.payload.attempt).filter(Boolean));
  assert(attempts.has(1) && attempts.has(2) && attempts.has(3), 'user003 尝试了 3 轮');
  console.log('✅ test2 验证码换牌 + 失败路径 通过');
}

// 测试 3：预算熔断——超预算立即全队停止领新号，未领取账号保持 unused
async function testBudgetCircuitBreaker() {
  // 预算=3：并发放大下多个 worker 同帧消耗，3 次内成功者成功，之后全部熔断
  const ctx = makeRunner({ accountCount: 10, concurrency: 8, maxExtractBudget: 3, registerMs: 10 });
  await ctx.runner.start();
  const done = findDone(ctx.events);
  assert.strictEqual(done.payload.ok.length, 3, '3 个号成功');
  assert.strictEqual(done.payload.stopped, true, '标记 stopped');
  assert.strictEqual(done.payload.stopReason, 'budget', '停止原因为预算熔断');
  // 8 个 worker 同帧各发起 1 次预筛：第 1~3 次成功，第 4~8 次消耗时触发熔断（每次尝试都计 1 次消耗，
  // 与真实 proxy.js consumeExtract 语义一致）。熔断后不再有 worker 进入下一轮/领新号。
  assert.strictEqual(ctx.proxyService._calls(), 8, `共 8 次预筛尝试（实际 ${ctx.proxyService._calls()}）`);
  const acc = ctx.accountStore.list();
  const used = acc.filter((a) => a.status === 'used').length;
  const failed = acc.filter((a) => a.status === 'failed').length;
  const unused = acc.filter((a) => a.status === 'unused').length;
  assert.strictEqual(used, 3, '3 个号 used');
  assert.strictEqual(failed, 5, '命中熔断的 5 个号按失败收尾');
  assert.strictEqual(unused, 2, '熔断后未再领新号');
  // 熔断后 stats 上报预算与用量
  const stats = ctx.events.filter((e) => e.event === 'batch:stats');
  const last = stats[stats.length - 1].payload;
  assert.strictEqual(last.extractBudget, 3);
  console.log(`✅ test3 预算熔断全队停止 通过（used=${used} failed=${failed} unused=${unused}）`);
}

// 测试 4：停止语义——不再领新号，在跑的号跑完当前流程
async function testStopSemantics() {
  const ctx = makeRunner({ accountCount: 6, concurrency: 2, registerMs: 250 });
  const started = ctx.runner.start();
  // 等 2 个号进入 running（浏览器已启动、注册中）
  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = setInterval(() => {
      const running = ctx.events.filter((e) => e.event === 'batch:account' && e.payload.state === 'running');
      if (running.length >= 2) { clearInterval(poll); resolve(); }
      else if (Date.now() - t0 > 10000) { clearInterval(poll); reject(new Error('等待 running 状态超时')); }
    }, 15);
  });
  ctx.runner.stop();
  await started;
  const done = findDone(ctx.events);
  assert(done, '必须触发 batch:done');
  assert.strictEqual(done.payload.ok.length, 2, '在跑的 2 个号跑完并成功');
  assert.strictEqual(done.payload.stopped, true, '标记 stopped');
  assert.strictEqual(ctx.registerer.stat.calls, 2, '注册只执行了 2 次（未再领新号）');
  const unused = ctx.accountStore.list().filter((a) => a.status === 'unused').length;
  assert.strictEqual(unused, 4, '剩余 4 个账号保持 unused');
  console.log('✅ test4 停止语义 通过');
}

// 测试 5：Google 专线探活失败 → 批量直接不启动，一个账号都不消耗
async function testGoogleLineAbort() {
  const ctx = makeRunner({ accountCount: 3, concurrency: 2 });
  ctx.proxyService.probeGoogleLine = async () => { throw new Error('Clash 未启动（模拟）'); };
  await ctx.runner.start();
  const done = findDone(ctx.events);
  assert.strictEqual(done.payload.aborted, 'google-line', '标记 google-line 中止');
  assert.strictEqual(done.payload.ok.length, 0, '无成功');
  assert.strictEqual(done.payload.fail.length, 0, '无失败');
  assert(ctx.accountStore.list().every((a) => a.status === 'unused'), '未消耗任何账号');
  assert.strictEqual(ctx.proxyService._calls(), 0, '未消耗任何提取预算');
  console.log('✅ test5 Google 专线探活失败不启动 通过');
}

// 测试 6：预筛抖动——前 2 次预筛失败，换 sid 重试后恢复，不丢单
async function testScreenFailRecover() {
  const ctx = makeRunner({ accountCount: 2, concurrency: 2, proxyOpts: { screenFailFirst: 2 }, registerMs: 10 });
  await ctx.runner.start();
  const done = findDone(ctx.events);
  assert.strictEqual(done.payload.ok.length, 2, '预筛抖动后仍全部成功');
  assert(done.payload.hk.fail >= 2, 'HK 池失败统计被记录');
  console.log('✅ test6 预筛失败重试恢复 通过');
}

// 测试 7：keepOpen=true——成功账号保留浏览器窗口（批量结束不再强制清空），失败账号仍关窗删环境
async function testKeepOpenKeepsSuccessWindows() {
  const ctx = makeRunner({
    accountCount: 4,
    concurrency: 4,
    scripts: { 'user002@test.com': 'fail' },
    keepOpenAfterRegister: true,
    registerMs: 10,
  });
  await ctx.runner.start();
  const done = findDone(ctx.events);
  const okEmails = new Set(done.payload.ok.map((x) => x.email));
  assert.strictEqual(done.payload.ok.length, 3, '3 个成功');
  assert.strictEqual(done.payload.fail.length, 1, '1 个失败');
  // keepOpen 逐号透传到 registerDola
  assert.strictEqual(ctx.registerer.stat.keepOpenSeen.length, 4, 'registerDola 被调用 4 次');
  assert(ctx.registerer.stat.keepOpenSeen.every(Boolean), '每次调用都收到 keepOpen=true');
  // 批量结束后：成功窗口保留（不再强制清空），失败窗口已关
  assert.strictEqual(ctx.launcher._running.size, 3, `批量结束保留 3 个成功窗口（实际 ${ctx.launcher._running.size}）`);
  // 失败账号：状态 failed、环境已删除、窗口不保留
  const acc = new Map(ctx.accountStore.list().map((a) => [a.email, a.status]));
  assert.strictEqual(acc.get('user002@test.com'), 'failed', '失败账号状态 failed');
  assert.strictEqual(ctx.store.list().length, 3, '失败环境已删除，成功环境保留');
  // 成功卡片 step 带保留提示；失败卡片不带
  const lastByEmail = new Map();
  for (const e of ctx.events) {
    if (e.event !== 'batch:account') continue;
    lastByEmail.set(e.payload.email, e.payload);
  }
  for (const [email, rec] of lastByEmail) {
    if (okEmails.has(email)) assert(/浏览器窗口已保留/.test(rec.step), `${email} 成功 step 带保留窗口提示`);
    else assert(!/浏览器窗口已保留/.test(rec.step), `${email} 失败 step 不带保留提示`);
  }
  console.log('✅ test7 keepOpen 成功保留窗口/失败照常关窗 通过');
}

// 测试 8：keepOpen=false（默认）——与旧版行为完全一致，批量结束浏览器全部关闭
async function testKeepOpenDefaultClosed() {
  const ctx = makeRunner({ accountCount: 3, concurrency: 3, keepOpenAfterRegister: false, registerMs: 10 });
  await ctx.runner.start();
  const done = findDone(ctx.events);
  assert.strictEqual(done.payload.ok.length, 3, '3 个成功');
  assert.strictEqual(ctx.launcher._running.size, 0, '默认关闭时批量结束浏览器全部关闭（旧行为）');
  assert(ctx.registerer.stat.keepOpenSeen.every((v) => v === false), '每次调用都收到 keepOpen=false');
  console.log('✅ test8 keepOpen 默认关闭行为不变 通过');
}

(async () => {
  await testAllSuccess();
  await testBudgetNotOverridden();
  await testCaptchaRotateAndFail();
  await testBudgetCircuitBreaker();
  await testStopSemantics();
  await testGoogleLineAbort();
  await testScreenFailRecover();
  await testKeepOpenKeepsSuccessWindows();
  await testKeepOpenDefaultClosed();
  console.log('\n全部 mock 测试通过 ✔');
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ 测试失败：', e);
  process.exit(1);
});

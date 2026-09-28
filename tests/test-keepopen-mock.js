// tests/test-keepopen-mock.js · keepOpenAfterRegister（注册成功保留浏览器窗口）mock 测试（无需真实浏览器，node 直接跑）
// 覆盖：keepOpen=true 全成功保留窗口 / 成功保留+失败照常关窗删环境 / 默认 false 向后兼容 /
//       预算熔断命中号不保留窗口（成功保留仅限真正成功的号）
// 运行：node tests/test-keepopen-mock.js
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dbk-keepopen-'));
}

// 用真实 AccountStore/EnvStore（fs 落盘到临时目录），与 test-batch-mock.js 同款
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

// fake launcher：额外记录 closeEnv 调用，便于断言「谁被关过窗」
function makeFakeLauncher() {
  const running = new Set();
  const closeCalls = [];
  return {
    DOLA_URL: 'https://www.dola.com/chat/',
    launchEnv: async (env) => { running.add(env.id); return { ok: true }; },
    closeEnv: async (envId) => { closeCalls.push(envId); running.delete(envId); return true; },
    isRunning: (id) => running.has(id),
    getRunningContext: (id) => (running.has(id) ? { id } : null),
    listRunning: () => [...running],
    _running: running,
    _closeCalls: closeCalls,
  };
}

// fake registerer：脚本语义与 test-batch-mock.js 一致（ok/fail/captcha-then-ok/captcha-always），
// 并记录每次调用收到的 { email, envId, keepOpen }，用于断言 keepOpen 传参链路与 env↔账号映射
function makeFakeRegisterer(scripts = {}, { registerMs = 15 } = {}) {
  const calls = [];
  const stat = { calls: 0 };
  const captchaSeen = new Set();
  return {
    stat,
    calls,
    registerDola: async ({ env, account, keepOpen }) => {
      stat.calls += 1;
      calls.push({ email: account.email, envId: env.id, keepOpen: Boolean(keepOpen) });
      const mode = scripts[account.email] || 'ok';
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
    },
  };
}

// 预算语义与真实 proxy.js 一致：consume 时 used+1，used>max 抛 BUDGET_EXHAUSTED（同 test-batch-mock.js）
function makeFakeProxyService() {
  let calls = 0;
  const budget = { max: 1000, used: 0 };
  return {
    resetExtractBudget: () => { budget.used = 0; },
    setExtractBudget: (m) => { budget.max = Math.floor(m); },
    getExtractUsage: () => ({ used: budget.used, max: budget.max, left: Math.max(0, budget.max - budget.used) }),
    probeGoogleLine: async () => ({ ok: true, host: 'mock:7897' }),
    screenStickyExit: async () => {
      calls += 1;
      budget.used += 1;
      if (budget.used > budget.max) {
        const e = new Error('代理提取预算已耗尽（模拟）');
        e.code = 'BUDGET_EXHAUSTED';
        throw e;
      }
      await sleep(5);
      return {
        host: 'gw.mock', port: 3010, username: 'u-hk-sid-x', password: 'p',
        region: 'hk', sid: `s${calls}`,
        exit: { ok: true, ip: `10.0.0.${(calls % 200) + 1}`, country: '香港', region: '', city: '香港', isp: 'HKT' },
      };
    },
    _calls: () => calls,
  };
}

const fakeExport = async () => ({ count: 6, lsCount: 4, missingCore: [] });

// keepOpenAfterRegister 显式传 undefined 时走 BatchRunner 默认 false（用例 C 的向后兼容语义）
function makeRunner({ accountCount = 2, concurrency = 2, scripts = {}, keepOpenAfterRegister, maxExtractBudget = 0, registerMs = 15 } = {}) {
  const dir = tmpDir();
  const store = new EnvStore(dir);
  const accountStore = new AccountStore(dir);
  makeAccounts(accountStore, accountCount);
  const launcher = makeFakeLauncher();
  const registerer = makeFakeRegisterer(scripts, { registerMs });
  const proxyService = makeFakeProxyService();
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

// 用例 A：keepOpen=true，2 账号全成功 → 窗口全部保留、注册器收到 keepOpen=true、账号 used、环境保留
async function testKeepOpenAllSuccess() {
  const ctx = makeRunner({ accountCount: 2, concurrency: 2, keepOpenAfterRegister: true, registerMs: 20 });
  await ctx.runner.start();
  const done = findDone(ctx.events);
  assert(done, '必须触发 batch:done');
  assert.strictEqual(done.payload.ok.length, 2, '2 个号全部成功');
  assert.strictEqual(done.payload.fail.length, 0, '无失败');

  // 注册器必须收到 keepOpen=true
  assert.strictEqual(ctx.registerer.calls.length, 2, '注册器被调用 2 次');
  for (const c of ctx.registerer.calls) {
    assert.strictEqual(c.keepOpen, true, `${c.email} 调用必须携带 keepOpen=true`);
  }

  // 批量结束后浏览器未关：running 集合仍有 2 个环境，且全程无 closeEnv 调用
  assert.strictEqual(ctx.launcher._running.size, 2, `成功号浏览器窗口应全部保留（实际 ${ctx.launcher._running.size}）`);
  assert.strictEqual(ctx.launcher._closeCalls.length, 0, 'keepOpen 成功路径不应有任何 closeEnv 调用');

  // 账号状态 used、环境保留
  for (const a of ctx.accountStore.list()) assert.strictEqual(a.status, 'used', `${a.email} 应为 used`);
  assert.strictEqual(ctx.store.list().length, 2, '成功环境全部保留');

  // 成功 step 文案带保留提示
  for (const c of ctx.registerer.calls) {
    const cards = ctx.events.filter((e) => e.event === 'batch:account' && e.payload.email === c.email);
    const last = cards[cards.length - 1].payload;
    assert.strictEqual(last.state, 'success', `${c.email} 最终 success`);
    assert(last.step.includes('浏览器窗口已保留'), `成功 step 应含保留提示（实际：${last.step}）`);
  }
  console.log('✅ 用例A keepOpen=true 全成功保留窗口 通过');
}

// 用例 B：keepOpen=true，1 成功 + 1 不可重试失败 → 成功号窗口保留，失败号照常关窗 + 删环境
async function testKeepOpenSuccessKeptFailClosed() {
  const ctx = makeRunner({
    accountCount: 2,
    concurrency: 2,
    keepOpenAfterRegister: true,
    scripts: { 'user002@test.com': 'fail' },
  });
  await ctx.runner.start();
  const done = findDone(ctx.events);
  assert.strictEqual(done.payload.ok.length, 1, '1 个号成功');
  assert.strictEqual(done.payload.fail.length, 1, '1 个号失败');
  const okEmail = done.payload.ok[0].email;
  const failEmail = done.payload.fail[0].email;
  const okCall = ctx.registerer.calls.find((c) => c.email === okEmail);
  const failCall = ctx.registerer.calls.find((c) => c.email === failEmail);
  assert(okCall && failCall, '两个号都进入过注册器（env↔账号映射齐全）');
  assert.strictEqual(okCall.keepOpen, true, '成功号调用携带 keepOpen=true');

  // 窗口：running 集合只含成功环境；失败号触发过 closeEnv，成功号从未被关
  assert.strictEqual(ctx.launcher._running.size, 1, 'running 集合只含成功环境');
  assert(ctx.launcher._running.has(okCall.envId), '成功号窗口保留');
  assert(!ctx.launcher._running.has(failCall.envId), '失败号窗口已关');
  assert(ctx.launcher._closeCalls.includes(failCall.envId), '失败号触发过 closeEnv');
  assert(!ctx.launcher._closeCalls.includes(okCall.envId), '成功号不应触发 closeEnv');

  // 失败环境已删，成功环境保留
  assert.deepStrictEqual(
    ctx.store.list().map((e) => e.id),
    [okCall.envId],
    'store 只剩成功环境（失败环境已删）',
  );
  const acc = new Map(ctx.accountStore.list().map((a) => [a.email, a.status]));
  assert.strictEqual(acc.get(okEmail), 'used', '成功号状态 used');
  assert.strictEqual(acc.get(failEmail), 'failed', '失败号状态 failed');
  console.log('✅ 用例B keepOpen=true 成功保留/失败照常关窗删环境 通过');
}

// 用例 C：keepOpenAfterRegister 缺省（默认 false），1 账号成功 → 批量结束浏览器全部关闭（向后兼容）
async function testKeepOpenDefaultFalseBackwardCompat() {
  const ctx = makeRunner({ accountCount: 1, concurrency: 1 }); // 不传 keepOpenAfterRegister
  await ctx.runner.start();
  const done = findDone(ctx.events);
  assert.strictEqual(done.payload.ok.length, 1, '1 个号成功');
  assert.strictEqual(ctx.registerer.calls[0].keepOpen, false, '默认路径注册器收到 keepOpen=false');
  assert.strictEqual(ctx.launcher._running.size, 0, '批量结束后浏览器全部关闭（向后兼容）');
  assert.strictEqual(ctx.launcher._closeCalls.length, 1, '成功号收尾照常 closeEnv');
  assert.strictEqual(ctx.store.list().length, 1, '成功环境保留');
  const cards = ctx.events.filter((e) => e.event === 'batch:account');
  const last = cards[cards.length - 1].payload;
  assert(!last.step.includes('浏览器窗口已保留'), '默认路径成功文案不带保留提示');
  console.log('✅ 用例C keepOpen 默认 false 向后兼容 通过');
}

// 用例 D：keepOpen=true + 预算熔断 → 熔断号窗口不保留，只有真正成功的号保留窗口
async function testKeepOpenBudgetBreaker() {
  // 预算=1：2 个 worker 同帧各发起 1 次预筛，第 1 次成功、第 2 次触发熔断（consume 语义同真实 proxy.js）
  const ctx = makeRunner({ accountCount: 2, concurrency: 2, keepOpenAfterRegister: true, maxExtractBudget: 1 });
  await ctx.runner.start();
  const done = findDone(ctx.events);
  assert.strictEqual(ctx.proxyService._calls(), 2, `共 2 次预筛尝试（实际 ${ctx.proxyService._calls()}）`);
  const okEmails = done.payload.ok.map((x) => x.email);
  const failEmails = done.payload.fail.map((x) => x.email);
  assert.strictEqual(okEmails.length, 1, `以实际成功数为基准：预算 1 → 恰 1 个号成功（实际 ${okEmails.length}）`);
  assert.strictEqual(failEmails.length, 1, '命中熔断的号按失败收尾');
  assert.strictEqual(done.payload.stopped, true, '标记 stopped');
  assert.strictEqual(done.payload.stopReason, 'budget', '停止原因为预算熔断');

  const okCall = ctx.registerer.calls.find((c) => c.email === okEmails[0]);
  assert(okCall, '成功号进入过注册器');
  assert.strictEqual(okCall.keepOpen, true, '成功号调用携带 keepOpen=true');
  assert.strictEqual(ctx.registerer.calls.length, 1, '熔断号未进入注册阶段（预筛即熔断）');

  // 窗口：只有真正成功的号保留窗口，熔断号窗口不保留
  assert.strictEqual(ctx.launcher._running.size, 1, 'running 集合只含成功环境');
  assert(ctx.launcher._running.has(okCall.envId), '成功号窗口保留');
  assert(!ctx.launcher._closeCalls.includes(okCall.envId), '成功号不应触发 closeEnv');

  // 环境与账号：熔断号环境已删、状态 failed；成功号环境保留、状态 used
  assert.deepStrictEqual(
    ctx.store.list().map((e) => e.id),
    [okCall.envId],
    'store 只剩成功环境（熔断号环境已删）',
  );
  const acc = new Map(ctx.accountStore.list().map((a) => [a.email, a.status]));
  assert.strictEqual(acc.get(okEmails[0]), 'used', '成功号状态 used');
  assert.strictEqual(acc.get(failEmails[0]), 'failed', '熔断号状态 failed');
  console.log(`✅ 用例D keepOpen=true 预算熔断号窗口不保留 通过（ok=${okEmails.length} fail=${failEmails.length}）`);
}

(async () => {
  await testKeepOpenAllSuccess();
  await testKeepOpenSuccessKeptFailClosed();
  await testKeepOpenDefaultFalseBackwardCompat();
  await testKeepOpenBudgetBreaker();
  console.log('\n全部 keepOpen mock 测试通过 ✔');
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ 测试失败：', e);
  process.exit(1);
});

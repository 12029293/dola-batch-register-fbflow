// tests/test-fbflow-extra-mock.js · QA 补测：工程师 mock 未覆盖的高风险路径（全程无网络/无真浏览器）
// 覆盖：
//  A1 直连模式 + fbAccount 缺失 → 回落 registerDola（不崩溃、不静默丢号）
//  A2 直连模式 + registerer 无 registerDolaViaFacebook（旧版模块）→ typeof 守卫回落 registerDola
//  A3 直连模式 + keepOpen=true + 注册失败 → 失败号窗口仍关、环境删、账号 failed（keepOpen 不吞失败收尾）
//  A4 keepOpen / saveCookies / onProgress 透传到 registerDolaViaFacebook
//  B1 classifyBindRow：已绑定行（含邮箱+解除綁定按钮）→ 'bound'（邮箱优先）——解绑确认弹窗误点风险的前提交错
//  B2 rowStateFromTexts：最短叶节点优先 + kind 大小写不敏感
//  C1 classifyExitRegion：小写 countryCode / 缺 countryCode 按国家名兜底 / 非 {A-Z}{2} 形态容错
// 运行：node tests/test-fbflow-extra-mock.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { classifyBindRow, rowStateFromTexts, waitForOAuthTarget } = require('../main/registerer');
const { classifyExitRegion } = require('../main/proxy');
const { BatchRunner } = require('../main/batchRunner');
const { AccountStore } = require('../main/accountStore');
const EnvStore = require('../main/envStore');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dbk-fbflow-extra-'));
}

function makeAccounts(accountStore, n, prefix = 'extra') {
  const lines = [];
  for (let i = 1; i <= n; i += 1) {
    lines.push(`${prefix}${String(i).padStart(3, '0')}@test.com----pw${i}----rec${i}@test.com`);
  }
  accountStore.importFromText(lines.join('\n'));
}

function makeFakeLauncher() {
  const running = new Map();
  return {
    DOLA_URL: 'https://www.dola.com/chat/',
    launchEnv: async (env) => { running.set(env.id, { proxy: env.proxy }); return { ok: true }; },
    closeEnv: async (envId) => { running.delete(envId); return true; },
    isRunning: (id) => running.has(id),
    getRunningContext: (id) => (running.has(id) ? { id } : null),
    listRunning: () => [...running.keys()],
    _running: running,
  };
}

function makeFakeProxyServiceDirect() {
  const stat = { probeCalls: 0, screenCalls: 0 };
  let n = 0;
  return {
    stat,
    resetExtractBudget: () => {},
    setExtractBudget: () => {},
    getExtractUsage: () => ({ used: 0, max: 0, left: 0 }),
    probeGoogleLine: async () => { throw new Error('直连模式不应探活'); },
    screenStickyExit: async () => { stat.screenCalls += 1; throw new Error('直连模式不应调用 screenStickyExit'); },
    phantomExitProbe: async () => {
      stat.probeCalls += 1;
      n += 1;
      return { ok: true, ip: `10.2.0.${n}`, country: 'Hong Kong', countryCode: 'HK', regionName: '', city: 'Hong Kong', isp: 'HKT', region: 'hk', tz: 'Asia/Shanghai', warn: '' };
    },
  };
}

const fakeExport = async () => ({ count: 6, lsCount: 4, missingCore: [] });

// scripts: email -> 'fail-hard'（不可重试错误）| 默认成功
function makeFakeRegisterer({ withFbFn = true, failEmails = [] } = {}) {
  const stat = { fbCalls: 0, googleCalls: 0, fbOpts: [], googleOpts: [] };
  const mod = {
    stat,
    registerDola: async (opts) => {
      stat.googleCalls += 1;
      stat.googleOpts.push(opts);
      if (failEmails.includes(opts.account.email)) {
        const e = new Error('密码错误，请检查卡密文件'); // 不可重试（_isRetryable=false）
        throw e;
      }
      await sleep(5);
      return { ok: true, localStorage: [] };
    },
  };
  if (withFbFn) {
    mod.registerDolaViaFacebook = async (opts) => {
      stat.fbCalls += 1;
      stat.fbOpts.push(opts);
      if (failEmails.includes(opts.account.email)) {
        const e = new Error('密码错误，请检查卡密文件'); // 不可重试（FB wrong_credentials 同语义）
        throw e;
      }
      await sleep(5);
      return { ok: true, localStorage: [{ k: 'sid', v: 'x' }], googleBound: true, fbUnbound: true };
    };
  }
  return mod;
}

function makeDirectRunner({ fbAccount = null, withFbFn = true, keepOpen = false, failEmails = [], accountCount = 2 } = {}) {
  const dir = tmpDir();
  const store = new EnvStore(dir);
  const accountStore = new AccountStore(dir);
  makeAccounts(accountStore, accountCount);
  const launcher = makeFakeLauncher();
  const registerer = makeFakeRegisterer({ withFbFn, failEmails });
  const proxyService = makeFakeProxyServiceDirect();
  const events = [];
  const runner = new BatchRunner({
    store,
    accountStore,
    proxyConfig: { mode: 'phantom-local', browserProxy: { host: '127.0.0.1', port: 65533 } },
    launcher,
    registerer,
    proxyService,
    exportCookies: fakeExport,
    emit: (event, payload) => events.push({ event, payload }),
    concurrency: 1,
    keepOpenAfterRegister: keepOpen,
    region: 'HK',
    googleProxy: 'http://127.0.0.1:7897',
    maxExtractBudget: -1,
    fbAccount,
  });
  return { runner, store, accountStore, launcher, registerer, proxyService, events };
}

// A1：直连模式 + fbAccount 缺失 → 回落 registerDola（降级可用，不崩溃不静默丢号）
async function testA1DirectModeWithoutFbAccount() {
  const ctx = makeDirectRunner({ fbAccount: null, accountCount: 2 });
  await ctx.runner.start();
  const done = ctx.events.find((e) => e.event === 'batch:done');
  assert(done, 'batch:done 必须触发');
  assert.strictEqual(done.payload.ok.length, 2, '回落 registerDola 后 2 个成功');
  assert.strictEqual(ctx.registerer.stat.googleCalls, 2, '走旧版 registerDola');
  assert.strictEqual(ctx.registerer.stat.fbCalls, 0, '不走 FB 流程');
  assert.strictEqual(ctx.proxyService.stat.screenCalls, 0, '回落时仍是直连分支（零预筛）');
  console.log('✅ A1 直连模式 fbAccount 缺失回落 registerDola 通过');
}

// A2：registerer 无 registerDolaViaFacebook（旧版模块）→ typeof 守卫回落 registerDola
async function testA2LegacyRegistererFallback() {
  const ctx = makeDirectRunner({ fbAccount: { email: 'a@b.com', password: 'p' }, withFbFn: false, accountCount: 1 });
  await ctx.runner.start();
  const done = ctx.events.find((e) => e.event === 'batch:done');
  assert.strictEqual(done.payload.ok.length, 1, 'typeof 守卫回落成功');
  assert.strictEqual(ctx.registerer.stat.googleCalls, 1, '走 registerDola');
  assert.strictEqual(ctx.registerer.stat.fbCalls, 0, '不调用不存在的 FB 驱动');
  console.log('✅ A2 registerer 无 FB 驱动时 typeof 守卫回落 通过');
}

// A3：直连 + keepOpen=true + 不可重试失败 → 窗口关闭、环境删除、账号 failed
async function testA3KeepOpenFailureStillCleans() {
  const ctx = makeDirectRunner({
    fbAccount: { email: 'a@b.com', password: 'p' },
    keepOpen: true,
    failEmails: ['extra001@test.com'],
    accountCount: 2,
  });
  await ctx.runner.start();
  const done = ctx.events.find((e) => e.event === 'batch:done');
  assert.strictEqual(done.payload.ok.length, 1, '1 成功');
  assert.strictEqual(done.payload.fail.length, 1, '1 失败');
  // 失败号 keepOpen 不保留：running 里只剩成功号（keepOpen=true 保留成功窗口）
  assert.strictEqual(ctx.launcher._running.size, 1, '失败号窗口已关，仅成功号保留');
  assert.strictEqual(ctx.store.list().length, 1, '失败环境已删除');
  const acc = ctx.accountStore.list().find((a) => a.email === 'extra001@test.com');
  assert.strictEqual(acc.status, 'failed', '失败号标记 failed');
  assert(/密码错误/.test(acc.note || ''), `失败原因回写（实际：${acc.note}）`);
  console.log('✅ A3 keepOpen=true 失败号照常关窗删环境 通过');
}

// A4：keepOpen/saveCookies/onProgress 透传 registerDolaViaFacebook
async function testA4OptsPassthrough() {
  const ctx = makeDirectRunner({
    fbAccount: { email: 'a@b.com', password: 'p' },
    keepOpen: true,
    accountCount: 1,
  });
  await ctx.runner.start();
  assert.strictEqual(ctx.registerer.stat.fbCalls, 1, '走 FB 流程');
  const opts = ctx.registerer.stat.fbOpts[0];
  assert.strictEqual(opts.keepOpen, true, 'keepOpen 透传');
  assert.strictEqual(typeof opts.saveCookies, 'function', 'saveCookies 透传');
  assert.strictEqual(typeof opts.onProgress, 'function', 'onProgress 透传');
  assert.deepStrictEqual(opts.fbAccount, { email: 'a@b.com', password: 'p' }, 'fbAccount 透传');
  assert(opts.account && opts.account.email, 'account 透传');
  console.log('✅ A4 keepOpen/saveCookies/onProgress 透传 通过');
}

// B1：已绑定行（邮箱 + 解除綁定按钮同现）→ classifyBindRow 判 'bound'（邮箱优先）
// 这是审查发现的「解绑确认弹窗误点」前提：绑定后的 Google 行内含「解除綁定」按钮文本，
// clickUnbindConfirm 的候选词含「解除綁定」，存在点到 Google 行解绑按钮的窗口期。
async function testB1BoundRowContainsUnbindText() {
  assert.strictEqual(classifyBindRow('Google g***@gmail.com 解除綁定'), 'bound', '邮箱优先于解绑词');
  assert.strictEqual(classifyBindRow('Facebook f***@fb.com 解除綁定'), 'bound');
  // 反向：无邮箱的解绑行仍是 unbind
  assert.strictEqual(classifyBindRow('Google 解除綁定'), 'unbind');
  console.log('✅ B1 已绑定行含解除綁定按钮文本 → bound（邮箱优先） 通过');
}

// B2：rowStateFromTexts 最短叶优先 + kind 大小写不敏感
async function testB2RowStateShortestLeaf() {
  const rows = ['Google 前往綁定', 'GOOGLE 前往綁定（长容器文案，含说明）', 'FACEBOOK 解除綁定'];
  const g = rowStateFromTexts(rows, 'google');
  assert.strictEqual(g.present, true);
  assert.strictEqual(g.text, 'Google 前往綁定', '取最短匹配行');
  const f = rowStateFromTexts(rows, 'facebook');
  assert.strictEqual(f.state, 'unbind', 'kind 大小写不敏感（FACEBOOK 命中）');
  console.log('✅ B2 rowStateFromTexts 最短叶优先/kind 大小写不敏感 通过');
}

// C1：classifyExitRegion 边界（小写 countryCode / 国家名兜底 / 异常形态）
async function testC1ClassifyExitRegionEdges() {
  const lower = classifyExitRegion({ status: 'success', country: 'Hong Kong', countryCode: 'hk', query: '1.1.1.1' });
  assert.strictEqual(lower.region, 'hk', '小写 countryCode 归一为大写再判定');
  assert.strictEqual(lower.tz, 'Asia/Shanghai');

  const byName = classifyExitRegion({ status: 'success', country: 'Taiwan', query: '2.2.2.2' });
  assert.strictEqual(byName.region, 'tw', '缺 countryCode 按国家名兜底');
  assert.strictEqual(byName.tz, 'Asia/Taipei');

  const junk = classifyExitRegion({ status: 'success', country: '', countryCode: '??', query: '' });
  assert.strictEqual(junk.ok, true, '异常形态不抛错');
  assert.strictEqual(junk.warn, '出口非港台：未知', '无法识别 → 走非港台警告分支（国家名展示为「未知」）');
  console.log('✅ C1 classifyExitRegion 边界（小写 cc/名称兜底/异常容错） 通过');
}

// ---------- Round 2 补测（P1-1/P1-2/P1-3/P2-1 修复验证） ----------

// R2-1：waitForOAuthTarget 覆盖「弹窗创建时 about:blank、稍后才导航到 OAuth 域」场景
async function testR1LatePopupAboutBlankThenNavigate() {
  const page = { _url: 'https://www.dola.com/chat/', url() { return this._url; }, isClosed: () => false };
  const pages = [page];
  const context = { pages: () => pages };
  const task = waitForOAuthTarget(context, page, { maxMs: 6000, pollMs: 100, domainRe: /facebook\.com/ });
  await sleep(300);
  // 弹窗先创建（about:blank，未命中），600ms 后才导航到 facebook.com
  const popup = { _url: 'about:blank', url() { return this._url; }, isClosed: () => false };
  pages.push(popup);
  await sleep(600);
  assert.strictEqual(await Promise.race([task.then(() => 'done'), sleep(10).then(() => 'pending')]), 'pending', 'about:blank 弹窗未导航前不命中');
  popup._url = 'https://www.facebook.com/login.php';
  const r = await task;
  assert.strictEqual(r.popup, popup, 'about:blank → 晚导航的弹窗被捕获');
  assert.strictEqual(r.target, popup);
  console.log('✅ R1 waitForOAuthTarget about:blank 晚导航弹窗捕获 通过');
}

// R2-2：waitForOAuthTarget 忽略已关闭页面与无关域页面（残留页清理后的健壮性）
async function testR2IgnoresClosedAndForeignPages() {
  const page = { _url: 'https://www.dola.com/chat/', url() { return this._url; }, isClosed: () => false };
  const closedFb = { _url: 'https://www.facebook.com/login.php', url() { return this._url; }, isClosed: () => true }; // 已关闭残留
  const foreign = { _url: 'https://www.facebook.com/login.php', url() { return this._url; }, isClosed: () => false }; // 域不匹配（accounts.google 仲裁）
  const r = await waitForOAuthTarget(
    { pages: () => [page, closedFb, foreign] },
    page,
    { maxMs: 600, pollMs: 100, domainRe: /accounts\.google\.com/ },
  );
  assert.strictEqual(r.target, page, '已关闭/无关域残留页不误判，走超时同页兜底');
  assert.strictEqual(r.popup, null);
  console.log('✅ R2 waitForOAuthTarget 忽略已关闭/无关域残留页 通过');
}

(async () => {
  await testA1DirectModeWithoutFbAccount();
  await testA2LegacyRegistererFallback();
  await testA3KeepOpenFailureStillCleans();
  await testA4OptsPassthrough();
  await testB1BoundRowContainsUnbindText();
  await testB2RowStateShortestLeaf();
  await testC1ClassifyExitRegionEdges();
  await testR1LatePopupAboutBlankThenNavigate();
  await testR2IgnoresClosedAndForeignPages();
  console.log('\n全部 QA 补测通过 ✔');
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ 补测失败：', e);
  process.exit(1);
});

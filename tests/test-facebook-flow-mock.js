// tests/test-facebook-flow-mock.js · FB 登录→绑定谷歌→解绑 FB 新流程 mock 测试（不联网真实出口、不开真浏览器）
// 覆盖：
//  ① facebookStateFromProbe 状态判定（多语言/多形态探针数据）
//  ② detectFacebookState（page stub 注入探针）
//  ③ classifyBindRow / rowStateFromTexts 帳號設定行状态判定（绑定/已绑定/解绑/缺行）
//  ④ classifyExitRegion 出口国家归类（HK/TW/其他+警告）
//  ⑤ phantomExitProbe 经本地 mock HTTP 代理（绝对路径形式）成功 + 失败抛 SLOW_NETWORK
//  ⑥ BatchRunner 直连模式：fbAccount 透传 / screenStickyExit 零调用 / env.proxy.noAuth /
//     CAPTCHA 换指纹重试 / 探测失败轮换 / keepOpen
//  ⑦ 旧网关模式回归：无 mode 字段时仍走 registerDola + screenStickyExit
// 运行：node tests/test-facebook-flow-mock.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const {
  detectFacebookState,
  facebookStateFromProbe,
  classifyBindRow,
  rowStateFromTexts,
  waitForOAuthTarget,
} = require('../main/registerer');
const { BatchRunner, MAX_IP } = require('../main/batchRunner');
const { AccountStore } = require('../main/accountStore');
const EnvStore = require('../main/envStore');
const { classifyExitRegion, phantomExitProbe } = require('../main/proxy');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dbk-fbflow-'));
}

// ---------- ① facebookStateFromProbe ----------

function testFacebookStateFromProbe() {
  const base = { url: '', text: '', hasEmail: false, hasPass: false, emailVal: '', hasLoginBtn: false, hasCaptchaIframe: false };

  // 登录表单（en/zh 空邮箱）
  assert.strictEqual(facebookStateFromProbe({ ...base, url: 'https://www.facebook.com/login.php?skip_api_login=1&api_key=x', hasEmail: true }), 'need_email');
  // 邮箱已带出、密码框可见
  assert.strictEqual(facebookStateFromProbe({ ...base, url: 'https://www.facebook.com/login.php', hasEmail: true, emailVal: 'a@b.com', hasPass: true }), 'need_password');
  // 回归：两字段同页且邮箱为空 → 必须先填邮箱（曾误判 need_password 导致邮箱空着提交）
  assert.strictEqual(facebookStateFromProbe({ ...base, url: 'https://www.facebook.com/login.php', hasEmail: true, hasPass: true, emailVal: '' }), 'need_email');
  // FB 自动安全检查页（可等待自动跳转，不应判为人机验证）
  assert.strictEqual(facebookStateFromProbe({ ...base, url: 'https://www.facebook.com/two_step_verification/authentication/?encrypted_context=x', text: 'Running security checks' }), 'two_step');
  // 仅密码框
  assert.strictEqual(facebookStateFromProbe({ ...base, url: 'https://www.facebook.com/login.php', hasPass: true }), 'need_password');
  // 密码错误（英文/中文）
  assert.strictEqual(facebookStateFromProbe({ ...base, url: 'https://www.facebook.com/login.php', text: "The password that you've entered is incorrect" }), 'wrong_credentials');
  assert.strictEqual(facebookStateFromProbe({ ...base, url: 'https://www.facebook.com/login.php', text: '您输入的密码有误。请重试' }), 'wrong_credentials');
  // 人机验证（文本 / iframe）
  assert.strictEqual(facebookStateFromProbe({ ...base, url: 'https://www.facebook.com/login.php', text: '请输入你看到的图片中的文字 security check' }), 'need_captcha');
  assert.strictEqual(facebookStateFromProbe({ ...base, url: 'https://www.facebook.com/login.php', hasCaptchaIframe: true }), 'need_captcha');
  // checkpoint（URL 命中）
  assert.strictEqual(facebookStateFromProbe({ ...base, url: 'https://www.facebook.com/checkpoint/start/?ip=1', text: '确认这是你尝试登录的帐号' }), 'checkpoint');
  // 保存浏览器提示
  assert.strictEqual(facebookStateFromProbe({ ...base, url: 'https://www.facebook.com/login/save-device/', text: '保存浏览器以方便下次登录' }), 'save_browser');
  assert.strictEqual(facebookStateFromProbe({ ...base, url: 'https://www.facebook.com/login/save-device/', text: 'Save your login info' }), 'save_browser');
  // OAuth 确认页（Continue as / 以 XX 身份繼續）
  assert.strictEqual(facebookStateFromProbe({ ...base, url: 'https://www.facebook.com/v19.0/dialog/oauth', text: 'Continue as John Doe' }), 'oauth_confirm');
  assert.strictEqual(facebookStateFromProbe({ ...base, url: 'https://www.facebook.com/v19.0/dialog/oauth', text: '以 John Doe 身份繼續' }), 'oauth_confirm');
  // 回到 Dola（流程结束）
  assert.strictEqual(facebookStateFromProbe({ ...base, url: 'https://www.dola.com/chat/', text: '聊天' }), 'left_facebook');
  // popup 刚创建（about:blank）：加载中，不是 left_facebook
  assert.strictEqual(facebookStateFromProbe({ ...base, url: 'about:blank', text: '' }), 'unknown');
  // 连接错误页
  assert.strictEqual(facebookStateFromProbe({ ...base, url: 'https://www.facebook.com/login.php', text: "This site can't be reached ERR_CONNECTION_RESET" }), 'net_error');
  // 探针缺失 → page_error
  assert.strictEqual(facebookStateFromProbe(null), 'page_error');
  // facebook 域但无特征 → unknown
  assert.strictEqual(facebookStateFromProbe({ ...base, url: 'https://www.facebook.com/whatever', text: 'hello' }), 'unknown');
  console.log('✅ test1 facebookStateFromProbe 状态判定 通过');
}

// ---------- ② detectFacebookState（page stub） ----------

async function testDetectFacebookStateStub() {
  const stub = (probe, fail = false) => ({
    evaluate: async () => { if (fail) throw new Error('page closed'); return probe; },
  });
  const s1 = await detectFacebookState(stub({ url: 'https://www.facebook.com/login.php', text: '', hasEmail: true, hasPass: false, emailVal: '', hasCaptchaIframe: false }));
  assert.strictEqual(s1, 'need_email');
  const s2 = await detectFacebookState(stub(null, true));
  assert.strictEqual(s2, 'page_error');
  console.log('✅ test2 detectFacebookState page stub 通过');
}

// ---------- ③ 帳號設定行状态判定 ----------

function testBindRowClassification() {
  // classifyBindRow：三语 + 已绑定邮箱
  assert.strictEqual(classifyBindRow('Google 前往綁定'), 'bind');
  assert.strictEqual(classifyBindRow('Google 前往绑定'), 'bind');
  assert.strictEqual(classifyBindRow('Google Bind now'), 'bind');
  assert.strictEqual(classifyBindRow('Google g***@gmail.com'), 'bound');
  assert.strictEqual(classifyBindRow('Facebook 解除綁定'), 'unbind');
  assert.strictEqual(classifyBindRow('Facebook 解除绑定'), 'unbind');
  assert.strictEqual(classifyBindRow('Facebook Unlink'), 'unbind');
  assert.strictEqual(classifyBindRow('Apple ID'), 'unknown');

  // rowStateFromTexts：繁体面板行
  const tw = ['手機號碼 前往綁定', 'Google 前往綁定', 'Facebook 解除綁定', 'Apple ID 前往綁定'];
  const g1 = rowStateFromTexts(tw, 'google');
  assert.strictEqual(g1.present, true);
  assert.strictEqual(g1.state, 'bind');
  const f1 = rowStateFromTexts(tw, 'facebook');
  assert.strictEqual(f1.state, 'unbind');

  // 已绑定形态（脱敏邮箱）
  const bound = ['手機號碼 +886***', 'Google g***@gmail.com', 'Facebook 前往綁定', 'Apple ID 前往綁定'];
  assert.strictEqual(rowStateFromTexts(bound, 'google').state, 'bound');
  assert.strictEqual(rowStateFromTexts(bound, 'facebook').state, 'bind');

  // 简体 + 英文
  const cn = ['手机号码 前往绑定', 'Google 前往绑定', 'Facebook 解除绑定'];
  assert.strictEqual(rowStateFromTexts(cn, 'facebook').state, 'unbind');
  const en = ['Phone Bind', 'Google Bind', 'Facebook Unbind'];
  assert.strictEqual(rowStateFromTexts(en, 'facebook').state, 'unbind');
  assert.strictEqual(rowStateFromTexts(en, 'google').state, 'bind');

  // 缺行
  const absent = rowStateFromTexts(['手機號碼 前往綁定'], 'google');
  assert.strictEqual(absent.present, false);
  assert.strictEqual(absent.state, 'absent');
  console.log('✅ test3 帳號設定行状态判定 通过');
}

// ---------- ④ classifyExitRegion ----------

function testClassifyExitRegion() {
  const hk = classifyExitRegion({ status: 'success', country: '香港', countryCode: 'HK', city: 'Hong Kong', isp: 'PCCW', query: '1.2.3.4' });
  assert.strictEqual(hk.tz, 'Asia/Shanghai');
  assert.strictEqual(hk.region, 'hk');
  assert.strictEqual(hk.warn, '');
  assert.strictEqual(hk.ip, '1.2.3.4');

  const tw = classifyExitRegion({ status: 'success', country: '台湾', countryCode: 'TW', city: 'Taipei', isp: 'HiNet', query: '5.6.7.8' });
  assert.strictEqual(tw.tz, 'Asia/Taipei');
  assert.strictEqual(tw.region, 'tw');
  assert.strictEqual(tw.warn, '');

  const jp = classifyExitRegion({ status: 'success', country: 'Japan', countryCode: 'JP', city: 'Tokyo', isp: 'NTT', query: '9.9.9.9' });
  assert.strictEqual(jp.tz, 'Asia/Shanghai');
  assert.strictEqual(jp.warn, '出口非港台：Japan');

  // countryCode 缺失时按国家名推断
  const hkByName = classifyExitRegion({ status: 'success', country: 'Hong Kong', city: '', isp: 'HKT', query: '1.1.1.1' });
  assert.strictEqual(hkByName.region, 'hk');
  const twByName = classifyExitRegion({ status: 'success', country: 'Taiwan', query: '2.2.2.2' });
  assert.strictEqual(twByName.tz, 'Asia/Taipei');

  // 空数据不抛错
  const empty = classifyExitRegion(null);
  assert.strictEqual(empty.ok, true);
  console.log('✅ test4 classifyExitRegion 出口归类 通过');
}

// ---------- ⑤ phantomExitProbe（本地 mock HTTP 代理） ----------

// mock HTTP 代理：收到绝对路径形式的请求后回固定 JSON（模拟 ip-api 响应，全程无外网）
function startMockProxy(payload, { statusCode = 200, drop = false } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (drop) { req.destroy(); return; }
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, close: () => new Promise((r) => server.close(r)) }));
  });
}

async function testPhantomExitProbeSuccess() {
  const mock = await startMockProxy({ status: 'success', country: 'Hong Kong', countryCode: 'HK', regionName: '', city: 'Hong Kong', isp: 'HKT', query: '1.2.3.4' });
  try {
    const attempts = [];
    const r = await phantomExitProbe({ host: '127.0.0.1', port: mock.port }, { timeoutMs: 5000, onAttempt: (m) => attempts.push(m) });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.countryCode, 'HK');
    assert.strictEqual(r.tz, 'Asia/Shanghai');
    assert.strictEqual(r.warn, '');
    assert(attempts.length > 0, 'onAttempt 有进度回调');
  } finally {
    await mock.close();
  }
  console.log('✅ test5a phantomExitProbe 绝对路径形式成功 通过');
}

async function testPhantomExitProbeFailure() {
  // 两种形式均失败（非 JSON 响应）→ 抛 SLOW_NETWORK
  const mock = await startMockProxy('<html>Bad Gateway</html>');
  try {
    await assert.rejects(
      () => phantomExitProbe({ host: '127.0.0.1', port: mock.port }, { timeoutMs: 3000 }),
      (e) => e.code === 'SLOW_NETWORK' && /Phantom 出口探测失败/.test(e.message),
    );
  } finally {
    await mock.close();
  }
  console.log('✅ test5b phantomExitProbe 失败抛 SLOW_NETWORK 通过');
}

// ---------- ⑥/⑦ BatchRunner mock ----------

function makeAccounts(accountStore, n, prefix = 'fbuser') {
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

// scripts: email -> 'ok' | 'captcha-then-ok'
function makeFakeRegisterer({ registerMs = 10 } = {}) {
  const stat = { fbCalls: 0, googleCalls: 0, maxConcurrent: 0, concurrent: 0, fbOpts: [], launchedProxies: [] };
  const captchaSeen = new Set();
  return {
    stat,
    registerDola: async (opts) => {
      stat.googleCalls += 1;
      await sleep(registerMs);
      return { ok: true, localStorage: [] };
    },
    registerDolaViaFacebook: async (opts) => {
      stat.fbCalls += 1;
      stat.fbOpts.push(opts);
      stat.concurrent += 1;
      stat.maxConcurrent = Math.max(stat.maxConcurrent, stat.concurrent);
      try {
        await sleep(registerMs);
        const { account } = opts;
        if (account.email.endsWith('cap@test.com') && !captchaSeen.has(account.email)) {
          captchaSeen.add(account.email);
          const e = new Error('Facebook 弹出人机验证（模拟，首轮）');
          e.code = 'CAPTCHA';
          throw e;
        }
        return { ok: true, localStorage: [{ k: 'sid', v: 'x' }], googleBound: true, fbUnbound: true };
      } finally {
        stat.concurrent -= 1;
      }
    },
  };
}

function makeFakeProxyServiceDirect({ probePayload = null, probeFailures = 0 } = {}) {
  let calls = 0;
  const stat = { screenCalls: 0, probeCalls: 0 };
  return {
    stat,
    resetExtractBudget: () => {},
    setExtractBudget: () => {},
    getExtractUsage: () => ({ used: 0, max: 0, left: 0 }),
    probeGoogleLine: async () => { throw new Error('直连模式不应探活 Google 线路'); },
    screenStickyExit: async () => { stat.screenCalls += 1; throw new Error('直连模式不应调用 screenStickyExit'); },
    phantomExitProbe: async (bp, { onAttempt = () => {} } = {}) => {
      stat.probeCalls += 1;
      calls += 1;
      onAttempt(`探测出口 IP（mock ${calls}）…`);
      if (calls <= probeFailures) {
        const e = new Error('mock 探测失败');
        e.code = 'SLOW_NETWORK';
        throw e;
      }
      return probePayload || { ok: true, ip: `10.1.1.${(calls % 200) + 1}`, country: 'Hong Kong', countryCode: 'HK', regionName: '', city: 'Hong Kong', isp: 'HKT', region: 'hk', tz: 'Asia/Shanghai', warn: '' };
    },
    _calls: () => calls,
  };
}

const fakeExport = async () => ({ count: 6, lsCount: 4, missingCore: [] });

function makeDirectRunner({ accountCount = 3, scripts = {}, proxyOpts = {}, keepOpen = false, concurrency = 1, registerMs = 10 } = {}) {
  const dir = tmpDir();
  const store = new EnvStore(dir);
  const accountStore = new AccountStore(dir);
  const emails = makeAccounts(accountStore, accountCount);
  const launcher = makeFakeLauncher();
  const registerer = makeFakeRegisterer({ registerMs });
  const proxyService = makeFakeProxyServiceDirect(proxyOpts);
  const events = [];
  const runner = new BatchRunner({
    store,
    accountStore,
    proxyConfig: { mode: 'phantom-local', browserProxy: { host: '127.0.0.1', port: 65533 } },
    launcher,
    registerer,
    proxyService,
    exportCookies: fakeExport,
    emit: (event, payload) => events.push({ event, payload, t: Date.now() }),
    concurrency,
    keepOpenAfterRegister: keepOpen,
    region: 'HK',
    googleProxy: 'http://127.0.0.1:7897', // 直连模式下必须被忽略
    maxExtractBudget: -1,
    fbAccount: { email: '15634110089@163.com', password: 'zxc12300' },
  });
  return { runner, store, accountStore, launcher, registerer, proxyService, events, emails };
}

function findDone(events) {
  return events.find((e) => e.event === 'batch:done');
}

// 测试 6a：直连模式全成功——fbAccount 透传 / screenStickyExit 零调用 / env.proxy.noAuth / 并发=1 串行
async function testDirectModeAllSuccess() {
  const ctx = makeDirectRunner({ accountCount: 3, concurrency: 1, registerMs: 15 });
  await ctx.runner.start();
  const done = findDone(ctx.events);
  assert(done, '必须触发 batch:done');
  assert.strictEqual(done.payload.ok.length, 3, '3 个号全部成功');
  assert.strictEqual(done.payload.fail.length, 0, '无失败');
  assert.strictEqual(ctx.registerer.stat.fbCalls, 3, '全部走 registerDolaViaFacebook');
  assert.strictEqual(ctx.registerer.stat.googleCalls, 0, '不触发旧版 registerDola');
  assert.strictEqual(ctx.proxyService.stat.screenCalls, 0, '直连模式零预筛调用');
  assert(ctx.proxyService.stat.probeCalls >= 3, `有出口探测（实际 ${ctx.proxyService.stat.probeCalls} 次）`);
  // fbAccount 透传
  assert(ctx.registerer.stat.fbOpts.every((o) => o.fbAccount && o.fbAccount.email === '15634110089@163.com'), 'fbAccount 透传到注册驱动');
  // 进度断言：直连模式探测步骤 + env.proxy 经 launchEnv 形状（详见 test6b）
  const accountEvents = ctx.events.filter((e) => e.event === 'batch:account');
  assert(accountEvents.some((e) => /Phantom 出口/.test(e.payload.step || '')), '进度含 Phantom 出口探测步骤');
  // keepOpen=false：批量结束浏览器全关
  assert.strictEqual(ctx.launcher._running.size, 0, '默认收尾关闭全部浏览器');
  // 并发=1 串行
  assert.strictEqual(ctx.registerer.stat.maxConcurrent, 1, 'FB 同账号串行复用（并发 1）');
  // 账号状态与环境
  for (const a of ctx.accountStore.list()) assert.strictEqual(a.status, 'used');
  assert.strictEqual(ctx.store.list().length, 3, '成功环境保留');
  console.log('✅ test6a 直连模式全成功（fbAccount 透传/零预筛） 通过');
}

// 测试 6b：直连模式 env.proxy.noAuth 断言（launchEnv 收到挂代理的 env）
async function testDirectModeProxyShape() {
  const ctx = makeDirectRunner({ accountCount: 1, concurrency: 1, registerMs: 5 });
  const origLaunch = ctx.launcher.launchEnv;
  const seenProxies = [];
  ctx.launcher.launchEnv = async (env, profilesDir, opts) => {
    seenProxies.push(env.proxy);
    return origLaunch(env, profilesDir, opts);
  };
  await ctx.runner.start();
  assert.strictEqual(seenProxies.length, 1, 'launchEnv 被调用 1 次');
  const p = seenProxies[0];
  assert.strictEqual(p.host, '127.0.0.1', '直挂 browserProxy.host');
  assert.strictEqual(p.port, 65533, '直挂 browserProxy.port');
  assert.strictEqual(p.noAuth, true, 'noAuth 标记（launcher 不启转发器）');
  assert.strictEqual(p.protocol, 'http', '混合端口 HTTP 形式');
  assert.strictEqual(p.tz, 'Asia/Shanghai', 'HK 出口 → Asia/Shanghai');
  assert.strictEqual(p.region, 'hk');
  assert(p.exit && p.exit.ip, '出口 IP 记录到 env.proxy.exit');
  console.log('✅ test6b 直连模式 env.proxy 形状（noAuth/tz/exit） 通过');
}

// 测试 6c：CAPTCHA 换指纹重试（同出口 MAX_IP=3）
async function testDirectModeCaptchaRotate() {
  const capEmail = 'fbusercap@test.com';
  const ctx = makeDirectRunner({ accountCount: 2, concurrency: 1, registerMs: 5 });
  // 把第二个号脚本设为 captcha-then-ok：makeFakeRegisterer 以 cap@test.com 结尾识别——重命名导入
  ctx.accountStore.importFromText(`${capEmail}----pw----rec@test.com`);
  await ctx.runner.start();
  const done = findDone(ctx.events);
  const okEmails = done.payload.ok.map((x) => x.email);
  assert(okEmails.includes(capEmail), 'CAPTCHA 换牌后成功');
  const capEvents = ctx.events.filter((e) => e.event === 'batch:account' && e.payload.email === capEmail);
  const attempts = new Set(capEvents.map((e) => e.payload.attempt).filter(Boolean));
  assert(attempts.has(1) && attempts.has(2), `CAPTCHA 后尝试了 2 轮（实际 ${[...attempts]}）`);
  console.log('✅ test6c 直连模式 CAPTCHA 换指纹重试 通过');
}

// 测试 6d：出口探测持续失败 → MAX_IP 轮换后放弃，账号 failed
async function testDirectModeProbeFailRotate() {
  const ctx = makeDirectRunner({
    accountCount: 1,
    concurrency: 1,
    registerMs: 5,
    proxyOpts: { probeFailures: 99 },
  });
  await ctx.runner.start();
  const done = findDone(ctx.events);
  assert.strictEqual(done.payload.ok.length, 0, '探测全失败无成功');
  assert.strictEqual(done.payload.fail.length, 1, '1 个失败');
  assert.strictEqual(ctx.proxyService.stat.probeCalls, MAX_IP, `探测了 MAX_IP 轮（实际 ${ctx.proxyService.stat.probeCalls}）`);
  assert.strictEqual(ctx.registerer.stat.fbCalls, 0, '未启动浏览器（探测失败在启动前）');
  const acc = ctx.accountStore.list();
  assert.strictEqual(acc.filter((a) => a.status === 'failed').length, 1, '账号标记 failed');
  assert.strictEqual(ctx.store.list().length, 0, '失败环境已删除');
  console.log('✅ test6d 探测失败 MAX_IP 轮换后放弃 通过');
}

// 测试 6e：出口非港台 → 警告写入进度与 proxy.warn
async function testDirectModeExitWarn() {
  const ctx = makeDirectRunner({
    accountCount: 1,
    concurrency: 1,
    registerMs: 5,
    proxyOpts: { probePayload: { ok: true, ip: '8.8.8.8', country: 'United States', countryCode: 'US', regionName: 'CA', city: 'LA', isp: 'GTT', region: 'us', tz: 'Asia/Shanghai', warn: '出口非港台：United States' } },
  });
  await ctx.runner.start();
  const done = findDone(ctx.events);
  assert.strictEqual(done.payload.ok.length, 1, '非港台出口不阻断（仅警告）');
  const accountEvents = ctx.events.filter((e) => e.event === 'batch:account');
  assert(accountEvents.some((e) => /出口非港台/.test(e.payload.step || '')), '进度含「出口非港台」警告');
  console.log('✅ test6e 出口非港台警告（不阻断） 通过');
}

// 测试 6f：直连模式 keepOpen=true 成功保留窗口
async function testDirectModeKeepOpen() {
  const ctx = makeDirectRunner({ accountCount: 2, concurrency: 1, registerMs: 5, keepOpen: true });
  await ctx.runner.start();
  const done = findDone(ctx.events);
  assert.strictEqual(done.payload.ok.length, 2, '2 个成功');
  assert.strictEqual(ctx.launcher._running.size, 2, 'keepOpen 保留成功窗口');
  console.log('✅ test6f 直连模式 keepOpen 保留窗口 通过');
}

// 测试 7：旧网关模式回归——无 mode 字段 → screenStickyExit + registerDola
async function testLegacyModeRegression() {
  const dir = tmpDir();
  const store = new EnvStore(dir);
  const accountStore = new AccountStore(dir);
  makeAccounts(accountStore, 2);
  const launcher = makeFakeLauncher();
  const registerer = makeFakeRegisterer({ registerMs: 5 });
  const legacyProxy = {
    resetExtractBudget: () => {},
    setExtractBudget: () => {},
    getExtractUsage: () => ({ used: 2, max: 40, left: 38 }),
    probeGoogleLine: async () => ({ ok: true, host: 'mock:7897' }),
    screenStickyExit: async () => ({
      host: 'gw.mock', port: 3010, username: 'u', password: 'p', region: 'hk', sid: 's1',
      exit: { ok: true, ip: '10.0.0.1', country: '香港', region: '', city: '香港', isp: 'HKT' },
    }),
  };
  const events = [];
  const runner = new BatchRunner({
    store,
    accountStore,
    proxyConfig: { extractUrl: 'http://mock/extract' }, // 无 mode：旧网关模式
    launcher,
    registerer,
    proxyService: legacyProxy,
    exportCookies: fakeExport,
    emit: (event, payload) => events.push({ event, payload }),
    concurrency: 2,
    region: 'HK',
    googleProxy: 'http://127.0.0.1:7897',
    maxExtractBudget: -1,
    fbAccount: { email: 'fb@x.com', password: 'p' }, // 旧模式下 fbAccount 不生效
  });
  await runner.start();
  const done = events.find((e) => e.event === 'batch:done');
  assert.strictEqual(done.payload.ok.length, 2, '旧模式 2 个成功');
  assert.strictEqual(registerer.stat.googleCalls, 2, '旧模式走 registerDola');
  assert.strictEqual(registerer.stat.fbCalls, 0, '旧模式不走 FB 流程');
  console.log('✅ test7 旧网关模式回归（registerDola/screenStickyExit 不受影响） 通过');
}

// ---------- ⑧ waitForOAuthTarget（QA P2-1：迟到弹窗仲裁） ----------

function fakePage(initialUrl) {
  const p = {
    _url: initialUrl,
    url() { return this._url; },
    isClosed: () => false,
  };
  return p;
}
function fakeContext(pages) {
  return { pages: () => pages };
}

async function testWaitForOAuthTargetLatePopup() {
  const page = fakePage('https://www.dola.com/chat/');
  const pages = [page];
  const context = fakeContext(pages);
  const task = waitForOAuthTarget(context, page, { maxMs: 6000, pollMs: 100, domainRe: /facebook\.com/ });
  // 1.5s 后「迟到弹窗」才出现并导航到 facebook.com（模拟 20s race 超时后弹窗才创建的场景）
  await sleep(1500);
  assert.strictEqual(pages.length, 1, '弹窗出现前仲裁不应返回');
  const popup = fakePage('https://www.facebook.com/login.php?skip_api_login=1');
  pages.push(popup);
  const r = await task;
  assert.strictEqual(r.popup, popup, '迟到弹窗被仲裁捕获');
  assert.strictEqual(r.target, popup, 'target 切换到弹窗');
  console.log('✅ test8a waitForOAuthTarget 迟到弹窗捕获 通过');
}

async function testWaitForOAuthTargetSameTab() {
  const page = fakePage('https://www.dola.com/chat/');
  const context = fakeContext([page]);
  const task = waitForOAuthTarget(context, page, { maxMs: 6000, pollMs: 100, domainRe: /accounts\.google\.com/ });
  await sleep(500);
  page._url = 'https://accounts.google.com/o/oauth2/auth?client_id=x'; // 同页跳转
  const r = await task;
  assert.strictEqual(r.target, page, '同页跳转 → target=page');
  assert.strictEqual(r.popup, null, '同页跳转 → popup=null');
  console.log('✅ test8b waitForOAuthTarget 同页跳转判定 通过');
}

async function testWaitForOAuthTargetTimeout() {
  const page = fakePage('https://www.dola.com/chat/');
  const popup = fakePage('about:blank'); // 未导航的弹窗不应命中
  const context = fakeContext([page, popup]);
  const r = await waitForOAuthTarget(context, page, { maxMs: 800, pollMs: 100, domainRe: /accounts\.google\.com/ });
  assert.strictEqual(r.target, page, '超时兜底 target=page');
  assert.strictEqual(r.popup, null, '超时兜底 popup=null');
  console.log('✅ test8c waitForOAuthTarget 超时兜底（about:blank 不误判） 通过');
}

(async () => {
  testFacebookStateFromProbe();
  await testDetectFacebookStateStub();
  testBindRowClassification();
  testClassifyExitRegion();
  await testPhantomExitProbeSuccess();
  await testPhantomExitProbeFailure();
  await testDirectModeAllSuccess();
  await testDirectModeProxyShape();
  await testDirectModeCaptchaRotate();
  await testDirectModeProbeFailRotate();
  await testDirectModeExitWarn();
  await testDirectModeKeepOpen();
  await testLegacyModeRegression();
  await testWaitForOAuthTargetLatePopup();
  await testWaitForOAuthTargetSameTab();
  await testWaitForOAuthTargetTimeout();
  console.log('\n全部 FB 流程 mock 测试通过 ✔');
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ 测试失败：', e);
  process.exit(1);
});

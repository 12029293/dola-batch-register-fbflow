// main.js · Electron 主进程入口：窗口 + IPC 路由 + 应用配置 + 批量引擎装配
'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { randomFingerprint } = require('./fingerprint');
const EnvStore = require('./envStore');
const { AccountStore } = require('./accountStore');
const proxyService = require('./proxy');
const launcher = require('./launcher');
const registerer = require('./registerer');
const { BatchRunner } = require('./batchRunner');
const { makeExporter } = require('./exporter');

let win = null;
let store = null;
let accountStore = null;
let proxyConfig = { protocol: 'socks5', extractUrl: '' };

// ---------- 应用配置（config/app.json）----------
// 与 config/proxy.json 分离的理由：proxy.json 含提取 API 密钥等敏感字段且由代理链路消费；
// app.json 是用户偏好（并发数/导出目录/预算上限），分开存取可避免把密钥带回渲染层。
function appConfigFile() {
  return path.join(app.getAppPath(), 'config', 'app.json');
}
const appConfig = {
  concurrency: 8, exportDir: '', maxExtractBudget: 0, headless: true, keepOpenAfterRegister: false,
  // Facebook 账号（FB 登录 → 绑定谷歌 → 解绑 FB 流程）：由 config/app.json 持久化
  facebook: { email: '', password: '' },
};

function normalizeAppConfig() {
  // 并发数：-1=无上限（每个待注册账号一个 worker）；1~999 有限并发
  const cc = Math.floor(Number(appConfig.concurrency));
  appConfig.concurrency = !Number.isFinite(cc) ? 8 : (cc < 0 ? -1 : Math.min(999, Math.max(1, cc)));
  appConfig.exportDir = String(appConfig.exportDir || '').trim();
  const mb = Number(appConfig.maxExtractBudget);
  // -1=无上限（不熔断）；0=自动（10×待注册数+20）；>0=硬上限
  appConfig.maxExtractBudget = !Number.isFinite(mb) ? 0 : (mb < 0 ? -1 : Math.floor(mb)); // 负值统一归一为 -1
  if (appConfig.maxExtractBudget > 0 && appConfig.maxExtractBudget < 1) appConfig.maxExtractBudget = 0;
  // 隐身注册（headless）：默认开启 = 软件内注册不弹浏览器窗口；显式 false 才关闭
  appConfig.headless = appConfig.headless !== false && appConfig.headless !== 'false';
  // 注册成功保留浏览器窗口：默认关闭；开启时必须可见窗口（与隐身注册互斥——隐身下看不到保留的窗口）
  appConfig.keepOpenAfterRegister = appConfig.keepOpenAfterRegister === true;
  if (appConfig.keepOpenAfterRegister) appConfig.headless = false;
  // Facebook 账号：保证对象形状（email/password 均为字符串）
  if (!appConfig.facebook || typeof appConfig.facebook !== 'object') appConfig.facebook = { email: '', password: '' };
  appConfig.facebook.email = String(appConfig.facebook.email || '').trim();
  appConfig.facebook.password = String(appConfig.facebook.password || '');
}

function saveAppConfig() {
  try {
    fs.mkdirSync(path.dirname(appConfigFile()), { recursive: true });
    fs.writeFileSync(appConfigFile(), JSON.stringify(appConfig, null, 2), 'utf8');
  } catch (e) { /* 目录只读等异常不阻断启动 */ }
}

function loadAppConfig() {
  try {
    Object.assign(appConfig, JSON.parse(fs.readFileSync(appConfigFile(), 'utf8')));
  } catch (e) { /* 首次无文件：用默认值 */ }
  normalizeAppConfig();
  saveAppConfig(); // 回写规范化结果 + 首次自动生成
}

function loadProxyConfig() {
  try {
    const file = path.join(app.getAppPath(), 'config', 'proxy.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 两种配置形态均采纳：传统提取网关（extractUrl）/ 直连模式（mode=clash-local，兼容旧值 phantom-local）
    if (parsed && (parsed.extractUrl || parsed.mode)) proxyConfig = parsed;
  } catch (e) { /* 用默认空配置 */ }
}

// 直连模式判定：本地代理端口直挂（Clash Verge 7897 / Phantom 65533；不提取、不预筛、不耗预算）
function isPhantomLocalMode() {
  return Boolean(proxyConfig && /^(clash|phantom)-local$/.test(String(proxyConfig.mode || '')));
}

// 保存提取 API URL 到 proxy.json（保留其余字段；密钥只落盘，不回传渲染层）
function saveExtractUrl(extractUrl) {
  const url = String(extractUrl || '').trim();
  if (!/^https?:\/\//.test(url)) throw new Error('提取 API URL 必须以 http(s):// 开头');
  proxyConfig = { ...proxyConfig, extractUrl: url };
  const file = path.join(app.getAppPath(), 'config', 'proxy.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(proxyConfig, null, 2), 'utf8');
}

// 提取 URL 脱敏：仅保留主机/路径与非敏感 query，username/password 等打码后回传渲染层
function maskExtractUrl(url) {
  if (!url) return '';
  const SAFE_KEYS = new Set(['hostFormat', 'hostPort', 'num', 'region', 'state', 'city', 'sessionType']);
  try {
    const u = new URL(url);
    const parts = [];
    for (const [k, v] of u.searchParams) parts.push(`${k}=${SAFE_KEYS.has(k) ? v : '***'}`);
    return `${u.origin}${u.pathname}?${parts.join('&')}`;
  } catch (e) {
    return `${url.slice(0, 24)}…（已脱敏）`;
  }
}

function defaultExportDir() {
  return path.join(app.getPath('desktop'), 'DolaCookies');
}

// Cookie 导出器：{appConfig.exportDir|桌面}/DolaCookies/{email}.json + 批量合并 all-cookies.json
// 具体逻辑在 main/exporter.js（主进程与 E2E 脚本复用同一份实现）
const exportEnvCookies = makeExporter({
  getDir: () => appConfig.exportDir || path.join(app.getPath('desktop'), 'DolaCookies'),
});

// 账号池统计
function accountStats() {
  const pool = accountStore.list();
  return {
    unused: pool.filter((a) => a.status === 'unused').length,
    inProgress: pool.filter((a) => a.status === 'in_progress').length,
    used: pool.filter((a) => a.status === 'used').length,
    failed: pool.filter((a) => a.status === 'failed').length,
    total: pool.length,
  };
}

// 不可重试的注册错误（卡密本身的问题，换 IP 没用）；预算耗尽也绝不重试
function isRetryableRegisterError(err) {
  if (err && err.code === 'BUDGET_EXHAUSTED') return false;
  const msg = String(err.message || '');
  return !(/找不到账号|密码错误|2 步验证/.test(msg));
}

function registerIpc() {
  // 向渲染层推送事件
  function sendToRenderer(channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  // ---------- 自绘标题栏：窗口控制 ----------
  ipcMain.on('win:minimize', () => { if (win) win.minimize(); });
  ipcMain.on('win:maximize', () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
  });
  ipcMain.on('win:close', () => { if (win) win.close(); });
  ipcMain.handle('win:isMaximized', () => (win ? win.isMaximized() : false));
  // 最大化状态变化时通知渲染层切换图标
  const emitMax = () => { if (win && !win.isDestroyed()) win.webContents.send('win:maximized', win.isMaximized()); };
  app.on('browser-window-maximize', emitMax);
  app.on('browser-window-unmaximize', emitMax);

  // ---------- 配置 ----------
  ipcMain.handle('config:get', () => ({
    concurrency: appConfig.concurrency,
    exportDir: appConfig.exportDir,
    exportDirDefault: defaultExportDir(),
    maxExtractBudget: appConfig.maxExtractBudget,
    headless: appConfig.headless,
    keepOpenAfterRegister: appConfig.keepOpenAfterRegister,
    facebookConfigured: Boolean(appConfig.facebook && appConfig.facebook.email && appConfig.facebook.password),
    proxy: {
      configured: Boolean(proxyConfig.extractUrl) || isPhantomLocalMode(),
      mode: isPhantomLocalMode() ? String(proxyConfig.mode) : 'gateway',
      extractUrlMasked: maskExtractUrl(proxyConfig.extractUrl),
      googleProxy: proxyConfig.googleProxy || '',
      region: proxyConfig.region || 'HK',
      extractBudget: proxyConfig.extractBudget || null,
    },
    accountStats: accountStats(),
    batchRunning: Boolean(batchRunner && batchRunner.running),
  }));

  // config:save：并发数/导出目录/预算上限写 app.json；传 extractUrl 时写 proxy.json（密钥不回传）
  ipcMain.handle('config:save', (e, patch = {}) => {
    if (patch.concurrency !== undefined) {
      const n = Math.floor(Number(patch.concurrency));
      // -1=无上限；1~999 有限并发
      if (!(n === -1 || (n >= 1 && n <= 999))) throw new Error('并发数需为 -1（无上限）或 1~999');
      appConfig.concurrency = n;
    }
    if (patch.exportDir !== undefined) appConfig.exportDir = String(patch.exportDir || '').trim();
    if (patch.maxExtractBudget !== undefined) {
      const mb = Number(patch.maxExtractBudget);
      // -1=无上限；0=自动；>0=硬上限（与 normalizeAppConfig 同一规则）
      appConfig.maxExtractBudget = !Number.isFinite(mb) ? 0 : (mb < 0 ? -1 : Math.floor(mb));
    }
    if (patch.headless !== undefined) appConfig.headless = Boolean(patch.headless);
    if (patch.keepOpenAfterRegister !== undefined) appConfig.keepOpenAfterRegister = Boolean(patch.keepOpenAfterRegister);
    // 联动互斥：开隐身自动关保留窗口（隐身模式看不到保留的窗口）
    if (patch.headless === true) appConfig.keepOpenAfterRegister = false;
    normalizeAppConfig();
    saveAppConfig();
    if (patch.extractUrl !== undefined && String(patch.extractUrl).trim() !== '') {
      saveExtractUrl(patch.extractUrl);
    }
    return { ok: true, config: { concurrency: appConfig.concurrency, exportDir: appConfig.exportDir, maxExtractBudget: appConfig.maxExtractBudget } };
  });

  // ---------- 首次使用向导 ----------
  // 首次判定：未配置提取 API 或账号池为空（DBK_FORCE_SETUP=1 可强制弹出，用于演示/回归）
  ipcMain.handle('setup:status', () => {
    const stats = accountStats();
    // 直连模式（Phantom 本地端口）无需提取 API：视为已配置，不再强制走向导
    const hasExtractUrl = Boolean(proxyConfig.extractUrl) || isPhantomLocalMode();
    const hasAccounts = stats.total > 0;
    return {
      needSetup: (!hasExtractUrl || !hasAccounts) || process.env.DBK_FORCE_SETUP === '1',
      hasExtractUrl,
      hasAccounts,
      accountStats: stats,
      concurrency: appConfig.concurrency,
    };
  });

  // 向导卡密粘贴导入：逐行校验（有效/重复/格式错），有效才落库
  ipcMain.handle('account:importText', (e, { text }) => {
    const lines = String(text || '').split(/\r?\n/).map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#') && !s.startsWith('//'));
    const known = new Set(accountStore.list().map((a) => a.email));
    const seen = new Set();
    let valid = 0;
    let duplicates = 0;
    const invalid = [];
    for (const line of lines) {
      const parts = line.split(/----|\t|\s{2,}|\s/).map((s) => s.trim()).filter(Boolean);
      if (!(parts.length >= 2 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parts[0]))) {
        invalid.push(line.slice(0, 60));
        continue;
      }
      if (seen.has(parts[0]) || known.has(parts[0])) { duplicates += 1; continue; }
      seen.add(parts[0]);
      valid += 1;
    }
    let added = 0;
    if (valid > 0) {
      const r = accountStore.importFromText(text);
      added = r.added;
    }
    return { ok: true, total: lines.length, valid, duplicates, invalid, added, poolTotal: accountStore.list().length };
  });

  // nexip 提取测试：真实提取 1 次（消耗 1 次配额，UI 明确提示）+ 出口 IP/归属地检测
  ipcMain.handle('setup:testNexip', async () => {
    if (!proxyConfig.extractUrl) throw new Error('请先填写并保存提取 API URL');
    const proxy = await proxyService.extractStickyProxy(proxyConfig, { region: proxyConfig.region || 'HK' });
    const t = await proxyService.testProxy(proxy);
    return {
      ok: true,
      ip: t.ip,
      country: t.country,
      region: t.region,
      city: t.city,
      isp: t.isp,
      usage: proxyService.getExtractUsage(),
    };
  });

  // Google 专线检测：探 Clash generate_204（0 提取配额），失败给指引文案
  ipcMain.handle('setup:testGoogleLine', async () => {
    try {
      const r = await proxyService.probeGoogleLine(proxyConfig.googleProxy);
      return { ok: true, host: r.host };
    } catch (err) {
      return {
        ok: false,
        error: String(err.message || err).slice(0, 160),
        hint: '请启动 Clash 并确认混合端口 7897 已监听；若仍失败，检查订阅节点是否可用。可跳过（批量开始时会自动再检，失败不启动批量）。',
      };
    }
  });

  // 链路体检：Clash 线路 → 隧道 CONNECT → 出口归属 → Dola 可达（仅消耗 1 次提取；
  // Clash 挂了直接短路返回，不浪费提取额度。用于开始批量前预检，避免整批撞进故障窗口）
  ipcMain.handle('chain:check', async () => {
    const steps = [];
    // 直连模式（Phantom 本地端口）：无提取/分流链路，浏览器启动时由 batchRunner 做出口探测即可
    if (isPhantomLocalMode()) {
      const bp = proxyConfig.browserProxy || {};
      steps.push({ ok: true, text: `直连模式（Phantom 本地混合端口 ${bp.host || '127.0.0.1'}:${bp.port || 65533}），无提取/分流链路` });
      return { ok: true, hk: true, direct: true, steps, usage: proxyService.getExtractUsage() };
    }
    // ① Clash 线路（0 提取）
    try {
      const g = await proxyService.probeGoogleLine(proxyConfig.googleProxy);
      steps.push({ ok: true, text: `Clash 线路连通（generate_204=204，经 ${g.host}）` });
    } catch (err) {
      steps.push({ ok: false, text: `Clash 线路不通：${String(err.message || err).slice(0, 140)}（请启动 Clash 并确认 7897 端口）` });
      return { ok: false, steps, usage: proxyService.getExtractUsage() };
    }
    // ② 提取一次 → 隧道 CONNECT → 出口归属
    if (!proxyConfig.extractUrl) {
      steps.push({ ok: false, text: '未配置提取 API（config/proxy.json）' });
      return { ok: false, steps, usage: proxyService.getExtractUsage() };
    }
    try {
      const cand = await proxyService.extractStickyProxy(proxyConfig, { region: proxyConfig.region || 'HK' });
      const t = await proxyService.testProxy(cand);
      // 归属地校验按配置地区动态取正则（与 screenStickyExit 同源 REGION_EXIT_RE）：无正则的地区不判归属 warn
      const regKey = String(proxyConfig.region || 'HK').toLowerCase();
      const geoRe = proxyService.REGION_EXIT_RE[regKey] || null;
      const isExpectedRegion = geoRe ? geoRe.test(`${t.country}${t.region}${t.city}`) : null; // null=该地区无校验正则，不判 warn
      const geoWarn = isExpectedRegion === false ? ` ⚠️ 出口非期望地区（期望 ${regKey.toUpperCase()}，实际 ${t.country} ${t.region}），重跑一次体检换 IP` : '';
      steps.push({ ok: true, warn: isExpectedRegion === false, text: `隧道 CONNECT 通过，出口 ${t.ip}（${t.country} ${t.city} · ${t.isp}）${geoWarn}` });
      // ③ 该出口访问 Dola
      const dola = await proxyService.probeDolaExit(cand);
      steps.push({ ok: true, text: `Dola 可达（HTTP ${dola.status}）` });
      // hk 字段为历史命名（渲染层未直接使用），语义=出口归属符合配置地区，保留字段名兼容外部调用
      return { ok: true, hk: isExpectedRegion !== false, exit: { ip: t.ip, country: t.country, city: t.city, isp: t.isp }, dola: dola.status, steps, usage: proxyService.getExtractUsage() };
    } catch (err) {
      steps.push({ ok: false, text: `隧道/出口失败：${String(err.message || err).slice(0, 160)}` });
      return { ok: false, steps, usage: proxyService.getExtractUsage() };
    }
  });

  // ---------- 账号库 ----------
  ipcMain.handle('account:stats', () => accountStats());

  ipcMain.handle('account:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '导入账号卡密文件',
      filters: [{ name: '文本', extensions: ['txt', 'csv'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths.length) return { ok: false, canceled: true };
    const text = fs.readFileSync(filePaths[0], 'utf8');
    const r = accountStore.importFromText(text);
    return { ok: true, total: r.total, added: r.added, skipped: r.skipped, ...accountStats() };
  });

  ipcMain.handle('account:list', () => ({ accounts: accountStore.list() }));

  ipcMain.handle('account:remove', (e, { email }) => {
    accountStore.remove(String(email || '').trim());
    return { ok: true };
  });

  // 失败账号：重置为未用（重新参与批量）/ 直接清除
  ipcMain.handle('account:reset-failed', () => ({ ok: true, reset: accountStore.resetFailed() }));
  ipcMain.handle('account:clear-failed', () => ({ ok: true, removed: accountStore.clearFailed() }));

  // ---------- 环境管理（保留旧 IPC，兼容单号注册与调试） ----------
  ipcMain.handle('env:list', () => ({
    envs: store.list(),
    running: launcher.listRunning(),
  }));

  ipcMain.handle('env:create', (e, { name }) => store.create(name));
  ipcMain.handle('env:rename', (e, { envId, name }) => store.update(envId, { name }));
  ipcMain.handle('env:delete', async (e, { envId }) => {
    // 运行中/残留运行状态：先自动关闭再删，避免"删不掉"
    if (launcher.isRunning(envId)) await launcher.closeEnv(envId);
    store.remove(envId);
    return { ok: true };
  });

  ipcMain.handle('fingerprint:randomize', (e, { envId }) => {
    const env = store.update(envId, { fingerprint: randomFingerprint() });
    return env;
  });

  ipcMain.handle('proxy:fetch', async (e, { envId }) => {
    const proxy = await proxyService.extractProxy(proxyConfig);
    store.update(envId, { proxy, proxyTest: null });
    return proxy;
  });

  ipcMain.handle('proxy:test', async (e, { envId }) => {
    const env = store.get(envId);
    const result = await proxyService.testProxy(env.proxy);
    store.update(envId, { proxyTest: result });
    return result;
  });

  ipcMain.handle('proxy:clear', (e, { envId }) => {
    store.update(envId, { proxy: null, proxyTest: null });
    return { ok: true };
  });

  // ---------- 单号注册（调试用，走已存在环境） ----------
  // Dola：全自动注册【验证即换牌：人机验证/未识别页 → 立即换 IP+指纹重试，不等人工】
  ipcMain.handle('register:dola', async (e, { envId }) => {
    const env = store.get(envId);
    if (!env) throw new Error('环境不存在');

    const account = accountStore.claim(envId);
    const MAX_ATTEMPTS = 5;
    let lastErr = null;
    let consecutiveNetworkFails = 0;
    let switchIp = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        sendToRenderer('register:progress', { envId, step: `第 ${attempt}/${MAX_ATTEMPTS} 轮：准备环境`, running: true });

        if (attempt > 1) {
          if (switchIp) {
            try {
              // 验证即换牌 = 换 IP + 换指纹：Google 会将失败尝试与指纹关联
              store.update(envId, { fingerprint: randomFingerprint() });
              const proxy = await proxyService.screenStickyExit(proxyConfig, {
                region: proxyConfig.region || 'HK',
                maxAttempts: 3,
                googleProxy: proxyService.parseGoogleProxy(proxyConfig.googleProxy),
                onAttempt: (i, msg) => sendToRenderer('register:progress', { envId, step: `[预筛${i}] ${msg}`, running: true }),
              });
              store.update(envId, { proxy, proxyTest: proxy.exit });
              sendToRenderer('register:progress', { envId, step: `已换新出口：${proxy.exit.ip}（${proxy.exit.country}）`, running: true });
            } catch (e2) {
              if (e2.code === 'BUDGET_EXHAUSTED') throw e2;
              sendToRenderer('register:progress', { envId, step: `换 IP 失败（${e2.message.slice(0, 40)}），用现有配置重试`, running: true });
            }
          } else {
            sendToRenderer('register:progress', { envId, step: '网络慢：不换 IP，直接重试', running: true });
          }
        }

        // 换 IP 时重开环境进程（干净状态）；同 IP 网络重试则复用已开的浏览器
        if (switchIp || !launcher.isRunning(envId)) {
          if (launcher.isRunning(envId)) await launcher.closeEnv(envId);
          const freshEnv = store.get(envId);
          await launcher.launchEnv(freshEnv, store.profilesDir);
          store.update(envId, { lastUsedAt: new Date().toISOString(), pendingCookies: null, pendingLocalStorage: null });
          await new Promise((r) => setTimeout(r, 2500));
        }

        const reg = await registerer.registerDola({
          env: store.get(envId),
          account,
          autoMode: true,
          onProgress: (step, detail) => sendToRenderer('register:progress', { envId, step: `[第${attempt}轮] ${step}`, detail, running: true }),
          saveCookies: (email) => exportEnvCookies(store.get(envId), email),
        });

        accountStore.finish(account.email, true, envId);
        let cookieInfo = null;
        try {
          cookieInfo = await exportEnvCookies(store.get(envId), account.email, reg.localStorage);
        } catch (e3) { cookieInfo = { error: e3.message }; }
        sendToRenderer('register:progress', { envId, step: `✅ ${account.email} 注册成功，Cookie 已导出`, running: false });
        return { ok: true, email: account.email, cookieInfo };
      } catch (err) {
        lastErr = err;
        if (err.code === 'BUDGET_EXHAUSTED') {
          sendToRenderer('register:progress', { envId, step: `🛑 ${err.message}`, running: false });
          break;
        }
        const isNetwork = err.code === 'SLOW_NETWORK';
        if (isNetwork) {
          consecutiveNetworkFails += 1;
          switchIp = consecutiveNetworkFails >= 2;
        } else {
          consecutiveNetworkFails = 0;
          switchIp = true;
        }
        if (attempt < MAX_ATTEMPTS && isRetryableRegisterError(err)) {
          sendToRenderer('register:progress', { envId, step: `❌ ${err.message} → ${switchIp ? '换 IP + 换指纹重试' : '同 IP 重试'}`, running: true });
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        break;
      }
    }

    accountStore.finish(account.email, false, envId, String(lastErr && lastErr.message).slice(0, 120));
    sendToRenderer('register:progress', { envId, step: `❌ 注册失败：${lastErr && lastErr.message}`, running: false });
    throw lastErr;
  });

  // ---------- 批量注册（并发引擎装配） ----------
  let batchRunner = null;

  ipcMain.handle('register:batch:stop', () => {
    if (batchRunner) batchRunner.stop();
    return { ok: true };
  });

  // maxCount：本轮最多处理几个账号（0=全部）；shutdownAfter：跑完后 60 秒自动关机（夜间挂机）
  ipcMain.handle('register:batch', (e, { concurrency, maxCount = 0, shutdownAfter = false } = {}) => {
    if (batchRunner && batchRunner.running) throw new Error('批量任务已在运行中');
    // 并发数：-1=无上限（引擎按待注册数开 worker）；1~999 有限并发
    let n = Math.floor(Number(concurrency));
    if (!Number.isFinite(n)) n = appConfig.concurrency || 8;
    n = n < 0 ? -1 : Math.min(999, Math.max(1, n));
    // FB 流程（直连模式）：fbAccount 透传给 BatchRunner → registerDolaViaFacebook
    const directMode = isPhantomLocalMode();
    const fb = appConfig.facebook;
    batchRunner = new BatchRunner({
      store,
      accountStore,
      proxyConfig,
      launcher,
      registerer,
      proxyService,
      exportCookies: exportEnvCookies,
      emit: sendToRenderer,
      concurrency: n,
      maxCount: Math.max(0, Math.floor(Number(maxCount) || 0)),
      headless: appConfig.headless,
      keepOpenAfterRegister: appConfig.keepOpenAfterRegister,
      region: proxyConfig.region || 'HK',
      // 直连模式无分流线路：不传 googleProxy（跳过探活）
      googleProxy: directMode ? null : proxyService.parseGoogleProxy(proxyConfig.googleProxy),
      maxExtractBudget: appConfig.maxExtractBudget,
      fbAccount: (fb && fb.email && fb.password) ? { email: fb.email, password: fb.password } : null,
    });
    batchRunner.start().then(() => {
      // 夜间挂机：整批正常跑完（非手动停止）后 60 秒自动关机；取消用 shutdown /a
      if (shutdownAfter && !batchRunner._stopped) {
        sendToRenderer('setup:progress', { message: '🛑 批量完成，60 秒后自动关机（取消请运行 shutdown /a）' });
        const { execFile } = require('child_process');
        execFile('shutdown', ['/s', '/t', '60'], () => {});
      }
    }).catch((err) => {
      // 引擎级意外异常（如 Google 探活前抛错）：如实上报 done，不伪造成功
      sendToRenderer('batch:done', {
        ok: [],
        fail: [{ email: '-', reason: `批量引擎异常：${String(err.message || err).slice(0, 120)}` }],
        stopped: false,
        error: String(err.message || err).slice(0, 160),
      });
    });
    return { ok: true, started: true, concurrency: n, headless: appConfig.headless };
  });

  // ---------- 启动/关闭环境（调试） ----------
  ipcMain.handle('env:launch', async (e, { envId }) => {
    const env = store.get(envId);
    if (!env) throw new Error('环境不存在');
    // 兼容旧数据：socks5+认证 Chromium 不支持，启动前探测降级到 http
    if (env.proxy && env.proxy.protocol === 'socks5' && env.proxy.username) {
      const fixed = await proxyService.probeProtocol(env.proxy);
      if (fixed.protocol !== env.proxy.protocol) store.update(envId, { proxy: fixed });
      env.proxy = fixed;
    }
    await launcher.launchEnv(env, store.profilesDir);
    store.update(envId, { lastUsedAt: new Date().toISOString(), pendingCookies: null, pendingLocalStorage: null });
    return { ok: true };
  });

  ipcMain.handle('env:close', async (e, { envId }) => {
    await launcher.closeEnv(envId);
    return { ok: true };
  });

  // Cookie 导出（手动）：环境必须运行中
  ipcMain.handle('cookie:export', async (e, { envId }) => {
    const cookies = await launcher.exportCookies(envId);
    const env = store.get(envId);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: '导出 Cookie',
      defaultPath: `${env ? env.name : 'env'}-cookies.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, JSON.stringify(cookies, null, 2), 'utf8');
    return { ok: true, count: cookies.length, filePath };
  });

  // Cookie 导入：运行中直接注入，未运行则暂存到下次启动
  ipcMain.handle('cookie:import', async (e, { envId }) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '导入 Cookie',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths.length) return { ok: false, canceled: true };
    const raw = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    const env = store.get(envId);
    const result = await launcher.importCookies(env, raw);
    if (!result.applied) store.update(envId, { pendingCookies: result.pending, pendingLocalStorage: result.pendingLocalStorage || null });
    return { ok: true, applied: result.applied, count: result.count };
  });

  // 代理配置状态（旧 IPC 保留）
  ipcMain.handle('config:proxy', () => ({
    configured: Boolean(proxyConfig.extractUrl),
    protocol: proxyConfig.protocol || 'socks5',
  }));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#0d0f14',
    autoHideMenuBar: true,
    frame: false, // 自绘深色标题栏，与界面一体
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  loadProxyConfig();
  loadAppConfig();
  store = new EnvStore(app.getPath('userData'));
  accountStore = new AccountStore(app.getPath('userData'));
  // 断点续跑基础：上次异常退出（断电/强杀/崩溃）遗留的 in_progress 僵尸账号自动释放回可用
  const recovered = accountStore.recoverStuck();
  registerIpc();
  createWindow();
  if (recovered > 0) {
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('setup:progress', { message: `🔄 检测到上次中断，已自动重置 ${recovered} 个账号为可用，可直接继续批量注册` });
    });
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // 退出前关闭所有环境浏览器
  const ids = launcher.listRunning();
  Promise.all(ids.map((id) => launcher.closeEnv(id))).finally(() => {
    if (process.platform !== 'darwin') app.quit();
  });
});

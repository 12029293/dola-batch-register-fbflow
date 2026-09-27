// launcher.js · 浏览器启动器：Playwright 持久化上下文 + 指纹注入 + 代理挂载
'use strict';

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { buildInitScript, buildUAMetadata } = require('./fingerprint');
const { startForwarder } = require('./forwarder');
const { tunnelViaFromConfig } = require('./proxy');

const DOUBAO_URL = 'https://www.doubao.com/chat/';
const DOLA_URL = 'https://www.dola.com/chat/';

// envId -> { context, homeUrl }
const running = new Map();

// 读取 config/proxy.json 的 googleProxy（Google 分流线路，如 Clash http://127.0.0.1:7897），
// 解析为 { host, port }。未配置/解析失败返回 null（转发器自动退化为 nexip 单上游）。
let googleUpstreamCache;
function loadGoogleUpstream() {
  if (googleUpstreamCache !== undefined) return googleUpstreamCache;
  googleUpstreamCache = null;
  try {
    const file = path.join(__dirname, '..', 'config', 'proxy.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cfg && cfg.googleProxy) {
      const u = new URL(cfg.googleProxy);
      const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
      if (u.hostname && port > 0) googleUpstreamCache = { host: u.hostname, port };
    }
  } catch (e) { /* 配置缺失时静默退化为单上游 */ }
  return googleUpstreamCache;
}

// 读取 config/proxy.json 的链式中转配置：provider=iplist（udealproxy）或显式 tunnelViaClash=true 时，
// 隧道连接须经本地分流线路（Clash）中转（隧道拒绝大陆来源 IP，直连必 602）。
// 返回 { host, port }（来自 googleProxy 解析，不含认证）；未启用/解析失败返回 null（转发器退化为直连隧道）。
let tunnelViaCache;
function loadTunnelVia() {
  if (tunnelViaCache !== undefined) return tunnelViaCache;
  tunnelViaCache = null;
  try {
    const file = path.join(__dirname, '..', 'config', 'proxy.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    tunnelViaCache = tunnelViaFromConfig(cfg);
  } catch (e) { /* 配置缺失时退化为直连 */ }
  return tunnelViaCache;
}

// 页面是否渲染完整：CSS 已应用且有可交互元素（随机出口代理常把 CSS/JS 资源请求弄丢，页面变成无样式裸 HTML）
async function pageReady(page) {
  return page.evaluate(() => {
    try {
      const styled = Array.from(document.styleSheets).some((s) => {
        try { return s.cssRules && s.cssRules.length > 0; } catch (e) { return false; }
      });
      if (!styled) return false;
      return document.querySelector('button, [role="button"], a[href]') !== null;
    } catch (e) { return false; }
  }).catch(() => false);
}

async function launchEnv(env, profilesDir, { headless = false } = {}) {
  if (running.has(env.id)) throw new Error('该环境已在运行中');
  if (!env.fingerprint) throw new Error('该环境没有指纹数据');
  const fp = env.fingerprint;

  const launchOpts = {
    // headless=true：批量注册在后台隐身跑（软件内注册，不弹浏览器窗口）
    headless,
    viewport: { width: fp.viewport.width, height: fp.viewport.height },
    userAgent: fp.userAgent,
    // 固定 en-US：Google 按 Accept-Language 决定 OAuth 页面语言，实测会出印尼语页（Lanjutkan/Batalkan），
    // 中文/英文状态机识别不了即误判换 IP；en-US 页面全被状态机覆盖。指纹注入 langs 已同步 en-US 保持一致。
    locale: 'en-US',
    timezoneId: fp.timezoneId || 'Asia/Shanghai',
    args: [
      '--disable-blink-features=AutomationControlled',
      // WebRTC 防泄漏：挂代理时禁止非代理 UDP，防止真实 IP 从 WebRTC 泄漏
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--no-first-run',
      '--no-default-browser-check',
      '--lang=zh-CN',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  };

  let forwarderRef = null;
  if (env.proxy && env.proxy.host) {
    // 本地认证转发器（双上游分流）：浏览器挂免认证的 127.0.0.1 端口，本模块代发认证。
    // Google 系域名 → 分流线路（config.googleProxy，如 Clash）；其余 → 出口隧道；Clash 拨号失败自动回隧道兜底。
    // 链式中转（via）：提取结果自带 via 时优先，否则按 config（provider=iplist / tunnelViaClash）启用；
    // 带 via 时所有对隧道的拨号（含 Google 兜底）均经 Clash 中转。
    const fw = await startForwarder({
      upstream: {
        host: env.proxy.host,
        port: env.proxy.port,
        username: env.proxy.username || '',
        password: env.proxy.password || '',
        via: env.proxy.via || loadTunnelVia() || undefined,
      },
      googleUpstream: loadGoogleUpstream(),
    });
    forwarderRef = fw;
    launchOpts.proxy = { server: `http://127.0.0.1:${fw.port}` };
  }

  const context = await chromium.launchPersistentContext(
    path.join(profilesDir, env.id),
    launchOpts,
  );

  // 指纹注入脚本：对所有后续页面生效
  await context.addInitScript(buildInitScript(fp));

  // 待导入 Cookie（环境未运行时导入的）：启动后立即写入
  if (Array.isArray(env.pendingCookies) && env.pendingCookies.length) {
    try {
      await context.addCookies(env.pendingCookies);
    } catch (e) { /* Cookie 异常不阻断启动 */ }
  }

  // 待导入 localStorage（Dola 登录态）：通过 init 脚本在首次页面加载时写入（仅限目标站点域名）
  if (Array.isArray(env.pendingLocalStorage) && env.pendingLocalStorage.length) {
    await context.addInitScript((items) => {
      try {
        if (!/^(www\.)?(dola|doubao)\.com$/.test(location.hostname)) return;
        if (localStorage.getItem('__dbk_ls_applied__')) return;
        for (const it of items) { try { localStorage.setItem(it.k, it.v); } catch (e) { /* 忽略 */ } }
        localStorage.setItem('__dbk_ls_applied__', '1');
      } catch (e) { /* 忽略 */ }
    }, env.pendingLocalStorage);
  }

  const homeUrl = env.homeUrl || DOUBAO_URL;
  const page = context.pages()[0] || (await context.newPage());

  // CDP 全量 UA-CH 覆写：UA 串、Accept-Language、Client Hints 元数据三者强制同源。
  // Chromium 的 Sec-CH-UA* 头与 navigator.userAgentData 由 userAgentMetadata 驱动，
  // 只在 launchOpts 改 UA 串时 Client Hints 仍按真实内核（Chromium 130）上报——与 UA 串矛盾即风控特征。
  // 对初始页导航前生效 + 监听后续弹窗页（OAuth 可能开新窗口）。
  const uaMetadata = buildUAMetadata(fp);
  const applyUaOverride = async (p) => {
    try {
      const cdp = await context.newCDPSession(p);
      await cdp.send('Network.setUserAgentOverride', {
        userAgent: fp.userAgent,
        acceptLanguage: 'en-US',
        platform: 'Win32',
        userAgentMetadata: uaMetadata,
      });
    } catch (e) { /* 页面/会话已关闭：静默 */ }
  };
  await applyUaOverride(page);
  context.on('page', (p) => { applyUaOverride(p); });

  // 首页加载自愈：最多 3 次尝试；加载后检查渲染完整性，样式丢失（资源被代理掉）自动重载
  // 注意：必须挂 .catch——页面/浏览器中途关闭时 waitForTimeout 会抛错，未处理的 rejection 会击杀主进程
  (async () => {
    for (let i = 0; i < 3; i += 1) {
      try {
        await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(6000);
        if (await pageReady(page)) return;
      } catch (e) { /* 导航超时/页面已关闭，继续下一轮 */ }
      try {
        await page.waitForTimeout(2000);
      } catch (e) { return; /* 页面已关闭：自愈流程终止 */ }
    }
  })().catch(() => {});

  running.set(env.id, { context, homeUrl, forwarder: forwarderRef });
  context.on('close', () => {
    running.delete(env.id);
    if (forwarderRef) forwarderRef.close().catch(() => {});
  });
  return { ok: true };
}

const CLOSE_GUARD_MS = 10000; // close 单步超时兜底：浏览器异常死亡后 close 会无限挂，超时后强杀进程
function closeGuard(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function closeEnv(envId) {
  const r = running.get(envId);
  if (!r) return false;
  // 先摘除运行表：close 挂死也不阻塞后续启动同名环境/批量流程
  running.delete(envId);
  // context.close()：浏览器进程已异常死亡时会无限挂——超时后直接 SIGKILL chromium 子进程兜底
  let contextClosed = false;
  await Promise.race([
    r.context.close().then(() => { contextClosed = true; }).catch(() => { contextClosed = true; }),
    closeGuard(CLOSE_GUARD_MS).then(() => {
      if (!contextClosed) {
        try {
          const browser = r.context.browser();
          const proc = browser && browser.process();
          if (proc) proc.kill('SIGKILL');
        } catch (e) { /* 进程可能已不存在 */ }
      }
    }),
  ]);
  // forwarder.close()：已改主动断开全部连接（forwarder.js），此处再挂超时兜底双保险
  if (r.forwarder) {
    await Promise.race([
      r.forwarder.close().catch(() => {}),
      closeGuard(CLOSE_GUARD_MS),
    ]);
  }
  return true;
}

function isRunning(envId) {
  return running.has(envId);
}

// 取运行中的 Playwright context（供注册驱动器复用环境浏览器）
function getRunningContext(envId) {
  return running.get(envId) || null;
}

function listRunning() {
  return [...running.keys()];
}

// 导出当前运行环境的全部 Cookie
async function exportCookies(envId) {
  const r = running.get(envId);
  if (!r) throw new Error('环境未运行，无法导出 Cookie（请先启动）');
  return r.context.cookies();
}

// 向运行中的环境导入 Cookie；环境未运行则存为待导入
// 兼容三种格式：纯数组 / {cookies:[...]} / {cookies, localStorage}（Dola 登录态需要 localStorage）
async function importCookies(env, cookies) {
  let arr = cookies;
  let ls = null;
  if (!Array.isArray(cookies) && cookies && Array.isArray(cookies.cookies)) {
    arr = cookies.cookies;
    if (Array.isArray(cookies.localStorage)) ls = cookies.localStorage;
  }
  const normalized = normalizeCookies(arr);
  if (!normalized.length) throw new Error('文件中没有可识别的 Cookie');
  const r = running.get(env.id);
  if (r) {
    await r.context.addCookies(normalized);
    if (ls && ls.length) {
      for (const p of r.context.pages()) {
        if (/dola\.com|doubao\.com/.test(p.url())) {
          await p.evaluate((items) => {
            for (const it of items) { try { localStorage.setItem(it.k, it.v); } catch (e) { /* 忽略 */ } }
          }, ls).catch(() => {});
        }
      }
    }
    await r.context.pages()[0].reload().catch(() => {});
    return { applied: true, count: normalized.length };
  }
  return { applied: false, count: normalized.length, pending: normalized, pendingLocalStorage: ls };
}

// 归一化：兼容 Playwright 数组 / {cookies:[...]} 包装格式
function normalizeCookies(input) {
  let arr = input;
  if (!Array.isArray(arr) && arr && Array.isArray(arr.cookies)) arr = arr.cookies;
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((c) => c && c.name && (c.value !== undefined) && (c.domain || c.url))
    .map((c) => ({
      name: c.name,
      value: String(c.value),
      domain: c.domain || undefined,
      path: c.path || '/',
      url: c.domain ? undefined : c.url,
      secure: Boolean(c.secure),
      httpOnly: Boolean(c.httpOnly),
      sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax',
      expires: c.expires && c.expires > 0 ? c.expires : undefined,
    }));
}

module.exports = { launchEnv, closeEnv, isRunning, getRunningContext, listRunning, exportCookies, importCookies, pageReady, loadGoogleUpstream, loadTunnelVia, DOUBAO_URL, DOLA_URL };

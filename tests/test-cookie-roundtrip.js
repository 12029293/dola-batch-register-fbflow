// tests/test-cookie-roundtrip.js · Cookie 导出→导入回环测试（用户最终验收标准：导出的东西必须能用）
// 用法：node tests/test-cookie-roundtrip.js [导出文件路径]
// 默认取桌面 DolaCookies/ 下最新的账号导出文件
// 流程：校验导出文件核心字段 → 新建临时环境（未运行态暂存 pendingCookies/pendingLocalStorage）
//       → 启动环境（launcher 自动注入）→ 打开 dola.com → 双语登录态检测（与注册驱动同款标准）
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const EnvStore = require('../main/envStore');
const launcher = require('../main/launcher');

const DOLA_URL = 'https://www.dola.com/chat/';
const CORE = ['sessionid', 'sid_guard'];
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// 找桌面 DolaCookies 下最新的 {email}.json（跳过 all-cookies.json）
function latestExport() {
  const dir = path.join(os.homedir(), 'Desktop', 'DolaCookies');
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'all-cookies.json')
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (!files.length) throw new Error(`桌面 DolaCookies 下没有导出文件`);
  return path.join(dir, files[0].f);
}

// 双语登录态检测（与 registerer.js 验证逻辑同款：无可见登录按钮 + 无登录引导文案）
async function checkLoggedIn(page) {
  return page.evaluate(() => {
    const t = document.body ? document.body.innerText : '';
    for (const el of document.querySelectorAll('button, [role="button"], a')) {
      const b = (el.innerText || '').trim();
      if ((b === '登录' || b === 'Log in' || b === 'Sign in' || b === 'Sign up') && el.offsetParent !== null) return false;
    }
    if (/登录以解锁|登录即代表|Log in to unlock/i.test(t)) return false;
    return true;
  }).catch(() => false);
}

async function main() {
  const file = process.argv[2] || latestExport();
  log(`导出文件：${file}`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));

  // ---- 1. 导出文件完整性 ----
  const cookies = Array.isArray(raw.cookies) ? raw.cookies : [];
  const ls = Array.isArray(raw.localStorage) ? raw.localStorage : [];
  const corePresent = CORE.filter((n) => cookies.some((c) => c.name === n));
  const now = Date.now() / 1000;
  const expired = cookies.filter((c) => c.expires > 0 && c.expires < now).length;
  console.log(`PASS | 导出文件解析 | Cookie ${cookies.length} 条，localStorage ${ls.length} 条，导出于 ${raw.exportedAt}`);
  if (corePresent.length === CORE.length) {
    console.log(`PASS | 核心登录态字段 | ${CORE.join(' / ')} 全部在（值长度 ${CORE.map((n) => `${n}:${String(cookies.find((c) => c.name === n).value).length}`).join(' ')}）`);
  } else {
    console.log(`FAIL | 核心登录态字段 | 缺少：${CORE.filter((n) => !corePresent.includes(n)).join(', ')}`);
    process.exit(1);
  }
  console.log(`INFO | 过期 Cookie | ${expired} 条（导入时归一化会保留，站点端自行判定）`);

  // ---- 2. 新建临时环境，暂存待注入数据（未运行态）----
  const dataDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'doubao-manager');
  const store = new EnvStore(dataDir);
  const env = store.create(`TMP-Roundtrip-${Date.now() % 10000}`);
  try {
    store.update(env.id, { homeUrl: DOLA_URL, pendingCookies: cookies, pendingLocalStorage: ls });
    log(`临时环境已创建：${env.id}（pendingCookies=${cookies.length}，pendingLocalStorage=${ls.length}）`);

    // ---- 3. 启动环境（launcher 注入 Cookie + localStorage init 脚本）----
    await launcher.launchEnv(store.get(env.id), store.profilesDir);
    store.update(env.id, { pendingCookies: null, pendingLocalStorage: null });
    const running = launcher.getRunningContext(env.id);
    if (!running) throw new Error('环境启动失败');

    // 额外确认 Cookie 真的进了浏览器
    const ctxCookies = await running.context.cookies();
    const coreInCtx = CORE.filter((n) => ctxCookies.some((c) => c.name === n && /dola\.com/i.test(c.domain)));
    if (coreInCtx.length === CORE.length) {
      console.log(`PASS | 注入确认 | 浏览器 Cookie 栈中 ${CORE.join(' / ')} 已就位`);
    } else {
      console.log(`FAIL | 注入确认 | 浏览器 Cookie 栈缺少：${CORE.filter((n) => !coreInCtx.includes(n)).join(', ')}`);
    }

    // ---- 4. 打开 dola.com 验证登录态 ----
    const page = await running.context.newPage();
    await page.goto(DOLA_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(8000);

    // 最多等 60 秒（首页可能自动跳转/弹引导层）
    let loggedIn = false;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      loggedIn = (await checkLoggedIn(page)) && (await new Promise((r) => setTimeout(r, 4000)).then(() => checkLoggedIn(page)));
      if (loggedIn) break;
      await page.waitForTimeout(5000);
    }

    if (loggedIn) {
      // localStorage 注入确认
      const lsApplied = await page.evaluate(() => localStorage.getItem('__dbk_ls_applied__')).catch(() => null);
      console.log(`PASS | 导入回环 | 打开 dola.com 检测到登录态（双语检测两轮一致）${lsApplied ? '，localStorage 注入标记已生效' : ''}`);
      await page.screenshot({ path: path.join(__dirname, '..', 'tmp_shots', 'roundtrip-loggedin.png') }).catch(() => {});
      log('截图：tmp_shots/roundtrip-loggedin.png');
    } else {
      await page.screenshot({ path: path.join(__dirname, '..', 'tmp_shots', 'roundtrip-fail.png') }).catch(() => {});
      console.log('FAIL | 导入回环 | 打开 dola.com 未检测到登录态（截图 tmp_shots/roundtrip-fail.png）');
      process.exitCode = 1;
    }
    await page.close().catch(() => {});
  } finally {
    // ---- 5. 清理临时环境（含 profile）----
    if (launcher.isRunning(env.id)) await launcher.closeEnv(env.id).catch(() => {});
    store.remove(env.id);
    log(`临时环境已清理：${env.id}`);
  }

  console.log(`\n===== 回环测试结束 =====`);
  process.exit(process.exitCode || 0);
}

main().catch((e) => {
  console.error(`[${new Date().toISOString()}] FATAL`, e);
  process.exit(1);
});

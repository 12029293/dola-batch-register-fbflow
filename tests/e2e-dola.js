// tests/e2e-dola.js · Dola 批量注册端到端验证（1 个账号，复刻 main.js runBatch 链路）
// 用法：node tests/e2e-dola.js [IP尝试上限]        → 代理模式（默认强制 HK 粘性出口，每次尝试消耗 nexip 提取 1 次）
//       node tests/e2e-dola.js --direct           → 直连模式（不挂代理，不消耗配额）
// 说明：
//   - 与生产 runBatch 一致：出口预筛强制 HK（提取 → 出口 IP → 归属地校验 → Dola 可达，失败换 sid），无 any 降级
//   - 分流架构：Google 可达性单独探分流线路（config.googleProxy，如 Clash 127.0.0.1:7897，每账号一次），
//     出口侧不探 Google（nexip 网关对 Google 域名网关级 RESET，出口级探测只会误杀健康出口）
//   - 成功产物：桌面 DolaCookies/{email}.json + all-cookies.json（Cookie+localStorage 双导出）
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomFingerprint } = require('../main/fingerprint');
const EnvStore = require('../main/envStore');
const { AccountStore } = require('../main/accountStore');
const proxyService = require('../main/proxy');
const launcher = require('../main/launcher');
const registerer = require('../main/registerer');

const ROOT = path.join(__dirname, '..');
const DIRECT = process.argv.includes('--direct');
const MAX_IP = DIRECT ? 1 : Math.max(1, Number(process.argv[3] || process.argv[2]) || 3);
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// 复刻 main.js exportEnvCookies：Cookie + localStorage 双导出到桌面 DolaCookies/
const CORE = ['sessionid', 'sid_guard'];
async function exportEnvCookies(env, email, localStorage = []) {
  const running = launcher.getRunningContext(env.id);
  if (!running) throw new Error('环境未运行，无法导出 Cookie');
  let cookies = [];
  for (let round = 0; round < 4; round += 1) {
    cookies = (await running.context.cookies()).filter((c) => /dola\.com/i.test(c.domain));
    if (CORE.some((n) => cookies.some((c) => c.name === n))) break;
    if (round < 3) {
      const dolaPage = running.context.pages().find((p) => /dola\.com/.test(p.url()));
      if (dolaPage) {
        await dolaPage.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await dolaPage.waitForTimeout(8000);
      } else {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
  if (!cookies.length) throw new Error('未获取到 dola.com Cookie');
  if (!localStorage.length) {
    const dolaPage = running.context.pages().find((p) => /dola\.com/.test(p.url()));
    if (dolaPage) {
      localStorage = await dolaPage.evaluate(() => {
        const items = [];
        try {
          for (let i = 0; i < localStorage.length; i += 1) {
            const k = localStorage.key(i);
            items.push({ k, v: localStorage.getItem(k) });
          }
        } catch (e) { /* 忽略 */ }
        return items;
      }).catch(() => []);
    }
  }
  const payload = { cookies, localStorage, exportedAt: new Date().toISOString() };
  const dir = path.join(os.homedir(), 'Desktop', 'DolaCookies');
  fs.mkdirSync(dir, { recursive: true });
  const safeName = String(email).replace(/[^a-zA-Z0-9@._-]/g, '_');
  fs.writeFileSync(path.join(dir, `${safeName}.json`), JSON.stringify(payload, null, 2), 'utf8');
  const batchPath = path.join(dir, 'all-cookies.json');
  let batch = [];
  try { batch = JSON.parse(fs.readFileSync(batchPath, 'utf8')); } catch (e) { /* 首次 */ }
  batch = batch.filter((b) => b.email !== email);
  batch.push({ email, ...payload });
  fs.writeFileSync(batchPath, JSON.stringify(batch, null, 2), 'utf8');
  const missingCore = CORE.filter((n) => !cookies.some((c) => c.name === n));
  return { dir, count: cookies.length, lsCount: localStorage.length, missingCore };
}

async function main() {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'proxy.json'), 'utf8'));
  const dataDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'doubao-manager');
  const store = new EnvStore(dataDir);
  const accountStore = new AccountStore(dataDir);

  const account = accountStore.claim('e2e-test');
  log(`🚀 E2E 批量注册开始：${account.email}（${DIRECT ? '直连模式' : `代理模式 · 强制 HK 粘性出口 · IP 尝试上限 ${MAX_IP}`}）`);

  const env = store.create(`E2E-${account.email.split('@')[0]}`);
  store.update(env.id, { homeUrl: launcher.DOLA_URL });
  let success = false;
  let lastMsg = '';
  let result = null;

  for (let ipTry = 1; ipTry <= MAX_IP && !success; ipTry += 1) {
    try {
      log(`━━━ [IP ${ipTry}/${MAX_IP}] 全新指纹 ━━━`);
      store.update(env.id, { fingerprint: randomFingerprint() });

      if (DIRECT) {
        store.update(env.id, { proxy: null, proxyTest: null });
        log('直连模式：不挂代理');
      } else {
        // HK 粘性出口预筛（强制 HK，与生产 runBatch 一致）：提取 → 出口 IP → 归属地校验 → Dola 可达，失败换 sid；
        // Google 可达性单独探分流线路（每账号一次）
        const proxy = await proxyService.screenStickyExit(config, {
          region: config.region || 'HK',
          maxAttempts: 3,
          googleProxy: config.googleProxy || null,
          onAttempt: (i, msg) => log(`  [预筛 HK #${i}] ${msg}`),
        });
        store.update(env.id, { proxy, proxyTest: proxy.exit });
        log(`出口已固定（HK）且可达 Dola：${proxy.exit.ip}（${proxy.exit.country} · ${proxy.exit.isp}）｜region=${proxy.region} sid=${proxy.sid}${proxy.googleLine ? `｜Google 分流线路 ${proxy.googleLine.host}` : ''}`);
      }

      // 启动环境 + 注册
      await launcher.launchEnv(store.get(env.id), store.profilesDir);
      store.update(env.id, { lastUsedAt: new Date().toISOString() });
      await new Promise((r) => setTimeout(r, 2000));

      const reg = await registerer.registerDola({
        env: store.get(env.id),
        account,
        autoMode: true,
        onProgress: (s, d) => log(`  [reg] ${s}${d ? ` | ${String(d).slice(0, 80)}` : ''}`),
        saveCookies: (em) => exportEnvCookies(store.get(env.id), em),
      });

      const ci = await exportEnvCookies(store.get(env.id), account.email, reg.localStorage);
      accountStore.finish(account.email, true, env.id);
      success = true;
      result = { email: account.email, envId: env.id, cookieInfo: ci };
      log(`✅ ${account.email} 成功：Cookie ${ci.count} 条${ci.missingCore.length ? `（⚠️ 缺核心字段：${ci.missingCore.join(', ')}）` : '（含 sessionid/sid_guard）'}，localStorage ${ci.lsCount} 条 → ${ci.dir}`);
    } catch (err) {
      lastMsg = String(err.message || err).slice(0, 150);
      const code = err.code || '';
      log(`❌ [IP ${ipTry}/${MAX_IP}] ${code ? `[${code}] ` : ''}${lastMsg}`);
      if (launcher.isRunning(env.id)) await launcher.closeEnv(env.id).catch(() => {});
      // 清脏 profile（与生产一致：Google 记住失败尝试，复用加重风控）
      try { fs.rmSync(store.profileDir(env.id), { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
      if (ipTry < MAX_IP) {
        log('换 IP + 换指纹重试…');
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  // 收尾：关浏览器 + 清环境（成功保留环境供任务#3 导入回环测试复用账号数据；失败删除）
  if (launcher.isRunning(env.id)) await launcher.closeEnv(env.id).catch(() => {});

  if (!success) {
    accountStore.finish(account.email, false, env.id, lastMsg);
    store.remove(env.id);
    log(`🛑 E2E 失败：${account.email}（${lastMsg}）`);
    process.exit(2);
  }

  log(`🎉 E2E 完成：${JSON.stringify(result)}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(`[${new Date().toISOString()}] FATAL`, e);
  process.exit(1);
});

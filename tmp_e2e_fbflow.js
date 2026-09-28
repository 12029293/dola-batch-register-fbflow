// tmp_e2e_fbflow.js · 单号真实 E2E 监控脚本（新 FB 流程 + Clash 直连）
// 与 batchRunner 直连分支同构：随机指纹 → phantomExitProbe → 无转发器直挂 → registerDolaViaFacebook → 导出
// 账号走 GUI 同一 accounts.json（claim/finish），不产生脏状态。keepOpen=false（headless 无窗口可留）。
'use strict';

const fs = require('fs');
const proxyService = require('./main/proxy');
const EnvStore = require('./main/envStore');
const { AccountStore } = require('./main/accountStore');
const { randomFingerprint } = require('./main/fingerprint');
const launcher = require('./main/launcher');
const registerer = require('./main/registerer');
const { makeExporter } = require('./main/exporter');
const appConfig = require('./config/app.json');

const USER_DATA = 'C:\\Users\\Administrator\\AppData\\Roaming\\doubao-manager';
const EXPORT_DIR = 'C:\\Users\\Administrator\\Desktop\\DolaCookies';
const BROWSER_PROXY = { host: '127.0.0.1', port: 7897 };
const MAX_IP = 3;
const log = (s) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${s}`);

(async () => {
  const store = new EnvStore(USER_DATA);
  const accounts = new AccountStore(USER_DATA);
  const exportCookies = makeExporter({ getDir: () => EXPORT_DIR });
  const env = store.create('E2E-FBMON');
  const account = accounts.claim(env.id);
  log(`已领号：${account.email}（辅助：${account.recovery || '-'}）`);
  let ok = false;
  let lastMsg = '';

  try {
    for (let ipTry = 1; ipTry <= MAX_IP && !ok; ipTry += 1) {
      try {
        store.update(env.id, { fingerprint: randomFingerprint() });
        log(`[第 ${ipTry}/${MAX_IP} 轮] 指纹已刷新，探测本地代理出口…`);
        const probeExit = await proxyService.phantomExitProbe(BROWSER_PROXY, {
          onAttempt: (m) => log(`  · ${m}`),
        });
        log(`出口：${probeExit.ip}（${probeExit.country} ${probeExit.city} · ${probeExit.isp}）tz=${probeExit.tz}${probeExit.warn ? ` ⚠️${probeExit.warn}` : ''}`);
        const proxy = {
          host: BROWSER_PROXY.host,
          port: BROWSER_PROXY.port,
          protocol: 'http',
          noAuth: true,
          region: probeExit.region,
          tz: probeExit.tz,
          warn: probeExit.warn || '',
          exit: { ip: probeExit.ip, country: probeExit.country, region: probeExit.regionName, city: probeExit.city, isp: probeExit.isp },
        };

        if (launcher.isRunning(env.id)) await launcher.closeEnv(env.id);
        try { fs.rmSync(store.profileDir(env.id), { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
        log('启动环境浏览器（headful，直挂本地代理，无转发器）…');
        await launcher.launchEnv(store.get(env.id), store.profilesDir, { headless: false });
        await new Promise((r) => setTimeout(r, 2000));

        const reg = await registerer.registerDolaViaFacebook({
          env: store.get(env.id),
          account,
          fbAccount: appConfig.facebook,
          autoMode: true,
          keepOpen: true,
          onProgress: (s) => log(`  · ${s}`),
          saveCookies: (em) => exportCookies(store.get(env.id), em),
        });
        log(`FB 流程完成（googleBound=${reg.googleBound !== false}），导出 Cookie…`);
        const ci = await exportCookies(store.get(env.id), account.email, reg.localStorage);
        log(`Cookie ${ci.count} 条 · localStorage ${ci.lsCount} 条 · 核心字段缺失: ${ci.missingCore && ci.missingCore.length ? ci.missingCore.join(',') : '无 ✅'}`);
        if (ci.missingCore && ci.missingCore.length) throw Object.assign(new Error('缺核心 Cookie 字段'), { code: 'VERIFY_FAILED' });
        accounts.finish(account.email, true, env.id);
        ok = true;
        log(`✅ E2E 成功：${account.email}（第 ${ipTry} 轮）`);
      } catch (err) {
        lastMsg = String(err.message || err).slice(0, 140);
        const rotate = err.code === 'CAPTCHA' || err.code === 'SLOW_NETWORK' || err.code === 'VERIFY_FAILED';
        log(`❌ [第 ${ipTry} 轮] 失败（code=${err.code || '-'}）：${lastMsg} → ${rotate && ipTry < MAX_IP ? '换指纹重试' : '放弃'}`);
        if (launcher.isRunning(env.id)) await launcher.closeEnv(env.id);
        await new Promise((r) => setTimeout(r, 1000));
        for (let rmTry = 0; rmTry < 3; rmTry += 1) {
          try { fs.rmSync(store.profileDir(env.id), { recursive: true, force: true }); break; } catch (e4) { await new Promise((r) => setTimeout(r, 800)); }
        }
        if (!rotate) break;
        log('轮间冷却 30 秒（给 FB 账号降温）…');
        await new Promise((r) => setTimeout(r, 30000));
      }
    }
  } finally {
    if (!ok) accounts.finish(account.email, false, env.id, lastMsg);
    // keepOpen 模式：成功保留窗口供用户手动测试；失败照常关窗删 profile
    if (launcher.isRunning(env.id) && !ok) await launcher.closeEnv(env.id).catch(() => {});
    log(ok ? '=== E2E 通过（窗口已保留，可手动测试） ===' : `=== E2E 失败：${lastMsg} ===`);
    setTimeout(() => process.exit(ok ? 0 : 1), 500);
  }
})();

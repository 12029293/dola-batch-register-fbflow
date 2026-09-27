// batch_test_headless.js · 端到端验证：粘性 HK 代理 + headless 隐身注册 + 核心 Cookie 导出（1 个账号）
'use strict';

const path = require('path');
const fs = require('fs');

const proxyService = require('./main/proxy');
const EnvStore = require('./main/envStore');
const launcher = require('./main/launcher');
const registerer = require('./main/registerer');
const { makeExporter } = require('./main/exporter');
const config = require('./config/proxy.json');
const account = require('./tmp_account.json');

const DATA_DIR = path.join(__dirname, 'tmp_batchtest');
const exportCookies = makeExporter({ getDir: () => path.join(__dirname, 'tmp_batchtest_out') });
const log = (s) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${s}`);

(async () => {
  const store = new EnvStore(DATA_DIR);
  const env = store.create('HEADLESS-TEST');
  store.update(env.id, { homeUrl: launcher.DOLA_URL });
  let ok = false;
  const MAX_IP = 3;

  for (let ipTry = 1; ipTry <= MAX_IP && !ok; ipTry += 1) {
    try {
      log(`[IP ${ipTry}/${MAX_IP}] 提取粘性 HK 代理…`);
      const proxy = await proxyService.extractStickyProxy(config, { region: 'HK' });
      const t = await proxyService.testProxy(proxy);
      log(`出口：${t.ip}（${t.country} ${t.city} · ${t.isp}）`);
      store.update(env.id, { proxy, proxyTest: t });

      if (launcher.isRunning(env.id)) await launcher.closeEnv(env.id);
      try { fs.rmSync(store.profileDir(env.id), { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
      log('启动环境浏览器（headless 隐身模式）…');
      await launcher.launchEnv(store.get(env.id), store.profilesDir, { headless: true });
      await new Promise((r) => setTimeout(r, 2500));

      const reg = await registerer.registerDola({
        env: store.get(env.id),
        account,
        autoMode: true,
        onProgress: (s) => log(`  · ${s}`),
      });
      log(`注册流程完成，localStorage ${reg.localStorage.length} 条`);

      const ci = await exportCookies(store.get(env.id), account.email, reg.localStorage);
      log(`Cookie ${ci.count} 条 · localStorage ${ci.lsCount} 条 · 核心字段缺失: ${ci.missingCore.length ? ci.missingCore.join(',') : '无 ✅'}`);
      if (ci.missingCore.length === 0) { ok = true; log('✅ 端到端验证通过（headless）'); }
      else { log('⚠️ 注册完成但缺核心 Cookie 字段（不再换 IP）'); break; }
    } catch (err) {
      log(`❌ [IP ${ipTry}] 失败（code=${err.code || '-'}）：${String(err.message).slice(0, 110)}`);
      if (ipTry < MAX_IP) log('换新 IP + 新指纹重试…');
    }
  }

  if (launcher.isRunning(env.id)) await launcher.closeEnv(env.id);
  setTimeout(() => process.exit(ok ? 0 : 1), 500);
})();

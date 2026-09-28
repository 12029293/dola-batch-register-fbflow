// tests/tmp-jp-e2e.js · 临时单号 E2E：验证 JP 出口 + 时区修复后 Google 不再必出人机验证（跑完即删）
// 与 e2e-batch-node.js 同一模块组合，但 concurrency=1、maxCount=1，最多消耗 1 个卡密。
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const EnvStore = require('../main/envStore');
const { AccountStore } = require('../main/accountStore');
const proxyService = require('../main/proxy');
const launcher = require('../main/launcher');
const registerer = require('../main/registerer');
const { makeExporter } = require('../main/exporter');
const { BatchRunner } = require('../main/batchRunner');

const DATA_DIR = path.join(process.env.APPDATA, 'doubao-manager');
const EXPORT_DIR = path.join(os.homedir(), 'Desktop', 'DolaCookies');
const RESULT_FILE = path.join(__dirname, '..', 'tmp_shots', 'tmp-jp-e2e-result.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

(async () => {
  const proxyConfig = readJson(path.join(__dirname, '..', 'config', 'proxy.json'), {});
  if (!proxyConfig.gateway && !proxyConfig.extractUrl) throw new Error('proxy.json 缺 gateway/extractUrl');

  const store = new EnvStore(DATA_DIR);
  const accountStore = new AccountStore(DATA_DIR);
  const exportEnvCookies = makeExporter({ getDir: () => EXPORT_DIR });

  const pendingBefore = accountStore.list().filter((a) => a.status === 'unused').length;
  console.log(`🚀 单号 E2E 启动：region=${proxyConfig.region}，待注册 ${pendingBefore}，maxCount=1`);
  const t0 = Date.now();
  const events = { account: [], stats: [], done: null };

  const runner = new BatchRunner({
    store,
    accountStore,
    proxyConfig,
    launcher,
    registerer,
    proxyService,
    exportCookies: exportEnvCookies,
    concurrency: 1,
    maxCount: 1,
    region: proxyConfig.region || 'HK',
    googleProxy: proxyService.parseGoogleProxy(proxyConfig.googleProxy),
    emit: (event, payload) => {
      if (event === 'batch:account') {
        events.account.push(payload);
        const at = ((Date.now() - t0) / 1000).toFixed(0).padStart(4);
        if (payload.step) console.log(`[${at}s] ${payload.email} :: ${payload.step}`);
      } else if (event === 'batch:done') {
        events.done = payload;
      }
    },
  });

  await runner.start();
  const done = events.done || {};
  const summary = {
    okCount: (done.ok || []).length,
    failCount: (done.fail || []).length,
    failReasons: (done.fail || []).map((x) => x.reason),
    stopped: done.stopped,
    stopReason: done.stopReason,
    elapsedSec: ((Date.now() - t0) / 1000).toFixed(0),
    // 每号的最终 step（含 CAPTCHA 相关字样即视为仍出验证）
    finalSteps: events.account.length
      ? [...new Map(events.account.map((e) => [e.email, e])).values()].map((e) => ({ email: e.email, state: e.state, step: e.step }))
      : [],
  };
  fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
  fs.writeFileSync(RESULT_FILE, JSON.stringify(summary, null, 2), 'utf8');
  console.log('\n===== SUMMARY =====');
  console.log(JSON.stringify(summary, null, 2));
  const captchaHit = summary.finalSteps.some((s) => /人机验证|CAPTCHA/i.test(s.step || ''));
  console.log(captchaHit ? 'RESULT-CAPTCHA-HIT' : 'RESULT-NO-CAPTCHA');
  process.exit(0);
})().catch((e) => {
  console.error('E2E-FAIL', String((e && e.message) || e).slice(0, 300));
  process.exit(1);
});

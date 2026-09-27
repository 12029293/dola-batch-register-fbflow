// tests/e2e-batch-node.js · 真实小批量并发 E2E（纯 Node 装配，不经 Electron）
// 与主进程完全相同的模块组合：EnvStore/AccountStore/launcher/registerer/proxy/exporter/BatchRunner。
// 预算上限读 config/app.json 的 maxExtractBudget（当前 12）。结果落盘 tmp_shots/e2e-result.json。
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

const CONCURRENCY = 3;
const DATA_DIR = path.join(process.env.APPDATA, 'doubao-manager'); // 与 Electron userData 一致
const EXPORT_DIR = path.join(os.homedir(), 'Desktop', 'DolaCookies');
const RESULT_FILE = path.join(__dirname, '..', 'tmp_shots', 'e2e-result.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

(async () => {
  const proxyConfig = readJson(path.join(__dirname, '..', 'config', 'proxy.json'), {});
  // 预算优先取命令行参数（防 app.json 被其他实例回写为 0 的竞态）；-1=无上限，默认 12
  const argBudget = Number(process.argv[2]);
  const appConfig = {
    concurrency: CONCURRENCY,
    maxExtractBudget: Number.isFinite(argBudget) ? (argBudget < 0 ? -1 : Math.floor(argBudget)) : 12,
  };
  if (!proxyConfig.extractUrl) throw new Error('config/proxy.json 缺 extractUrl');

  const store = new EnvStore(DATA_DIR);
  const accountStore = new AccountStore(DATA_DIR);
  const exportEnvCookies = makeExporter({ getDir: () => EXPORT_DIR });

  const pendingBefore = accountStore.list().filter((a) => a.status === 'unused').length;
  console.log(`🚀 E2E 批量启动：并发 ${CONCURRENCY}，待注册 ${pendingBefore}，预算上限 ${appConfig.maxExtractBudget} 次提取`);
  const t0 = Date.now();
  let lastLog = 0;
  const events = { account: [], stats: [], done: null };

  const runner = new BatchRunner({
    store,
    accountStore,
    proxyConfig,
    launcher,
    registerer,
    proxyService,
    exportCookies: exportEnvCookies,
    concurrency: CONCURRENCY,
    region: proxyConfig.region || 'HK',
    googleProxy: proxyService.parseGoogleProxy(proxyConfig.googleProxy),
    maxExtractBudget: appConfig.maxExtractBudget,
    emit: (event, payload) => {
      if (event === 'batch:account') {
        events.account.push({ t: Date.now() - t0, ...payload });
        const key = `${payload.email} → ${payload.state}`;
        const terminal = ['success', 'failed', 'exporting'].includes(payload.state);
        if (terminal || Date.now() - lastLog > 30000) {
          console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${key} ｜ ${String(payload.step || '').slice(0, 100)}`);
          lastLog = Date.now();
        }
      } else if (event === 'batch:stats') {
        events.stats.push({ t: Date.now() - t0, ...payload });
      } else if (event === 'batch:done') {
        events.done = payload;
      }
    },
  });

  await runner.start();
  const done = events.done;
  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`\n========== 批量结束（${elapsed}s）==========`);
  console.log(`成功 ${done.ok.length} · 失败 ${done.fail.length} · stopped=${done.stopped}（${done.stopReason || '-'}）`);
  for (const o of done.ok) console.log(`  ✅ ${o.email} Cookie ${o.cookies} / LS ${o.ls}${o.missingCore.length ? ` ⚠️缺${o.missingCore.join(',')}` : ''}`);
  for (const f of done.fail) console.log(`  ❌ ${f.email} ${f.reason}`);
  if (done.hk) console.log(`HK 出口：成功 ${done.hk.success} / 失败 ${done.hk.fail}${done.hk.lastError ? `，最近错误 ${done.hk.lastError}` : ''}`);
  const usage = proxyService.getExtractUsage();
  console.log(`提取消耗：${usage.used}/${usage.max}`);

  // 核心登录态字段校验
  const exportChecks = [];
  for (const o of done.ok) {
    const file = path.join(EXPORT_DIR, `${o.email.replace(/[^a-zA-Z0-9@._-]/g, '_')}.json`);
    if (!fs.existsSync(file)) { exportChecks.push({ email: o.email, ok: false, error: '导出文件不存在' }); continue; }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const names = new Set((data.cookies || []).map((c) => c.name));
    exportChecks.push({
      email: o.email,
      ok: names.has('sessionid') && names.has('sid_guard'),
      cookies: (data.cookies || []).length,
      localStorage: (data.localStorage || []).length,
      sessionid: names.has('sessionid'),
      sid_guard: names.has('sid_guard'),
    });
  }
  for (const c of exportChecks) {
    console.log(`导出校验 ${c.ok ? '✅' : '⚠️'} ${c.email}: ${JSON.stringify(c)}`);
  }

  const summary = {
    finishedAt: new Date().toISOString(),
    elapsedSec: elapsed,
    concurrency: CONCURRENCY,
    ok: done.ok,
    fail: done.fail,
    stopped: done.stopped,
    stopReason: done.stopReason,
    hk: done.hk,
    extractUsage: usage,
    exportChecks,
    accountStatuses: accountStore.list().map((a) => ({ email: a.email, status: a.status })),
  };
  fs.writeFileSync(RESULT_FILE, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\n结果已写入 ${RESULT_FILE}`);
  process.exit(0);
})().catch((e) => {
  console.error('❌ E2E 失败：', e);
  process.exit(1);
});

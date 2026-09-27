// tests/e2e-ui-batch.js · 真实小批量并发 E2E：并发 3 跑账号池前 3 个未用号，预算上限 12 次提取
// 验证：并发调度、共享预算、batch:account/stats/done 实时上报、成功导出含 sessionid/sid_guard。
// 如实报告成功/失败与出口质量，不伪造结果。
'use strict';

const path = require('path');
const fs = require('fs');
const { _electron } = require('playwright');

const SHOT_DIR = path.join(__dirname, '..', 'tmp_shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const CONCURRENCY = 3;
const DONE_TIMEOUT_MS = 25 * 60 * 1000;

(async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DBK_FORCE_SETUP;

  const app = await _electron.launch({ args: ['.'], cwd: path.join(__dirname, '..'), env });
  const win = await app.firstWindow();
  win.setDefaultTimeout(20000);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(1500);

  // 在页面上下文挂事件采集器（contextBridge 暴露的 api 在主世界可见）
  await win.evaluate(() => {
    window.__ev = [];
    window.api.on('batch:account', (d) => window.__ev.push({ t: Date.now(), kind: 'account', d }));
    window.api.on('batch:stats', (d) => window.__ev.push({ t: Date.now(), kind: 'stats', d }));
    window.api.on('batch:done', (d) => window.__ev.push({ t: Date.now(), kind: 'done', d }));
  });

  // 启动批量（并发 3）
  await win.evaluate((n) => window.api.invoke('register:batch', { concurrency: n }), CONCURRENCY);
  console.log(`🚀 批量已启动（并发 ${CONCURRENCY}）`);
  const t0 = Date.now();

  // 轮询进度直到 done
  let done = null;
  let lastReport = 0;
  let shotCount = 0;
  while (!done) {
    if (Date.now() - t0 > DONE_TIMEOUT_MS) throw new Error('批量超时（12 分钟）未结束');
    await new Promise((r) => setTimeout(r, 4000));
    const evs = await win.evaluate(() => window.__ev.splice(0));
    for (const e of evs) {
      if (e.kind === 'account') {
        // 每号状态变化只在终端状态或每 30 秒汇报一次，避免刷屏
        if (['success', 'failed', 'exporting'].includes(e.d.state) || Date.now() - lastReport > 30000) {
          console.log(`[${Math.round((e.t - t0) / 1000)}s] ${e.d.email} → ${e.d.state} ｜ ${String(e.d.step || '').slice(0, 90)}`);
          lastReport = Date.now();
        }
      } else if (e.kind === 'stats') {
        // 静默采集
      } else if (e.kind === 'done') {
        done = e.d;
      }
    }
    // 关键节点截图：有号进入 running 且还没拍过
    const hasRunning = await win.evaluate(() => window.__ev.length >= 0 && document.querySelectorAll('.worker.st-running,.worker.st-screening').length);
    if (hasRunning && shotCount === 0) {
      shotCount += 1;
      await win.screenshot({ path: path.join(SHOT_DIR, 'e2e-01-batch-running.png') });
      console.log('📸 e2e-01-batch-running.png');
    }
  }

  await win.screenshot({ path: path.join(SHOT_DIR, 'e2e-02-batch-done.png') });
  console.log('📸 e2e-02-batch-done.png');
  console.log('\n========== 批量结果 ==========');
  console.log(`成功 ${done.ok.length} 个：`);
  for (const o of done.ok) console.log(`  ✅ ${o.email}  Cookie ${o.cookies} 条 / localStorage ${o.ls} 条${o.missingCore && o.missingCore.length ? `  ⚠️ 缺 ${o.missingCore.join(',')}` : ''}`);
  console.log(`失败 ${done.fail.length} 个：`);
  for (const f of done.fail) console.log(`  ❌ ${f.email}  ${f.reason}`);
  console.log(`停止标记: ${done.stopped}（${done.stopReason || '-'}）`);
  if (done.hk) console.log(`HK 出口质量: 成功 ${done.hk.success} / 失败 ${done.hk.fail}${done.hk.lastError ? `，最近错误 ${done.hk.lastError}` : ''}`);

  // 验证导出文件含核心登录态字段
  const exportDir = path.join(app.getPath('desktop'), 'DolaCookies').replace(/\\/g, '/');
  const results = [];
  for (const o of done.ok) {
    const file = path.join(exportDir, `${o.email.replace(/[^a-zA-Z0-9@._-]/g, '_')}.json`);
    if (!fs.existsSync(file)) { results.push(`❌ ${o.email}：导出文件不存在`); continue; }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const names = new Set((data.cookies || []).map((c) => c.name));
    const hasCore = names.has('sessionid') && names.has('sid_guard');
    results.push(`${hasCore ? '✅' : '⚠️'} ${o.email}：Cookie ${(data.cookies || []).length} 条，localStorage ${(data.localStorage || []).length} 条，sessionid=${names.has('sessionid')}, sid_guard=${names.has('sid_guard')}`);
  }
  console.log('\n========== 导出文件核心字段校验 ==========');
  for (const r of results) console.log(r);

  // 最终 UI 截图（结果区）
  await win.click('#resultTabs button[data-tab="all"]').catch(() => {});
  await win.waitForTimeout(500);
  await win.screenshot({ path: path.join(SHOT_DIR, 'e2e-03-results.png') });
  console.log('📸 e2e-03-results.png');

  await app.close();
  console.log('\nE2E 结束 ✔');
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ E2E 失败：', e);
  process.exit(1);
});

// tests/ui-smoke.js · Electron UI 冒烟：强制首用向导 → 逐步截图 → 完成向导 → 工作台/设置截图
// 运行：node tests/ui-smoke.js（不消耗提取额度：nexip 步只验证已配置态，Google 步可跳过）
'use strict';

const path = require('path');
const fs = require('fs');
const { _electron } = require('playwright');

const SHOT_DIR = path.join(__dirname, '..', 'tmp_shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const shot = async (win, name) => {
  const p = path.join(SHOT_DIR, name);
  await win.screenshot({ path: p });
  console.log(`📸 ${name}`);
  return p;
};

(async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // 防 Electron 退化成纯 Node
  env.DBK_FORCE_SETUP = '1';       // 强制首用向导弹出

  const app = await _electron.launch({
    args: ['.'],
    cwd: path.join(__dirname, '..'),
    env,
  });
  const win = await app.firstWindow();
  win.setDefaultTimeout(15000);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(1500);

  // 1. 向导应自动弹出
  await win.waitForSelector('#wizardOverlay:not(.hidden)', { timeout: 8000 });
  console.log('✅ 首用向导自动弹出');
  await shot(win, 'ui-01-wizard-step1.png');

  // 步骤①：池中已有卡密（本机已有账号），直接下一步
  await win.click('#wizNext');
  await win.waitForTimeout(400);
  await shot(win, 'ui-02-wizard-step2-nexip.png');

  // 步骤②：nexip 已配置态显示脱敏 URL；跳过真实提取（省配额），直接下一步
  const masked = await win.textContent('#setExtractMasked').catch(() => '');
  console.log(`提取 API 脱敏显示：${masked ? '有（已脱敏）' : '无'}`);
  await win.click('#wizNext');
  await win.waitForTimeout(400);

  // 步骤③：Google 专线一键检测（0 提取配额；Clash 未开则显示指引，同样可跳过）
  await win.click('#wizTestGoogle').catch(() => {});
  await win.waitForTimeout(9000);
  await shot(win, 'ui-03-wizard-step3-google.png');
  const googleFb = await win.textContent('#wizGoogleFeedback').catch(() => '');
  console.log(`Google 专线检测结果：${(googleFb || '').slice(0, 80)}`);
  // 无论结果如何都允许跳过继续
  await win.click('#wizSkip');
  await win.waitForTimeout(400);

  // 步骤④：导出目录（保持默认）→ 完成
  await shot(win, 'ui-04-wizard-step4-export.png');
  await win.click('#wizNext');
  await win.waitForTimeout(800);
  await win.waitForSelector('#wizardOverlay.hidden', { state: 'attached', timeout: 8000 });
  console.log('✅ 向导完成并关闭');

  // 2. 工作台渲染
  await win.waitForTimeout(800);
  await shot(win, 'ui-05-workbench.png');
  const pool = await win.textContent('#poolStats');
  console.log(`顶栏账号池统计：${pool.trim()}`);

  // 3. 设置抽屉
  await win.click('#btnSettings');
  await win.waitForSelector('#settingsOverlay:not(.hidden)');
  await win.waitForTimeout(500);
  await shot(win, 'ui-06-settings.png');
  console.log('✅ 设置抽屉打开');

  await app.close();
  console.log('\nUI 冒烟通过 ✔');
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ UI 冒烟失败：', e);
  process.exit(1);
});

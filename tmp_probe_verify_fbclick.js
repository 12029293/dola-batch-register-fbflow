// probe-verify-fbclick.js · 验证修复后的 clickFacebookIcon：点中后应进入 facebook.com 登录页
// 只验证点击命中，不填账号不登录。
'use strict';
const { chromium } = require('playwright');
const { clickFacebookIcon } = require('./main/registerer');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    proxy: { server: 'http://127.0.0.1:65533' },
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    locale: 'en-US',
    timezoneId: 'Asia/Taipei',
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  await page.goto('https://www.dola.com/chat/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(6000);
  await page.evaluate(() => {
    const norm = (s) => (s || '').trim().toLowerCase();
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    for (const el of document.querySelectorAll('button, [role="button"], a')) {
      if (!isVisible(el)) continue;
      const t = norm(el.innerText);
      if (t === 'log in' || t === '登录' || t === '登入' || t === 'sign in') { el.click(); return; }
    }
  });
  for (let i = 0; i < 30; i += 1) {
    const ok = await page.evaluate(() => /continue with google/i.test(document.body ? document.body.innerText : ''));
    if (ok) break;
    await page.waitForTimeout(1000);
  }
  console.log('[modal] open');

  // 挂 popup 监听（点击前），复刻 registerer 的捕获方式
  const popupPromise = ctx.waitForEvent('page', { timeout: 30000 }).catch(() => null);
  const hit = await clickFacebookIcon(page);
  console.log('[click] clickFacebookIcon =>', hit);
  if (!hit) {
    await page.screenshot({ path: 'tmp_shots/probe5-miss.png' });
    console.log('RESULT: MISS');
    await browser.close();
    process.exit(2);
  }
  const popup = await Promise.race([popupPromise, new Promise((r) => setTimeout(() => r(null), 15000))]);
  const target = popup || page;
  for (let i = 0; i < 20; i += 1) {
    const url = target.url();
    if (/facebook\.com/i.test(url)) {
      console.log('[nav]', url.slice(0, 120));
      console.log('RESULT: HIT_FACEBOOK');
      await target.screenshot({ path: 'tmp_shots/probe5-fbpage.png' }).catch(() => {});
      await browser.close();
      process.exit(0);
    }
    await page.waitForTimeout(1500);
  }
  console.log('[nav-fail] 当前 URL:', (popup || page).url().slice(0, 120));
  await page.screenshot({ path: 'tmp_shots/probe5-nonav.png' }).catch(() => {});
  console.log('RESULT: CLICKED_NO_NAV');
  await browser.close();
  process.exit(3);
})().catch((e) => { console.error('PROBE_FAIL:', e.message); process.exit(1); });

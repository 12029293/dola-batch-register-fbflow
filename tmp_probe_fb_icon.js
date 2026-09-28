// probe-fb-icon3.js · 只读探针 v3：dump 登录弹窗最小容器的完整 HTML（含三个圆标）
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');

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
  let ok = false;
  for (let i = 0; i < 30 && !ok; i += 1) {
    ok = await page.evaluate(() =>
      /continue with google|使用 google 登入|透過 google 繼續/i.test(document.body ? document.body.innerText : ''),
    ).catch(() => false);
    if (!ok) await page.waitForTimeout(1000);
  }
  console.log('[modal]', ok);

  const result = await page.evaluate(() => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    // ① 最小弹窗容器：含 Google 文案、宽度 300~900 的最小可见元素
    let best = null;
    for (const el of document.querySelectorAll('div, section, [role="dialog"]')) {
      if (!isVisible(el)) continue;
      if (!/continue with google|使用 google 登入|透過 google 繼續/i.test(el.textContent || '')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 300 || r.width > 900) continue;
      if (!best || r.width * r.height < best._area) { best = el; best._area = r.width * r.height; }
    }
    const modalHtml = best ? (best.outerHTML || '').slice(0, 20000) : 'MODAL_NOT_FOUND';
    // ② 全局搜 outerHTML 含 facebook 的可见小元素
    const fbHits = [];
    for (const el of document.querySelectorAll('*')) {
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 120 || r.height > 120) continue;
      const html = el.outerHTML || '';
      if (/facebook/i.test(html)) fbHits.push({ tag: el.tagName, cls: String(el.className || '').slice(0, 120), rect: `${Math.round(r.width)}x${Math.round(r.height)}`, html: html.slice(0, 800) });
    }
    return { modalHtml, fbHitCount: fbHits.length, fbHits: fbHits.slice(0, 10) };
  });
  fs.writeFileSync('tmp_shots/probe3-result.json', JSON.stringify(result, null, 2), 'utf8');
  console.log('[fb-hit]', result.fbHitCount);
  console.log(result.fbHits.map((h) => `${h.tag} ${h.rect} cls=${h.cls}\n${h.html}\n---`).join('\n'));
  await browser.close();
})().catch((e) => { console.error('PROBE_FAIL:', e.message); process.exit(1); });

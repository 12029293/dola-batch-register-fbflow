// exporter.js · Cookie + localStorage 导出器（供 main.js 与 E2E 脚本复用）
// Dola 登录态在 localStorage，必须连同 localStorage 一起导出，仅 Cookie 恢复不了会话；
// 核心登录态 Cookie（sessionid/sid_guard）：导出前确保出现，未出现时重载 Dola 触发 Set-Cookie。
'use strict';

const path = require('path');
const fs = require('fs');
const launcher = require('./launcher');

/**
 * 生成卡密格式文本块（与 卡密_dola_*.txt 同构）：
 * 头部元信息 + 空行 + 一行 k=v;k=v Cookie 串
 */
function toKamiBlock(email, cookies, exportedAt) {
  const str = cookies.map((c) => `${c.name}=${c.value}`).join(';');
  const utc = new Date(exportedAt).toISOString().replace('T', ' ').slice(0, 19);
  return [
    '商品: dola',
    '订单: -',
    `账号: ${email}`,
    '数量: 1',
    `生成时间(UTC): ${utc}`,
    '----------------------------------------',
    '',
    str,
  ].join('\n');
}

/**
 * @param {() => string} getDir 导出目录（惰性求值；主进程读 appConfig，测试读固定目录）
 * @returns {(env, email, localStorage?) => Promise<{dir, count, lsCount, missingCore}>}
 */
function makeExporter({ getDir }) {
  return async function exportEnvCookies(env, email, localStorage = []) {
    const running = launcher.getRunningContext(env.id);
    if (!running) throw new Error('环境未运行，无法导出 Cookie');
    const CORE = ['sessionid', 'sid_guard'];
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
    // 未显式传 localStorage 时从打开的 Dola 页面抓
    if (!localStorage.length) {
      const dolaPage = running.context.pages().find((p) => /dola\.com/.test(p.url()));
      if (dolaPage) {
        // Storage 对象没有可枚举属性，必须逐 key 读取
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
    const dir = getDir();
    fs.mkdirSync(dir, { recursive: true });
    const safeName = String(email).replace(/[^a-zA-Z0-9@._-]/g, '_');
    fs.writeFileSync(path.join(dir, `${safeName}.json`), JSON.stringify(payload, null, 2), 'utf8');
    // 卡密格式 TXT（k=v;k=v 一行串，可直接粘进 dola-pool 等工具）
    fs.writeFileSync(path.join(dir, `${safeName}.txt`), `${toKamiBlock(email, cookies, payload.exportedAt)}\n`, 'utf8');
    // 批量合并文件
    const batchPath = path.join(dir, 'all-cookies.json');
    let batch = [];
    try { batch = JSON.parse(fs.readFileSync(batchPath, 'utf8')); } catch (e) { /* 首次 */ }
    batch = batch.filter((b) => b.email !== email);
    batch.push({ email, ...payload });
    fs.writeFileSync(batchPath, JSON.stringify(batch, null, 2), 'utf8');
    // 批量卡密 TXT：由合并 JSON 全量重生成（免去按块去重）
    fs.writeFileSync(
      path.join(dir, 'all-cookies.txt'),
      batch.map((b) => toKamiBlock(b.email, b.cookies, b.exportedAt)).join('\n\n') + '\n',
      'utf8',
    );
    const missingCore = CORE.filter((n) => !cookies.some((c) => c.name === n));
    return { dir, count: cookies.length, lsCount: localStorage.length, missingCore };
  };
}

module.exports = { makeExporter, toKamiBlock };

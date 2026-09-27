// tests/e2e-nexip.js · nexip 代理模式全自动注册 E2E 实测（分流版）
// 用法：node tests/e2e-nexip.js
// 特性：
//   - 分流架构：Google 域走本地分流线路（config.googleProxy，如 Clash 127.0.0.1:7897），其余走 nexip
//   - 强制 HK 出口预筛：提取 → 出口 IP → 归属地校验（必须是香港）→ Dola 可达性，
//     失败只换 sid 重试，无 any 降级——非 HK 出口一律不进入注册流程
//   - Google 可达性单独探分流线路（每账号一次，不随 sid 循环）——nexip 网关对 Google 域名
//     网关级 RESET（实测 100%），绝不做出口级 Google 探测，避免误杀健康 HK 出口、空烧预算
//   - 提取预算保护：总提取次数硬上限（config.extractBudget，可用 DBK_BUDGET 覆盖），耗尽立即熔断退出
//   - 全自动注册：验证即换牌（人机验证/未识别页/需验证码 → 换 IP+指纹重试），无任何人工问答
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
const BUDGET = Math.max(1, Number(process.env.DBK_BUDGET) || 15);
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

// HK 出口质量数据表：预筛全程按 HK 记录（成功出口 + 失败次数 + 最近错误），结束统一上报
const hkPool = { success: 0, fail: 0, streak: 0, lastError: '', exits: [] };

// 出口预筛（强制 HK，无降级 + Google 分流线路预筛）：screenStickyExit 内部失败自动换 sid；
// 整轮失败如实记入 HK 池状态后上抛。Google 可达性由分流线路单独承接（screenStickyExit 内部每轮探一次）
async function screenHK(config) {
  try {
    const proxy = await proxyService.screenStickyExit(config, {
      region: config.region || 'HK',
      maxAttempts: 3,
      googleProxy: config.googleProxy || null,
      onAttempt: (i, msg) => log(`  [预筛 HK #${i}] ${msg}`),
    });
    hkPool.success += 1;
    hkPool.streak = 0;
    hkPool.exits.push({
      ip: proxy.exit.ip, country: proxy.exit.country, city: proxy.exit.city,
      isp: proxy.exit.isp, sid: proxy.sid,
      googleLine: proxy.googleLine ? proxy.googleLine.host : '(未配置)',
      at: new Date().toISOString(),
    });
    return proxy;
  } catch (e) {
    if (e.code === 'BUDGET_EXHAUSTED') throw e;
    hkPool.fail += 1;
    hkPool.streak += 1;
    hkPool.lastError = String(e.message || e).slice(0, 120);
    if (hkPool.streak >= 6) {
      log(`⛔ HK 出口预筛连续失败 ${hkPool.streak} 次（最近错误：${hkPool.lastError}）——疑似 HK 池整体异常，保持仅 HK 换 sid 重试，不换区`);
    }
    throw e;
  }
}

async function main() {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'proxy.json'), 'utf8'));
  // 预算：DBK_BUDGET > config.extractBudget > 默认。注意必须同步改写 config.extractBudget——
  // extractStickyProxy 每次提取会内部用 config.extractBudget 重设预算上限，不改写会被覆盖回 15
  config.extractBudget = Number(process.env.DBK_BUDGET) || config.extractBudget || BUDGET;
  proxyService.setExtractBudget(config.extractBudget);

  const dataDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'doubao-manager');
  const store = new EnvStore(dataDir);
  const accountStore = new AccountStore(dataDir);

  const account = accountStore.claim('e2e-nexip');
  const MAX_IP = 3;
  log(`🚀 E2E（nexip 出口 + Google 分流线路）开始：${account.email}｜出口预筛强制 HK（无降级）｜Google 走分流线路（每账号预筛一次）｜提取预算 ${proxyService.getExtractUsage().max} 次`);

  const env = store.create(`E2E-NX-${account.email.split('@')[0]}`);
  store.update(env.id, { homeUrl: launcher.DOLA_URL });
  let success = false;
  let lastMsg = '';
  let result = null;

  for (let ipTry = 1; ipTry <= MAX_IP && !success; ipTry += 1) {
    try {
      log(`━━━ [IP ${ipTry}/${MAX_IP}] 全新指纹 ━━━`);
      store.update(env.id, { fingerprint: randomFingerprint() });

      // 出口预筛（强制 HK，无降级），预算熔断直接终止
      const proxy = await screenHK(config);
      store.update(env.id, { proxy, proxyTest: proxy.exit });
      log(`出口已固定（HK）且可达 Dola：${proxy.exit.ip}（${proxy.exit.country} · ${proxy.exit.isp}）｜region=${proxy.region} sid=${proxy.sid}${proxy.googleLine ? `｜Google 分流线路 ${proxy.googleLine.host}` : ''}`);

      // 启动环境 + 全自动注册
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
      result = { email: account.email, envId: env.id, cookieInfo: ci, exitsUsed: ipTry };
      log(`✅ ${account.email} 成功：Cookie ${ci.count} 条${ci.missingCore.length ? `（⚠️ 缺核心字段：${ci.missingCore.join(', ')}）` : '（含 sessionid/sid_guard）'}，localStorage ${ci.lsCount} 条 → ${ci.dir}`);
    } catch (err) {
      lastMsg = String(err.message || err).slice(0, 150);
      const code = err.code || '';
      log(`❌ [IP ${ipTry}/${MAX_IP}] ${code ? `[${code}] ` : ''}${lastMsg}`);
      if (launcher.isRunning(env.id)) await launcher.closeEnv(env.id).catch(() => {});
      // 清脏 profile（与生产一致：Google 记住失败尝试，复用加重风控）
      try { fs.rmSync(store.profileDir(env.id), { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
      if (err.code === 'BUDGET_EXHAUSTED') {
        log('🛑 提取预算熔断，E2E 终止');
        break;
      }
      if (ipTry < MAX_IP) {
        log('验证即换牌：换 IP + 换指纹重试…');
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  // 收尾：关浏览器 + 清环境（成功保留环境；失败删除）
  if (launcher.isRunning(env.id)) await launcher.closeEnv(env.id).catch(() => {});

  const usage = proxyService.getExtractUsage();

  // HK 出口质量数据表（按 HK 记录，无降级换区）
  log('📊 HK 出口质量数据：');
  log(`   预筛成功 ${hkPool.success} 次 / 失败 ${hkPool.fail} 次${hkPool.streak >= 6 ? '（⚠️ 连续失败 ≥6 次，疑似 HK 池整体异常）' : ''}`);
  if (hkPool.lastError) log(`   最近预筛错误：${hkPool.lastError}`);
  for (const x of hkPool.exits) {
    log(`   ✓ ${x.ip}（${x.country} · ${x.city} · ${x.isp}）sid=${x.sid} Dola=OK Google线路=${x.googleLine} @ ${x.at}`);
  }

  if (!success) {
    accountStore.finish(account.email, false, env.id, lastMsg);
    store.remove(env.id);
    log(`🛑 E2E 失败：${account.email}（${lastMsg}）｜提取用量 ${usage.used}/${usage.max}`);
    process.exit(2);
  }

  log(`🎉 E2E 完成：${JSON.stringify(result)}｜提取用量 ${usage.used}/${usage.max}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(`[${new Date().toISOString()}] FATAL`, e);
  process.exit(1);
});

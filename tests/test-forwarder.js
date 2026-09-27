// tests/test-forwarder.js · 本地认证转发器（双上游分流版）端到端验证
// 用法：node tests/test-forwarder.js
// 说明：消耗 nexip 提取 API 1 次；Google 分流线路（config.googleProxy）探测不消耗配额
// 验证点：
//   1. 提取预算保护：初始 usage 归零、可设置上限
//   2. nexip 粘性会话提取（消耗 1 次配额，计数 +1）
//   3. nexip 出口 IP 检测
//   4. nexip 对 Google 域名连通性（事实记录：网关级 RESET 属预期，生产由分流线路承接）
//   5. Google 分流线路探活（generate_204，不耗配额）
//   6. 转发器启动（双上游分流：Google→分流线路，其余→nexip）
//   7. 经转发器访问 Dola（走 nexip 认证代发）
//   8. 经转发器访问 Google（应走分流线路，而非 nexip）
//   9. 经转发器出口 IP == 网关直检出口 IP（非 Google 域粘性会话生效，无分流误伤）
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');

const { startForwarder } = require('../main/forwarder');
const { extractStickyProxy, testProxy, parseGoogleProxy, getExtractUsage, setExtractBudget } = require('../main/proxy');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} | ${detail}`);
}

// 经指定代理（转发器或直连网关）请求一个 https 地址，返回 { status, body }
function httpsGetVia(proxyUrl, url, { timeoutMs = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const agent = new HttpsProxyAgent(proxyUrl);
    const req = https.get(url, {
      agent,
      timeout: timeoutMs,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36' },
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)));
    req.on('error', reject);
  });
}

async function main() {
  const root = path.join(__dirname, '..');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config', 'proxy.json'), 'utf8'));

  // ---- 1. 提取预算保护 ----
  setExtractBudget(config.extractBudget || 15);
  const u0 = getExtractUsage();
  record('1.提取预算初始化', u0.used === 0 && u0.max === (config.extractBudget || 15),
    `used=${u0.used} max=${u0.max}（config.extractBudget=${config.extractBudget || '未配置，默认 15'}）`);

  // ---- 2. 提取 nexip 粘性会话（消耗 1 次配额）----
  let sticky;
  try {
    sticky = await extractStickyProxy(config, { region: 'any' });
    const u1 = getExtractUsage();
    record('2.nexip 粘性会话提取', u1.used === 1,
      `网关 ${sticky.host}:${sticky.port}（region=${sticky.region} sid=${sticky.sid}），预算计数 ${u1.used}/${u1.max}`);
  } catch (e) {
    record('2.nexip 粘性会话提取', false, `${e.message}（后续测试无法继续）`);
    return;
  }

  // ---- 3. 出口 IP（Node 直连网关检测）----
  let exitIp = null;
  try {
    const t = await testProxy(sticky);
    exitIp = t.ip;
    record('3.nexip 出口 IP', true, `${t.ip}（${t.country} · ${t.isp}）`);
  } catch (e) {
    record('3.nexip 出口 IP', false, e.message);
  }

  // ---- 4. nexip 对 Google 域名连通性（事实记录：网关级 RESET 属预期）----
  try {
    const r = await httpsGetVia(`http://${encodeURIComponent(sticky.username)}:${encodeURIComponent(sticky.password)}@${sticky.host}:${sticky.port}`, 'https://www.google.com/generate_204', { timeoutMs: 25000 });
    record('4.nexip→Google（generate_204）', r.status === 204, `HTTP ${r.status}：该网关对 Google 可达（与既有实测不符，请复核）`);
  } catch (e) {
    record('4.nexip→Google（generate_204）', true, `不可达（${String(e.message).slice(0, 60)}）→ 符合预期（网关级 RESET），生产由分流线路承接`);
  }

  // ---- 5. Google 分流线路探活（不耗配额）----
  const googleUpstream = parseGoogleProxy(config.googleProxy);
  if (googleUpstream) {
    try {
      const r = await httpsGetVia(`${googleUpstream.protocol}://${googleUpstream.host}:${googleUpstream.port}`, 'https://www.google.com/generate_204', { timeoutMs: 20000 });
      record('5.Google 分流线路探活', r.status === 204, `HTTP ${r.status} @ ${googleUpstream.host}:${googleUpstream.port}`);
    } catch (e) {
      record('5.Google 分流线路探活', false, `${String(e.message).slice(0, 80)} @ ${googleUpstream.host}:${googleUpstream.port}`);
    }
  } else {
    record('5.Google 分流线路探活', false, 'config/proxy.json 未配置有效 googleProxy');
  }

  // ---- 6. 启动转发器（双上游分流）----
  const fw = await startForwarder({
    upstream: { host: sticky.host, port: sticky.port, username: sticky.username, password: sticky.password },
    googleUpstream: googleUpstream || null,
  });
  console.log(`INFO | 转发器已启动 127.0.0.1:${fw.port}（Google→${googleUpstream ? `${googleUpstream.host}:${googleUpstream.port}` : '无（未配置）'}，其余→nexip）`);
  record('6.转发器启动', true, `监听 127.0.0.1:${fw.port}`);

  const viaFw = `http://127.0.0.1:${fw.port}`;

  // ---- 7. 经转发器访问 Dola（nexip 认证代发）----
  try {
    const r = await httpsGetVia(viaFw, 'https://www.dola.com/', { timeoutMs: 60000 });
    record('7.转发器→Dola（走 nexip）', r.status >= 200 && r.status < 400, `HTTP ${r.status}，页面 ${r.body.length} 字节`);
  } catch (e) {
    record('7.转发器→Dola（走 nexip）', false, String(e.message).slice(0, 100));
  }

  // ---- 8. 经转发器访问 Google（应走分流线路）----
  if (googleUpstream) {
    try {
      const r = await httpsGetVia(viaFw, 'https://www.google.com/generate_204', { timeoutMs: 30000 });
      record('8.转发器→Google（走分流线路）', r.status === 204, `HTTP ${r.status}（分流线路承接）`);
    } catch (e) {
      record('8.转发器→Google（走分流线路）', false, String(e.message).slice(0, 100));
    }
  } else {
    record('8.转发器→Google（走分流线路）', false, '未配置 googleProxy，跳过');
  }

  // ---- 9. 经转发器出口 IP 一致性（非 Google 域粘性会话生效）----
  try {
    const r = await httpsGetVia(viaFw, 'https://api.ipify.org/?format=json', { timeoutMs: 45000 });
    const ip = JSON.parse(r.body).ip;
    if (exitIp && ip !== exitIp) {
      record('9.转发器出口 IP 一致性', false, `转发器出口 ${ip} ≠ 网关直检出口 ${exitIp}`);
    } else {
      record('9.转发器出口 IP 一致性', true, `出口 ${ip} 与网关直检一致（粘性会话生效）`);
    }
  } catch (e) {
    record('9.转发器出口 IP 一致性', false, String(e.message).slice(0, 100));
  }

  await fw.close();
  console.log('INFO | 转发器已关闭');

  const fails = results.filter((r) => !r.ok);
  console.log(`\n===== 汇总：${results.length - fails.length}/${results.length} 通过 =====`);
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL | 测试脚本异常：', e);
  process.exit(1);
});

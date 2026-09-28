// proxy.js · 代理模块：通用提取适配器（兼容 JSON / 文本响应）+ 连通性检测
'use strict';

const https = require('https');
const http = require('http');
const tls = require('tls');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { dialUpstream } = require('./forwarder');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// 基础 GET（可挂代理 agent），跟随一层 30x
// 注意：代理 CONNECT 握手挂死时 req 的 'timeout' 事件不可靠，必须额外用硬计时器兜底销毁
function httpGetText(url, { agent = null, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const doGet = (target, redirectLeft) => {
      const mod = target.startsWith('https:') ? https : http;
      const req = mod.get(target, { agent, headers: { 'User-Agent': UA }, timeout: timeoutMs }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectLeft > 0) {
          res.resume();
          return doGet(new URL(res.headers.location, target).toString(), redirectLeft - 1);
        }
        let text = '';
        res.on('data', (d) => { text += d; });
        res.on('end', () => { if (!settled) { settled = true; clearTimeout(hardTimer); resolve({ status: res.statusCode, text }); } });
      });
      const hardTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        req.destroy();
        reject(new Error(`请求硬超时（${timeoutMs}ms，代理可能挂死）`));
      }, timeoutMs + 5000);
      req.on('timeout', () => req.destroy(new Error('请求超时')));
      req.on('error', (e) => { if (!settled) { settled = true; clearTimeout(hardTimer); reject(e); } });
    };
    doGet(url, 1);
  });
}

// 链式 GET：proxy.via 存在时使用——隧道连接必须经中间代理（如 Clash）中转，直连隧道在大陆被拒（602）。
// 用 forwarder 的 dialUpstream 建链（两段嵌套 CONNECT），再在隧道 socket 上手写原始 HTTP GET。
// https 目标在 CONNECT 隧道内是 TLS：用 tls.connect 复用已建立的 socket 升级后再发请求。
// 返回 { status, text }（与 httpGetText 返回形状一致，text 为 body）。
async function httpGetViaChain(proxy, url, timeoutMs = 20000) {
  const target = new URL(url);
  const isHttps = target.protocol === 'https:';
  const port = Number(target.port) || (isHttps ? 443 : 80);
  const { socket, remaining } = await dialUpstream({
    host: proxy.host,
    port: proxy.port,
    username: proxy.username || '',
    password: proxy.password || '',
    via: proxy.via,
  }, `${target.hostname}:${port}`, timeoutMs);

  // https 目标：在 CONNECT 隧道内做 TLS 升级（node 的 tls 模块支持复用已建立 socket）
  let sock = socket;
  if (isHttps) {
    sock = await new Promise((resolveTls, rejectTls) => {
      const tlsSock = tls.connect({ socket, servername: target.hostname }, () => resolveTls(tlsSock));
      // once 监听兜底：TLS 握手失败或后续任何错误都由本监听消化（promise 已 settle 后调用为无害 no-op），
      // 防止 error 事件无人接管变成未捕获异常
      tlsSock.once('error', (e) => {
        try { tlsSock.destroy(); } catch (e2) { /* 忽略 */ }
        rejectTls(e);
      });
    });
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let buf = Buffer.alloc(0);
    // 非 TLS 场景：拨号阶段可能已收到服务器先发的字节（罕见），拼回缓冲区最前面
    if (!isHttps && remaining && remaining.length) buf = Buffer.concat([remaining, buf]);

    const settle = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      try { sock.destroy(); } catch (e) { /* 忽略 */ }
      if (err) reject(err); else resolve(result);
    };
    const hardTimer = setTimeout(() => settle(new Error(`链式请求硬超时（${timeoutMs}ms，隧道可能挂死）`)), timeoutMs + 5000);
    sock.on('error', (e) => settle(e));
    sock.on('data', (chunk) => { buf = Buffer.concat([buf, chunk]); });
    sock.on('close', () => {
      // Connection: close：服务端关连接即响应结束，解析状态行与 body
      const text = buf.toString('utf8');
      const idx = text.indexOf('\r\n\r\n');
      const headText = idx >= 0 ? text.slice(0, idx) : text;
      let body = idx >= 0 ? text.slice(idx + 4) : '';
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(headText);
      const status = m ? Number(m[1]) : 0;
      // HTTP/1.1 下服务端可能用 chunked 分块，须解帧后再交给调用方
      if (/transfer-encoding:\s*chunked/i.test(headText)) body = dechunkBody(body);
      settle(null, { status, text: body });
    });

    sock.write(`GET ${target.pathname}${target.search || ''} HTTP/1.1\r\n`
      + `Host: ${target.hostname}\r\n`
      + `User-Agent: ${UA}\r\n`
      + 'Connection: close\r\n\r\n');
  });
}

// 最小 chunked 解帧：按「块大小行 CRLF + 块数据 CRLF」循环拼接，size=0 结束。
// 必须全程在 Buffer 层按字节切片——chunk 大小是字节数，若先 toString 再按 JS 字符串索引，
// 非 ASCII（如中文 UTF-8 多字节）内容会切片错位产出乱码。
function dechunkBody(bodyBuf) {
  const buf = Buffer.isBuffer(bodyBuf) ? bodyBuf : Buffer.from(String(bodyBuf), 'utf8');
  const parts = [];
  let pos = 0;
  while (pos < buf.length) {
    const lineEnd = buf.indexOf('\r\n', pos);
    if (lineEnd < 0) break;
    const size = parseInt(buf.slice(pos, lineEnd).toString('latin1').trim(), 16);
    if (!Number.isFinite(size) || size < 0) break;
    if (size === 0) break;
    const dataStart = lineEnd + 2;
    const dataEnd = Math.min(dataStart + size, buf.length);
    parts.push(buf.slice(dataStart, dataEnd));
    pos = dataEnd + 2; // 跳过块数据后的 CRLF
  }
  return Buffer.concat(parts).toString('utf8');
}

// 深度遍历 JSON，收集含 ip/host + port 的节点
function deepFindProxy(node, out) {
  if (!node || out.length >= 10) return;
  if (Array.isArray(node)) {
    node.forEach((item) => deepFindProxy(item, out));
    return;
  }
  if (typeof node === 'object') {
    const host = node.ip || node.host || node.addr || node.server;
    const port = node.port;
    if (host && port && !Number.isNaN(Number(port))) {
      const proto = String(node.protocol || node.proto || node.type || '').toLowerCase();
      out.push({
        protocol: /^socks|^http/.test(proto) ? proto : '',
        host: String(host),
        port: Number(port),
        user: node.user || node.username || '',
        password: node.password || node.pass || '',
      });
      return;
    }
    Object.values(node).forEach((v) => deepFindProxy(v, out));
  }
}

// 兼容三种响应：scheme://user:pass@host:port、JSON 对象/数组、纯文本 host:port(:user:pass)
function parseProxyResponse(text, extractUrl) {
  const results = [];

  // ① 标准 URL 格式（含协议与凭证，优先级最高）
  const urlRe = /(https?|socks[45h]?):\/\/([^:@/\s]+):([^@/\s]+)@([a-zA-Z0-9.\-]+):(\d{2,5})/gi;
  let m;
  while ((m = urlRe.exec(text)) !== null) {
    results.push({
      protocol: m[1].toLowerCase(),
      host: m[4],
      port: Number(m[5]),
      user: decodeURIComponent(m[2]),
      password: decodeURIComponent(m[3]),
    });
  }

  // ② JSON 深度搜索
  if (!results.length) {
    try {
      deepFindProxy(JSON.parse(text), results);
    } catch (e) { /* 非 JSON，走正则 */ }
  }

  // ③ 纯文本 host:port(:user:pass)
  if (!results.length) {
    const re = /([a-zA-Z0-9.\-]+\.[a-zA-Z0-9.\-]+|\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})(?::([^:\s]+):([^:\s]+))?/g;
    while ((m = re.exec(text)) !== null) {
      results.push({ host: m[1], port: Number(m[2]), user: m[3] || '', password: m[4] || '' });
    }
  }

  // 凭证兜底：响应里没带就从提取 URL 的 query 里取
  if (results.length && extractUrl) {
    try {
      const u = new URL(extractUrl);
      for (const r of results) {
        if (!r.user) r.user = u.searchParams.get('username') || '';
        if (!r.password) r.password = u.searchParams.get('password') || '';
      }
    } catch (e) { /* 忽略 */ }
  }
  return results;
}

// 协议探测：Chromium 不支持带认证的 SOCKS5，若服务商入口同时支持 http 则自动切换
async function probeProtocol(proxy) {
  if (proxy.protocol === 'socks5' && proxy.username) {
    for (const proto of ['http', 'socks5']) {
      try {
        const agent = buildAgent({ ...proxy, protocol: proto });
        const { text } = await httpGetText('http://ip-api.com/json/?fields=status', { agent, timeoutMs: 15000 });
        if (JSON.parse(text).status === 'success') return { ...proxy, protocol: proto };
      } catch (e) { /* 尝试下一种协议 */ }
    }
  }
  return proxy;
}

const crypto = require('crypto');

// ---------- 提取预算保护 ----------
// 提取 API 有配额成本（每次 extractStickyProxy/extractProxy 调用计 1 次），
// 超过预算立即抛错停止，避免失败重试无限烧配额。默认 15 次，可用 config.extractBudget 覆盖。
const extractBudget = { max: 15, used: 0 };

function setExtractBudget(max) {
  const n = Number(max);
  if (n === Infinity) { extractBudget.max = Infinity; return; } // 无上限：不熔断
  if (Number.isFinite(n) && n > 0) extractBudget.max = Math.floor(n);
}

function getExtractUsage() {
  return { used: extractBudget.used, max: extractBudget.max, left: Math.max(0, extractBudget.max - extractBudget.used) };
}

function resetExtractBudget() {
  extractBudget.used = 0;
}

// 计一次提取；超出预算抛 BUDGET_EXHAUSTED（调用方必须停止重试，不得吞掉）
// max=Infinity（无上限）时永不熔断
function consumeExtract() {
  extractBudget.used += 1;
  if (extractBudget.max !== Infinity && extractBudget.used > extractBudget.max) {
    const e = new Error(`代理提取预算已耗尽（上限 ${extractBudget.max} 次），已停止提取以保护配额`);
    e.code = 'BUDGET_EXHAUSTED';
    throw e;
  }
}

// 生成随机会话 ID（8 位小写字母数字）
function randomSid() {
  return crypto.randomBytes(5).toString('hex').slice(0, 8);
}

// iplist 型服务商（如 udealproxy：白名单认证、响应为纯文本 ip:port 列表）的错误检测：
// 这类服务出错时返回中文文案（如「白名单不存在1.2.3.4」「提取过于频繁」），HTTP 仍是 200，
// 必须在解析前显式拦截，否则错误文案会被当响应吞掉或误报「无法解析」。
const IPLIST_ERROR_RE = /白名单|频繁|余额|过期|授权|无效|错误|失败|禁止|login|auth/i;

// 解析 iplist 响应（每行 ip:port），返回免认证代理对象
// 注意：iplist 无粘性会话概念——每次提取即一个新出口（隧道在有效期内保持同一 IP），
// 「换 IP」= 重新调用提取 API，与 nexip 的 sid 轮换在调用方语义一致。
function parseIplistResponse(text, config, region) {
  const t = String(text || '').trim();
  if (IPLIST_ERROR_RE.test(t) && !/^\s*\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}/m.test(t)) {
    const e = new Error(`代理服务商返回错误：${t.slice(0, 120)}`);
    e.code = 'PROVIDER_ERROR';
    throw e;
  }
  const list = parseProxyResponse(t, config.extractUrl).filter((p) => p.host && p.port);
  if (!list.length) throw new Error(`无法从 iplist 响应中解析出代理地址：${t.slice(0, 160)}`);
  const p = list[0];
  return {
    protocol: config.protocol || 'http',
    host: p.host,
    port: p.port,
    username: '',
    password: '',
    region: String(region || 'HK').toLowerCase(),
    sid: null,
    extractedAt: new Date().toISOString(),
  };
}

// 链式中转（via）判定：udealproxy 等隧道拒绝中国大陆来源 IP，隧道连接须经本地分流线路（Clash）中转。
// 仅当 provider=iplist 或显式 tunnelViaClash=true 时生效——严禁影响 nexip 现有直连行为。
// googleProxy 解析失败返回 null（行为退化为直连，预筛时 602 暴露，可接受）。
function tunnelViaFromConfig(config) {
  if (!config) return null;
  const isIplist = String(config.provider || '').toLowerCase() === 'iplist';
  if (!isIplist && config.tunnelViaClash !== true) return null;
  const gp = parseGoogleProxy(config.googleProxy);
  return gp ? { host: gp.host, port: gp.port } : null;
}

// 提取粘性会话代理：从提取 API 拿网关入口，然后把用户名改写为 {user}-{region}-sid-{sid}
// 实测（2026-09）：-sid- 后缀固定出口 IP（住宅 ISP），换 sid 即换 IP；region 后缀选地区（取配置地区，无 any 降级——
// 业务要求注册链路只允许配置地区出口，探活/归属地校验失败一律换 sid 重试，绝不静默换区）
// provider=iplist（如 udealproxy）：白名单认证免账密，region 由提取 URL 自带，每次提取即新出口。
async function extractStickyProxy(config, { region = 'HK', sid = null } = {}) {
  if (!config) throw new Error('未配置代理（config/proxy.json）');
  // 网关模式（udealproxy jp_tokyo 等）：固定网关入口 + 账密认证，用户名内嵌 session 控制出口——
  // 实测（2026-09-27）：jp 地区 iplist 白名单节点 CONNECT 611（该地区不支持免认证提取），必须走账密网关。
  // 不调提取 API（0 提取配额、不触发预算熔断），换 sid 即换出口；隧道仍按 tunnelViaClash 经 Clash 中转。
  if (config.gateway && config.gateway.host) {
    const useSid = sid || randomSid();
    const tpl = String(config.gateway.usernameTemplate || '');
    const username = tpl.replace('{sid}', useSid);
    if (!username || username === tpl) throw new Error('gateway.usernameTemplate 缺失或不含 {sid} 占位符');
    const result = {
      protocol: config.protocol || 'http',
      host: config.gateway.host,
      port: Number(config.gateway.port) || 6666,
      username,
      password: config.gateway.password || '',
      region: String(region || 'HK').toLowerCase(),
      sid: useSid,
      extractedAt: new Date().toISOString(),
    };
    const gvia = tunnelViaFromConfig(config);
    if (gvia) result.via = gvia;
    return result;
  }
  if (!config.extractUrl) throw new Error('未配置代理提取 API（config/proxy.json）');
  if (config.extractBudget) setExtractBudget(config.extractBudget);
  consumeExtract();
  const { text, status } = await httpGetText(config.extractUrl);
  if (status !== 200) throw new Error(`提取 API 返回 HTTP ${status}：${text.slice(0, 120)}`);
  if (String(config.provider || '').toLowerCase() === 'iplist') {
    const cand = parseIplistResponse(text, config, region);
    // 隧道须中转时给提取结果挂 via（testProxy/probeDolaExit/转发器据此走链式拨号）
    const via = tunnelViaFromConfig(config);
    if (via) cand.via = via;
    return cand;
  }
  const list = parseProxyResponse(text, config.extractUrl);
  if (!list.length) throw new Error(`无法从响应中解析出代理地址：${text.slice(0, 160)}`);
  const p = list[0];
  // 基础用户名：优先配置文件里的纯用户名，其次响应凭证（剥掉地区/会话后缀）
  let baseUser = String(config.username || p.user || '').trim();
  baseUser = baseUser.replace(/-(?:any|us|hk|sg|jp|tw|kr|sid-[a-z0-9]+)$/i, '');
  if (!baseUser) throw new Error('无法确定代理基础用户名');
  const useRegion = String(region || 'HK').toLowerCase();
  const useSid = sid || randomSid();
  const result = {
    protocol: 'http',
    host: p.host,
    port: p.port,
    username: `${baseUser}-${useRegion}-sid-${useSid}`,
    password: p.password || config.password || '',
    region: useRegion,
    sid: useSid,
    extractedAt: new Date().toISOString(),
  };
  // nexip 路径：tunnelViaFromConfig 对非 iplist/未开 tunnelViaClash 的配置恒返回 null，行为不变
  const via = tunnelViaFromConfig(config);
  if (via) result.via = via;
  return result;
}

// 从配置的提取 API 拉一个新代理
async function extractProxy(config) {
  if (!config || !config.extractUrl) throw new Error('未配置代理提取 API（config/proxy.json）');
  if (config.extractBudget) setExtractBudget(config.extractBudget);
  consumeExtract();
  const { text, status } = await httpGetText(config.extractUrl);
  if (status !== 200) throw new Error(`提取 API 返回 HTTP ${status}：${text.slice(0, 120)}`);
  const list = parseProxyResponse(text, config.extractUrl);
  if (!list.length) throw new Error(`无法从响应中解析出代理地址：${text.slice(0, 160)}`);
  const p = list[0];
  return probeProtocol({
    protocol: p.protocol || config.protocol || 'socks5',
    host: p.host,
    port: p.port,
    username: p.user || '',
    password: p.password || '',
    extractedAt: new Date().toISOString(),
  });
}

// 按协议构造 Node 代理 agent
function buildAgent(proxy) {
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
    : '';
  const base = `${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`;
  if (/^socks/i.test(proxy.protocol)) return new SocksProxyAgent(base);
  return new HttpsProxyAgent(base);
}

// 连通性检测：经代理请求 ip-api 拿出口 IP 与归属地（随机住宅节点不稳，自动重试一次）
// proxy.via 存在时走链式 GET（经中间代理中转隧道），否则走 buildAgent 直连路径
async function testProxy(proxy) {
  if (!proxy || !proxy.host) throw new Error('该环境还没有配置代理');
  const viaChain = Boolean(proxy.via && proxy.via.host && proxy.via.port);
  const url = 'http://ip-api.com/json/?lang=zh-CN&fields=status,query,country,regionName,city,isp';
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      let text;
      if (viaChain) {
        ({ text } = await httpGetViaChain(proxy, url, 20000));
      } else {
        const agent = buildAgent(proxy);
        ({ text } = await httpGetText(url, { agent, timeoutMs: 20000 }));
      }
      const j = JSON.parse(text);
      if (j.status !== 'success') throw new Error('代理不可用');
      return {
        ok: true,
        ip: j.query,
        country: j.country,
        region: j.regionName,
        city: j.city,
        isp: j.isp,
        testedAt: new Date().toISOString(),
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`出口 IP 检测失败：${lastErr ? lastErr.message : '代理不可用'}`);
}

// Dola 出口可达性探测：经出口访问 Dola 首页，收到任意服务器响应（<500）即认为线路可达。
// 分流版预筛用：出口只验「归属地 + Dola 可达」，Google 可达性不看出口（Google 走分流线路）。
async function probeDolaExit(proxy, { timeoutMs = 25000 } = {}) {
  if (!proxy || !proxy.host) throw new Error('无代理可探测');
  let status;
  if (proxy.via && proxy.via.host && proxy.via.port) {
    ({ status } = await httpGetViaChain(proxy, 'https://www.dola.com/', timeoutMs));
  } else {
    const agent = buildAgent(proxy);
    ({ status } = await httpGetText('https://www.dola.com/', { agent, timeoutMs }));
  }
  if (status >= 500) throw new Error(`Dola 出口探测异常（HTTP ${status}）`);
  return { ok: true, status, probedAt: new Date().toISOString() };
}

// 解析 config.googleProxy（形如 "http://127.0.0.1:7897"）为 { protocol, host, port }；无效返回 null
function parseGoogleProxy(value) {
  try {
    const u = new URL(String(value || ''));
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    if (!u.hostname || !(port > 0 && port <= 65535)) return null;
    return { protocol: u.protocol.replace(':', '') || 'http', host: u.hostname, port };
  } catch (e) { return null; }
}

// Google 分流线路预筛：经本地分流线路（如 Clash 127.0.0.1:7897）探 generate_204。
// 分流架构下 Google 流量不走出口 IP，故该探测每账号只需一次（不随 sid 循环）；失败=分流线路本身故障。
async function probeGoogleLine(googleProxy, { timeoutMs = 12000 } = {}) {
  const gp = parseGoogleProxy(googleProxy) || (googleProxy && googleProxy.host ? googleProxy : null);
  if (!gp) throw new Error('未配置 Google 分流线路（config/proxy.json 的 googleProxy）');
  const agent = buildAgent(gp);
  const { status } = await httpGetText('https://www.google.com/generate_204', { agent, timeoutMs });
  if (status !== 204) throw new Error(`Google 分流线路预筛未通过（HTTP ${status}，期望 204）`);
  return { ok: true, host: `${gp.host}:${gp.port}`, probedAt: new Date().toISOString() };
}

// Google 出口级预筛（旧版，仅保留兼容）：经代理出口访问 generate_204。
// 注意：nexip 网关对 Google 域名网关级 RESET（实测 100%），分流架构下不要对 nexip 出口使用本函数。
async function probeGoogleExit(proxy, { timeoutMs = 20000 } = {}) {
  if (!proxy || !proxy.host) throw new Error('无代理可预筛');
  const agent = buildAgent(proxy);
  const { status } = await httpGetText('https://www.google.com/generate_204', { agent, timeoutMs });
  if (status !== 204) throw new Error(`Google 出口预筛未通过（HTTP ${status}，期望 204）`);
  return { ok: true, probedAt: new Date().toISOString() };
}

// 出口归属地校验：出口必须落在配置地区（按实测出口归属文案匹配，非配置地区一律换 sid/重提取重试）。
// 各地区正则按服务商实测出口归属文案维护：HK 节点实测含 香港 Pccw 等住宅 ISP；udealproxy jp_tokyo 节点实测出口文案含 日本/Tokyo
const REGION_EXIT_RE = {
  hk: /香港|hong ?kong/i,
  jp: /日本|东京|japan|tokyo/i,
};
const HK_EXIT_RE = REGION_EXIT_RE.hk; // 兼容旧导出名（外部引用/测试依赖），新代码请改用 REGION_EXIT_RE

// 组合预筛（分流版）：提取粘性会话 → 出口 IP 检测 → 归属地校验 → Dola 可达性。
// Google 可达性：传入 googleProxy（分流线路）时，先单独探一次分流线路（每账号一次，不随 sid 循环，
// 不消耗提取预算），出口侧不再做 Google 探测——避免 nexip→Google 网关级 RESET 误杀健康出口、空烧预算。
// 强制归属地：未显式传 requireRegion 时按 region 从 REGION_EXIT_RE 自动启用对应归属地校验（无正则的地区不做校验），不做 any 降级。
// 任一出口环节失败自动换 sid 重筛；全程受提取预算保护（预算耗尽抛 BUDGET_EXHAUSTED 向上传播）。
async function screenStickyExit(config, { region = 'HK', requireRegion = null, maxAttempts = 4, googleProxy = null, onAttempt = () => {} } = {}) {
  const reg = String(region || 'HK').toLowerCase();
  const geoRe = requireRegion instanceof RegExp ? requireRegion : (REGION_EXIT_RE[reg] || null);

  // ① Google 分流线路预筛（每账号一次，独立于出口 sid 循环）
  let googleLine = null;
  if (googleProxy) {
    googleLine = await probeGoogleLine(googleProxy);
    onAttempt(0, `Google 分流线路预筛通过（generate_204 = 204，经 ${googleLine.host}，Google 登录将走本地专线）`);
  } else {
    onAttempt(0, '未配置 Google 分流线路：跳过 Google 线路预筛（Google 流量将由转发器按域名分流，未命中分流线路时无法访问 Google）');
  }

  // ② 出口预筛循环：归属地 + Dola 可达（不做出口级 Google 探测）
  let lastErr = null;
  for (let i = 1; i <= maxAttempts; i += 1) {
    try {
      const cand = await extractStickyProxy(config, { region: reg });
      onAttempt(i, `已提取网关 ${cand.host}:${cand.port}（sid=${cand.sid}，预算已用 ${getExtractUsage().used}/${getExtractUsage().max}）`);
      const t = await testProxy(cand);
      cand.exit = t;
      onAttempt(i, `出口 IP ${t.ip}（${t.country} · ${t.city} · ${t.isp}）`);
      if (geoRe && !geoRe.test(`${t.country}${t.region}${t.city}`)) {
        throw new Error(`出口地区不符（期望 ${reg.toUpperCase()}，实际 ${t.country} ${t.region}）`);
      }
      cand.dola = await probeDolaExit(cand);
      onAttempt(i, `出口可达 Dola（HTTP ${cand.dola.status}）${googleLine ? '；Google 已由分流线路承接' : ''}`);
      if (googleLine) cand.googleLine = googleLine;
      return cand;
    } catch (e) {
      if (e.code === 'BUDGET_EXHAUSTED') throw e;
      lastErr = e;
      onAttempt(i, `预筛第 ${i}/${maxAttempts} 次失败：${String(e.message).slice(0, 80)}`);
    }
  }
  throw lastErr || new Error('出口预筛失败（未知原因）');
}

// ---------- Phantom 本地混合端口直连模式（mode=phantom-local） ----------

// 纯函数：ip-api 出口信息 → 时区/地区归类（可离线单测）。
// HK → Asia/Shanghai；TW → Asia/Taipei；其他 → Asia/Shanghai + warn「出口非港台：XX」。
function classifyExitRegion(info) {
  const raw = info || {};
  const name = String(raw.country || '').trim();
  const cc = String(raw.countryCode || '').trim().toUpperCase();
  // countryCode 缺失时按国家名兜底推断（中文/英文/域名后缀）
  const code = /^[A-Z]{2}$/.test(cc) ? cc
    : (/香港|hong ?kong/i.test(name) ? 'HK'
      : (/台湾|台灣|taiwan/i.test(name) ? 'TW' : ''));
  const base = {
    ok: true,
    ip: String(raw.query || raw.ip || ''),
    country: name || code || '未知',
    countryCode: code || cc || '',
    regionName: String(raw.regionName || raw.region || ''),
    city: String(raw.city || ''),
    isp: String(raw.isp || ''),
  };
  if (code === 'HK') return { ...base, region: 'hk', tz: 'Asia/Shanghai', warn: '' };
  if (code === 'TW') return { ...base, region: 'tw', tz: 'Asia/Taipei', warn: '' };
  return { ...base, region: (code || 'xx').toLowerCase(), tz: 'Asia/Shanghai', warn: `出口非港台：${base.country}` };
}

// 经无认证 HTTP 代理请求 http 目标：绝对路径形式（GET http://host/path），无需 CONNECT 隧道
function httpGetViaHttpProxy(proxyHost, proxyPort, targetUrl, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (err) reject(err); else resolve(result);
    };
    const target = new URL(targetUrl);
    const req = http.request({
      host: proxyHost,
      port: proxyPort,
      method: 'GET',
      path: targetUrl, // 绝对形式：HTTP 代理据此转发
      headers: { Host: target.host, 'User-Agent': UA, Accept: '*/*', Connection: 'close' },
      timeout: timeoutMs,
    }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => settle(null, { status: res.statusCode, text }));
    });
    const hardTimer = setTimeout(() => {
      req.destroy();
      settle(new Error(`探测请求硬超时（${timeoutMs}ms）`));
    }, timeoutMs + 5000);
    req.on('timeout', () => req.destroy(new Error('探测请求超时')));
    req.on('error', (e) => settle(e));
    req.end();
  });
}

// Phantom 出口探测（直连模式轻量预筛，替代 screenStickyExit 的提取预筛）：
// 经本地混合端口（无认证）请求 ip-api 拿出口国家 → classifyExitRegion 归类时区。
// 两层形式各试 2 轮：① HTTP 绝对路径形式（ip-api 免费版仅 http）② HTTPS CONNECT 兜底。
// 全部失败抛 SLOW_NETWORK（调用方按「同出口换指纹重试」语义处理）。
async function phantomExitProbe(browserProxy, { timeoutMs = 12000, onAttempt = () => {} } = {}) {
  const host = String((browserProxy && browserProxy.host) || '127.0.0.1');
  const port = Number((browserProxy && browserProxy.port) || 7897);
  const query = 'fields=status,message,country,countryCode,regionName,city,isp,timezone,query';
  let lastErr = null;
  const parseAndClassify = (text) => {
    let j;
    try { j = JSON.parse(text); } catch (e) { throw new Error(`ip-api 响应非 JSON（${String(text).slice(0, 40)}）`); }
    if (!j || j.status !== 'success') throw new Error(`ip-api 返回失败（${String((j && j.message) || 'unknown').slice(0, 60)}）`);
    return classifyExitRegion(j);
  };
  for (let i = 1; i <= 2; i += 1) {
    // ① HTTP 绝对路径形式（phantom 混合端口 HTTP 模式）
    try {
      onAttempt(`探测出口 IP（第 ${i}/2 轮 · HTTP 代理形式）…`);
      const res = await httpGetViaHttpProxy(host, port, `http://ip-api.com/json/?${query}`, timeoutMs);
      return parseAndClassify(res.text);
    } catch (e) { lastErr = e; }
    // ② HTTPS CONNECT 兜底（phantom 走 SOCKS 场景由 agent 兼容）
    try {
      onAttempt(`探测出口 IP（第 ${i}/2 轮 · CONNECT 形式）…`);
      const agent = new HttpsProxyAgent({ host, port });
      const res = await httpGetText(`https://ip-api.com/json/?${query}`, { agent, timeoutMs });
      return parseAndClassify(res.text);
    } catch (e) { lastErr = e; }
  }
  const err = new Error(`Phantom 出口探测失败：${lastErr ? String(lastErr.message || lastErr).slice(0, 90) : '未知错误'}`);
  err.code = 'SLOW_NETWORK';
  throw err;
}

module.exports = { extractProxy, extractStickyProxy, randomSid, testProxy, parseProxyResponse, probeProtocol, probeGoogleExit, probeGoogleLine, probeDolaExit, parseGoogleProxy, tunnelViaFromConfig, screenStickyExit, setExtractBudget, getExtractUsage, resetExtractBudget, REGION_EXIT_RE, HK_EXIT_RE, httpGetViaChain, classifyExitRegion, phantomExitProbe, httpGetViaHttpProxy };

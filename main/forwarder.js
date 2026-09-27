// forwarder.js · 本地认证转发器（双上游分流版）
// 浏览器统一挂 127.0.0.1 随机端口的本地免认证代理，由本模块代发认证：
//   - Google 系域名（isGoogleHost 命中）→ 优先走 Google 分流线路（Clash 127.0.0.1:7897，免认证），
//     Clash 拨号失败自动降级回 nexip 兜底；
//   - 其余全部流量 → nexip 粘性会话出口。
// 背景：① Chromium 不支持带认证的代理（--proxy-server 无法带 user:pass），故由本模块代发 Proxy-Authorization；
//      ② nexip 网关对 Google 域名是网关级 ECONNRESET（实测 100% 复现），Google 流量必须走分流线路。
'use strict';

const http = require('http');
const net = require('net');

// Google 系域名后缀白名单（OAuth 注册链路实际会触达的域 + 常见静态资源域）
const GOOGLE_HOST_SUFFIXES = [
  'google.com', 'googleapis.com', 'gstatic.com', 'googleusercontent.com',
  'gmail.com', 'googlemail.com', 'youtube.com', 'ytimg.com', 'ggpht.com',
  'google.com.hk', 'gvt1.com', 'gvt2.com', 'recaptcha.net', 'recaptcha.google.com',
  'googletagmanager.com', 'google-analytics.com', 'googlesyndication.com',
  'googleadservices.com', 'doubleclick.net', 'withgoogle.com', 'google.page',
];

// 判定 CONNECT 目标是否为 Google 系域名。target 形如 "accounts.google.com:443"
function isGoogleHost(target) {
  const host = String(target || '').split(':')[0].trim().toLowerCase();
  if (!host) return false;
  return GOOGLE_HOST_SUFFIXES.some((sfx) => host === sfx || host.endsWith(`.${sfx}`));
}

// 构造 CONNECT 请求头（带可选 Basic 认证）。auth 为 { username?, password? }，可空
function buildConnectHead(hostPort, auth) {
  let head = `CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n`;
  if (auth && auth.username) {
    head += `Proxy-Authorization: Basic ${Buffer.from(`${auth.username}:${auth.password || ''}`).toString('base64')}\r\n`;
  }
  head += '\r\n';
  return head;
}

// 通用 CONNECT 上游拨号：向上游代理发送 CONNECT（带可选认证），返回 { socket, remaining }
// upstream.via = { host, port, username?, password? } 时走链式拨号（见 dialUpstreamVia），
// 无 via 时行为与单跳直连完全一致（nexip 路径不受影响）。
function dialUpstream(upstream, target, timeoutMs = 15000) {
  if (upstream && upstream.via && upstream.via.host && upstream.via.port) {
    return dialUpstreamVia(upstream, target, timeoutMs);
  }
  return new Promise((resolve, reject) => {
    const sock = net.connect(upstream.port, upstream.host);
    sock.setTimeout(timeoutMs);
    let buf = Buffer.alloc(0);
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(err);
    };

    sock.on('timeout', () => fail(new Error('上游连接超时')));
    sock.on('error', (e) => fail(e));

    sock.on('connect', () => {
      sock.write(buildConnectHead(target, upstream));
    });

    // 关键：握手阶段用 data 监听器收响应头；resolve 前必须移除，否则后续 TLS 数据被吞
    const onData = (chunk) => {
      if (settled) return;
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const headText = buf.slice(0, idx).toString('latin1');
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(headText);
      const status = m ? Number(m[1]) : 0;
      if (status !== 200) {
        return fail(new Error(`上游 CONNECT 返回 ${status}`));
      }
      settled = true;
      sock.setTimeout(0);
      sock.removeListener('data', onData);
      resolve({ socket: sock, remaining: buf.slice(idx + 4) });
    };
    sock.on('data', onData);
  });
}

// 链式拨号（嵌套 CONNECT）：隧道连接必须经中间代理（via，如 Clash）中转——
// udealproxy 隧道拒绝大陆来源 IP，直连必 602，故先经 Clash 出口再连隧道。
//   ① 对 via 发 CONNECT <upstream.host>:<upstream.port>（带 via 的认证头，若有）
//   ② 收到 200 后，同一 socket 上对隧道发 CONNECT <target>（带 upstream 自身的认证头，若有）
//   ③ 再收到 200 才 resolve；两段各自的剩余字节统一保留进 buf，
//      最终 remaining = 第二段响应头之后的字节（即 TLS 数据）。
//      注意：第一段剩余里可能已包含第二段响应甚至后续数据，顺序通过单一 buf 天然保证。
function dialUpstreamVia(upstream, target, timeoutMs = 15000) {
  const via = upstream.via;
  return new Promise((resolve, reject) => {
    const sock = net.connect(via.port, via.host);
    sock.setTimeout(timeoutMs);
    let buf = Buffer.alloc(0);
    let phase = 1;   // 1 = 对 via 的 CONNECT；2 = 对隧道(upstream) 的 CONNECT
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(err);
    };

    sock.on('timeout', () => fail(new Error('链式上游连接超时')));
    sock.on('error', (e) => fail(e));

    sock.on('connect', () => {
      // 第一段：CONNECT 目标是隧道入口本身
      sock.write(buildConnectHead(`${upstream.host}:${upstream.port}`, via));
    });

    const onData = (chunk) => {
      if (settled) return;
      buf = Buffer.concat([buf, chunk]);
      processBuf();
    };

    const processBuf = () => {
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const headText = buf.slice(0, idx).toString('latin1');
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(headText);
      const status = m ? Number(m[1]) : 0;
      if (status !== 200) {
        return fail(new Error(phase === 1
          ? `中间代理(via) CONNECT 返回 ${status}`
          : `上游 CONNECT 返回 ${status}`));
      }
      buf = buf.slice(idx + 4);
      if (phase === 1) {
        phase = 2;
        // 第二段：同一 socket 上对隧道发 CONNECT 目标域名
        sock.write(buildConnectHead(target, upstream));
        processBuf(); // 第一段剩余里可能已包含第二段响应甚至后续数据
        return;
      }
      settled = true;
      sock.setTimeout(0);
      sock.removeListener('data', onData);
      resolve({ socket: sock, remaining: buf });
    };
    sock.on('data', onData);
  });
}

// 启动转发器。
//   upstream:       { host, port, username?, password?, via? }  出口隧道（nexip 网关带认证 /
//                   udealproxy 白名单免认证；via 指定中间 HTTP 代理时链式拨号，如 Clash 中转）
//   googleUpstream: { host, port, username?, password? }  Google 分流线路（如 Clash，免认证，可选）
// 返回 { port, close() }
// 分流：Google 系域名 → [googleUpstream, upstream 兜底]；其余 → [upstream]。
// upstream 带 via 时所有对 upstream 的拨号（含 Google 兜底候选）均为链式拨号——
// 直连隧道在大陆必 602，兜底也必须经 via 中转（由 dialUpstream 内部自动处理）。
function startForwarder({ upstream, googleUpstream = null }) {
  if (!upstream || !upstream.host || !upstream.port) {
    return Promise.reject(new Error('startForwarder 需要提供 upstream（nexip 网关）'));
  }

  const server = http.createServer((req, res) => {
    // 仅需支持 CONNECT（目标全为 https）；普通请求直接拒绝
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('CONNECT only');
  });

  server.on('connect', async (req, clientSock, head) => {
    const target = String(req.url || '');
    // 必须在拨号前就挂 error 监听：浏览器中途断开（ECONNRESET/EPIPE 很常见）时若无监听，
    // 'error' 事件会成为未捕获异常击穿主进程；建立隧道后另有 cleanup 监听，双销毁无害
    clientSock.on('error', () => { try { clientSock.destroy(); } catch (e) { /* 忽略 */ } });
    // 分流：Google 系域名 → [分流线路, nexip 兜底]；其余 → [nexip]
    const candidates = (googleUpstream && googleUpstream.host && isGoogleHost(target))
      ? [googleUpstream, upstream]
      : [upstream];

    let established = null;
    for (const cand of candidates) {
      try {
        established = await dialUpstream(cand, target);
        break;
      } catch (e) {
        // 当前候选失败（如 Clash 未运行 / nexip 网关 RESET），尝试下一个候选
      }
    }
    if (!established) {
      clientSock.destroy();
      return;
    }

    clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) established.socket.write(head);
    if (established.remaining && established.remaining.length) clientSock.write(established.remaining);

    established.socket.pipe(clientSock);
    clientSock.pipe(established.socket);

    const cleanup = () => {
      established.socket.destroy();
      clientSock.destroy();
    };
    established.socket.on('error', cleanup);
    clientSock.on('error', cleanup);
    established.socket.on('close', cleanup);
    clientSock.on('close', cleanup);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        close: () => new Promise((r) => {
          server.close(() => r());
          // 浏览器异常死亡后可能有半开连接永不排空（server.close 会一直等连接关闭）：
          // 主动断开全部连接，防止 close() 挂死卡住整批流程
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        }),
      });
    });
  });
}

// 单次 CONNECT 探测：经指定上游访问 targetHost 是否可建立（用于线路探活/诊断）
async function probeUpstream(upstream, target = 'accounts.google.com:443', timeoutMs = 12000) {
  const { socket } = await dialUpstream(upstream, target, timeoutMs);
  socket.destroy();
  return true;
}

module.exports = { startForwarder, probeUpstream, dialUpstream, isGoogleHost, GOOGLE_HOST_SUFFIXES };

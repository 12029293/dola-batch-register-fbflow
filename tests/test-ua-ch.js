// test-ua-ch.js · UA-CH 一致性回归测试：UA 串 / Sec-CH-UA* 头 / navigator.userAgentData / connection 四者同源
'use strict';
const http = require('http');
const { chromium } = require('playwright');
const { randomFingerprint, buildInitScript, buildUAMetadata } = require('../main/fingerprint');

(async () => {
  const fp = randomFingerprint();
  const meta = buildUAMetadata(fp);

  // 单元断言：元数据与 UA 串同源
  const uaMajor = Number(fp.userAgent.match(/Chrome\/(\d+)\./)[1]);
  if (uaMajor !== fp.chromeMajor) { console.log('FAIL: UA 串版本与 chromeMajor 不一致'); process.exit(1); }
  if (meta.brands.find((b) => b.brand === 'Google Chrome').version !== String(fp.chromeMajor)) { console.log('FAIL: brands 版本与 chromeMajor 不一致'); process.exit(1); }
  if (meta.fullVersion !== `${fp.chromeMajor}.0.0.0`) { console.log('FAIL: fullVersion 不一致'); process.exit(1); }
  console.log(`PASS 单元: 元数据与 UA 串同源（Chrome/${fp.chromeMajor}）`);

  // 端到端：本地服务捕获请求头 + 页面内读 JS 视角
  let headers = null;
  const srv = http.createServer((req, res) => { headers = req.headers; res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><body>ok</body></html>'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: fp.userAgent });
  await context.addInitScript(buildInitScript(fp));

  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.setUserAgentOverride', {
    userAgent: fp.userAgent,
    acceptLanguage: 'en-US',
    platform: 'Win32',
    userAgentMetadata: meta,
  });

  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // ① 请求头：低熵 Client Hints 与元数据一致
  const secUa = headers['sec-ch-ua'] || '';
  const expectBrand = `"Google Chrome";v="${fp.chromeMajor}"`;
  if (!secUa.includes(expectBrand)) { console.log(`FAIL: sec-ch-ua=${secUa} 缺 ${expectBrand}`); process.exitCode = 1; }
  else console.log(`PASS 头: sec-ch-ua 含 ${expectBrand}`);
  if (headers['sec-ch-ua-platform'] !== '"Windows"') { console.log(`FAIL: sec-ch-ua-platform=${headers['sec-ch-ua-platform']}`); process.exitCode = 1; }
  else console.log('PASS 头: sec-ch-ua-platform = "Windows"');
  if (!String(headers['user-agent']).includes(`Chrome/${fp.chromeMajor}.0.0.0`)) { console.log('FAIL: 请求 UA 头与指纹不一致'); process.exitCode = 1; }
  else console.log(`PASS 头: User-Agent = Chrome/${fp.chromeMajor}.0.0.0`);

  // ② JS 视角：userAgentData 高熵值 + UA + connection
  const js = await page.evaluate(async () => {
    const uaData = navigator.userAgentData;
    const hi = uaData ? await uaData.getHighEntropyValues(['fullVersionList', 'uaFullVersion', 'platformVersion', 'architecture', 'bitness']) : null;
    return {
      ua: navigator.userAgent,
      brands: uaData ? uaData.brands : null,
      hi,
      conn: navigator.connection ? { rtt: navigator.connection.rtt, downlink: navigator.connection.downlink, effectiveType: navigator.connection.effectiveType, type: navigator.connection.type } : null,
      langs: navigator.languages,
    };
  });
  if (!js.ua.includes(`Chrome/${fp.chromeMajor}.0.0.0`)) { console.log(`FAIL: navigator.userAgent=${js.ua}`); process.exitCode = 1; }
  else console.log(`PASS JS: navigator.userAgent 同源`);
  const chromeFull = js.hi && js.hi.fullVersionList && js.hi.fullVersionList.find((b) => b.brand === 'Google Chrome');
  if (!chromeFull || chromeFull.version !== `${fp.chromeMajor}.0.0.0`) { console.log(`FAIL: fullVersionList=${JSON.stringify(js.hi && js.hi.fullVersionList)}`); process.exitCode = 1; }
  else console.log(`PASS JS: getHighEntropyValues().fullVersionList = ${chromeFull.version}`);
  if (js.hi.platformVersion !== '10.0.0' || js.hi.architecture !== 'x86' || js.hi.bitness !== '64') { console.log(`FAIL: 高熵平台信息不一致 ${JSON.stringify(js.hi)}`); process.exitCode = 1; }
  else console.log('PASS JS: platformVersion/architecture/bitness 同源');
  if (!js.conn) { console.log('FAIL: navigator.connection 缺失'); process.exitCode = 1; }
  else console.log(`PASS JS: connection = ${JSON.stringify(js.conn)}`);
  if (JSON.stringify(js.langs) !== JSON.stringify(['en-US', 'en'])) { console.log(`FAIL: languages=${js.langs}`); process.exitCode = 1; }
  else console.log('PASS JS: languages = en-US,en');

  await browser.close();
  srv.close();
  console.log(process.exitCode ? '=== 存在失败项 ===' : '=== 全部通过 ===');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });

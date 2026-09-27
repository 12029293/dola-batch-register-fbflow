// fingerprint.js · 指纹引擎：随机生成浏览器指纹 + 生成页面注入脚本
'use strict';

const CHROME_MAJORS = [120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133];
const VIEWPORTS = [
  [1366, 768], [1440, 900], [1536, 864], [1600, 900], [1920, 1080], [2560, 1440],
];
// 真实显卡字符串池（Windows / D3D11 口径）
const WEBGL_CONFIGS = [
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
];
const MEMORIES = [4, 8, 16];
const CPUS = [4, 6, 8, 12, 16];
const TIMEZONES = ['Asia/Shanghai', 'Asia/Shanghai', 'Asia/Shanghai', 'Asia/Urumqi'];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// 生成一份随机指纹（Windows 桌面口径，与豆包目标用户群一致）
function randomFingerprint() {
  const major = pick(CHROME_MAJORS);
  const vp = pick(VIEWPORTS);
  return {
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    chromeMajor: major,
    platform: 'Win32',
    viewport: { width: vp[0], height: vp[1] },
    // 与 launcher 的 locale:'en-US' 保持一致（Google OAuth 页面按 Accept-Language 出小语种是实锤坑）；
    // 「英文浏览器 + 上海时区」是海外华人常见组合，指纹自洽即可
    locale: 'en-US',
    timezoneId: pick(TIMEZONES),
    hardwareConcurrency: pick(CPUS),
    deviceMemory: pick(MEMORIES),
    webgl: pick(WEBGL_CONFIGS),
    canvasSeed: randInt(1, 2147483000),
    // navigator.connection 口径：与「住宅宽带/wifi」场景自洽，值按指纹稳定
    net: { rtt: pick([25, 50, 50, 75, 100]), downlink: pick([5, 10, 10, 15]) },
    generatedAt: new Date().toISOString(),
  };
}

// 生成与 UA 串严格同源的 Client Hints 元数据。
// Chromium 的 Sec-CH-UA* 请求头与 navigator.userAgentData 都由这份元数据驱动——
// 只改 UA 串不改它，会出现「UA 写 126、Client Hints 上报 130（真实内核版本）」的自相矛盾，属字节系风控经典检测点。
function buildUAMetadata(fp) {
  const major = fp.chromeMajor;
  const full = `${major}.0.0.0`;
  return {
    brands: [
      { brand: 'Not_A Brand', version: '8' },
      { brand: 'Chromium', version: String(major) },
      { brand: 'Google Chrome', version: String(major) },
    ],
    fullVersionList: [
      { brand: 'Not_A Brand', version: '8.0.0.0' },
      { brand: 'Chromium', version: full },
      { brand: 'Google Chrome', version: full },
    ],
    fullVersion: full,
    platform: 'Windows',
    platformVersion: '10.0.0',
    architecture: 'x86',
    bitness: '64',
    model: '',
    mobile: false,
    wow64: false,
  };
}

// 生成注入脚本字符串：在页面脚本运行前覆盖 navigator / WebGL / Canvas 读取接口
function buildInitScript(fp) {
  const conf = JSON.stringify({
    ua: fp.userAgent,
    platform: fp.platform,
    cores: fp.hardwareConcurrency,
    mem: fp.deviceMemory,
    langs: ['en-US', 'en'],
    vendor: fp.webgl.vendor,
    renderer: fp.webgl.renderer,
    seed: fp.canvasSeed,
    screen: { width: fp.viewport.width, height: fp.viewport.height },
    net: fp.net || { rtt: 50, downlink: 10 },
  });
  return `
(() => {
  const C = ${conf};
  const def = (obj, key, value) => {
    try { Object.defineProperty(obj, key, { get: () => value, configurable: true }); } catch (e) {}
  };
  // navigator 基础面
  def(navigator, 'userAgent', C.ua);
  def(navigator, 'appVersion', C.ua.replace(/^Mozilla\\//, ''));
  def(navigator, 'platform', C.platform);
  def(navigator, 'hardwareConcurrency', C.cores);
  def(navigator, 'deviceMemory', C.mem);
  def(navigator, 'language', C.langs[0]);
  def(navigator, 'languages', Object.freeze(C.langs.slice()));

  // navigator.connection：网络类型/质量自洽（桌面 Chrome 有此 API，缺省反而少见）
  try {
    const conn = {
      effectiveType: '4g',
      type: 'wifi',
      downlink: C.net.downlink,
      rtt: C.net.rtt,
      saveData: false,
      onchange: null,
      addEventListener: function () {},
      removeEventListener: function () {},
      dispatchEvent: function () { return false; },
    };
    def(navigator, 'connection', conn);
    if (navigator.connection !== undefined && navigator.connection !== conn) {
      def(Navigator.prototype, 'connection', conn);
    }
  } catch (e) {}

  // WebGL 厂商/型号（UNMASKED_VENDOR_WEBGL=37445 / UNMASKED_RENDERER_WEBGL=37446）
  const patchGL = (proto) => {
    if (!proto || !proto.getParameter) return;
    const orig = proto.getParameter;
    proto.getParameter = function (p) {
      if (p === 37445) return C.vendor;
      if (p === 37446) return C.renderer;
      return orig.apply(this, [p]);
    };
  };
  if (window.WebGLRenderingContext) patchGL(WebGLRenderingContext.prototype);
  if (window.WebGL2RenderingContext) patchGL(WebGL2RenderingContext.prototype);

  // 画布噪声：确定性 PRNG（mulberry32），按种子稳定加噪，同指纹同结果
  let s = C.seed >>> 0;
  const rand = () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  if (window.CanvasRenderingContext2D) {
    const origGet = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (...args) {
      const img = origGet.apply(this, args);
      try {
        const d = img.data;
        for (let i = 0; i < d.length; i += 16) {
          if (rand() > 0.5) d[i] = (d[i] + 1) & 0xff;
        }
      } catch (e) {}
      return img;
    };
  }

  // 音频指纹噪声：AudioContext 采样值加微噪
  if (window.OfflineAudioContext) {
    const origGetChan = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = function (...args) {
      const data = origGetChan.apply(this, args);
      try {
        for (let i = 0; i < data.length; i += 500) {
          data[i] = data[i] + (rand() - 0.5) * 1e-7;
        }
      } catch (e) {}
      return data;
    };
  }

  // screen 与 viewport 对齐（避免 window 尺寸与屏幕声明打架）
  try {
    if (window.screen && C.screen) {
      ['width', 'height', 'availWidth', 'availHeight'].forEach((k) => def(screen, k, C.screen[k]));
      def(screen, 'colorDepth', 24);
      def(screen, 'pixelDepth', 24);
    }
  } catch (e) {}

  // permissions.query 修正（notifications 恒为 granted/prompt，消除自动化特征）
  if (window.Notification && navigator.permissions && navigator.permissions.query) {
    const origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (p) =>
      p && p.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission, onchange: null })
        : origQuery(p);
  }
})();`;
}

module.exports = { randomFingerprint, buildInitScript, buildUAMetadata };

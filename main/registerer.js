// registerer.js · Dola 自动注册：环境浏览器内驱动 Google OAuth 登录
'use strict';

const launcher = require('./launcher');
const fs = require('fs');
const path = require('path');

const DOLA_URL = 'https://www.dola.com/chat/';
const SHOT_DIR = path.join(__dirname, '..', 'tmp_shots');

// 工具：在页面里按文本点可见按钮
// 可见性判定：fixed 定位容器的子元素 offsetParent 恒为 null——登录弹窗/遮罩场景整棵按钮树被
// 误判不可见导致点击全部落空（E2E 实锤：debug-login.png 弹窗按钮清晰可见但 120 秒匹配不到）。
// 改用 getBoundingClientRect 尺寸 + display/visibility 判定。
async function clickByText(page, text, exact = false) {
  return page.evaluate(({ text, exact }) => {
    // 大小写不敏感：en-US 页面按钮实文案为 "Log In"（大写 I），exact 匹配 'Log in' 会错失
    const norm = (s) => (s || '').trim().toLowerCase();
    const needle = norm(text);
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    for (const el of document.querySelectorAll('button, [role="button"], a')) {
      if (!isVisible(el)) continue;
      const t = norm(el.innerText);
      if (exact ? t === needle : t.includes(needle)) { el.click(); return true; }
    }
    return false;
  }, { text, exact });
}

// 工具：按文本点可见按钮（深度版）——主 frame 优先，逐个子 frame 兜底。
// Google 同意页/欢迎页的按钮可能嵌在 iframe 里（主文档 innerText 找不到）。
async function clickByTextDeep(page, text, exact = true) {
  const main = page.mainFrame ? page.mainFrame() : page;
  const frames = [main, ...page.frames().filter((f) => f !== main)];
  for (const f of frames) {
    try {
      if (await clickByText(f, text, exact)) return true;
    } catch (e) { /* 该 frame 不可用，试下一个 */ }
  }
  return false;
}

// 慢网络容错：页面加载两次重试，仍失败返回 false（由调用方标记 SLOW_NETWORK，同 IP 重试即可，不用换 IP）
async function gotoWithRetry(page, url) {
  for (let i = 0; i < 2; i += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
      return true;
    } catch (e) { /* 超时/中断：再来一次 */ }
  }
  return false;
}

// 慢网络容错：在 maxMs 内反复找按钮，走到一半还没找到就执行 halfway（如重载页面）再继续找
async function pollClick(page, targets, { maxMs = 60000, pollMs = 2000, halfway = null } = {}) {
  const deadline = Date.now() + maxMs;
  let halfDone = false;
  while (Date.now() < deadline) {
    for (const [text, exact] of targets) {
      if (await clickByText(page, text, exact).catch(() => false)) return true;
    }
    if (halfway && !halfDone && Date.now() > deadline - maxMs / 2) {
      halfDone = true;
      await halfway();
      continue;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

function slowError(msg) {
  const e = new Error(msg);
  e.code = 'SLOW_NETWORK';
  return e;
}

// 人机验证/风控拦截错误：调用方应立即换 IP + 换指纹重试，不等待人工
function captchaError(msg) {
  const e = new Error(msg);
  e.code = 'CAPTCHA';
  return e;
}

// 识别 Google 当前处于哪个状态页
async function detectGoogleState(page) {
  return page.evaluate(() => {
    const t = document.body ? document.body.innerText : '';
    const url = location.href;
    // Chrome 错误页（代理连接被重置/超时等）：可重载恢复
    if (/无法访问此网站|This site can't be reached|ERR_CONNECTION_RESET|ERR_TIMED_OUT|ERR_NAME_NOT_RESOLVED/i.test(t)) return 'net_error';
    if (/此浏览器或应用可能不安全|This browser or app may not be secure/i.test(t)) return 'blocked_browser';
    if (/Couldn't find your Google Account|找不到.{0,8}(Google )?账号/.test(t)) return 'account_not_found';
    if (/(密码|password).{0,12}(有误|不正确|incorrect)|Wrong password/i.test(t)) return 'wrong_password';
    if (/输入您听到的|Type the text you hear|此步骤旨在确认不是机器人|不是机器人|not a robot|unusual traffic|异常流量/i.test(t)) return 'need_captcha';
    // reCAPTCHA 图片挑战渲染在 iframe 里（innerText 不可见），直接探测挑战 iframe 的 title
    if (document.querySelector('iframe[title*="recaptcha challenge" i]')) return 'need_captcha';
    // 账号选择页（Google 记住了上次登录时出现）：无邮箱输入框，必须点账号行继续
    // 印尼语：Pilih akun（选择账号）/ Gunakan akun lain（使用其他账号）
    if (/选择账号|选择帐号|Choose an account|Pilih akun|gunakan akun lain/i.test(t)) return 'choose_account';
    // 密码框 selector 语言无关（input[name="Passwd"]）；印尼语文案兜底加固：「Masukkan sandi」（输入密码）
    if (document.querySelector('input[name="Passwd"]') || /masukkan sandi/i.test(t)) return 'need_password';
    if (/验证.{0,10}辅助邮箱|Confirm your recovery email|verify.{0,20}recovery email/i.test(t)) return 'need_recovery_email';
    if (/输入验证码|Enter the code/i.test(t)) return 'need_code';
    if (/2 步验证|2-Step Verification|选择一种验证方式|Choose a way to verify/i.test(t)) return 'need_2fa';
    // 授权确认页（中英多版本：旧版「想访问您的 Google 账号」/ 新版英文「Google will allow dola.com to access」
    // / 印尼语「Google akan mengizinkan dola.com mengakses info tentang Anda」，按钮 Lanjutkan(继续)/Izinkan(允许)）
    if (/(想访问您的 Google 账号|wants to access your Google Account|此应用未经过验证|hasn't been verified|hasn't approved|Google will allow .{0,60} to access|将允许 .{0,60} 访问|akan mengizinkan|mengizinkan .{0,60} (untuk|mengakses)|izinkan)/i.test(t)) return 'consent';
    // Workspace 教育版首次登录欢迎页：需滚动到底部点「我同意」，否则永远停在 unknown
    if (/欢迎使用您的新账号|Welcome to your new account|Google Workspace 教育版/i.test(t)) return 'need_welcome';
    // 欢迎条款后的年龄确认弹窗（Material 对话框：否/确认）——不点「确认」流程卡死
    if (/确认你的年龄|Confirm your age|请确认你的出生年份|confirm your birthday/i.test(t)) return 'need_age_confirm';
    if (!/accounts\.google\.com/.test(url)) {
      // OAuth 错误回跳：dola 回调带 error 参数
      if (/error=/.test(url)) return 'auth_error';
      return 'left_google';
    }
    return 'unknown';
  }).catch(() => 'page_error');
}

async function waitForStateChange(page, from, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = from;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1200));
    last = await detectGoogleState(page);
    if (last !== from && last !== 'unknown') return last;
  }
  return last;
}

// 等待 Google 邮箱输入框：期间检测连接错误页（代理 RESET 很常见）自动重载
async function waitEmailInput(g, onProgress, { tries = 3, waitMs = 30000 } = {}) {
  const sel = '#identifierId, input[type="email"], input[name="identifier"]';
  for (let i = 0; i < tries; i += 1) {
    try {
      await g.locator(sel).first().waitFor({ timeout: waitMs });
      return true;
    } catch (e) {
      if (i >= tries - 1) return false;
      const dead = await g.evaluate(() =>
        /无法访问此网站|This site can't be reached|ERR_CONNECTION|ERR_TIMED_OUT/i.test(document.body ? document.body.innerText : ''),
      ).catch(() => false);
      onProgress(dead ? 'Google 页连接被代理重置，自动重载…' : 'Google 页未出邮箱框，自动重载…');
      await g.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    }
  }
  return false;
}

// 等待 Dola 页面渲染完整：随机出口常把 CSS/JS 资源请求弄丢，页面变成无样式裸 HTML（没有登录按钮，等再久也没用）——检测到就自动重载
// 注意节奏：页面经代理加载要 15~20 秒，重载太频繁永远加载不完；间隔 ≥25 秒 + load 事件 + 磁盘缓存逐轮累积
async function waitDolaReady(page, onProgress, maxMs = 120000) {
  const deadline = Date.now() + maxMs;
  let lastReload = 0;
  let reloadCount = 0;
  let deadCount = 0;
  while (Date.now() < deadline) {
    if (await launcher.pageReady(page)) {
      // Dola 后端按出口 IP 拒绝时返回应用级错误页（渲染完整但没有登录按钮，等再久也没用）
      const dead = await page.evaluate(() =>
        /this page is temporarily unavailable|页面暂时无法访问/i.test(document.body ? document.body.innerText : ''),
      ).catch(() => false);
      if (!dead) return true;
      deadCount += 1;
      if (deadCount > 2) { onProgress('Dola 持续返回「页面暂时无法访问」（出口 IP 被拒），提前放弃本轮'); return false; }
    }
    if (Date.now() - lastReload > 25000) {
      lastReload = Date.now();
      reloadCount += 1;
      onProgress(`页面渲染不完整（样式资源丢失），第 ${reloadCount} 次自动重载…`);
      await page.reload({ waitUntil: 'load', timeout: 60000 }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}

// 主流程：在 env 的浏览器里完成 Dola 注册（Google OAuth）
// 全自动模式：遇到人机验证/风控拦截/未识别页/需辅助邮箱验证码，立即抛 CAPTCHA 错误（调用方换 IP+指纹重试），
// 不等待人工——验证即换牌。askResume 参数已移除（旧版人工问答回路废弃）。
async function registerDola({ env, account, onProgress = () => {}, saveCookies = null, autoMode = true }) {
  const running = launcher.getRunningContext(env.id);
  if (!running) throw new Error('环境未运行，请先启动环境');
  const context = running.context;

  onProgress('打开 Dola 页面（网络慢时会长一点）');
  const page = await context.newPage();
  // 清掉上次失败残留的 Dola 页面，避免旧弹窗干扰
  for (const p of context.pages()) {
    if (p !== page && /dola\.com/.test(p.url())) await p.close().catch(() => {});
  }
  let popup = null;

  try {
    const opened = await gotoWithRetry(page, DOLA_URL);
    if (!opened) throw slowError('网络过慢：Dola 页面两次加载均超时');
    await page.waitForTimeout(5000);

    onProgress('等待 Dola 页面渲染完整');
    const ready = await waitDolaReady(page, onProgress, 120000);
    if (!ready) throw slowError('网络过慢：Dola 页面 120 秒未渲染完整（CSS/JS 资源加载失败）');

    await clickByText(page, '我知道了').catch(() => {});

    onProgress('查找登录按钮（网络慢时请耐心等待）');
    // 两轮完整尝试：每轮先确保渲染完整再找 60 秒；一轮失败重载页面再来
    let clicked = false;
    for (let round = 1; round <= 2 && !clicked; round += 1) {
      await waitDolaReady(page, onProgress, 90000);
      clicked = await pollClick(page, [['登录', true], ['Log in', true], ['Sign in', true]], { maxMs: 60000 });
      if (!clicked && round === 1) {
        onProgress('未找到登录按钮，重载 Dola 再试一轮');
        await page.reload({ waitUntil: 'load', timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(3000);
      }
    }
    if (!clicked) {
      await shot(page, 'debug-login');
      throw slowError('网络过慢：两轮尝试均未找到登录按钮（截图 tmp_shots/debug-login.png，可能是 JS 资源加载失败页面未激活）');
    }
    await page.waitForTimeout(2500);

    onProgress('发起 Google 登录');
    // popup 监听必须在点击前挂上；给足 3 分钟覆盖两轮按钮轮询
    const popupPromise = context.waitForEvent('page', { timeout: 180000 }).catch(() => null);
    let gClicked = false;
    for (let round = 1; round <= 2 && !gClicked; round += 1) {
      gClicked = await pollClick(page, [['Google 登录', false], ['Sign in with Google', false], ['Continue with Google', false]], { maxMs: 45000 });
      if (!gClicked && round === 1) {
        onProgress('未找到 Google 登录按钮，重载后重试');
        await page.reload({ waitUntil: 'load', timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(3000);
        await waitDolaReady(page, onProgress, 60000);
        await pollClick(page, [['登录', true], ['Log in', true], ['Sign in', true]], { maxMs: 30000 });
        await page.waitForTimeout(2000);
      }
    }
    if (!gClicked) {
      await shot(page, 'debug-google-btn');
      throw slowError('网络过慢：未找到 Google 登录按钮（截图 tmp_shots/debug-google-btn.png）');
    }
    // 同标签页跳转的流程没有 popup：最多再等 20 秒
    popup = await Promise.race([
      popupPromise,
      new Promise((r) => setTimeout(() => r(null), 20000)),
    ]);
    const g = popup || page;
    await g.waitForLoadState('domcontentloaded').catch(() => {});
    await g.waitForTimeout(3000);

    // ---- 填账号 ----
    onProgress('填写 Google 账号');
    const emailOk = await waitEmailInput(g, onProgress, { tries: 3, waitMs: 30000 });
    if (!emailOk) {
      await shot(g, 'debug-google');
      throw slowError(`网络过慢或页面异常：Google 登录页 90 秒内未出现邮箱输入框（截图 tmp_shots/debug-google.png）`);
    }
    const emailInput = g.locator('#identifierId, input[type="email"], input[name="identifier"]').first();
    await emailInput.fill(account.email);
    await Promise.all([
      g.waitForNavigation({ timeout: 45000 }).catch(() => {}),
      (async () => {
        const nextBtn = g.locator('#identifierNext button, button:has-text("Next"), button:has-text("下一步")').first();
        await nextBtn.click({ timeout: 8000 }).catch(async () => { await g.keyboard.press('Enter'); });
      })(),
    ]);
    await g.waitForTimeout(2500);

    // ---- 状态机循环 ----
    let state = await detectGoogleState(g);
    let passwordTried = false;
    let recoveryTried = false;
    let codeTried = false;
    let consentTried = false;
    let welcomeRounds = 0;
    let ageConfirmRounds = 0;
    let unknownSince = null;
    let unknownShot = false;
    let lastLoggedState = null;
    let netRetries = 0;
    const deadline = Date.now() + 300000; // 总时限 5 分钟（全自动无人工等待，超时即换牌）

    while (Date.now() < deadline) {
      if (state === 'left_google') break;
      // OAuth 弹窗已关闭 = Google 流程已结束（无论成败），立即去验证 Dola 登录态，不再空转
      if (popup && popup.isClosed()) { onProgress('Google 弹窗已关闭'); break; }
      if (state !== lastLoggedState) { lastLoggedState = state; onProgress(`Google 状态: ${state}`); }

      if (state === 'account_not_found') throw new Error(`Google 找不到账号 ${account.email}（卡密可能无效）`);
      if (state === 'auth_error') throw new Error('Google 授权被拒/中断（常见于 IP 被限流），请稍后重试或更换代理 IP');
      if (state === 'blocked_browser') {
        // 全自动：验证即换牌——自动化浏览器被 Google 风控拦截，换 IP + 指纹重试
        throw captchaError('Google 拦截自动化浏览器（风控）');
      }
      if (state === 'wrong_password') throw new Error('密码错误，请检查卡密文件');
      // 2FA 账号换 IP 也无法解决：普通错误（非 CAPTCHA），调用方直接放弃该账号，不浪费提取预算
      if (state === 'need_2fa') throw new Error('该 Google 账号开启了 2 步验证，无法自动注册，跳过该账号');

      if (state === 'net_error') {
        netRetries += 1;
        if (netRetries > 4) throw slowError('Google 页面连接反复被代理重置（该出口 IP 质量差）');
        onProgress(`Google 页连接被重置，自动重载（${netRetries}/4）…`);
        await g.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await g.waitForTimeout(3000);
        state = await detectGoogleState(g);
        continue;
      }

      if (state === 'need_password' && !passwordTried) {
        onProgress('填写密码');
        passwordTried = true;
        // 注意：Google 会渲染隐藏假密码框 hiddenPassword，真身是 name="Passwd"
        await g.locator('input[name="Passwd"]').first().fill(account.password);
        await Promise.all([
          g.waitForNavigation({ timeout: 45000 }).catch(() => {}),
          (async () => {
            const btn = g.locator('#passwordNext button, button:has-text("Next"), button:has-text("下一步")').first();
            await btn.click({ timeout: 8000 }).catch(async () => { await g.keyboard.press('Enter'); });
          })(),
        ]);
        await g.waitForTimeout(2500);
        state = await detectGoogleState(g);
        continue;
      }

      if (state === 'need_recovery_email' && !recoveryTried) {
        if (!account.recovery) throw new Error('Google 要求验证辅助邮箱，但该账号没有辅助邮箱信息');
        onProgress('填写辅助邮箱');
        recoveryTried = true;
        await g.locator('input[type="email"], input[type="tel"], input[type="text"]').last().fill(account.recovery);
        await g.keyboard.press('Enter');
        await g.waitForTimeout(3000);
        state = await detectGoogleState(g);
        continue;
      }

      if (state === 'need_code' && !codeTried) {
        codeTried = true;
        // 全自动：验证即换牌——需要辅助邮箱验证码时无法自动应答，立即换 IP + 指纹重试
        throw captchaError('需要辅助邮箱验证码（验证即换牌）');
      }

      if (state === 'need_captcha') {
        // 全自动：验证即换牌——人机验证立即换 IP + 指纹，不等人工
        throw captchaError('Google 弹出人机验证（该 IP/指纹风控过重）');
      }

      if (state === 'choose_account') {
        // 账号选择页（Google 记住上次登录 / OAuth 带 login_hint）：点匹配账号行，没有则走「使用其他账号」。
        // 匹配优先级：① data-identifier/data-email 属性精确匹配 或 行文本含完整邮箱；
        // ② 「使用其他账号」；③ login_hint 已带出本账号时（QA 实测会列出本账号）点第一个账号行兜底。
        onProgress('选择 Google 账号');
        const picked = await g.evaluate((email) => {
          const norm = (s) => (s || '').trim();
          const emailLc = String(email || '').toLowerCase();
          const isOtherRow = (el) => /使用其他账号|Use another account|gunakan akun lain/i.test(norm(el.innerText));
          // 可见性：fixed 定位容器的子元素 offsetParent 恒为 null，改用尺寸 + display/visibility 判定
          const isVisible = (el) => {
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
            const cs = getComputedStyle(el);
            return cs.display !== 'none' && cs.visibility !== 'hidden';
          };
          const visible = [...document.querySelectorAll(
            'div[role="link"], li[role="link"], div[data-identifier], li, button, [role="button"], a',
          )].filter(isVisible);
          // ① 精确匹配：账号行携带 data-identifier/data-email（Google 标准属性）或行文本含完整邮箱
          for (const el of visible) {
            const dataEmail = norm(el.getAttribute('data-identifier') || el.getAttribute('data-email') || '').toLowerCase();
            if ((dataEmail && dataEmail === emailLc) || norm(el.innerText).includes(email)) { el.click(); return 'matched'; }
          }
          // ② 「使用其他账号」（印尼语 Gunakan akun lain 一并覆盖）
          for (const el of visible) {
            if (isOtherRow(el)) { el.click(); return 'other'; }
          }
          // ③ 兜底：点第一个「账号行」（限定 role=link / 带 data-identifier 的元素，防误点页头按钮）
          const firstRow = visible.find((el) => !isOtherRow(el)
            && (el.getAttribute('data-identifier') || el.getAttribute('role') === 'link'));
          if (firstRow) { firstRow.click(); return 'first'; }
          return false;
        }, account.email).catch(() => false);
        if (!picked) {
          // 行可能是嵌套结构，深度兜底：模糊点击账号前缀
          await clickByTextDeep(g, account.email.split('@')[0], false).catch(() => {});
        } else {
          onProgress(`已点${picked === 'matched' ? '选匹配账号' : picked === 'other' ? '「使用其他账号」' : '第一个账号行（login_hint 带出）'}`);
        }
        await g.waitForTimeout(3000);
        state = await detectGoogleState(g);
        continue;
      }

      if (state === 'need_welcome') {
        // Workspace 教育版首登欢迎页：滚动驱动的多屏条款页，「我同意」要滚到最后才出现——
        // 循环「找同意按钮 → 点自带 ↓ 按钮/滚动一屏」直到按钮出现并点掉
        welcomeRounds += 1;
        if (welcomeRounds > 3) throw new Error('Google Workspace 欢迎页连续 3 次未完成同意，请手动处理');
        onProgress(`接受 Google Workspace 欢迎条款（${welcomeRounds}/3）`);
        await shot(g, `debug-welcome-${welcomeRounds}`);
        let agreed = false;
        for (let s = 0; s < 12 && !agreed; s += 1) {
          // ① 先找同意/知悉按钮（实测按钮文案有「我了解」和「我同意」两种变体；主 frame + iframe 都找）
          agreed = await clickByTextDeep(g, '我了解').catch(() => false)
            || await clickByTextDeep(g, '我同意').catch(() => false)
            || await clickByTextDeep(g, 'I understand').catch(() => false)
            || await clickByTextDeep(g, 'I agree').catch(() => false);
          if (agreed) break;
          // ② 点页面自带的「向下」圆形按钮（aria-label 含 向下/down）
          const clickedDown = await g.evaluate(() => {
            const isVisible = (el) => {
              const r = el.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) return false;
              const cs = getComputedStyle(el);
              return cs.display !== 'none' && cs.visibility !== 'hidden';
            };
            for (const el of document.querySelectorAll('button, [role="button"]')) {
              if (!isVisible(el)) continue;
              const label = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`;
              if (/向下|下滚|scroll down|^down$/i.test(label.trim())) { el.click(); return true; }
            }
            return false;
          }).catch(() => false);
          // ③ 兜底：窗口/内层容器滚到底 + 鼠标滚轮一屏
          if (!clickedDown) {
            await g.evaluate(() => {
              const sc = document.scrollingElement || document.documentElement;
              sc.scrollTop = sc.scrollHeight;
              for (const el of document.querySelectorAll('*')) {
                if (el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 0) el.scrollTop = el.scrollHeight;
              }
            }).catch(() => {});
            await g.mouse.wheel(0, 1200).catch(() => {});
          }
          await g.waitForTimeout(1500);
        }
        if (!agreed) {
          // 最后模糊匹配兜底（有的版本按钮含图标文本）
          await clickByTextDeep(g, '了解', false).catch(() => {});
          await clickByTextDeep(g, '同意', false).catch(() => {});
          await clickByTextDeep(g, 'understand', false).catch(() => {});
          await clickByTextDeep(g, 'Agree', false).catch(() => {});
          await shot(g, `debug-welcome-${welcomeRounds}-fail`);
        }
        await g.waitForTimeout(5000);
        state = await waitForStateChange(g, 'need_welcome', 40000);
        continue;
      }

      if (state === 'need_age_confirm') {
        // 「确认你的年龄」弹窗（欢迎条款后出现）：点「确认」继续；按钮可能在 iframe 里，深度点击
        ageConfirmRounds += 1;
        if (ageConfirmRounds > 3) throw new Error('Google 年龄确认弹窗连续 3 次未完成，请手动处理');
        onProgress(`确认年龄提示（${ageConfirmRounds}/3）`);
        await shot(g, `debug-age-${ageConfirmRounds}`);
        let confirmed = await clickByTextDeep(g, '确认', true).catch(() => false);
        if (!confirmed) {
          // 兜底：模糊匹配（按钮可能带图标文本）+ Enter 提交默认项
          confirmed = await clickByTextDeep(g, '确认', false).catch(() => false)
            || await clickByTextDeep(g, 'Confirm', false).catch(() => false);
          if (!confirmed) await g.keyboard.press('Enter').catch(() => {});
        }
        await g.waitForTimeout(4000);
        state = await waitForStateChange(g, 'need_age_confirm', 30000);
        continue;
      }

      if (state === 'consent' && !consentTried) {
        consentTried = true;
        onProgress('确认授权');
        await shot(g, 'debug-consent');
        await clickByText(g, '继续').catch(() => {});
        await clickByText(g, '允许').catch(() => {});
        await clickByText(g, 'Continue').catch(() => {});
        await clickByText(g, 'Allow').catch(() => {});
        // 印尼语 OAuth 同意页：Lanjutkan（继续）/ Izinkan（允许）
        await clickByText(g, 'Lanjutkan').catch(() => {});
        await clickByText(g, 'Izinkan').catch(() => {});
        await g.waitForTimeout(4000);
        state = await waitForStateChange(g, 'consent', 20000);
        continue;
      }

      // unknown / page_error：先等 20 秒截图留证；50 秒仍未识别 → 疑似人机验证，验证即换牌；150 秒 → 放弃识别直接验证登录态
      unknownSince = unknownSince || Date.now();
      if (Date.now() - unknownSince > 20000 && !unknownShot) {
        unknownShot = true;
        await shot(g, 'debug-unknown');
      }
      const unknownMs = Date.now() - unknownSince;
      if (unknownMs > 50000) {
        // 50 秒识别不出（iframe 验证码对 innerText 不可见，多半是人机验证）→ 快速换牌
        throw captchaError('Google 停在未识别页面（疑似人机验证）');
      }
      await new Promise((r) => setTimeout(r, 2000));
      state = await detectGoogleState(g);
      if (state !== 'unknown' && state !== 'page_error') { unknownSince = null; unknownShot = false; }
    }

    if (popup && !popup.isClosed()) {
      // Google 流程可能残留未关页面
      await popup.close().catch(() => {});
    }

    // ---- 验证 Dola 登录态（中英双语）----
    onProgress('验证 Dola 登录态');
    await page.bringToFront().catch(() => {});
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(6000);
    // 登录态检测需连续两轮一致，防时序假阳性
    const checkOnce = () => page.evaluate(() => {
      const t = document.body ? document.body.innerText : '';
      // 可见性：fixed 定位容器子元素 offsetParent 恒为 null，改用尺寸 + display/visibility 判定
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden';
      };
      for (const el of document.querySelectorAll('button, [role="button"], a')) {
        // 大小写不敏感：en-US 页面实文案为 "Log In"（大写 I），精确比较 'Log in' 会漏判 → 假阳性「已登录」
        const b = (el.innerText || '').trim().toLowerCase();
        if ((b === '登录' || b === 'log in' || b === 'sign in' || b === 'sign up') && isVisible(el)) return false;
      }
      if (/登录以解锁|登录即代表|Log in to unlock/i.test(t)) return false;
      return true;
    }).catch(() => false);
    const loggedIn = (await checkOnce()) && (await new Promise((r) => setTimeout(r, 5000)).then(checkOnce));

    if (!loggedIn) {
      await shot(page, 'debug-dola-end');
      // 兜底：Google 流程已走完，Cookie 先临时保存（UI 检测可能误判，实际可能已登录）
      let cookieSaved = false;
      if (saveCookies) {
        try { await saveCookies(account.email); cookieSaved = true; } catch (e2) { /* 导出失败忽略 */ }
      }
      const err = new Error('Google 流程已走完，但 Dola 未检测到登录态' +
        (cookieSaved ? '（Cookie 已临时保存到桌面 DolaCookies，可直接导入使用）' : '（截图 tmp_shots/debug-dola-end.png）'));
      err.code = 'VERIFY_FAILED';
      throw err;
    }

    // 捕获 localStorage：Dola 登录态存在 localStorage（仅 Cookie 恢复不了会话）
    // 注意 Storage 对象没有可枚举属性，必须逐 key 读取
    const localStorageDump = await page.evaluate(() => {
      const items = [];
      try {
        for (let i = 0; i < localStorage.length; i += 1) {
          const k = localStorage.key(i);
          items.push({ k, v: localStorage.getItem(k) });
        }
      } catch (e) { /* 忽略 */ }
      return items;
    }).catch(() => []);
    onProgress('✅ 注册/登录成功');
    await page.close().catch(() => {});
    return { ok: true, localStorage: localStorageDump };
  } catch (err) {
    throw err;
  }
}

async function shot(page, name) {
  try {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SHOT_DIR, name + '.png') });
  } catch (e) { /* 忽略 */ }
}

module.exports = { registerDola };

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

// Google OAuth 驱动（从 registerDola 抽取，供直注与 FB 流程「绑定谷歌」步骤共用）：
// 在页面/弹窗 g 上完成「填邮箱 → 密码/辅助邮箱/验证码/账号选择/欢迎页/年龄确认/授权」全状态机。
// 全自动：验证即换牌（need_captcha/need_code/未识别页 50s → 抛 CAPTCHA/SLOW_NETWORK）。
// g：承载 Google OAuth 的 Page；popup：若为弹窗流程传入（用于监听弹窗关闭提前收尾），同页跳转传 null。
async function googleOAuthDrive(g, popup, account, onProgress, { deadlineMs = 300000 } = {}) {
  // ---- 填账号 ----
  onProgress('填写 Google 账号');
  const emailOk = await waitEmailInput(g, onProgress, { tries: 3, waitMs: 30000 });
  if (!emailOk) {
    await shot(g, 'debug-google');
    throw slowError('网络过慢或页面异常：Google 登录页 90 秒内未出现邮箱输入框（截图 tmp_shots/debug-google.png）');
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
  const deadline = Date.now() + deadlineMs;

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
}

// Dola 登录态检测单轮（中英双语；连续两轮一致才认定已登录，防时序假阳性——由 verifyDolaLoggedIn 组合）
function dolaLoggedInOnce(page) {
  return page.evaluate(() => {
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
      if ((b === '登录' || b === '登入' || b === 'log in' || b === 'sign in' || b === 'sign up') && isVisible(el)) return false;
    }
    if (/登录以解锁|登录即代表|登入以解鎖|Log in to unlock/i.test(t)) return false;
    return true;
  }).catch(() => false);
}

// 双轮确认登录态（registerDola 与 registerDolaViaFacebook 共用）
async function verifyDolaLoggedIn(page) {
  const first = await dolaLoggedInOnce(page);
  if (!first) return false;
  await new Promise((r) => setTimeout(r, 5000));
  return dolaLoggedInOnce(page);
}

// 捕获 localStorage：Dola 登录态存在 localStorage（仅 Cookie 恢复不了会话）
// 注意 Storage 对象没有可枚举属性，必须逐 key 读取
async function dumpDolaLocalStorage(page) {
  return page.evaluate(() => {
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

// 主流程：在 env 的浏览器里完成 Dola 注册（Google OAuth）
// 全自动模式：遇到人机验证/风控拦截/未识别页/需辅助邮箱验证码，立即抛 CAPTCHA 错误（调用方换 IP+指纹重试），
// 不等待人工——验证即换牌。askResume 参数已移除（旧版人工问答回路废弃）。
async function registerDola({ env, account, onProgress = () => {}, saveCookies = null, autoMode = true, keepOpen = false }) {
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

    // ---- Google OAuth 驱动（状态机已抽取复用：直注与 FB 流程绑定谷歌共用） ----
    // 直注总时限 5 分钟（与旧版一致）；FB 流程的绑定步骤由 registerDolaViaFacebook 按 8 分钟总预算传入
    await googleOAuthDrive(g, popup, account, onProgress, { deadlineMs: 300000 });

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
    const loggedIn = await verifyDolaLoggedIn(page);

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
    const localStorageDump = await dumpDolaLocalStorage(page);
    onProgress('✅ 注册/登录成功');
    if (keepOpen) {
      // 保留窗口模式：工作页停在已登录的 Dola 画面，关掉 launcher 的初始旧页（未登录旧画面）
      for (const p of context.pages()) {
        if (p !== page) await p.close().catch(() => {});
      }
    } else {
      await page.close().catch(() => {});
    }
    return { ok: true, localStorage: localStorageDump };
  } catch (err) {
    throw err;
  }
}

// ==================== Facebook 登录 → 绑定谷歌 → 解绑 Facebook 流程 ====================

// 浏览器端探针：收集 Facebook 登录/OAuth 页的纯数据（语言无关，selector 为主 + 文本兜底）
// 注意：必须自包含（序列化进浏览器执行），不得引用外部变量
function fbLoginProbe() {
  return (() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const email = document.querySelector('input#email, input[name="email"], input[type="email"]');
    const pass = document.querySelector('input#pass, input[name="pass"]');
    const loginBtn = document.querySelector('button[name="login"], #loginbutton');
    const captchaIframe = document.querySelector('iframe[title*="captcha" i], iframe[src*="captcha" i], iframe[src*="recaptcha" i]');
    return {
      url: location.href,
      text: document.body ? document.body.innerText.slice(0, 4000) : '',
      hasEmail: Boolean(email && isVisible(email)),
      hasPass: Boolean(pass && isVisible(pass)),
      emailVal: email ? String(email.value || '') : '',
      hasLoginBtn: Boolean(loginBtn && isVisible(loginBtn)),
      hasCaptchaIframe: Boolean(captchaIframe),
    };
  })();
}

// 纯函数：FB 探针数据 → 状态（可离线单测；detectFacebookState 的判定核心）
function facebookStateFromProbe(p) {
  if (!p) return 'page_error';
  const t = String(p.text || '');
  const url = String(p.url || '');
  if (/无法访问此网站|This site can't be reached|ERR_CONNECTION_RESET|ERR_TIMED_OUT|ERR_NAME_NOT_RESOLVED/i.test(t)) return 'net_error';
  // 两步验证/自动安全检查页（登录后 FB 风控："Running security checks…automatically redirected"）
  // 特征：URL two_step_verification 或页面文案——处理方式是安静等待自动跳转，不能乱点
  if (/two_step_verification|twofactor|two-factor|running security checks|verify this login/i.test(`${url} ${t}`)) return 'two_step';
  if (p.hasCaptchaIframe || /安全验证|人机验证|请输入图片中的|security check|enter the code|captcha/i.test(t)) return 'need_captcha';
  // 密码错误/账号不存在（FB 中英多文案）——注意先于表单态判定（错误提示与表单常同页出现）
  if (/密码不正确|您输入的密码有误|the password (that )?you('ve| have)? entered|incorrect password|the login information you entered is incorrect|找不到你的账号|isn't connected to an account|not connected to an account|找不到帐户/i.test(t)) return 'wrong_credentials';
  // 安全检查页（checkpoint / 疑似异常登录 / 账号锁定）
  if (/checkpoint|确认这是你|confirm (that it's|your) (identity|you)|suspicious|异常登录|帐号已被锁定|账号已被锁定|account has been locked/i.test(`${url} ${t}`)) return 'checkpoint';
  // 「保存浏览器」提示（登录成功后）
  if (/保存浏览器|記住瀏覽器|记住浏览器|save (your )?(browser|login info)|save this browser/i.test(t)) return 'save_browser';
  // OAuth 确认页（继续使用 XXX / Continue as XXX）——含印尼语（FB 账号界面语言可能为 id：
  // 「Lanjutkan sebagai Terry」=以 Terry 身份继续；Anda sebelumnya login…=你之前用 FB 登录过 Dola）
  if (/continue as |lanjut(kan)? sebagai|teruskan|sebelumnya login|以.{0,30}(身份|身分)(繼續|继续)|繼續使用|继续使用/i.test(t)) return 'oauth_confirm';
  // 登录表单态：密码框可见且邮箱已有值 → 只需补密码（FB 预带邮箱/两字段同页邮箱已填）；
  // 邮箱框可见但为空 → 先填邮箱（修复：曾误用 hasEmail「框存在」当「已填」，导致邮箱空着直接填密码）
  if (p.hasPass && p.emailVal) return 'need_password';
  if (p.hasEmail) return 'need_email';
  if (p.hasPass) return 'need_password';
  if (!/facebook\.com/.test(url)) {
    // 仅当已回到 Dola 域才判定流程结束；about:blank / 中转页一律视为加载中（unknown，由轮询兜底）
    if (/dola\.com/.test(url)) return 'left_facebook';
    return 'unknown';
  }
  return 'unknown';
}

// 识别 Facebook 当前处于哪个状态页（探针失败归 page_error）
async function detectFacebookState(page) {
  const probe = await page.evaluate(fbLoginProbe).catch(() => null);
  return facebookStateFromProbe(probe);
}

// 纯函数：帳號設定行文本 → 绑定状态（可离线单测）
// 'bind'=待绑定（前往綁定/前往绑定/Bind）；'bound'=已绑定（行内显示邮箱）；'unbind'=可解绑（解除綁定/Unbind）
function classifyBindRow(text) {
  const t = String(text || '');
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(t)) return 'bound';
  if (/解除綁定|解除绑定|解绑|解綁|unbind|unlink|remove|移除/i.test(t)) return 'unbind';
  if (/前往綁定|前往绑定|綁定|绑定|bind|link/i.test(t)) return 'bind';
  return 'unknown';
}

// 纯函数：从帳號設定候选行文本中挑出指定平台（google/facebook）的行并给出状态。
// 取包含平台关键词的最短文本（叶节点），避免把整块面板文本误判为行。
function rowStateFromTexts(rows, kind) {
  const kindRe = kind === 'google' ? /google|谷歌/i : /facebook|臉書|脸书/i;
  const candidates = (Array.isArray(rows) ? rows : [])
    .filter((t) => kindRe.test(String(t)))
    .sort((a, b) => String(a).length - String(b).length);
  if (!candidates.length) return { present: false, state: 'absent', text: '' };
  const text = String(candidates[0]);
  return { present: true, state: classifyBindRow(text), text };
}

// 帳號設定面板探针：收集可见短文本行（含绑定关键词或邮箱）
function accountRowsProbe() {
  return (() => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const out = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('body *')) {
      if (!isVisible(el)) continue;
      const t = (el.innerText || '').trim();
      if (!t || t.length > 120) continue;
      if (!/(手機號碼|手机号码|phone|google|facebook|臉書|脸書|脸书|apple)/i.test(t)) continue;
      if (!/(綁定|绑定|bind|unlink|unbind|remove|移除|解除|@)/i.test(t)) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    return out;
  })();
}

// 宽松版按文本点击：全文档找含目标文本的可见元素，点「最短匹配」（叶节点优先，触发冒泡到行/按钮）
async function clickByTextBroad(page, text, exact = false) {
  return page.evaluate(({ text, exact }) => {
    const norm = (s) => (s || '').trim().toLowerCase();
    const needle = norm(text);
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    let best = null;
    let bestLen = Infinity;
    for (const el of document.querySelectorAll('body *')) {
      if (!isVisible(el)) continue;
      const t = norm(el.innerText || '');
      if (!t) continue;
      const hit = exact ? t === needle : t.includes(needle);
      if (!hit) continue;
      if (t.length < bestLen) { best = el; bestLen = t.length; }
    }
    if (!best) return false;
    best.click();
    return true;
  }, { text, exact });
}

// 行内动作点击：在含平台关键词的行内点含动作关键词的最短元素。
// 防御性定位（QA P1-2）：行 DOM 可能是 `<div class=row><span>Google</span><button>前往綁定</button></div>`——
// 最短 kindEl 是无子树的 `<span>Google</span>` 叶子。策略：
// ① kindEls 短→长逐个在其子树找动作按钮（完整行容器通常也在候选里），首个命中即用；
// ② ①全空时沿父链向上找「含平台关键词且子树含动作按钮、且不是整块面板（innerText<200）」的祖先。
// kindRe/actionRe 为正则源字符串（page.evaluate 不可传 RegExp 实例的场景用字符串中转）。
// 返回 { row, btn } 或 null（未找到，调用方截图 + 抛错走换指纹重试）。
async function clickActionInRow(page, kindReSrc, actionReSrc) {
  return page.evaluate(({ kindReSrc, actionReSrc }) => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const kindRe = new RegExp(kindReSrc, 'i');
    const actRe = new RegExp(actionReSrc, 'i');
    const all = [...document.querySelectorAll('body *')].filter((el) => isVisible(el) && (el.innerText || '').trim());
    const findBtn = (root) => {
      const cands = [root, ...root.querySelectorAll('*')].filter((el) => isVisible(el) && actRe.test(el.innerText || ''));
      return cands.length ? cands.sort((a, b) => a.innerText.length - b.innerText.length)[0] : null;
    };
    // ① 含平台关键词的候选（短→长：标签叶子 → 完整行 → 更大容器）
    const kindEls = all.filter((el) => kindRe.test(el.innerText)).sort((a, b) => a.innerText.length - b.innerText.length);
    for (const row of kindEls) {
      const btn = findBtn(row);
      if (btn) {
        btn.click();
        return { row: row.innerText.slice(0, 80), btn: btn.innerText.slice(0, 40) };
      }
    }
    // ② 父链兜底：从最短候选向上找子树含动作按钮的祖先（防面板过大误中，限 6 层 + innerText<200）
    for (const leaf of kindEls.slice(0, 5)) {
      let anc = leaf.parentElement;
      for (let hop = 0; anc && hop < 6; hop += 1) {
        if (!isVisible(anc) || anc === document.body) { anc = anc.parentElement; continue; }
        if ((anc.innerText || '').length < 200) {
          const btn = findBtn(anc);
          if (btn) {
            btn.click();
            return { row: anc.innerText.slice(0, 80), btn: btn.innerText.slice(0, 40) };
          }
        }
        anc = anc.parentElement;
      }
    }
    return null;
  }, { kindReSrc, actionReSrc }).catch(() => null);
}

// 多策略定位并点击左下角齿轮设置图标（无文字：aria-label → 左下角坐标启发式）。
// 点击用鼠标坐标（齿轮外层可能不是 button，element.click() 未必触发）。
async function clickGearIcon(page, onProgress) {
  const findGear = (strategy) => page.evaluate((strategy) => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cands = [...document.querySelectorAll('button, [role="button"], [aria-label], svg, img, i, span')].filter(isVisible);
    for (const el of cands) {
      const r = el.getBoundingClientRect();
      // 齿轮图标尺寸约束：排除正文/整块容器
      if (r.width <= 0 || r.width > 80 || r.height <= 0 || r.height > 80) continue;
      if (strategy === 'aria') {
        const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`;
        if (/settings?|设置|設定/i.test(label)) {
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      } else {
        // 左下角启发式：viewport 左侧 1/3 + 下半屏区域内的可点击小图标
        if (r.left < vw / 3 && r.top > vh * 0.55) {
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
    }
    return null;
  }, strategy).catch(() => null);

  for (const strategy of ['aria', 'bottom-left']) {
    const pt = await findGear(strategy);
    if (pt) {
      onProgress(`点击设置齿轮（策略：${strategy === 'aria' ? 'aria-label' : '左下角坐标'}）`);
      await page.mouse.click(pt.x, pt.y).catch(() => {});
      return true;
    }
  }
  // TODO 截图调试：若真实页面齿轮定位仍失败，用 tmp_shots/debug-gear.png 确认 DOM 结构后补策略
  await shot(page, 'debug-gear');
  throw slowError('未找到设置齿轮图标（截图 tmp_shots/debug-gear.png，需人工确认 UI 结构后补充定位策略）');
}

// Facebook OAuth 驱动（状态机，参考 detectGoogleState 风格）：
// need_email → need_password → save_browser/oauth_confirm → left_facebook。
// 全自动：wrong_credentials 抛普通错误（配置问题不换牌）；need_captcha/checkpoint/unknown 50s 抛 CAPTCHA。
async function driveFacebookOAuth(g, fbAccount, onProgress, { deadlineMs = 240000 } = {}) {
  const deadline = Date.now() + deadlineMs;
  let state = await detectFacebookState(g);
  let emailTried = false;
  let passTried = false;
  let savedTried = false;
  let twoStepWaits = 0;
  let confirmTried = false;
  let netRetries = 0;
  let unknownSince = null;
  let unknownShot = false;
  let lastLogged = null;

  const clickLoginBtn = async () => {
    await g.locator('button[name="login"]').first().click({ timeout: 8000 })
      .catch(async () => {
        // 2026-09-28 实测：新版 FB 登录页输入框 id 是 React 随机串，button[name=login] 也可能缺失——按可见文本兜底，最后 Enter 提交
        const byText = await clickByText(g, 'Log in', true).catch(() => false)
          || await clickByText(g, '登录', true).catch(() => false)
          || await clickByText(g, '登入', true).catch(() => false);
        if (!byText) await g.keyboard.press('Enter');
      });
  };

// 拟人化输入：点击聚焦 → 清空 → 逐键输入（随机 55~145ms/键）→ 随机停顿。
// fill() 瞬间置值是 FB 行为风控的重点识别特征（实测触发人机验证）
async function humanType(g, locator, text) {
  await locator.click({ timeout: 8000 }).catch(() => {});
  await locator.fill('').catch(() => {});
  await locator.pressSequentially(String(text), { delay: 55 + Math.floor(Math.random() * 90) });
  await g.waitForTimeout(300 + Math.floor(Math.random() * 400));
}

  while (Date.now() < deadline) {
    if (state === 'left_facebook') break;
    if (g.isClosed && g.isClosed()) { onProgress('Facebook 弹窗已关闭'); break; }
    if (state !== lastLogged) { lastLogged = state; onProgress(`Facebook 状态: ${state}`); }

    if (state === 'wrong_credentials') {
      // 邮箱从未填过时，「找不到账号」多半是邮箱空着提交导致的——先补填邮箱，不急着判死
      if (!emailTried) { state = 'need_email'; continue; }
      const wcUrl = g.url();
      onProgress(`FB 判定凭据错误（url=${String(wcUrl).slice(0, 90)}），留证…`);
      await g.waitForTimeout(4000).catch(() => {});
      await shot(g, 'debug-fb-wrongcreds').catch(() => {});
      throw new Error(`Facebook 凭据被拒（url=${String(wcUrl).slice(0, 60)}），请检查 config/app.json 的 facebook 配置或人工登录核查账号状态`);
    }
    if (state === 'two_step') {
      // FB「Running security checks」自动风控检查页：会自动跳转，只需安静等待轮询。
      // 实测等 8s×10=80s 内基本完成；期间点击任何东西都可能干扰检查流程
      twoStepWaits += 1;
      if (twoStepWaits > 12) {
        await shot(g, 'debug-fb-twostep').catch(() => {});
        throw captchaError(`Facebook 安全检查页超时未跳转（url=${String(g.url() || '').slice(0, 60)}）`);
      }
      onProgress(`FB 自动安全检查进行中，等待跳转（${twoStepWaits}/12）…`);
      await g.waitForTimeout(8000).catch(() => {});
      state = await detectFacebookState(g);
      continue;
    }
    if (state === 'need_captcha') {
      // 等 checkpoint 页渲染完再截图留证（刚跳转时常是空白页，证据无效）
      const capUrl = g.url();
      onProgress(`疑似人机验证（url=${String(capUrl).slice(0, 90)}），等 8 秒留证…`);
      await g.waitForTimeout(8000).catch(() => {});
      await shot(g, 'debug-fb-captcha').catch(() => {});
      throw captchaError(`Facebook 弹出人机验证（url=${String(capUrl).slice(0, 60)}）`);
    }
    if (state === 'checkpoint') {
      const cpUrl = g.url();
      onProgress(`安全检查页（url=${String(cpUrl).slice(0, 90)}），等 8 秒留证…`);
      await g.waitForTimeout(8000).catch(() => {});
      await shot(g, 'debug-fb-checkpoint').catch(() => {});
      throw captchaError(`Facebook 安全检查 checkpoint（url=${String(cpUrl).slice(0, 60)}）`);
    }

    if (state === 'net_error') {
      netRetries += 1;
      if (netRetries > 4) throw slowError('Facebook 页面连接反复被代理重置（该出口 IP 质量差）');
      onProgress(`Facebook 页连接被重置，自动重载（${netRetries}/4）…`);
      await g.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await g.waitForTimeout(3000).catch(() => {});
      state = await detectFacebookState(g);
      continue;
    }

    if (state === 'need_email' && !emailTried) {
      onProgress('填写 Facebook 邮箱');
      emailTried = true;
      await shot(g, 'debug-fb-before-email').catch(() => {});
      await humanType(g, g.locator('input#email, input[name="email"], input[type="email"]').first(), fbAccount.email);
      // 两字段同页布局：密码框可见就把密码一起填好再点登录——
      // 「邮箱+空密码」提交会白烧一次失败尝试并拉升 FB 风控等级（实测导致人机验证）
      const passAlso = g.locator('input#pass, input[name="pass"]').first();
      if (await passAlso.isVisible().catch(() => false)) {
        onProgress('同页检测到密码框，一并填写');
        await humanType(g, passAlso, fbAccount.password).catch(() => {});
        await g.keyboard.press('Escape').catch(() => {});
      }
      await clickLoginBtn();
      await g.waitForTimeout(3000).catch(() => {});
      state = await detectFacebookState(g);
      continue;
    }

    if (state === 'need_password' && !passTried) {
      onProgress('填写 Facebook 密码');
      passTried = true;
      await shot(g, 'debug-fb-before-pass').catch(() => {});
      await humanType(g, g.locator('input#pass, input[name="pass"]').first(), fbAccount.password);
      // Chrome 会在输入密码后弹「顯示儲存的密碼嗎？」浏览器级气泡（页面 DOM 点不到），
      // 可能遮挡 Log in 按钮——按 Escape 关掉再点登录
      await g.keyboard.press('Escape').catch(() => {});
      await g.waitForTimeout(300);
      await clickLoginBtn();
      await g.waitForTimeout(3000).catch(() => {});
      state = await detectFacebookState(g);
      continue;
    }

    if (state === 'save_browser' && !savedTried) {
      // 「保存浏览器」提示：点保存/跳过均可（宽松匹配，点了哪个都行）
      savedTried = true;
      onProgress('处理「保存浏览器」提示');
      const saved = await clickByTextBroad(g, '保存', false).catch(() => false)
        || await clickByTextBroad(g, '儲存', false).catch(() => false)
        || await clickByTextBroad(g, 'Save', false).catch(() => false)
        || await clickByTextBroad(g, '跳過', true).catch(() => false)
        || await clickByTextBroad(g, '跳过', true).catch(() => false)
        || await clickByTextBroad(g, 'Skip', true).catch(() => false)
        || await clickByTextBroad(g, '稍后', true).catch(() => false)
        || await clickByTextBroad(g, '稍後', true).catch(() => false);
      if (!saved) onProgress('未找到保存/跳过按钮，等待页面自行跳转');
      await g.waitForTimeout(3000).catch(() => {});
      if (g.isClosed && g.isClosed()) break;
      state = await detectFacebookState(g);
      continue;
    }

    if (state === 'oauth_confirm' && !confirmTried) {
      // OAuth 确认页（Continue as XXX / 以 XXX 身份繼續 / Lanjutkan sebagai XXX[印尼]）
      confirmTried = true;
      onProgress('确认 Facebook OAuth 授权');
      // 前缀匹配确认文案，取最大的可见主按钮点击（蓝 CTA 最大），不受语言词尾变化影响
      const clicked = await g.evaluate(() => {
        const isVisible = (el) => {
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          const cs = getComputedStyle(el);
          return cs.display !== 'none' && cs.visibility !== 'hidden';
        };
        const RE = /^(lanjut(kan)?( sebagai)?|teruskan|continue( as)?|繼續|继续|以.{0,20}(身份|身分|身份))/i;
        let best = null; let bestArea = 0;
        for (const el of document.querySelectorAll('button, [role="button"], a, div[tabindex], span')) {
          if (!isVisible(el)) continue;
          const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
          if (!t || t.length > 60 || !RE.test(t)) continue;
          const r = el.getBoundingClientRect();
          const area = r.width * r.height;
          if (area > bestArea) { best = el; bestArea = area; }
        }
        if (best) { best.click(); return true; }
        return false;
      }).catch(() => false);
      if (!clicked) await g.keyboard.press('Enter').catch(() => {});
      // 授权完成时 FB 弹窗会立即自关（成功信号）——waitForTimeout 可能撞上已关闭页
      await g.waitForTimeout(3000).catch(() => {});
      if (g.isClosed && g.isClosed()) break;
      state = await detectFacebookState(g);
      continue;
    }

    // unknown / page_error：等 20 秒截图留证，50 秒未识别 → 疑似人机验证换牌
    unknownSince = unknownSince || Date.now();
    if (Date.now() - unknownSince > 20000 && !unknownShot) {
      unknownShot = true;
      await shot(g, 'debug-fb-unknown');
    }
    if (Date.now() - unknownSince > 50000) {
      throw captchaError('Facebook 停在未识别页面（疑似人机验证）');
    }
    await new Promise((r) => setTimeout(r, 2000));
    state = await detectFacebookState(g);
    if (state !== 'unknown' && state !== 'page_error') { unknownSince = null; unknownShot = false; }
  }

  if (state !== 'left_facebook' && !(g.isClosed && g.isClosed())) {
    throw slowError('Facebook 登录/OAuth 流程超时未完成');
  }
}

// OAuth 目标仲裁（QA P2-1）：等待「同页跳转到 OAuth 域」或「新弹窗导航到 OAuth 域」二者其一。
// 弹窗创建时 URL 是 about:blank，无法创建即区分——轮询 context.pages() 等其导航完成后按域名匹配，
// 迟到弹窗（超过固定 race 时限才出现）天然被覆盖，不再有 20s 后放弃监听的问题。
// 返回 { target, popup }：弹窗命中 → target=popup；同页跳转 → target=page, popup=null；超时 → 同页兜底。
async function waitForOAuthTarget(context, page, { maxMs = 45000, pollMs = 1500, domainRe = /facebook\.com|accounts\.google\.com/ } = {}) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    // ① 同页跳转（无弹窗流程）
    if (domainRe.test(page.url() || '')) return { target: page, popup: null };
    // ② 弹窗（含轮询开始前已创建的）：扫描上下文里域名匹配的其它页面
    const pop = context.pages().find((p) => p !== page && !p.isClosed() && domainRe.test(p.url() || ''));
    if (pop) return { target: pop, popup: pop };
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { target: page, popup: null };
}

// 等待 FB OAuth 入口页就绪（点击图标后弹窗/同页加载完成）：unknown/page_error 轮询至出现可识别状态
async function waitForFacebookEntry(g, onProgress, maxMs = 90000) {
  const deadline = Date.now() + maxMs;
  let state = await detectFacebookState(g);
  while (Date.now() < deadline && (state === 'unknown' || state === 'page_error')) {
    await new Promise((r) => setTimeout(r, 2000));
    state = await detectFacebookState(g);
  }
  if (state === 'left_facebook') throw new Error('点击 Facebook 图标后未进入 Facebook 登录页（页面直接回跳）');
  onProgress(`Facebook 登录页已就绪（状态: ${state}）`);
  return state;
}

// 轮询帳號設定行状态直至达到期望状态（verify 绑定/解绑结果共用）。
// wantState=null：仅等待行出现（present 即返回，用于面板渲染等待）。
async function waitForRowState(page, kind, wantState, { maxMs = 30000, onTick = null } = {}) {
  const deadline = Date.now() + maxMs;
  let last = null;
  while (Date.now() < deadline) {
    const rows = await page.evaluate(accountRowsProbe).catch(() => []);
    last = rowStateFromTexts(rows, kind);
    if (wantState === null) {
      if (last.present) return last;
    } else if (last.present && last.state === wantState) {
      return last;
    }
    if (onTick) onTick(last);
    await new Promise((r) => setTimeout(r, 2000));
  }
  return last;
}

// 多语言轮询点击（zh-TW/zh-CN/en 至少三语，复用 pollClick 的节奏控制）
async function pollClickBroad(page, targets, { maxMs = 45000, pollMs = 2000 } = {}) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    for (const [text, exact] of targets) {
      if (await clickByTextBroad(page, text, exact).catch(() => false)) return true;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

// 点击登录弹窗里的 Facebook 圆形图标（实测 DOM：无任何 facebook 文字标记，纯 SVG）。
// 2026-09-28 探针实锤（tmp_shots/probe4-seg.txt）：弹窗内 Google 大按钮下方一行三个圆标
// div[class*="button-"]（含 svg.size-24，均无 aria/文本），DOM 序 = f(脸书) → 电话 → Apple。
// 三层策略：
//   ① SVG path 特征：Facebook 圆形 logo 的 path d 含特征片段（对 UI 改版最稳，logo 不会变）；
//   ② 结构定位：Google 按钮正下方、同一行、尺寸相近的小图标组（≥3 个）取最左（f 在最左）；
//   ③ 关键词兜底：旧 aria/href/alt/文本含 facebook 的最小可见元素。
async function clickFacebookIcon(page) {
  const rect = await page.evaluate(() => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    // 从元素向上找最近的可点击祖先（div.button-*/clickable/cursor-pointer/button/a）
    const clickableAncestor = (el) => {
      let node = el;
      for (let i = 0; i < 5 && node; i += 1) {
        const tag = node.tagName;
        const cls = String(node.className && node.className.baseVal !== undefined ? node.className.baseVal : node.className || '');
        if (/^(button|a)$/i.test(tag) || node.getAttribute('role') === 'button'
          || /clickable|cursor-pointer/i.test(cls) || /(^|\s)button-/.test(cls)) {
          const r = node.getBoundingClientRect();
          if (r.width > 0 && r.width <= 120 && r.height > 0 && r.height <= 120) return node;
        }
        node = node.parentElement;
      }
      return null;
    };
    const center = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };

    // ① SVG path 特征（Facebook 圆形 logo，特征片段取自实测 DOM）
    const FB_PATH_RE = /8\.86-10\.435C22\.5 6\.73 17\.798 2 12 2|17\.798 2 12 2['"]?\s*$|v7\.383c5\.02-\.792/;
    for (const path of document.querySelectorAll('svg path')) {
      const d = path.getAttribute('d') || '';
      if (!FB_PATH_RE.test(d)) continue;
      const target = clickableAncestor(path.closest('svg')) || path.closest('svg');
      if (target && isVisible(target)) return center(target);
    }

    // ② 结构定位：找 Google 登录大按钮 → 收集其下方同行的小图标（≤64px、含 svg、可点击类），≥3 个取最左
    const norm = (s) => (s || '').trim().toLowerCase();
    let googleBtn = null;
    for (const el of document.querySelectorAll('button, [role="button"], div, a')) {
      if (!isVisible(el)) continue;
      const t = norm(el.innerText);
      if (/^(continue with google|使用 google 登入|透過 google 繼續|通过 google 登录)$/.test(t)) { googleBtn = el; break; }
    }
    if (googleBtn) {
      const gr = googleBtn.getBoundingClientRect();
      const icons = [];
      for (const el of document.querySelectorAll('div, button, a, [role="button"]')) {
        if (!isVisible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 16 || r.width > 64 || r.height <= 16 || r.height > 64) continue;
        if (!el.querySelector('svg')) continue;
        const cls = String(el.className || '');
        if (!(/button-|clickable|cursor-pointer/i.test(cls) || /^(button|a)$/i.test(el.tagName))) continue;
        // 在 Google 按钮下方（y 中心大于按钮底边），且横向大致在弹窗区域内
        if (r.top < gr.bottom - 8) continue;
        if (r.left < gr.left - 200 || r.right > gr.right + 400) continue;
        icons.push(el);
      }
      // 按行分组（y 中心 ±14px），取包含 ≥3 个图标的最上流行中的最左者
      icons.sort((a, b) => (a.getBoundingClientRect().top - b.getBoundingClientRect().top)
        || (a.getBoundingClientRect().left - b.getBoundingClientRect().left));
      const rows = [];
      for (const el of icons) {
        const y = el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2;
        const row = rows.find((rw) => Math.abs(rw.y - y) < 14);
        if (row) row.items.push(el);
        else rows.push({ y, items: [el] });
      }
      for (const row of rows) {
        if (row.items.length >= 3) {
          row.items.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
          if (isVisible(row.items[0])) return center(row.items[0]);
        }
      }
      // 行不足 3 个（截断/改版）：退而取按钮下方第一个图标（最上、最左）
      if (icons.length && isVisible(icons[0])) return center(icons[0]);
    }

    // ③ 关键词兜底（旧策略）
    const RE = /facebook|臉書|脸書|脸书/;
    let best = null;
    let bestArea = Infinity;
    for (const el of document.querySelectorAll('a, button, [role="button"], [aria-label], img, svg, i, span, div')) {
      if (!isVisible(el)) continue;
      const label = [
        el.getAttribute && el.getAttribute('aria-label'),
        el.getAttribute && el.getAttribute('href'),
        el.tagName === 'IMG' ? el.getAttribute('alt') : '',
        (el.innerText || '').slice(0, 60),
      ].join(' ');
      if (!RE.test(label)) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.width > 300 || r.height <= 0 || r.height > 120) continue;
      const area = r.width * r.height;
      if (area < bestArea) { best = el; bestArea = area; }
    }
    if (best) return center(best);
    return null;
  }).catch(() => null);
  if (!rect) return false;
  await page.mouse.click(rect.x, rect.y).catch(() => {});
  return true;
}

// 弹窗容器探测：[role=dialog]/[role=alertdialog]/.modal/class 含 modal|dialog，或全屏 fixed/absolute 遮罩容器
function dialogRootExists() {
  return (() => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    for (const el of document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, [class*="modal" i], [class*="dialog" i]')) {
      if (isVisible(el)) return true;
    }
    // 兜底：全屏 fixed/absolute 遮罩（确认弹窗的 backdrop 容器，占 viewport ≥60%）
    for (const el of document.querySelectorAll('body > div, body > div > div')) {
      const cs = getComputedStyle(el);
      if (!/(fixed|absolute)/.test(cs.position) || !isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width >= innerWidth * 0.6 && r.height >= innerHeight * 0.6 && el.querySelector('button, [role="button"]')) return true;
    }
    return false;
  })();
}

// 在弹窗容器子树内按文本点击（容器判定同 dialogRootExists；取容器内最短匹配元素）
async function clickInDialogText(page, text, exact) {
  return page.evaluate(({ text, exact }) => {
    const norm = (s) => (s || '').trim().toLowerCase();
    const needle = norm(text);
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const containers = [];
    for (const el of document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, [class*="modal" i], [class*="dialog" i]')) {
      if (isVisible(el)) containers.push(el);
    }
    for (const el of document.querySelectorAll('body > div, body > div > div')) {
      const cs = getComputedStyle(el);
      if (!/(fixed|absolute)/.test(cs.position) || !isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width >= innerWidth * 0.6 && r.height >= innerHeight * 0.6) containers.push(el);
    }
    if (!containers.length) return false;
    let best = null;
    let bestLen = Infinity;
    for (const c of containers) {
      for (const el of [c, ...c.querySelectorAll('*')]) {
        if (!isVisible(el)) continue;
        const t = norm(el.innerText || '');
        if (!t) continue;
        const hit = exact ? t === needle : t.includes(needle);
        if (hit && t.length < bestLen) { best = el; bestLen = t.length; }
      }
    }
    if (!best) return false;
    best.click();
    return true;
  }, { text, exact });
}

// 解绑 Facebook 的确认弹窗（文案未知，宽松匹配）。
// 防御性（QA P1-1，补测 B1 实锤）：弹窗是点击 FB 行后异步渲染的——弹窗出现前，页面上刚绑定的
// Google 行/手机行自身就带「解除綁定/移除」按钮，全文档扫描会误点谷歌行的解绑按钮，产出
// 「谷歌被解绑+FB 未解绑」脏状态烧号。因此：
//  ① 先轮询等弹窗容器出现；候选点击一律限定在弹窗容器子树内（clickInDialogText）；
//  ② 高危候选（解除綁定/移除类）仅在弹窗容器存在时启用；
//  ③ 全程未出现弹窗 → 返回 false，由调用方「可能直接生效」路径 + 行状态验证兜底。
async function clickUnbindConfirm(page, { maxMs = 15000 } = {}) {
  const SAFE_TARGETS = ['確定', '确定', 'Confirm', 'OK', 'Yes', '是', '繼續', '继续', 'Continue'];
  const RISKY_TARGETS = ['解除綁定', '解除绑定', '解绑', '解綁', 'Unbind', 'Remove', '移除'];
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const hasDialog = await page.evaluate(dialogRootExists).catch(() => false);
    if (hasDialog) {
      const targets = [...SAFE_TARGETS, ...RISKY_TARGETS];
      // 先精确后包含（按钮可能带图标文本）
      for (const t of targets) {
        if (await clickInDialogText(page, t, true).catch(() => false)) return true;
      }
      for (const t of targets) {
        if (await clickInDialogText(page, t, false).catch(() => false)) return true;
      }
    }
    // 无弹窗容器：不点任何候选（此时页面上的「解除綁定」属于行内按钮，点了必误伤谷歌行）
    await new Promise((r) => setTimeout(r, 1200));
  }
  return false;
}

// 新流程主入口：Facebook 登录 → 绑定谷歌（复用 Google 状态机）→ 解绑 Facebook → 导出验收。
// 防频繁设计：FB 直登不触发 Google OAuth 直注的风控画像；绑卡完成后解绑 FB，谷歌成为唯一登录方式。
// account：谷歌卡密 {email, password, recovery}；fbAccount：{email, password}（config/app.json → facebook）。
// 总时限 8 分钟（两个 OAuth 串行）；keepOpen=true 时保留已登录窗口。
async function registerDolaViaFacebook({
  env,
  account,
  fbAccount,
  onProgress = () => {},
  saveCookies = null,
  keepOpen = false,
}) {
  if (!fbAccount || !fbAccount.email || !fbAccount.password) {
    throw new Error('缺少 Facebook 账号配置（config/app.json → facebook.email/password）');
  }
  const running = launcher.getRunningContext(env.id);
  if (!running) throw new Error('环境未运行，请先启动环境');
  const context = running.context;
  const overallDeadline = Date.now() + 480000; // 总时限 8 分钟（FB + Google 两个 OAuth 串行）
  const remainMs = () => Math.max(60000, overallDeadline - Date.now()); // 保底 60 秒，防中途抛"负时限"

  onProgress('打开 Dola 页面（FB 登录 → 绑定谷歌 → 解绑 FB，总时限 8 分钟）');
  const page = await context.newPage();
  // 清掉上次失败残留的 Dola 页面与 OAuth 弹窗（facebook/google），避免旧弹窗被 waitForOAuthTarget 误认
  for (const p of context.pages()) {
    if (p !== page && /dola\.com|facebook\.com|accounts\.google\.com/.test(p.url())) await p.close().catch(() => {});
  }

  try {
    // ---- ① 打开 Dola 并点击登录 ----
    const opened = await gotoWithRetry(page, DOLA_URL);
    if (!opened) throw slowError('网络过慢：Dola 页面两次加载均超时');
    await page.waitForTimeout(5000);
    onProgress('等待 Dola 页面渲染完整');
    const ready = await waitDolaReady(page, onProgress, 120000);
    if (!ready) throw slowError('网络过慢：Dola 页面 120 秒未渲染完整（CSS/JS 资源加载失败）');
    await clickByText(page, '我知道了').catch(() => {});

    onProgress('查找登录按钮（网络慢时请耐心等待）');
    let clicked = false;
    for (let round = 1; round <= 2 && !clicked; round += 1) {
      await waitDolaReady(page, onProgress, 90000);
      // 多语言：zh-TW 登入 / zh-CN 登录 / en Log in / Sign in
      clicked = await pollClick(page, [['登入', true], ['登录', true], ['Log in', true], ['Sign in', true]], { maxMs: 60000 });
      if (!clicked && round === 1) {
        onProgress('未找到登录按钮，重载 Dola 再试一轮');
        await page.reload({ waitUntil: 'load', timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(3000);
      }
    }
    if (!clicked) {
      await shot(page, 'debug-login');
      throw slowError('网络过慢：两轮尝试均未找到登录按钮（截图 tmp_shots/debug-login.png）');
    }
    await page.waitForTimeout(2500);

    // ---- ② 点击 Facebook 圆形图标（不是 Google 大按钮） ----
    onProgress('点击 Facebook 登录图标');
    let fbClicked = false;
    for (let round = 1; round <= 2 && !fbClicked; round += 1) {
      fbClicked = await clickFacebookIcon(page);
      if (!fbClicked && round === 1) {
        onProgress('未找到 Facebook 图标，重载后重试');
        await page.reload({ waitUntil: 'load', timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(3000);
        await waitDolaReady(page, onProgress, 60000);
        await pollClick(page, [['登入', true], ['登录', true], ['Log in', true], ['Sign in', true]], { maxMs: 30000 });
        await page.waitForTimeout(2000);
      }
    }
    if (!fbClicked) {
      await shot(page, 'debug-fb-btn');
      throw slowError('未找到 Facebook 登录图标（截图 tmp_shots/debug-fb-btn.png，需人工确认 UI 结构）');
    }
    // OAuth 目标仲裁（P2-1）：等「同页跳转 facebook.com」或「弹窗导航到 facebook.com」，迟到弹窗不放弃（最长 45s）
    const { target: fbTarget, popup: fbPopup } = await waitForOAuthTarget(context, page, { maxMs: 45000, domainRe: /facebook\.com/ });
    const fb = fbTarget;
    await fb.waitForLoadState('domcontentloaded').catch(() => {});
    await fb.waitForTimeout(3000);

    // ---- ③ Facebook OAuth 登录状态机 ----
    onProgress('进入 Facebook OAuth 流程');
    await waitForFacebookEntry(fb, onProgress, 90000);
    await driveFacebookOAuth(fb, fbAccount, onProgress, { deadlineMs: remainMs() });
    if (fbPopup && !fbPopup.isClosed()) await fbPopup.close().catch(() => {});

    // ---- ④ 验证 Dola 登录态 ----
    onProgress('验证 Dola 登录态');
    await page.bringToFront().catch(() => {});
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(6000);
    const loggedIn = await verifyDolaLoggedIn(page);
    if (!loggedIn) {
      await shot(page, 'debug-dola-end');
      let cookieSaved = false;
      if (saveCookies) {
        try { await saveCookies(account.email); cookieSaved = true; } catch (e2) { /* 导出失败忽略 */ }
      }
      const err = new Error('Facebook 流程已走完，但 Dola 未检测到登录态'
        + (cookieSaved ? '（Cookie 已临时保存到桌面 DolaCookies，可直接导入使用）' : '（截图 tmp_shots/debug-dola-end.png）'));
      err.code = 'VERIFY_FAILED';
      throw err;
    }

    // ---- ⑤ 打开设置 → 帳號設定 ----
    onProgress('打开设置面板');
    await page.waitForTimeout(2000);
    await clickByTextBroad(page, '我知道了', false).catch(() => {});
    await clickByTextBroad(page, 'I know', false).catch(() => {});
    await clickGearIcon(page, onProgress);
    await page.waitForTimeout(2000);
    onProgress('进入帳號設定');
    let settingsClicked = await pollClickBroad(page, [
      ['帳號設定', false], ['账号设置', false], ['帳號設置', false], ['Account Settings', false], ['Account', false],
    ], { maxMs: 30000 });
    if (!settingsClicked) {
      // 重开齿轮再来一轮
      await clickGearIcon(page, onProgress).catch(() => {});
      settingsClicked = await pollClickBroad(page, [
        ['帳號設定', false], ['账号设置', false], ['Account Settings', false], ['Account', false],
      ], { maxMs: 20000 });
    }
    if (!settingsClicked) {
      await shot(page, 'debug-account-settings');
      throw slowError('未找到「帳號設定」入口（截图 tmp_shots/debug-account-settings.png，需人工确认 UI 结构）');
    }
    // 等帳號設定面板渲染出 Google/Facebook 行
    await waitForRowState(page, 'google', null, { maxMs: 30000, onTick: null }).catch(() => {});
    const rowsNow = await page.evaluate(accountRowsProbe).catch(() => []);
    if (!rowsNow.length) {
      await shot(page, 'debug-account-rows');
      onProgress('⚠️ 帳號設定面板未检测到绑定行（继续尝试，截图 tmp_shots/debug-account-rows.png）');
    }

    // ---- ⑥ 绑定谷歌（Google 行「前往綁定」→ 复用 Google 状态机） ----
    const gState0 = rowStateFromTexts(rowsNow, 'google');
    let googleBound = gState0.present && gState0.state === 'bound';
    if (googleBound) {
      onProgress(`Google 行已绑定（${gState0.text.slice(0, 40)}），跳过绑定步骤`);
    } else {
      onProgress('绑定 Google 账号（点击 Google 行「前往綁定」）');
      const bindClicked = await clickActionInRow(page, 'google|谷歌', '前往綁定|前往绑定|綁定|绑定|bind|link');
      if (!bindClicked) {
        await shot(page, 'debug-bind-google');
        throw slowError('未找到 Google 行「前往綁定」按钮（截图 tmp_shots/debug-bind-google.png）');
      }
      onProgress(`已点击 Google 绑定入口（行：${bindClicked.row.slice(0, 30)} · 按钮：${bindClicked.btn.slice(0, 20)}）`);
      // OAuth 目标仲裁（P2-1）：等「同页跳转 accounts.google.com」或「绑定弹窗导航到 accounts.google.com」，
      // 迟到弹窗不放弃（最长 45s）——旧 20s race 超时后误按同页处理会让 detectGoogleState 在 dola.com
      // 判 left_google 假完成，谷歌没绑上就继续解绑 FB，产出死号。
      const { target: g2, popup: bindPopup } = await waitForOAuthTarget(context, page, { maxMs: 45000, domainRe: /accounts\.google\.com/ });
      await g2.waitForLoadState('domcontentloaded').catch(() => {});
      await g2.waitForTimeout(3000);
      await googleOAuthDrive(g2, bindPopup, account, onProgress, { deadlineMs: remainMs() });
      if (bindPopup && !bindPopup.isClosed()) await bindPopup.close().catch(() => {});

      // 确认 Google 行已显示绑定邮箱（脱敏）——硬门槛（QA P1-3）：未确认绝不解绑 FB。
      // 宁可不解绑（保住已绑上的谷歌）也不能产出「谷歌没绑上+FB 又解绑」的死号。
      let boundState = await waitForRowState(page, 'google', 'bound', { maxMs: 30000 });
      if (!(boundState.present && boundState.state === 'bound')) {
        // 二次长等待：重载设置页再探（面板可能未刷新）
        onProgress('绑定结果未确认，重载设置页二次确认…');
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(6000);
        await clickGearIcon(page, onProgress).catch(() => {});
        await pollClickBroad(page, [
          ['帳號設定', false], ['账号设置', false], ['Account Settings', false], ['Account', false],
        ], { maxMs: 20000 });
        await waitForRowState(page, 'google', null, { maxMs: 15000 }).catch(() => {});
        boundState = await waitForRowState(page, 'google', 'bound', { maxMs: 30000 });
      }
      googleBound = Boolean(boundState.present && boundState.state === 'bound');
      if (!googleBound) {
        await shot(page, 'debug-bind-verify');
        const err = new Error(`Google OAuth 已完成，但帳號設定未确认绑定成功（行状态：${boundState ? boundState.state : 'absent'}，截图 tmp_shots/debug-bind-verify.png）。为防产出死号，已跳过解绑 Facebook，请人工核查后再试`);
        err.code = 'VERIFY_FAILED';
        throw err;
      }
      onProgress(`✅ Google 已绑定（${boundState.text.slice(0, 40)}）`);
    }

    // ---- ⑦ 解绑 Facebook（宽松确认弹窗 → 验证行状态回到「前往綁定」） ----
    onProgress('解绑 Facebook');
    const fbRow = rowStateFromTexts(await page.evaluate(accountRowsProbe).catch(() => []), 'facebook');
    if (fbRow.present && fbRow.state === 'bind') {
      onProgress('Facebook 行已是未绑定状态，无需解绑');
    } else {
      const unbindClicked = await clickActionInRow(page, 'facebook|臉書|脸書|脸书', '解除綁定|解除绑定|解绑|解綁|unbind|unlink|remove|移除');
      if (!unbindClicked) {
        await shot(page, 'debug-unbind-fb');
        throw slowError('未找到 Facebook 行「解除綁定」按钮（截图 tmp_shots/debug-unbind-fb.png）');
      }
      onProgress(`已点击 Facebook 解绑（行：${unbindClicked.row.slice(0, 30)} · 按钮：${unbindClicked.btn.slice(0, 20)}）`);
      const confirmed = await clickUnbindConfirm(page, { maxMs: 15000 });
      onProgress(confirmed ? '已点击解绑确认弹窗' : '未检测到解绑确认弹窗（可能直接生效）');
      const unboundState = await waitForRowState(page, 'facebook', 'bind', { maxMs: 30000 });
      if (!(unboundState.present && unboundState.state === 'bind')) {
        await shot(page, 'debug-unbind-verify');
        const err = new Error(`解绑 Facebook 未确认成功（行状态：${unboundState.state}，截图 tmp_shots/debug-unbind-verify.png）`);
        err.code = 'VERIFY_FAILED';
        throw err;
      }
      onProgress('✅ Facebook 已解绑（行状态回到「前往綁定」）');
    }

    // ---- ⑧ 收尾：localStorage 捕获 + keepOpen ----
    const localStorageDump = await dumpDolaLocalStorage(page);
    onProgress('✅ FB 登录 + 谷歌绑定 + FB 解绑 全流程完成');
    if (keepOpen) {
      // 保留窗口模式：工作页停在已登录的 Dola 画面，关掉 launcher 的初始旧页
      for (const p of context.pages()) {
        if (p !== page) await p.close().catch(() => {});
      }
    } else {
      await page.close().catch(() => {});
    }
    return { ok: true, localStorage: localStorageDump, googleBound, fbUnbound: true };
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

module.exports = {
  registerDola,
  registerDolaViaFacebook,
  detectFacebookState,
  facebookStateFromProbe,
  classifyBindRow,
  rowStateFromTexts,
  waitForOAuthTarget,
  clickFacebookIcon,
};

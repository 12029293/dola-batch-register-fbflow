// 重置因 Google 风控（人机验证/网络慢）失败的账号回 unused，供重试。
// 仅重置可重试类失败（CAPTCHA/风控/网络），绝不重置 密码错误/找不到账号/2步验证 等卡密硬伤。
'use strict';
const path = require('path');
const fs = require('fs');
const { AccountStore } = require('../main/accountStore');

const HARD_FAIL_RE = /密码错误|找不到账号|2 ?步验证/;
const RETRYABLE_RE = /人机验证|未识别|风控|网络过慢|验证码|ECONNRESET|ERR_ABORTED|渲染完整|登录按钮/;

const store = new AccountStore(path.join(process.env.APPDATA, 'doubao-manager'));
let reset = 0;
for (const a of store.list()) {
  if (a.status !== 'failed') continue;
  const note = String(a.note || '');
  if (HARD_FAIL_RE.test(note)) continue;
  if (!RETRYABLE_RE.test(note)) continue;
  a.status = 'unused';
  a.envId = null;
  a.note = `${note}（已重置供重试）`;
  reset += 1;
  console.log('重置:', a.email);
}
store.save();
const c = {};
for (const a of store.list()) c[a.status] = (c[a.status] || 0) + 1;
console.log(`重置 ${reset} 个，池状态:`, JSON.stringify(c));

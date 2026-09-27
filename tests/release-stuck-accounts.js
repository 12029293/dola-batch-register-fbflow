// 释放被中断批次卡在 in_progress 的账号（非注册失败，引擎崩溃残留）回 unused
'use strict';
const path = require('path');
const { AccountStore } = require('../main/accountStore');
const store = new AccountStore(path.join(process.env.APPDATA, 'doubao-manager'));
for (const a of store.list()) {
  if (a.status === 'in_progress') {
    console.log('释放中断号:', a.email);
    store.release(a.email);
  }
}
const c = {};
for (const a of store.list()) c[a.status] = (c[a.status] || 0) + 1;
console.log('池状态:', JSON.stringify(c));

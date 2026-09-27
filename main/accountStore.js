// accountStore.js · 邮箱账号库：解析 cards txt + 状态管理 + 环境绑定
'use strict';

const fs = require('fs');
const path = require('path');

// 解析 账号----密码----辅助邮箱 格式（兼容 3 段/2 段，---- 或 \t 或空格分隔）
function parseCards(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const parts = line.split(/----|\t|\s{2,}|\s/).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parts[0])) {
      out.push({ email: parts[0], password: parts[1], recovery: parts[2] || '' });
    }
  }
  return out;
}

class AccountStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'accounts.json');
    this.data = { accounts: [] };
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && Array.isArray(parsed.accounts)) this.data = parsed;
    } catch (e) { /* 首次无文件 */ }
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
  }

  list() {
    return this.data.accounts;
  }

  // 导入 txt：去重（按 email），新账号状态 unused
  importFromText(text) {
    const parsed = parseCards(text);
    if (!parsed.length) throw new Error('没有解析到有效账号（格式：账号----密码----辅助邮箱）');
    const known = new Set(this.data.accounts.map((a) => a.email));
    let added = 0;
    for (const c of parsed) {
      if (known.has(c.email)) continue;
      known.add(c.email);
      this.data.accounts.push({
        email: c.email,
        password: c.password,
        recovery: c.recovery,
        status: 'unused', // unused | in_progress | used | failed
        envId: null,
        importedAt: new Date().toISOString(),
      });
      added += 1;
    }
    this.save();
    return { added, skipped: parsed.length - added, total: this.data.accounts.length };
  }

  // 取一个未用账号并标记注册中
  claim(envId) {
    const acc = this.data.accounts.find((a) => a.status === 'unused');
    if (!acc) throw new Error('没有未使用的账号，请先导入');
    acc.status = 'in_progress';
    acc.envId = envId;
    acc.claimedAt = new Date().toISOString();
    this.save();
    return acc;
  }

  // 注册结果回写
  finish(email, ok, envId, note) {
    const acc = this.data.accounts.find((a) => a.email === email);
    if (!acc) return;
    acc.status = ok ? 'used' : 'failed';
    acc.envId = ok ? envId : acc.envId;
    acc.note = note || '';
    acc.finishedAt = new Date().toISOString();
    this.save();
  }

  // 注册失败释放回未用（可重试）
  release(email) {
    const acc = this.data.accounts.find((a) => a.email === email);
    if (!acc || acc.status !== 'in_progress') return;
    acc.status = 'unused';
    acc.envId = null;
    this.save();
  }

  // 应用启动恢复：把上次异常退出遗留的 in_progress 僵尸账号全部释放回未用（断点续跑的基础）
  recoverStuck() {
    const stuck = this.data.accounts.filter((a) => a.status === 'in_progress');
    for (const acc of stuck) {
      acc.status = 'unused';
      acc.envId = null;
      acc.note = (acc.note ? `${acc.note}；` : '') + '上次中断，已自动重置';
    }
    if (stuck.length) this.save();
    return stuck.length;
  }

  // 重置全部失败账号为未用（重新参与批量）
  resetFailed() {
    let n = 0;
    for (const acc of this.data.accounts) {
      if (acc.status === 'failed') {
        acc.status = 'unused';
        acc.envId = null;
        acc.note = '';
        n += 1;
      }
    }
    if (n) this.save();
    return n;
  }

  // 清除全部失败账号（从账号库删除）
  clearFailed() {
    const before = this.data.accounts.length;
    this.data.accounts = this.data.accounts.filter((a) => a.status !== 'failed');
    const n = before - this.data.accounts.length;
    if (n) this.save();
    return n;
  }

  // 删除账号
  remove(email) {
    const idx = this.data.accounts.findIndex((a) => a.email === email);
    if (idx >= 0) {
      this.data.accounts.splice(idx, 1);
      this.save();
    }
  }
}

module.exports = { AccountStore, parseCards };

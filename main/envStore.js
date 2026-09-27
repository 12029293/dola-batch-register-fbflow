// envStore.js · 环境存储：envs.json 持久化 + 独立 userDataDir 管理
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { randomFingerprint } = require('./fingerprint');

class EnvStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'envs.json');
    this.profilesDir = path.join(dataDir, 'profiles');
    fs.mkdirSync(this.profilesDir, { recursive: true });
    this.data = { envs: [] };
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.envs)) this.data = parsed;
    } catch (e) { /* 首次启动无文件 */ }
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
  }

  profileDir(envId) {
    return path.join(this.profilesDir, envId);
  }

  list() {
    return this.data.envs;
  }

  get(envId) {
    return this.data.envs.find((e) => e.id === envId) || null;
  }

  create(name) {
    const env = {
      id: `env-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      name: name || `环境 ${this.data.envs.length + 1}`,
      fingerprint: randomFingerprint(),
      proxy: null,
      proxyTest: null,
      pendingCookies: null,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    this.data.envs.push(env);
    this.save();
    return env;
  }

  update(envId, patch) {
    const env = this.get(envId);
    if (!env) throw new Error('环境不存在');
    Object.assign(env, patch);
    this.save();
    return env;
  }

  remove(envId) {
    const idx = this.data.envs.findIndex((e) => e.id === envId);
    if (idx < 0) throw new Error('环境不存在');
    this.data.envs.splice(idx, 1);
    this.save();
    // 清掉对应 profile 目录（应用自有数据目录，可安全删除）
    try {
      fs.rmSync(this.profileDir(envId), { recursive: true, force: true });
    } catch (e) { /* 忽略 */ }
  }
}

module.exports = EnvStore;

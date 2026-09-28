// batchRunner.js · 并发批量注册引擎：worker-pool 调度 + 共享提取预算 + 统一事件上报
// 设计要点：
//  - 单号处理逻辑 _registerOne() 由所有 worker 复用（自旧 runBatch 单号块抽取，行为保持一致：
//    MAX_IP=3 轮、CAPTCHA/SLOW_NETWORK 换 IP+指纹、BUDGET_EXHAUSTED 传播熔断、失败删环境清 profile）
//  - 账号领取依赖 AccountStore.claim 的同步原子性（claim 全程无 await，Node 单线程下天然原子）
//  - 共享提取预算：批量开始时 resetExtractBudget 并按 min(10×待注册数+20, maxExtractBudget||∞) 设置
//  - Google 分流线路批量开始探活一次（不随账号重复探，省时延；转发器仍按域名分流）
//  - 停止语义：stop=不再领新号，在跑的号跑完当前流程；批量结束统一上报 batch:done
'use strict';

const fs = require('fs');
const { randomFingerprint } = require('./fingerprint');

const MAX_IP = 3;            // 单号最多换 3 轮出口（与旧 runBatch 一致）
const STATS_INTERVAL = 2000; // 统计节流推送间隔（ms）
const HK_STREAK_ALERT = 6;   // 出口预筛连续失败告警阈值（常量名 HK 为历史命名，不改）

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

class BatchRunner {
  /**
   * @param {object} opts
   * @param {object} opts.store           EnvStore 实例
   * @param {object} opts.accountStore    AccountStore 实例
   * @param {object} opts.proxyConfig     config/proxy.json 内容
   * @param {object} opts.launcher        launcher 模块
   * @param {object} opts.registerer      registerer 模块
   * @param {object} opts.proxyService    proxy 模块（含预算函数与 screenStickyExit/probeGoogleLine）
   * @param {Function} opts.exportCookies async (env, email, localStorage) => {count, lsCount, missingCore}
   * @param {Function} [opts.emit]        (event, payload) 渲染层事件推送
   * @param {number} [opts.concurrency]   并发 worker 数（-1=无上限：按待注册数开 worker；1~999 有限）
   * @param {number} [opts.maxCount]      本轮最多处理账号数（0=全部，断点续跑/限量挂机用）
   * @param {boolean} [opts.headless]     隐身注册：浏览器后台运行不弹窗（默认 true = 软件内注册）
   * @param {boolean} [opts.keepOpenAfterRegister] 注册成功后保留浏览器窗口（手动测试用；失败账号仍关窗删环境，与隐身注册互斥）
   * @param {string} [opts.region]        出口地区（默认 HK，无降级）
   * @param {string|null} [opts.googleProxy] Google 分流线路（批量开始探活一次）
   * @param {number} [opts.maxExtractBudget] 提取预算上限（0=自动 10×待注册数+20）
   * @param {object|null} [opts.fbAccount]  Facebook 账号 {email, password}（FB 登录→绑定谷歌→解绑 FB 流程）
   */
  constructor({
    store,
    accountStore,
    proxyConfig,
    launcher,
    registerer,
    proxyService,
    exportCookies,
    emit = () => {},
    concurrency = 8,
    maxCount = 0,
    headless = true,
    keepOpenAfterRegister = false,
    region = 'HK',
    googleProxy = null,
    maxExtractBudget = 0,
    fbAccount = null,
  }) {
    this.store = store;
    this.accountStore = accountStore;
    this.proxyConfig = proxyConfig;
    this.launcher = launcher;
    this.registerer = registerer;
    this.proxyService = proxyService;
    this.exportCookies = exportCookies;
    this.emit = emit;
    // 并发数：-1=无上限（start 时按待注册数开 worker）；1~999 有限并发
    const cc = Math.floor(Number(concurrency));
    this.concurrency = !Number.isFinite(cc) ? 8 : (cc < 0 ? -1 : Math.min(999, Math.max(1, cc)));
    this.maxCount = Math.max(0, Math.floor(Number(maxCount) || 0)); // 0=全部
    this.headless = headless !== false;
    // 注册成功保留浏览器窗口（手动测试用）：只有显式 true 才开启；失败账号收尾路径不受影响
    this.keepOpen = keepOpenAfterRegister === true;
    this.region = String(region || 'HK');
    this.googleProxy = googleProxy || null;
    this.maxExtractBudget = Number(maxExtractBudget) || 0;
    // Facebook 账号（config/app.json → facebook）：存在且代理配置为直连模式时启用新流程
    this.fbAccount = fbAccount && fbAccount.email && fbAccount.password ? fbAccount : null;
    // 直连模式（proxy.json → mode=clash-local，兼容旧值 phantom-local）：本地代理端口
    // （Clash Verge 7897 / Phantom 65533），不提取不预筛不耗预算，
    // 轻量出口探测（phantomExitProbe）替代 screenStickyExit；换 IP 逻辑退化为同出口换指纹（MAX_IP=3 不变）
    this.directMode = Boolean(proxyConfig && /^(clash|phantom)-local$/.test(String(proxyConfig.mode || '')));
    this.browserProxy = (proxyConfig && proxyConfig.browserProxy) || { host: '127.0.0.1', port: 7897 };
    // 关键：剔除 extractBudget，防止 extractStickyProxy 内部用 proxy.json 的静态值
    // 覆盖批量开始时设置的共享预算（实测 E2E 发现：预算条会从设定值回落到 15）
    this._screenConfig = { ...proxyConfig, extractBudget: undefined };

    this.running = false;
    this._stopped = false;     // 停止领新号（手动停止或预算熔断）
    this._stopReason = '';     // 'manual' | 'budget' | ''
    this._processed = 0;       // 本轮已处理账号数（限量用）
    this._accounts = new Map(); // email -> 卡片数据
    this._ok = [];
    this._fail = [];
    this._lastStatsEmit = 0;
    this._statsTimer = null;
    // HK 池状态统计：不做 any 降级，HK 池整体挂死时如实报告
    this._hk = { success: 0, fail: 0, streak: 0, lastError: '', exits: [] };
  }

  /** 启动批量：Google 线路探活 → 预算设置 → 并发 worker。resolve 于批量结束。 */
  async start() {
    if (this.running) throw new Error('批量任务已在运行中');
    this.running = true;
    try {
      // ① Google 分流线路探活（整批一次；失败直接不启动，省配额）。
      //    直连模式无分流线路：跳过探活。
      if (this.googleProxy && !this.directMode) {
        try {
          await this.proxyService.probeGoogleLine(this.googleProxy);
        } catch (e) {
          this.emit('batch:done', {
            ok: [], fail: [], stopped: false, aborted: 'google-line',
            message: `Google 分流线路不可用，批量未启动：${String(e.message || e).slice(0, 120)}`,
            hk: this._hkSummary(),
          });
          return;
        }
      }

      // ② 共享提取预算：maxExtractBudget>0 取 min(10×待注册数+20, 上限)；<0 无上限；0=自动。
      //    直连模式不提取代理：无预算概念，跳过（统计里的 extractUsage/extractBudget 保持默认 0）。
      const pending = this.accountStore.list().filter((a) => a.status === 'unused').length;
      if (!this.directMode) {
        const computed = pending * 10 + 20;
        let budget = this.maxExtractBudget > 0 ? Math.min(computed, this.maxExtractBudget) : computed;
        if (this.maxExtractBudget < 0) budget = Infinity; // 无上限：不熔断，永不停止提取
        this.proxyService.resetExtractBudget();
        this.proxyService.setExtractBudget(budget);
      }

      // ③ worker pool：每个 worker 独立循环领号→注册→领下一个
      //    concurrency<0 = 无上限：worker 数 = min(待注册数, 本轮限量>0 ? 限量 : 待注册数)
      const effConc = this.concurrency > 0
        ? this.concurrency
        : Math.max(1, this.maxCount > 0 ? Math.min(pending, this.maxCount) : pending);
      this._statsTimer = setInterval(() => this._emitStats(true), STATS_INTERVAL);
      this._emitStats(true);
      const workers = [];
      for (let i = 0; i < effConc; i += 1) workers.push(this._workerLoop(i));
      await Promise.all(workers);
    } finally {
      if (this._statsTimer) { clearInterval(this._statsTimer); this._statsTimer = null; }
      this.running = false;
      this._emitStats(true);
      this.emit('batch:done', {
        ok: this._ok.map((x) => ({ ...x })),
        fail: this._fail.map((x) => ({ ...x })),
        stopped: Boolean(this._stopped),
        stopReason: this._stopReason,
        hk: this._hkSummary(),
      });
    }
  }

  /** 停止：不再领新号，在跑的号跑完当前流程 */
  stop() {
    this._stopped = true;
    this._stopReason = 'manual';
  }

  /** worker 主循环：领号 → 单号流程 → 领下一个，直到队列空/停止/达本轮限量 */
  async _workerLoop(workerId) {
    for (;;) {
      if (this._stopped) break;
      if (this.maxCount > 0 && this._processed >= this.maxCount) break; // 达本轮限量
      let account;
      try {
        // claim 全同步（find+改状态+writeFileSync），Node 单线程下多 worker 领号原子不重复
        account = this.accountStore.claim(`worker-${workerId + 1}`);
      } catch (e) {
        break; // 没有未使用账号：队列空
      }
      this._setAccount(account.email, {
        state: 'pending',
        step: `已领号，创建环境${this.headless ? '（隐身模式）' : ''}`,
        workerId: workerId + 1,
        startedAt: Date.now(),
        attempt: 0,
        maxAttempt: MAX_IP,
      });
      try {
        await this._registerOne(account);
      } catch (e) {
        // 兜底：_registerOne 内部已完整处理常规路径，此处只处理意外异常，避免账号悬在 in_progress
        const msg = String(e.message || e).slice(0, 120);
        if (!this._ok.some((x) => x.email === account.email) && !this._fail.some((x) => x.email === account.email)) {
          try { this.accountStore.finish(account.email, false, null, msg); } catch (e2) { /* 忽略 */ }
          this._fail.push({ email: account.email, reason: msg });
          this._setAccount(account.email, { state: 'failed', step: `异常终止：${msg.slice(0, 80)}` });
        }
      }
      this._processed += 1; // 限量计数（成功/失败都算已处理）
      this._emitStats();
    }
  }

  /**
   * 单号完整流程（旧 runBatch 单号块抽取，worker 复用）：
   * 建环境 → 最多 MAX_IP 轮 {全新指纹 → HK 强制预筛（无降级）→ 启动 → 全自动注册 → 导出} → 收尾
   * 成功：保留环境 + 回写 used；失败：删环境 + 清 profile + 回写 failed
   */
  async _registerOne(account) {
    const env = this.store.create(`Dola-${account.email.split('@')[0]}`);
    this.store.update(env.id, { homeUrl: this.launcher.DOLA_URL });
    const mark = (patch) => this._setAccount(account.email, { envId: env.id, ...patch });
    let success = false;
    let lastMsg = '';
    let roundsTried = 0;

    try {
      for (let ipTry = 1; ipTry <= MAX_IP && !success && !this._stopped; ipTry += 1) {
        roundsTried = ipTry;
        try {
          // 1. 每轮全新指纹（Google 会将失败尝试与指纹关联，换 IP 必须同时换指纹）
          mark({
            state: 'screening',
            attempt: ipTry,
            maxAttempt: MAX_IP,
            step: this.directMode
              ? `第 ${ipTry}/${MAX_IP} 轮：刷新指纹并探测 Phantom 出口`
              : `第 ${ipTry}/${MAX_IP} 轮：刷新指纹并预筛 ${this.region.toUpperCase()} 出口`,
          });
          this.store.update(env.id, { fingerprint: randomFingerprint() });

          // 2. 出口获取：直连模式（phantom-local）轻量探测；网关模式强制预筛。
          let proxy;
          if (this.directMode) {
            // 直连模式：phantomExitProbe 经本地混合端口探出口国家 → 时区归类（HK/TW/其他+警告）。
            // 不消耗提取预算；失败按 SLOW_NETWORK 语义处理（同出口换指纹重试）。
            try {
              const probeExit = await this.proxyService.phantomExitProbe(this.browserProxy, {
                onAttempt: (msg) => mark({ step: msg }),
              });
              this._hk.streak = 0;
              this._hk.success += 1;
              this._hk.exits.push({
                ip: probeExit.ip, country: probeExit.country, city: probeExit.city,
                isp: probeExit.isp, sid: null, at: new Date().toISOString(),
              });
              proxy = {
                host: this.browserProxy.host,
                port: this.browserProxy.port,
                protocol: 'http',
                noAuth: true, // launcher 据此直接挂代理，不启认证转发器
                region: probeExit.region,
                tz: probeExit.tz,
                warn: probeExit.warn || '',
                exit: { ip: probeExit.ip, country: probeExit.country, region: probeExit.regionName, city: probeExit.city, isp: probeExit.isp },
              };
            } catch (e3) {
              this._hk.fail += 1;
              this._hk.streak += 1;
              this._hk.lastError = String(e3.message || e3).slice(0, 120);
              mark({ step: `Phantom 出口探测失败（${this._hk.lastError}）→ 换指纹重试（累计失败 ${this._hk.fail} 次）` });
              const wrapped = new Error(String(e3.message || e3));
              wrapped.code = e3.code || 'SLOW_NETWORK';
              throw wrapped;
            }
          } else {
            // 出口预筛（强制配置地区归属：提取→出口 IP→归属地校验→Dola 可达，失败换 sid，无 any 降级）。
            //    Google 分流线路已在批量开始探活一次，这里不重复探（转发器仍按域名分流）。
            try {
              proxy = await this.proxyService.screenStickyExit(this._screenConfig, {
                region: this.region,
                maxAttempts: 3,
                googleProxy: null,
                onAttempt: (i, msg) => mark({ step: `[预筛 ${i}] ${msg}` }),
              });
            } catch (e3) {
              if (e3.code === 'BUDGET_EXHAUSTED') throw e3;
              // 无降级：出口预筛失败按本轮失败处理（外层换 sid 进入下一轮），如实记录出口池状态（字段名 _hk/hk 为历史命名，UI 与测试依赖，不改）
              this._hk.fail += 1;
              this._hk.streak += 1;
              this._hk.lastError = String(e3.message || e3).slice(0, 120);
              if (this._hk.streak >= HK_STREAK_ALERT) {
                mark({
                  step: `⛔ ${this.region.toUpperCase()} 出口预筛已连续失败 ${this._hk.streak} 次（最近错误：${this._hk.lastError}）——疑似 ${this.region.toUpperCase()} 池整体异常，继续仅用 ${this.region.toUpperCase()} 换 sid 重试`,
                  hkAlert: true,
                });
              } else {
                mark({ step: `${this.region.toUpperCase()} 预筛失败（${String(e3.message).slice(0, 60)}）→ 换 sid 重试（${this.region.toUpperCase()} 池累计失败 ${this._hk.fail} 次）` });
              }
              throw e3;
            }
          }
          this.store.update(env.id, { proxy, proxyTest: proxy.exit });
          const exit = { ip: proxy.exit.ip, country: proxy.exit.country, isp: proxy.exit.isp };
          mark({
            state: 'running',
            exit,
            step: `出口已固定（${exit.ip} · ${exit.country}${proxy.warn ? ` · ⚠️${proxy.warn}` : ''} · ${exit.isp || '-'}），启动浏览器注册`,
          });

          // 3. 启动环境（指纹注入 + 代理挂载；直连模式不启转发器；headless=隐身不弹窗）
          //    + 注册驱动：直连模式 + FB 账号配置 → registerDolaViaFacebook（FB 登录→绑定谷歌→解绑 FB）；
          //    否则走旧版 Google OAuth 直注 registerDola。
          await this.launcher.launchEnv(this.store.get(env.id), this.store.profilesDir, { headless: this.headless });
          this.store.update(env.id, { lastUsedAt: new Date().toISOString() });
          await sleep(2000);
          const useFbFlow = this.directMode && this.fbAccount && typeof this.registerer.registerDolaViaFacebook === 'function';
          const regFn = useFbFlow
            ? this.registerer.registerDolaViaFacebook
            : this.registerer.registerDola;
          const reg = await regFn({
            env: this.store.get(env.id),
            account,
            fbAccount: useFbFlow ? this.fbAccount : undefined,
            autoMode: true,
            keepOpen: this.keepOpen,
            onProgress: (s, d) => mark({ step: d ? `${s}（${d}）` : s }),
            saveCookies: (em) => this.exportCookies(this.store.get(env.id), em),
          });

          // 4. 导出完整 Cookie（含 sessionid/sid_guard 核心字段）+ localStorage
          mark({ state: 'exporting', step: '注册成功，导出 Cookie 与 localStorage' });
          const ci = await this.exportCookies(this.store.get(env.id), account.email, reg.localStorage);
          this.accountStore.finish(account.email, true, env.id);
          this._ok.push({
            email: account.email,
            cookies: ci.count,
            ls: ci.lsCount,
            missingCore: ci.missingCore || [],
            exportedAt: new Date().toISOString(),
          });
          success = true;
          mark({
            state: 'success',
            exit,
            step: `✅ 成功：Cookie ${ci.count} 条${ci.missingCore && ci.missingCore.length ? `（⚠️ 缺核心字段：${ci.missingCore.join(', ')}）` : '（含核心登录态）'}${this.keepOpen ? ' · 浏览器窗口已保留，可手动测试' : ''}`,
          });
          this._emitStats(true);
        } catch (err) {
          if (err.code === 'BUDGET_EXHAUSTED') {
            // 预算熔断：立即停止全队领新号，保护配额（当前号按失败收尾）
            this._stopped = true;
            this._stopReason = 'budget';
            lastMsg = err.message;
            mark({ step: `🛑 ${err.message}，全队停止` });
            if (this.launcher.isRunning(env.id)) await this.launcher.closeEnv(env.id);
            break;
          }
          lastMsg = String(err.message || err).slice(0, 100);
          const rotate = err.code === 'CAPTCHA' || err.code === 'SLOW_NETWORK' || this._isRetryable(err);
          mark({ step: `❌ ${lastMsg} → ${rotate && ipTry < MAX_IP ? '换 IP + 换指纹重试' : '放弃该账号'}` });
          if (this.launcher.isRunning(env.id)) await this.launcher.closeEnv(env.id);
          // 清掉脏 profile：Google 会记住失败尝试，复用会加重风控。
          // 注意：Chrome 进程完全退出要一点时间，立即删会因文件句柄未释放而残留 → 等 1 秒 + 重试删除
          await sleep(1000);
          for (let rmTry = 0; rmTry < 3; rmTry += 1) {
            try { fs.rmSync(this.store.profileDir(env.id), { recursive: true, force: true }); break; } catch (e4) { await sleep(800); }
          }
          if (!rotate) break;
          await sleep(2000);
        }
      }
    } finally {
      // 收尾：关浏览器；成功保留环境，失败删环境并回写
      // keepOpen 模式：成功时保留浏览器窗口（含认证转发器，用户手动关窗由 launcher 的 context.on('close') 清理），
      // 失败/熔断路径照常关窗（catch 分支已关，此处不重复关）
      if (this.launcher.isRunning(env.id) && !(success && this.keepOpen)) await this.launcher.closeEnv(env.id).catch(() => {});
      if (!success) {
        if (this._stopped && this._stopReason === 'manual' && roundsTried === 0) {
          // 手动停止且尚未开始任何一轮：释放回账号池，不计失败
          this.accountStore.release(account.email);
          this._setAccount(account.email, { state: 'idle', step: '已停止（未开始，账号已释放回池）' });
        } else {
          this.accountStore.finish(account.email, false, env.id, lastMsg);
          this._fail.push({ email: account.email, reason: lastMsg || '未知失败' });
          this.store.remove(env.id);
          this._setAccount(account.email, { state: 'failed', step: lastMsg ? `失败：${lastMsg}` : '注册失败' });
        }
        this._emitStats(true);
      }
    }
  }

  // 不可重试的注册错误（卡密本身的问题，换 IP 没用）；预算耗尽也绝不重试
  _isRetryable(err) {
    if (err && err.code === 'BUDGET_EXHAUSTED') return false;
    const msg = String((err && err.message) || '');
    return !(/找不到账号|密码错误|2 步验证/.test(msg));
  }

  /** 更新账号卡片状态并推送 batch:account（每号状态变化即推） */
  _setAccount(email, patch) {
    const prev = this._accounts.get(email);
    const rec = prev || {
      email, state: 'pending', step: '', attempt: 0, maxAttempt: MAX_IP,
      exit: null, workerId: 0, startedAt: Date.now(), hkAlert: false, envId: null,
    };
    const prevState = rec.state;
    Object.assign(rec, patch);
    if (patch.state && patch.state !== prevState) rec.stateChangedAt = Date.now();
    rec.elapsedMs = Date.now() - rec.startedAt;
    this._accounts.set(email, rec);
    this.emit('batch:account', { ...rec });
    this._emitStats(); // 节流推送
  }

  /** 统计推送（节流；force=true 立即推） */
  _emitStats(force = false) {
    const now = Date.now();
    if (!force && now - this._lastStatsEmit < STATS_INTERVAL) return;
    this._lastStatsEmit = now;
    const pool = this.accountStore.list();
    let runningCount = 0;
    for (const rec of this._accounts.values()) {
      if (['pending', 'screening', 'running', 'exporting'].includes(rec.state)) runningCount += 1;
    }
    const usage = this.proxyService.getExtractUsage();
    this.emit('batch:stats', {
      pending: pool.filter((a) => a.status === 'unused').length,
      running: runningCount,
      success: this._ok.length,
      failed: this._fail.length,
      extractUsage: usage.used,
      extractBudget: usage.max,
    });
  }

  /** HK 池状态摘要（出口质量数据，仅 HK 无降级） */
  _hkSummary() {
    return {
      success: this._hk.success,
      fail: this._hk.fail,
      streak: this._hk.streak,
      lastError: this._hk.lastError,
      exits: this._hk.exits.slice(-5),
    };
  }
}

module.exports = { BatchRunner, MAX_IP };

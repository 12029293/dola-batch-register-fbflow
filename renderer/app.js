// app.js · Dola 批量注册工作台（渲染层）
'use strict';

const $ = (sel) => document.querySelector(sel);

const state = {
  config: null,            // config:get 返回值
  setup: null,             // setup:status 返回值
  batchRunning: false,
  concurrency: 8,
  lastFiniteCc: 16,        // 从无上限切回有限并发时恢复的值
  view: 'batch',           // 'batch' | 'accounts'
  acctFilter: 'all',       // 账号库状态筛选
  workers: new Map(),      // email -> { data, el }
  revealed: new Set(),     // 已展开明文的邮箱
  wizardStep: 0,
  wizard: { importedOk: false, nexipOk: false, googleOk: false, exportSaved: false },
};

// ---------- 工具 ----------
function maskEmail(email) {
  const at = email.indexOf('@');
  if (at <= 2) return email;
  return `${email.slice(0, 2)}***${email.slice(at)}`;
}

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false }); } catch (e) { return iso; }
}

// 卡片终态：进入后计时冻结（成功 / 彻底失败都不再跳动；重试回到进行中状态则自动恢复计时）
const TERMINAL_STATES = new Set(['success', 'failed']);

let toastTimer = null;
function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

// 向导步骤① 的前端即时预览（与服务端 parseCards 同规则；落库以 account:importText 为准）
function quickParse(text) {
  let valid = 0, dup = 0, bad = 0;
  const seen = new Set();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const parts = line.split(/----|\t|\s{2,}|\s/).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parts[0])) {
      if (seen.has(parts[0])) dup += 1;
      else { seen.add(parts[0]); valid += 1; }
    } else bad += 1;
  }
  return { valid, dup, bad };
}

// ---------- 数据刷新 ----------
// 并发数渲染：-1 = 无上限（显示 ∞，高亮切换钮）
function renderConcurrency() {
  const unlimited = state.concurrency < 0;
  $('#ccValue').textContent = unlimited ? '∞' : state.concurrency;
  $('#ccUnlimited').classList.toggle('active', unlimited);
  $('#ccMinus').disabled = state.batchRunning;
  $('#ccPlus').disabled = state.batchRunning;
  $('#ccUnlimited').disabled = state.batchRunning;
}

// 视图切换：批量注册 / 账号库（账号库为常用功能，独立一级视图）
function switchView(v) {
  state.view = v;
  $('#viewBatch').classList.toggle('hidden', v !== 'batch');
  $('#viewAccounts').classList.toggle('hidden', v !== 'accounts');
  $('#tabBatch').classList.toggle('active', v === 'batch');
  $('#tabAccounts').classList.toggle('active', v === 'accounts');
  if (v === 'accounts') loadAccounts();
}

async function refreshConfig() {
  state.config = await window.api.invoke('config:get');
  state.concurrency = state.config.concurrency;
  if (state.concurrency > 0) state.lastFiniteCc = state.concurrency;
  renderConcurrency();
  $('#setExportDir').value = state.config.exportDir || '';
  $('#setExportDir').placeholder = state.config.exportDirDefault;
  $('#setExtractMasked').textContent = state.config.proxy.extractUrlMasked || '未配置';
  $('#setGoogleProxy').textContent = state.config.proxy.googleProxy || '未配置';
  const headlessChk = $('#setHeadless');
  if (headlessChk) headlessChk.checked = Boolean(state.config.headless);
  renderPool(state.config.accountStats);
  if (state.config.batchRunning) setRunningUi(true);
  renderGuide();
}

async function refreshSetup() {
  state.setup = await window.api.invoke('setup:status');
  renderGuide();
  return state.setup;
}

function renderPool(stats) {
  if (!stats) return;
  $('#poolStats').textContent = `可用 ${stats.unused} · 成功 ${stats.used} · 失败 ${stats.failed}`;
}

// ---------- 账号库管理 ----------
const STATUS_LABEL = { unused: '可用', in_progress: '注册中', used: '成功', failed: '失败' };

async function loadAccounts() {
  try {
    const { accounts } = await window.api.invoke('account:list');
    const list = $('#accountList');
    if (!list) return;
    // 状态统计 chips（顶栏标题旁）
    const counts = { all: accounts.length, unused: 0, in_progress: 0, used: 0, failed: 0 };
    for (const a of accounts) counts[a.status] = (counts[a.status] || 0) + 1;
    $('#acctChips').textContent = `共 ${counts.all} · 可用 ${counts.unused} · 注册中 ${counts.in_progress} · 成功 ${counts.used} · 失败 ${counts.failed}`;
    // 筛选后渲染
    const shown = state.acctFilter === 'all' ? accounts : accounts.filter((a) => a.status === state.acctFilter);
    list.innerHTML = '';
    if (!shown.length) {
      const d = document.createElement('div');
      d.className = 'acct-empty';
      d.textContent = accounts.length ? '该状态下暂无账号' : '账号库为空，请先导入卡密';
      list.appendChild(d);
    }
    for (const a of shown) {
      const row = document.createElement('div');
      row.className = `acct-row st-${a.status}`;
      const email = document.createElement('span');
      email.className = 'acct-email mono';
      email.textContent = state.revealed.has(a.email) ? a.email : maskEmail(a.email);
      email.title = (a.note ? `${a.note}\n` : '') + '点击切换打码';
      email.addEventListener('click', () => {
        if (state.revealed.has(a.email)) state.revealed.delete(a.email);
        else state.revealed.add(a.email);
        loadAccounts();
      });
      const badge = document.createElement('span');
      badge.className = `acct-badge b-${a.status}`;
      badge.textContent = STATUS_LABEL[a.status] || a.status;
      const del = document.createElement('button');
      del.className = 'acct-del';
      del.textContent = '✕';
      del.title = '删除该账号';
      del.addEventListener('click', async () => {
        try {
          await window.api.invoke('account:remove', { email: a.email });
          toast(`已删除 ${maskEmail(a.email)}`);
          loadAccounts();
          refreshConfig();
        } catch (e) { toast(String(e.message || e), 'err'); }
      });
      row.append(email, badge, del);
      list.appendChild(row);
    }
  } catch (e) { /* 账号库加载失败不阻断 */ }
}

function renderGuide() {
  const need = state.setup ? state.setup.needSetup : false;
  $('#guideHint').classList.toggle('hidden', !need || state.batchRunning);
}

function renderBudget(used, max) {
  $('#budgetText').textContent = max === Infinity ? `${used}/∞` : `${used}/${max}`;
  const bar = $('#budgetBar');
  const pct = Number.isFinite(max) && max > 0 ? Math.min(100, (used / max) * 100) : 0;
  bar.style.width = `${pct}%`;
  bar.className = `bar-fill${pct >= 85 ? ' danger' : pct >= 60 ? ' warn' : ''}`;
}

// ---------- Worker 卡片 ----------
function buildWorkerCard(d) {
  const card = document.createElement('div');
  card.className = `worker st-${d.state}`;
  card.innerHTML = `
    <div class="w-head">
      <span class="w-email mono"></span>
      <span class="w-exit badge hidden"></span>
    </div>
    <div class="w-step"></div>
    <div class="w-meta mono">
      <span>轮次 <b class="w-attempt">0/3</b></span>
      <span class="w-timer">0s</span>
      <span class="w-worker"></span>
    </div>`;
  card.querySelector('.w-email').addEventListener('click', () => {
    const email = card.dataset.email;
    if (state.revealed.has(email)) state.revealed.delete(email);
    else state.revealed.add(email);
    card.querySelector('.w-email').textContent = state.revealed.has(email) ? email : maskEmail(email);
  });
  return card;
}

function upsertWorker(d) {
  if (d.state === 'idle') {
    // 账号已释放回池：卡片撤除
    const rec = state.workers.get(d.email);
    if (rec) { rec.el.remove(); state.workers.delete(d.email); }
    return;
  }
  let rec = state.workers.get(d.email);
  if (!rec) {
    $('#workerEmpty') && $('#workerEmpty').remove();
    const el = buildWorkerCard(d);
    el.dataset.email = d.email;
    $('#workerGrid').appendChild(el);
    rec = { el, data: d };
    state.workers.set(d.email, rec);
  }
  rec.data = d;
  const el = rec.el;
  el.className = `worker st-${d.state}`;
  el.querySelector('.w-email').textContent = state.revealed.has(d.email) ? d.email : maskEmail(d.email);
  el.querySelector('.w-email').dataset.email = d.email;
  const exitEl = el.querySelector('.w-exit');
  if (d.exit) {
    exitEl.textContent = `${d.exit.country || ''} · ${d.exit.isp || d.exit.ip || ''}`.slice(0, 26);
    exitEl.classList.remove('hidden');
    exitEl.classList.add('hk');
  } else {
    exitEl.classList.add('hidden');
  }
  el.querySelector('.w-step').textContent = d.step || '';
  el.querySelector('.w-step').title = d.step || '';
  el.querySelector('.w-attempt').textContent = `${d.attempt || 0}/${d.maxAttempt || 3}`;
  const timerEl = el.querySelector('.w-timer');
  timerEl.dataset.startedAt = d.startedAt;
  if (TERMINAL_STATES.has(d.state)) {
    // 终态：定格最终耗时并冻结（成功 / 彻底失败后计时停止）
    if (d.startedAt) timerEl.textContent = fmtElapsed(Date.now() - Number(d.startedAt));
    timerEl.classList.add('frozen');
  } else {
    timerEl.classList.remove('frozen');
  }
  el.querySelector('.w-worker').textContent = d.workerId ? `W${d.workerId}` : '';
  const total = state.workers.size;
  const running = [...state.workers.values()].filter((r) => ['pending', 'screening', 'running', 'exporting'].includes(r.data.state)).length;
  $('#queueInfo').textContent = `${total} 号 · 进行中 ${running}`;
}

// 耗时计时器（终态冻结：成功/彻底失败后不再更新）
setInterval(() => {
  for (const rec of state.workers.values()) {
    if (TERMINAL_STATES.has(rec.data.state)) continue;
    const t = rec.el.querySelector('.w-timer');
    const startedAt = Number(t.dataset.startedAt || 0);
    if (startedAt) t.textContent = fmtElapsed(Date.now() - startedAt);
  }
}, 1000);

// ---------- 运行控制 ----------
function setRunningUi(running) {
  state.batchRunning = running;
  const btn = $('#btnStart');
  btn.textContent = running ? '停止' : '开始批量注册';
  btn.classList.toggle('stop', running);
  $('#runDot').className = `status-dot ${running ? 'running' : ''}`;
  renderConcurrency(); // 运行中冻结并发控件
  renderGuide();
}

async function startBatch() {
  if (state.batchRunning) {
    await window.api.invoke('register:batch:stop');
    toast('已发送停止指令：不再领新号，在跑的账号会跑完当前流程');
    return;
  }
  const setup = state.setup || (await refreshSetup());
  if (setup.needSetup) { openWizard(); return; }
  const stats = state.config.accountStats;
  if (!stats || stats.unused < 1) { toast('没有可用卡密，请先导入', 'warn'); openWizard(); return; }
  // 清空上一轮的卡片
  state.workers.forEach((rec) => rec.el.remove());
  state.workers.clear();
  try {
    const r = await window.api.invoke('register:batch', {
      concurrency: state.concurrency,
      maxCount: Math.max(0, Math.floor(Number($('#maxCount') && $('#maxCount').value) || 0)),
      shutdownAfter: $('#chkShutdown') && $('#chkShutdown').checked,
    });
    setRunningUi(true);
    toast(`批量已启动（并发 ${r.concurrency < 0 ? '无上限' : r.concurrency}${r.headless ? ' · 隐身' : ' · 可见浏览器'}）`);
  } catch (e) {
    toast(String(e.message || e), 'err');
  }
}

function onBatchDone(done) {
  setRunningUi(false);
  // 结果区已移除：批量结束以 toast 摘要 + 卡片终态呈现
  const stoppedTxt = done.stopped
    ? (done.stopReason === 'budget' ? ' · 🛑 预算熔断' : ' · ⏹ 手动停止')
    : '';
  const okN = (done.ok || []).length;
  const failN = (done.fail || []).length;
  const abortedTxt = done.aborted === 'google-line' ? '（Google 线路不可用，未启动）' : '';
  toast(`批量结束：成功 ${okN} · 失败 ${failN}${stoppedTxt}${abortedTxt}`, failN && !okN ? 'warn' : '');
  if (done.message) toast(done.message, done.aborted ? 'err' : '');
  refreshConfig();
  if (done.stopped && done.stopReason === 'budget') toast('提取预算耗尽，批量已自动停止', 'warn');
}

// ---------- 向导 ----------
const WIZ_STEPS = [
  { title: '① 导入卡密', skip: null },
  { title: '② nexip 代理配置', skip: '未配置也可跳过，但批量会因无法提取代理而失败' },
  { title: '③ Google 专线检测', skip: '可跳过：批量开始时会自动再检（失败不启动批量）' },
  { title: '④ 导出目录', skip: null },
];

function renderWizardSteps() {
  const box = $('#wizardSteps');
  box.innerHTML = '';
  WIZ_STEPS.forEach((_, i) => {
    const dot = document.createElement('span');
    dot.className = `dot${i === state.wizardStep ? ' active' : i < state.wizardStep ? ' done' : ''}`;
    box.appendChild(dot);
  });
}

function wizardStepView() {
  const body = $('#wizardBody');
  const cfg = state.config;
  if (state.wizardStep === 0) {
    body.innerHTML = `
      <h3>① 导入卡密</h3>
      <p class="desc">粘贴账号卡密，每行一个，格式：<span class="mono">账号----密码----辅助邮箱</span>（辅助邮箱可选；支持 ---- / Tab / 空格分隔，# 开头为注释）</p>
      <textarea id="wizCards" placeholder="abc@gmail.com----p@ssw0rd----recovery@gmail.com&#10;..."></textarea>
      <div class="wiz-stats mono">
        <span>有效 <b class="num ok-c" id="wizValid">0</b></span>
        <span>重复 <b class="num dup-c" id="wizDup">0</b></span>
        <span>格式错 <b class="num bad-c" id="wizBad">0</b></span>
      </div>
      <div class="wiz-feedback" id="wizImportFeedback"></div>`;
    const ta = $('#wizCards');
    ta.addEventListener('input', () => {
      const r = quickParse(ta.value);
      $('#wizValid').textContent = r.valid;
      $('#wizDup').textContent = r.dup;
      $('#wizBad').textContent = r.bad;
    });
  } else if (state.wizardStep === 1) {
    const configured = cfg && cfg.proxy.configured;
    body.innerHTML = `
      <h3>② nexip 代理配置</h3>
      <p class="desc">粘贴 nexip 提取 API URL（含密钥，保存后脱敏显示）。${configured ? `当前已配置：<span class="mono">${cfg.proxy.extractUrlMasked}</span>` : '尚未配置。'}</p>
      <input type="password" class="input" id="wizNexipUrl" placeholder="https://api.nexip.net/api/external/traffic/extract?...">
      <div class="btn-row">
        <button class="btn-ghost sm" id="wizSaveNexip">保存 URL</button>
        <button class="btn-ghost sm" id="wizTestNexip">测试提取（⚠️ 消耗 1 次提取额度）</button>
      </div>
      <div class="wiz-feedback" id="wizNexipFeedback">${configured ? '✅ 已有配置，可直接测试或跳过' : ''}</div>`;
    $('#wizSaveNexip').addEventListener('click', async () => {
      const url = $('#wizNexipUrl').value.trim();
      if (!url) { toast('请先粘贴提取 API URL', 'warn'); return; }
      try {
        await window.api.invoke('config:save', { extractUrl: url });
        await refreshConfig();
        $('#wizNexipFeedback').textContent = '✅ 提取 API 已保存';
        $('#wizNexipFeedback').className = 'wiz-feedback ok';
      } catch (e) {
        $('#wizNexipFeedback').textContent = `❌ ${e.message}`;
        $('#wizNexipFeedback').className = 'wiz-feedback err';
      }
    });
    $('#wizTestNexip').addEventListener('click', async () => {
      const fb = $('#wizNexipFeedback');
      fb.textContent = '⏳ 正在提取并检测出口（约 5~20 秒）…';
      fb.className = 'wiz-feedback';
      try {
        const r = await window.api.invoke('setup:testNexip');
        state.wizard.nexipOk = true;
        fb.textContent = `✅ 出口 ${r.ip}（${r.country} ${r.city} · ${r.isp}）—— 提取可用。剩余额度 ${r.usage.left} 次`;
        fb.className = 'wiz-feedback ok';
      } catch (e) {
        state.wizard.nexipOk = false;
        fb.textContent = `❌ ${e.message}`;
        fb.className = 'wiz-feedback err';
      }
    });
  } else if (state.wizardStep === 2) {
    body.innerHTML = `
      <h3>③ Google 专线检测</h3>
      <p class="desc">检测本地 Clash 分流线路（${cfg && cfg.proxy.googleProxy ? `<span class="mono">${cfg.proxy.googleProxy}</span>` : '未配置 googleProxy'}）。Google 登录流量走该线路，此检测不消耗提取额度。</p>
      <div class="btn-row"><button class="btn-ghost sm" id="wizTestGoogle">一键检测</button></div>
      <div class="wiz-feedback" id="wizGoogleFeedback"></div>`;
    $('#wizTestGoogle').addEventListener('click', async () => {
      const fb = $('#wizGoogleFeedback');
      fb.textContent = '⏳ 正在探测 generate_204 …';
      fb.className = 'wiz-feedback';
      try {
        const r = await window.api.invoke('setup:testGoogleLine');
        if (r.ok) {
          state.wizard.googleOk = true;
          fb.textContent = `✅ Google 专线连通（经 ${r.host}）`;
          fb.className = 'wiz-feedback ok';
        } else {
          state.wizard.googleOk = false;
          fb.textContent = `❌ ${r.error}。${r.hint}`;
          fb.className = 'wiz-feedback err';
        }
      } catch (e) {
        state.wizard.googleOk = false;
        fb.textContent = `❌ ${e.message}`;
        fb.className = 'wiz-feedback err';
      }
    });
  } else {
    body.innerHTML = `
      <h3>④ 导出目录</h3>
      <p class="desc">每个账号导出一个 JSON（Cookie + localStorage），可直接导入恢复登录态。默认导出到桌面 DolaCookies 目录。</p>
      <input type="text" class="input" id="wizExportDir" value="${cfg ? cfg.exportDir : ''}" placeholder="${cfg ? cfg.exportDirDefault : ''}">
      <p class="desc wiz-step-tag">留空 = 使用默认目录（桌面 DolaCookies）</p>
      <div class="wiz-feedback" id="wizExportFeedback"></div>`;
    $('#wizExportDir').addEventListener('change', async () => {
      const dir = $('#wizExportDir').value.trim();
      await window.api.invoke('config:save', { exportDir: dir });
      state.wizard.exportSaved = true;
      $('#wizExportFeedback').textContent = `✅ 导出目录已保存：${dir || '默认（桌面 DolaCookies）'}`;
      $('#wizExportFeedback').className = 'wiz-feedback ok';
    });
  }
  renderWizardSteps();
  $('#wizPrev').disabled = state.wizardStep === 0;
  $('#wizSkip').style.visibility = WIZ_STEPS[state.wizardStep].skip ? 'visible' : 'hidden';
  $('#wizNext').textContent = state.wizardStep === WIZ_STEPS.length - 1 ? '完成' : '下一步';
}

async function wizardNext() {
  const s = state.wizardStep;
  if (s === 0 && !state.wizard.importedOk) {
    // 池中已有卡密：本步视为已满足（重开向导无需重复导入）
    const setup = state.setup || (await refreshSetup());
    if (setup.hasAccounts) {
      state.wizard.importedOk = true;
      const fb = $('#wizImportFeedback');
      if (fb) { fb.textContent = `✅ 账号池已有 ${setup.accountStats.total} 个卡密，可直接下一步`; fb.className = 'wiz-feedback ok'; }
    }
  }
  if (s === 0 && !state.wizard.importedOk) {
    // 尝试导入
    const ta = $('#wizCards');
    if (!ta || !ta.value.trim()) { toast('请先粘贴卡密', 'warn'); return; }
    try {
      const r = await window.api.invoke('account:importText', { text: ta.value });
      const fb = $('#wizImportFeedback');
      if (r.valid > 0) {
        state.wizard.importedOk = true;
        fb.textContent = `✅ 已导入 ${r.added} 个（有效 ${r.valid} · 重复 ${r.duplicates}${r.invalid.length ? ` · 格式错 ${r.invalid.length}` : ''}）`;
        fb.className = 'wiz-feedback ok';
        await refreshConfig();
      } else {
        fb.textContent = `❌ 没有可导入的有效账号（重复 ${r.duplicates}${r.invalid.length ? ` · 格式错 ${r.invalid.length}：${r.invalid.slice(0, 2).join('；')}` : ''}）`;
        fb.className = 'wiz-feedback err';
        return;
      }
    } catch (e) {
      const fb = $('#wizImportFeedback');
      fb.textContent = `❌ ${e.message}`;
      fb.className = 'wiz-feedback err';
      return;
    }
  }
  if (s === 1 && !(state.config && state.config.proxy.configured)) {
    toast('请先保存提取 API URL（或点左下「跳过此步」）', 'warn');
    return;
  }
  if (s < WIZ_STEPS.length - 1) {
    state.wizardStep += 1;
    wizardStepView();
  } else {
    // 完成：保存导出目录
    const dirInput = $('#wizExportDir');
    if (dirInput) await window.api.invoke('config:save', { exportDir: dirInput.value.trim() });
    await refreshConfig();
    await refreshSetup();
    closeWizard();
    toast('向导完成，可以开始批量注册了 🎉');
  }
}

function openWizard() {
  state.wizardStep = 0;
  state.wizard = { importedOk: false, nexipOk: false, googleOk: false, exportSaved: false };
  $('#wizardOverlay').classList.remove('hidden');
  wizardStepView();
}

function closeWizard() {
  $('#wizardOverlay').classList.add('hidden');
}

// ---------- 设置抽屉 ----------
function openSettings() {
  $('#settingsOverlay').classList.remove('hidden');
  refreshConfig();
  loadAccounts();
}
function closeSettings() {
  $('#settingsOverlay').classList.add('hidden');
}

function wireSettings() {
  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnCloseSettings').addEventListener('click', closeSettings);
  $('#settingsOverlay').addEventListener('click', (e) => {
    if (e.target === $('#settingsOverlay')) closeSettings();
  });

  $('#btnSaveExportDir').addEventListener('click', async () => {
    await window.api.invoke('config:save', { exportDir: $('#setExportDir').value.trim() });
    toast('导出目录已保存');
    refreshConfig();
  });

  $('#btnSaveExtract').addEventListener('click', async () => {
    const url = $('#setExtractUrl').value.trim();
    if (!url) { toast('请先粘贴新的提取 API URL（留空不修改）', 'warn'); return; }
    try {
      await window.api.invoke('config:save', { extractUrl: url });
      $('#setExtractUrl').value = '';
      toast('提取 API 已保存');
      refreshConfig();
    } catch (e) { toast(e.message, 'err'); }
  });

  const showTest = (text, cls) => {
    const el = $('#settingsTestResult');
    el.textContent = text;
    el.className = `test-result mono ${cls || ''}`;
  };
  $('#btnTestNexip').addEventListener('click', async () => {
    showTest('⏳ 正在提取并检测出口（消耗 1 次提取额度）…');
    try {
      const r = await window.api.invoke('setup:testNexip');
      showTest(`✅ 出口 ${r.ip}（${r.country} ${r.city} · ${r.isp}），剩余额度 ${r.usage.left} 次`, 'ok');
    } catch (e) { showTest(`❌ ${e.message}`, 'err'); }
  });
  $('#btnTestGoogle').addEventListener('click', async () => {
    showTest('⏳ 正在探测 generate_204 …');
    try {
      const r = await window.api.invoke('setup:testGoogleLine');
      showTest(r.ok ? `✅ 连通（经 ${r.host}）` : `❌ ${r.error}。${r.hint}`, r.ok ? 'ok' : 'err');
    } catch (e) { showTest(`❌ ${e.message}`, 'err'); }
  });

  const headlessChk = $('#setHeadless');
  if (headlessChk) {
    headlessChk.addEventListener('change', async () => {
      await window.api.invoke('config:save', { headless: headlessChk.checked });
      toast(headlessChk.checked ? '已开启隐身注册（后台运行不弹窗）' : '已关闭隐身注册（批量时会弹出浏览器窗口）');
      refreshConfig();
    });
  }
  $('#btnRerunWizard').addEventListener('click', () => {
    closeSettings();
    openWizard();
  });
}

// ---------- 事件绑定 ----------
function wire() {
  $('#btnStart').addEventListener('click', startBatch);

  // 链路体检：开始批量前预检 Clash → 隧道 → 出口 → Dola（消耗 1 次提取）
  $('#btnChainCheck').addEventListener('click', async () => {
    const btn = $('#btnChainCheck');
    const box = $('#chainResult');
    btn.disabled = true;
    box.classList.remove('hidden');
    box.innerHTML = '<div class="chain-line">⏳ 正在体检（约 5~20 秒，消耗 1 次提取额度）…</div>';
    try {
      const r = await window.api.invoke('chain:check');
      box.innerHTML = r.steps
        .map((s) => `<div class="chain-line ${s.ok ? (s.warn ? 'warn' : 'ok') : 'err'}">${s.ok ? (s.warn ? '⚠️' : '✅') : '❌'} ${s.text}</div>`)
        .join('');
      if (r.usage) renderBudget(r.usage.used, r.usage.max);
      const allOk = r.ok && !r.steps.some((s) => s.warn);
      toast(allOk ? '链路体检通过，可以开始批量' : (r.ok ? '链路通但出口非 HK，建议再体检一次换 IP' : '链路体检未通过，详见上方'), allOk ? 'ok' : 'warn');
    } catch (e) {
      box.innerHTML = `<div class="chain-line err">❌ ${String(e.message || e)}</div>`;
    } finally {
      btn.disabled = false;
    }
  });

  // 自绘标题栏：窗口控制 + 最大化状态图标切换
  if (window.api.win) {
    $('#tbMin').addEventListener('click', () => window.api.win.minimize());
    $('#tbMax').addEventListener('click', () => window.api.win.maximize());
    $('#tbClose').addEventListener('click', () => window.api.win.close());
    // 双击标题栏空白区切换最大化（对齐原生窗口习惯）
    $('#titlebar').addEventListener('dblclick', (e) => {
      if (e.target.closest('.tb-controls')) return;
      window.api.win.maximize();
    });
    window.api.win.isMaximized().then((m) => document.body.classList.toggle('is-maximized', Boolean(m)));
    window.api.on('win:maximized', (m) => document.body.classList.toggle('is-maximized', Boolean(m)));
  }

  // 并发数：1~999 有限档 + ∞ 无上限档（-1）
  const saveCc = async () => {
    renderConcurrency();
    try { await window.api.invoke('config:save', { concurrency: state.concurrency }); }
    catch (e) { toast(String(e.message || e), 'err'); }
  };
  $('#ccMinus').addEventListener('click', async () => {
    // 无上限状态下点 −/+：先回到有限档再步进
    state.concurrency = state.concurrency < 0
      ? Math.max(1, state.lastFiniteCc - 1)
      : Math.max(1, state.concurrency - 1);
    if (state.concurrency > 0) state.lastFiniteCc = state.concurrency;
    await saveCc();
  });
  $('#ccPlus').addEventListener('click', async () => {
    state.concurrency = state.concurrency < 0
      ? Math.min(999, state.lastFiniteCc + 1)
      : Math.min(999, state.concurrency + 1);
    if (state.concurrency > 0) state.lastFiniteCc = state.concurrency;
    await saveCc();
  });
  $('#ccUnlimited').addEventListener('click', async () => {
    state.concurrency = state.concurrency < 0 ? state.lastFiniteCc : -1; // ∞ ↔ 有限档
    await saveCc();
  });

  // 一级视图切换：批量注册 / 账号库
  $('#tabBatch').addEventListener('click', () => switchView('batch'));
  $('#tabAccounts').addEventListener('click', () => switchView('accounts'));

  $('#linkWizard').addEventListener('click', (e) => { e.preventDefault(); openWizard(); });

  // 向导导航
  $('#wizPrev').addEventListener('click', () => {
    if (state.wizardStep > 0) { state.wizardStep -= 1; wizardStepView(); }
  });
  $('#wizNext').addEventListener('click', wizardNext);
  $('#wizSkip').addEventListener('click', () => {
    if (state.wizardStep < WIZ_STEPS.length - 1) { state.wizardStep += 1; wizardStepView(); }
    else wizardNext();
  });

  // 账号库：状态筛选 + 管理操作
  $('#acctFilter').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-f]');
    if (!btn) return;
    state.acctFilter = btn.dataset.f;
    $('#acctFilter').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
    loadAccounts();
  });
  $('#btnImportFile').addEventListener('click', async () => {
    try {
      const r = await window.api.invoke('account:import');
      if (r.ok) { toast(`已导入 ${r.added} 个（跳过重复 ${r.skipped}）`); refreshConfig(); loadAccounts(); }
    } catch (e) { toast(String(e.message || e), 'err'); }
  });
  $('#btnResetFailed').addEventListener('click', async () => {
    try {
      const r = await window.api.invoke('account:reset-failed');
      toast(r.reset ? `已重置 ${r.reset} 个失败账号为可用` : '没有失败账号');
      loadAccounts(); refreshConfig();
    } catch (e) { toast(String(e.message || e), 'err'); }
  });
  $('#btnClearFailed').addEventListener('click', async () => {
    try {
      const r = await window.api.invoke('account:clear-failed');
      toast(r.removed ? `已清除 ${r.removed} 个失败账号` : '没有失败账号');
      loadAccounts(); refreshConfig();
    } catch (e) { toast(String(e.message || e), 'err'); }
  });

  // 批量引擎事件
  window.api.on('batch:account', (d) => upsertWorker(d));
  window.api.on('batch:stats', (s) => {
    renderBudget(s.extractUsage, s.extractBudget);
    // 顶栏池统计随批量实时刷新
    if (typeof s.pending === 'number') {
      $('#poolStats').textContent = `可用 ${s.pending} · 成功 ${s.success} · 失败 ${s.failed}`;
    }
  });
  window.api.on('batch:done', (d) => { onBatchDone(d); loadAccounts(); });
  // 主进程通知（如：启动时自动重置中断账号、自动关机倒计时）
  window.api.on('setup:progress', (d) => { if (d && d.message) toast(d.message); });

  wireSettings();
}

// ---------- 启动 ----------
(async () => {
  wire();
  await refreshConfig();
  const setup = await refreshSetup();
  loadAccounts();
  if (setup.needSetup) openWizard();
})().catch((e) => toast(`初始化失败：${e.message}`, 'err'));

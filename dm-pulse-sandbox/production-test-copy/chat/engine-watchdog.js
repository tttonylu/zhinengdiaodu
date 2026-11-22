'use strict';
/**
 * 守箱引擎看门狗（独立 content script）。
 *
 * 为什么需要它：拉新阶段会跳到本号主页读粉丝数。若该页 content_chat 初始化异常，
 * 主引擎就不会再 tick，表现是 OPS 上 last_pulse_at 永远停住、"引擎在但没检测"。
 * 这个文件不依赖 content_chat，能在任何 X 页面运行，负责：
 *   1. 拉新阶段卡住超过 90 秒 → 复位回守箱；粉丝扫描中给 180 秒；
 *   2. 守箱脉冲逾期超过 3 分钟 → 主动唤醒主引擎；主引擎不存在则回列表页重新加载；
 *   3. 每次动作写 chat.engine_watchdog，OPS 能直接看到"是谁把引擎救回来的"。
 */
(function () {
  var CYCLE_KEY = 'sg_inbox_cycle';
  var STATE_KEY = 'sg_inbox_state';
  var MODE_KEY = 'sg_run_mode';
  var NAV_AT_KEY = 'sg_wd_nav_at';
  var ROSTER_STALE_MS = 90 * 1000;
  var ROSTER_SCAN_STALE_MS = 180 * 1000;
  // 拉新封口后会逐个破冰：每次开人都要离开粉丝列表去资料页/会话页，
  // 期间主引擎用 noteChatProgress 续命。只要进度新鲜就说明队列在动，
  // 不能按「进入拉新的时长」判卡死（现场就是每 90 秒复位、一个人也破不了）。
  var ROSTER_PROGRESS_GRACE_MS = 150 * 1000;
  var PULSE_STALE_MS = 3 * 60 * 1000;
  var NAV_COOLDOWN_MS = 2 * 60 * 1000;

  function lsGet(k) {
    try { return localStorage.getItem(k); } catch (e) { return null; }
  }
  function ssGet(k) {
    try { return sessionStorage.getItem(k); } catch (e) { return null; }
  }
  function ssSet(k, v) {
    try { sessionStorage.setItem(k, v); } catch (e) {}
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, v); } catch (e) {}
  }
  function readJson(raw) {
    try {
      var v = JSON.parse(raw || 'null');
      return (v && typeof v === 'object') ? v : null;
    } catch (e) { return null; }
  }
  function buildVersion() {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
        return String(chrome.runtime.getManifest().version || '');
      }
    } catch (e) {}
    return '';
  }
  function currentPath() {
    try { return String(window.location.pathname || ''); } catch (e) { return ''; }
  }
  function onInboxSurface() {
    var p = currentPath().toLowerCase();
    return p === '/i/chat' || p === '/i/chat/' || p.indexOf('/messages') === 0;
  }
  function inboxWindowOpen() {
    try {
      if (typeof window.TimeUtil !== 'undefined' && window.TimeUtil.isWithinChatHours) {
        return !!window.TimeUtil.isWithinChatHours();
      }
    } catch (eTime) {
      return false;
    }
    // 时段工具缺失时按“夜间关闭”处理，绝不放行守箱导航。
    return false;
  }
  function inboxOn() {
    if (!inboxWindowOpen()) return false;
    var mode = ssGet(MODE_KEY) || lsGet(MODE_KEY) || '';
    if (mode !== 'inbox') return false;
    if (ssGet('sg_test_inbox_watch') === 'true') return true;
    if (lsGet('sg_test_inbox_watch') === 'true') return true;
    try {
      var cfg = JSON.parse(lsGet('sg_config_thresholds') || '{}') || {};
      return cfg.chat_inbox_watch_enabled === true || cfg.chat_inbox_watch_enabled === 'true';
    } catch (e) { return false; }
  }
  function emit(action, extra) {
    try {
      var key = 'sg_wd_emit_' + action;
      var at = parseInt(ssGet(key) || '0', 10) || 0;
      if (at && (Date.now() - at) < 60 * 1000) return;
      ssSet(key, String(Date.now()));
    } catch (eThrottle) {}
    try {
      if (typeof window.SgTelemetry !== 'undefined' && window.SgTelemetry.emit) {
        window.SgTelemetry.emit('chat.engine_watchdog', Object.assign({
          build: buildVersion(),
          action: action,
          path: currentPath(),
          reason_zh: REASON_ZH[action] || action
        }, extra || {}));
      }
    } catch (e) {}
  }
  var REASON_ZH = {
    reset_roster: '拉新阶段长时间无收尾，看门狗复位回守箱',
    back_to_inbox: '不在私信列表页，看门狗导航回 /i/chat',
    nudge_engine: '守箱脉冲逾期，看门狗唤醒主引擎',
    engine_missing: '主引擎不在当前页，看门狗回列表页重新加载',
    nav_cooldown: '两次看门狗导航间隔不足，暂不重复跳转'
  };
  function canNavigate(now) {
    var at = parseInt(ssGet(NAV_AT_KEY) || '0', 10) || 0;
    if (at && (now - at) < NAV_COOLDOWN_MS) return false;
    ssSet(NAV_AT_KEY, String(now));
    return true;
  }
  function goInbox() {
    try {
      if (!onInboxSurface()) window.location.assign('/i/chat');
    } catch (e) {}
  }

  function tick() {
    if (!inboxOn()) return;
    var now = Date.now();

    var cyc = readJson(lsGet(CYCLE_KEY));
    if (cyc && cyc.phase === 'roster') {
      var enteredAt = Number(cyc.enteredAt) || 0;
      var scanAt = Number(cyc.scanActiveAt) || 0;
      var scanning = !!(cyc.scanActive && scanAt);
      var staleFrom = scanning ? scanAt : enteredAt;
      var staleLimit = scanning ? ROSTER_SCAN_STALE_MS : ROSTER_STALE_MS;
      var staleMs = staleFrom ? (now - staleFrom) : 0;
      // 主引擎进度（queue_drain / step_* / roster_*）比“进入时间”更能说明还在干活。
      // 只认私信相关的进度原因，避免关注/养号的进度把真正卡死的拉新也保活。
      var progressAt = parseInt(lsGet('sg_chat_last_progress_at') || ssGet('sg_chat_last_progress_at') || '0', 10) || 0;
      var progressWhy = String(lsGet('sg_chat_last_progress_why') || ssGet('sg_chat_last_progress_why') || '');
      var progressFresh = !!(progressAt && (now - progressAt) < ROSTER_PROGRESS_GRACE_MS
        // 注意：`roster_scan_active` / `inbox_roster_wait_profile` 只是每拍打的心跳，
        // 不代表扫描真的在推进。把它们算成进度会让“卡死的扫描”永远不被复位，
        // 所以这里只认真正换了步骤/换了目标的进度。
        && /^(queue_|step_|ice_|has_target|target_|dm_|roster_seal|roster_ice)/.test(progressWhy));
      if (staleFrom && staleMs > staleLimit && !progressFresh) {
        var wasScanning = !!cyc.scanActive;
        cyc.phase = 'watch';
        cyc.enteredAt = 0;
        cyc.lastExitAt = now;
        cyc.reason = 'watchdog_roster_stale';
        cyc.scanActive = false;
        lsSet(CYCLE_KEY, JSON.stringify(cyc));
        emit('reset_roster', {
          stale_ms: staleMs,
          stale_limit_ms: staleLimit,
          scan_active: wasScanning,
          progress_at: progressAt,
          progress_why: progressWhy,
          progress_fresh: progressFresh
        });
        if (!onInboxSurface() && canNavigate(now)) {
          emit('back_to_inbox', { from: currentPath() });
          goInbox();
          return;
        }
      }
    }

    var st = readJson(ssGet(STATE_KEY)) || readJson(lsGet(STATE_KEY)) || {};
    var nextPulseAt = Number(st.nextPulseAt) || 0;
    var overdue = nextPulseAt ? (now - nextPulseAt) : 0;
    if (st.busy || !nextPulseAt || overdue <= PULSE_STALE_MS) return;

    if (typeof window.__sgChatMainEngineTick === 'function') {
      emit('nudge_engine', { overdue_ms: overdue, path: currentPath() });
      try { window.__sgChatMainEngineTick(); } catch (e) {}
      return;
    }
    emit('engine_missing', { overdue_ms: overdue, path: currentPath() });
    if (!onInboxSurface() && canNavigate(now)) {
      emit('back_to_inbox', { from: currentPath() });
      goInbox();
    }
  }

  try {
    window.SgEngineWatchdog = {
      tick: tick,
      inboxOn: inboxOn,
      inboxWindowOpen: inboxWindowOpen,
      onInboxSurface: onInboxSurface
    };
  } catch (e) {}
  try { setTimeout(tick, 5000); } catch (e1) {}
  try { setInterval(tick, 15000); } catch (e2) {}
})();

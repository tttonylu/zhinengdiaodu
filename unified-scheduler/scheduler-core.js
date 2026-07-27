// =============================================================================
// 智能调度 — 调度核心 V5
// 改动：
//   1. Logger + SKeys 替换硬编码
//   2. prev 三字段持久化 → 跨页面边沿检测不丢
//   3. chatRoundsToday / chatLastEndAt → 私信轮次管控
// =============================================================================

(function () {
  'use strict';

  var K = SKeys;
  var S = {};
  var prev = { followActive: false, nurturing: false, chatRunning: false };
  var g_stage = 'S0';
  var _lastCoorNurtureStart = 0;

  // ==================== 工具 ====================
  function inRange(hS, mS, hE, mE) {
    var s = new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour12: false });
    var m = s.match(/(\d+):(\d+)/);
    if (!m) return false;
    var t = parseInt(m[1]) * 60 + parseInt(m[2]);
    return t >= (hS * 60 + mS) && t < (hE * 60 + mE);
  }
  function getMyHandle() {
    var h = localStorage.getItem(K.LK_MY_HANDLE);
    if (h) return h.replace('@', '').replace('#guard', '').toLowerCase();
    var el = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    if (el && el.href) { h = el.href.split('/').pop().toLowerCase(); localStorage.setItem(K.LK_MY_HANDLE, '@' + h + '#guard'); return h; }
    return 'unknown';
  }
  function getWorkerId() { var h = getMyHandle(); if (h === 'unknown') h = String(Math.floor(Math.random() * 90000 + 10000)); return '@' + h + '#guard'; }
  function getDayCount() {
    try { return (JSON.parse(localStorage.getItem('matrix_stats_' + getMyHandle()) || '{}')).day_count || 1; } catch (e) { return 1; }
  }
  function getFollowedToday() {
    try { return (JSON.parse(localStorage.getItem('matrix_stats_' + getMyHandle()) || '{}')).follows_today || 0; } catch (e) { return 0; }
  }
  function getLimit() {
    try {
      if (localStorage.getItem(K.LK_ANTIBAN_ENABLED) === 'true') { var d = Math.max(0, getDayCount() - 1); return d === 0 ? rnd(10, 20) : Math.min(50 * d, 200); }
      var remote = localStorage.getItem('sg_config_thresholds');
      if (remote) {
        var t = JSON.parse(remote);
        if (t.follow_daily_limit) return parseInt(t.follow_daily_limit);
      }
      return (JSON.parse(localStorage.getItem(K.LK_CONSOLE_SETTINGS) || '{}')).followLimit || 200;
    } catch (e) { return 200; }
  }
  function rnd(m, x) { return Math.floor(Math.random() * (x - m + 1)) + m; }
  function shanghaiDate() { return new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }); }

  // ==================== 状态持久化(含 prev 边沿快照 + 私信管控) ====================
  function loadSG() {
    try {
      var raw = JSON.parse(localStorage.getItem(K.LK_STATE)) || {};
      S.running = raw.running || false;
      S.engine = raw.engine || 'idle';
      S.followRound = raw.followRound || 0;
      S.followPhase = raw.followPhase || 'idle';
      S.currentBlogger = raw.currentBlogger || '';
      S.warmupEndAt = raw.warmupEndAt || 0;
      S.chatPhase = raw.chatPhase || 'idle';
      S.suspendedBlogger = raw.suspendedBlogger || '';
      S.pendingChat = raw.pendingChat || false;
      S.followRoundsToday = raw.followRoundsToday || 0;
      // 跨页边沿
      prev.followActive = raw.pvFa || false;
      prev.nurturing = raw.pvNr || false;
      prev.chatRunning = raw.pvCr || false;
      // 私信管控
      S.chatRoundsToday = raw.chatRoundsToday || 0;
      S.chatLastEndAt = raw.chatLastEndAt || 0;
      S.chatDate = raw.chatDate || '';
      S.nurtureOnly = raw.nurtureOnly || false;
    } catch (e) {}
  }
  function saveSG() {
    try {
      localStorage.setItem(K.LK_STATE, JSON.stringify({
        running: S.running, engine: S.engine, followRound: S.followRound, followPhase: S.followPhase,
        currentBlogger: S.currentBlogger, warmupEndAt: S.warmupEndAt, chatPhase: S.chatPhase,
        suspendedBlogger: S.suspendedBlogger, pendingChat: S.pendingChat, followRoundsToday: S.followRoundsToday,
        pvFa: prev.followActive, pvNr: prev.nurturing, pvCr: prev.chatRunning,
        chatRoundsToday: S.chatRoundsToday, chatLastEndAt: S.chatLastEndAt, chatDate: S.chatDate,
        nurtureOnly: S.nurtureOnly,
      }));
    } catch (e) {}
  }

  // ==================== 引擎控制 ====================
  function stopFollow() {
    sessionStorage.setItem(K.SK_TAB_RUNNING, 'stopped_by_user');
    localStorage.removeItem(K.LK_FOLLOW_RUNNING);
  }
  function stopChat() {
    sessionStorage.setItem(K.SK_CHAT_AUTO_RUN, 'false');
    localStorage.setItem(K.LK_CHAT_STATUS, 'stopped');
    localStorage.removeItem(K.LK_CHAT_RECOVERY);
  }
  function startNurture() {
    try {
      sessionStorage.setItem(K.SK_NURTURE_RUNNING, 'true');
      window.dispatchEvent(new CustomEvent('sg-nurture-command', { detail: { command: 'start' } }));
      Logger.info('调度', '启动养号引擎');
    } catch (e) {}
  }
  function stopNurture() {
    try {
      sessionStorage.removeItem(K.SK_NURTURE_RUNNING);
      window.dispatchEvent(new CustomEvent('sg-nurture-command', { detail: { command: 'stop' } }));
      Logger.info('调度', '停止养号引擎');
    } catch (e) {}
  }
  function stopAll() { stopFollow(); stopChat(); stopNurture(); }

  function startFollow() {
    stopChat();  // 清对立引擎 flag
    Logger.info('调度', '领号中');
    chrome.runtime.sendMessage({ action: 'pool_pop', worker_id: getWorkerId() }, function (r) {
      if (r && r.handle) {
        var h = r.handle.replace(/^@/, '');
        localStorage.setItem(K.LK_CURRENT_CREATOR, h);
        if (r.id) localStorage.setItem(K.LK_CURRENT_TASK_ID, String(r.id));
        S.currentBlogger = h; S.followPhase = 'active';
        localStorage.setItem(K.LK_FOLLOW_RUNNING, 'true');
        sessionStorage.setItem(K.SK_TAB_RUNNING, 'true');
        Logger.info('调度', '领号成功 → @' + h);
        window.location.href = 'https://x.com/' + h + '/followers';
      } else {
        Logger.warn('调度', '池空');
        S.engine = 'idle'; saveSG();
      }
    });
  }

  function startChat() {
    stopFollow();  // 清对立引擎 flag
    var h = getMyHandle();
    if (h && h !== 'unknown') {
      sessionStorage.setItem(K.SK_CHAT_AUTO_RUN, 'true');
      localStorage.setItem(K.LK_CHAT_STATUS, 'running');
      localStorage.setItem(K.LK_CHAT_RECOVERY, 'true');
      S.chatPhase = 'running';
      Logger.info('调度', '启动私信');
      window.location.href = 'https://x.com/' + h + '/followers?_t=' + Date.now();
    }
  }

  // ==================== 主循环 ====================
  // V5 tick 已退役 — 由 Coordinator 全权接管

  // ==================== 控制接口 ====================
  function schedulerStart() {
    stopAll(); S.running = true; S.engine = 'idle'; S.followRound = 0; S.followPhase = 'idle';
    S.currentBlogger = ''; S.warmupEndAt = 0; S.chatPhase = 'idle'; S.suspendedBlogger = ''; S.pendingChat = false;
    S.nurtureOnly = false;
    Logger.info('调度', '自动模式启动');
    chrome.runtime.sendMessage({ action: 'ops_account_register', bot_id: getWorkerId() }, function (r) {
      if (r && r.ok) Logger.info('调度', 'OPS注册: Day ' + r.account.day_count);
    });
    saveSG();
    if (typeof Coordinator !== 'undefined') Coordinator.start();
  }
  function schedulerPause() { stopAll(); S.running = false; S.engine = 'idle'; S.followPhase = 'idle'; Logger.info('调度', '暂停'); saveSG(); if (typeof Coordinator !== 'undefined') Coordinator.pause(); }
  function manualFollow() { stopChat(); stopNurture(); S.running = false; saveSG(); startFollow(); }
  function manualChat() { stopFollow(); stopNurture(); S.running = false; saveSG(); startChat(); }
  function manualNurture() { stopFollow(); stopChat(); S.running = false; saveSG(); startNurture(); }
  function toggleNurtureOnly() {
    S.nurtureOnly = !S.nurtureOnly;
    if (S.nurtureOnly) {
      stopFollow(); stopChat(); S.running = true;
      Logger.info('调度', '养号独立模式: ON');
    } else {
      stopNurture(); S.engine = 'idle';
      Logger.info('调度', '养号独立模式: OFF');
    }
    saveSG();
  }

  // ==================== 面板 ====================
  function updatePanel() {
    try {
      var nuStats = {};
      try {
        if (typeof NurtureTracker !== 'undefined' && NurtureTracker.getStats) {
          var ns = NurtureTracker.getStats();
          if (ns.daily && ns.daily.used) {
            nuStats.likes = ns.daily.used.likes || 0;
            nuStats.comments = ns.daily.used.comments || 0;
            nuStats.likeBudget = (ns.daily.budget && ns.daily.budget.likes) ? ns.daily.budget.likes : 0;
            nuStats.commentBudget = (ns.daily.budget && ns.daily.budget.comments) ? ns.daily.budget.comments : 0;
          }
        }
      } catch (e) {}
      window.dispatchEvent(new CustomEvent('sg-scheduler-tick', { detail: {
        engine: S.engine, followRound: S.followRound, followPhase: S.followPhase,
        warmupEndAt: S.warmupEndAt, autoMode: S.running, pendingChat: S.pendingChat, chatPhase: S.chatPhase,
        chatRoundsToday: S.chatRoundsToday, nurtureOnly: S.nurtureOnly,
        followRunning: localStorage.getItem(K.LK_FOLLOW_RUNNING) === 'true',
        chatRunning: sessionStorage.getItem(K.SK_CHAT_AUTO_RUN) === 'true',
        nurtureRunning: sessionStorage.getItem(K.SK_NURTURE_RUNNING) === 'true',
        nurtureDaily: nuStats,
        warmupNeeded: localStorage.getItem(K.LK_WARMUP_NEEDED) === 'true',
        dayCount: getDayCount(), followedToday: getFollowedToday(), followLimit: getLimit(),
        isChatTime: inRange(8, 0, 18, 0), isWorkTime: inRange(8, 0, 23, 0),
        currentCreator: S.currentBlogger || localStorage.getItem(K.LK_CURRENT_CREATOR) || '',
        suspended: S.suspendedBlogger, url: window.location.href,
        stage: g_stage,
      }}));
    } catch (e) {}
  }

  // ==================== 初始化 ====================
  function init() {
    loadSG();
    saveSG(); updatePanel();

    // Coordinator — 智能调度唯一大脑
    window.addEventListener('sg-coordinator-tick', function (e) {
      if (e.detail && e.detail.stage) g_stage = e.detail.stage;
    });
    window.addEventListener('sg-coordinator-command', function (e) {
      var d = e.detail;
      if (d.action === 'stop') {
        if (d.module === 'nurture') { stopNurture(); if (window._lastModuleAction) window._lastModuleAction.nurture = Date.now(); }
        if (d.module === 'follow')  { stopFollow();  if (window._lastModuleAction) window._lastModuleAction.follow  = Date.now(); }
        if (d.module === 'chat')    { stopChat();    if (window._lastModuleAction) window._lastModuleAction.chat    = Date.now(); }
      }
      if (d.action === 'start') {
        if (d.module === 'nurture') {
          if (Date.now() - _lastCoorNurtureStart > 30000) { startNurture(); _lastCoorNurtureStart = Date.now(); }
          if (window._lastModuleAction) window._lastModuleAction.nurture = Date.now();
        }
        if (d.module === 'follow')  { startFollow(); if (window._lastModuleAction) window._lastModuleAction.follow = Date.now(); }
        if (d.module === 'chat')    { startChat();   if (window._lastModuleAction) window._lastModuleAction.chat   = Date.now(); }
      }
    });
    if (typeof Coordinator !== 'undefined') {
      var msCheck = function () {
        try {
          var raw = localStorage.getItem('sg_module_switches');
          if (raw) { var sw = JSON.parse(raw); return function (m) { return sw[m] !== false; }; }
        } catch (e) {}
        return function () { return true; };
      };
      var msOn = msCheck();
      window._lastModuleAction = { follow: Date.now(), chat: Date.now(), nurture: Date.now() };
      window.addEventListener('matrix-nurture-log', function () { if (window._lastModuleAction) window._lastModuleAction.nurture = Date.now(); });
      window.addEventListener('matrix-follow-status', function () { if (window._lastModuleAction) window._lastModuleAction.follow = Date.now(); });
      Coordinator.register('nurture', { canRun: function () { return msOn('nurture'); }, tick: function () { return { tookPage: true, nextDelayMs: 0 }; } });
      Coordinator.register('follow',  { canRun: function (s) { return msOn('follow') && s !== 'S0' && s !== 'S1' && s !== 'S4'; }, tick: function () { return { tookPage: true, nextDelayMs: 0 }; } });
      Coordinator.register('chat',    { canRun: function (s) { return msOn('chat') && s === 'S3'; }, tick: function () { return { tookPage: true, nextDelayMs: 0 }; } });
      Coordinator.init();
      Coordinator.start();
      Logger.info('调度', '智能调度 V6 已启动（Coordinator 全权接管）');
    }

  // ==================== 消息监听 ====================
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (msg.action === 'sg_scheduler_start')  { schedulerStart(); sendResponse({ ok: true }); return true; }
      if (msg.action === 'sg_scheduler_pause')  { schedulerPause(); sendResponse({ ok: true }); return true; }
      if (msg.action === 'sg_manual_follow')    { manualFollow(); sendResponse({ ok: true }); return true; }
      if (msg.action === 'sg_manual_chat')      { manualChat(); sendResponse({ ok: true }); return true; }
      if (msg.action === 'sg_manual_nurture')   { manualNurture(); sendResponse({ ok: true }); return true; }
      if (msg.action === 'sg_nurture_only')     { toggleNurtureOnly(); sendResponse({ ok: true }); return true; }
      if (msg.action === 'sg_nurture_throttled') {
        Logger.info('调度', '养号报告: 今日配额用完');
        if (!S.nurtureOnly && S.engine === 'nurture_only') {
          S.engine = 'idle'; saveSG();
        }
        sendResponse({ ok: true }); return true;
      }
      if (msg.action === 'sg_test_chat_first') {
        stopFollow(); stopChat();
        S.running = true; S.engine = 'chat'; S.followRound = 2; S.followPhase = 'idle'; S.pendingChat = true; S.chatPhase = 'running';
        sessionStorage.setItem(K.SK_CHAT_AUTO_RUN, 'true');
        localStorage.setItem(K.LK_CHAT_STATUS, 'running');
        localStorage.setItem(K.LK_CHAT_RECOVERY, 'true');
        saveSG(); updatePanel();
        var myH = getMyHandle();
        if (myH !== 'unknown') window.location.href = 'https://x.com/' + myH + '/followers?_t=' + Date.now();
        sendResponse({ ok: true }); return true;
      }
      if (msg.action === 'sg_scheduler_status') {
        sendResponse({
          engine: S.engine, followRound: S.followRound, followPhase: S.followPhase,
          autoMode: S.running, pendingChat: S.pendingChat, chatPhase: S.chatPhase, chatRoundsToday: S.chatRoundsToday,
          warmupEndAt: S.warmupEndAt, followRunning: localStorage.getItem(K.LK_FOLLOW_RUNNING) === 'true',
          warmupNeeded: localStorage.getItem(K.LK_WARMUP_NEEDED) === 'true', chatRunning: sessionStorage.getItem(K.SK_CHAT_AUTO_RUN) === 'true',
          nurtureRunning: sessionStorage.getItem(K.SK_NURTURE_RUNNING) === 'true', nurtureOnly: S.nurtureOnly,
          dayCount: getDayCount(), followedToday: getFollowedToday(), followLimit: getLimit(), url: window.location.href,
          currentCreator: S.currentBlogger || localStorage.getItem(K.LK_CURRENT_CREATOR) || '', suspended: S.suspendedBlogger,
        }); return true;
      }
    });
  }

  window.addEventListener('beforeunload', saveSG);
  setTimeout(init, 1500);
})();

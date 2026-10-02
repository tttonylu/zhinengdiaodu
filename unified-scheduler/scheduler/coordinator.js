// V3: 调度核心已合入 scheduler-core.js，此文件不再加载
return;
// === 原 coordinator.js 保留供参考 ===

(function () {
  'use strict';

  var K = SKeys;

  var modules = {};
  var prev = { stage: 'S0' };
  var interval = null, wdTimer = null, lastTick = 0;
  var tickLock = false;
  var running = false;

  var MODULE_MAX_RUNTIME = { chat: 30 * 60 * 1000, follow: 20 * 60 * 1000, nurture: 15 * 60 * 1000 };

  // ==================== 状态读写 ====================
  function STATE_KEY(name) { return 'sg_module_' + name; }

  function readModuleState(name) {
    try {
      var raw = sessionStorage.getItem(STATE_KEY(name));
      return raw ? JSON.parse(raw) : { running: false, phase: 'idle', targetUrl: '', startedAt: 0, lastActive: 0 };
    } catch (e) { return { running: false, phase: 'idle', targetUrl: '', startedAt: 0, lastActive: 0 }; }
  }

  function writeModuleState(name, s) {
    try { sessionStorage.setItem(STATE_KEY(name), JSON.stringify(s)); } catch (e) {}
  }

  function isModuleRunning(name) {
    return readModuleState(name).running === true;
  }

  function stopModule(name) {
    var prevMs = readModuleState(name);
    var m = modules[name];
    try { if (m && typeof m.stop === 'function') m.stop(); } catch (e) {}
    if (m) { m._state = 'stopped'; m._startedAt = 0; }
    writeModuleState(name, { running: false, phase: 'idle', targetUrl: '', startedAt: 0, lastActive: Date.now() });
    Logger.info('Coor', '停止模块: ' + name);
  }

  function startModule(name, targetUrl) {
    var m = modules[name];
    if (!m) return;
    try { if (typeof m.start === 'function') m.start(targetUrl); } catch (e) { Logger.error('Coor', name + ' start失败: ' + e.message); }
    m._state = 'running';
    m._startedAt = Date.now();
    writeModuleState(name, { running: true, phase: 'starting', targetUrl: targetUrl || '', startedAt: m._startedAt, lastActive: m._startedAt });
    Logger.info('Coor', '启动模块: ' + name + ' → ' + (targetUrl || '(无目标)'));
  }

  // ==================== 模块注册 ====================
  function register(name, mod) {
    if (!mod || typeof mod.canRun !== 'function') { Logger.warn('Coor', '模块 ' + name + ' 缺少 canRun, 跳过'); return; }
    modules[name] = mod;
    mod._name = name; mod._state = 'stopped'; mod._startedAt = 0;
    Logger.info('Coor', '注册模块: ' + name);
  }

  // ==================== 计时辅助 ====================
  function readSgState() {
    try { return JSON.parse(localStorage.getItem(K.LK_STATE) || '{}'); } catch (e) { return {}; }
  }

  function writeSgState(s) {
    try { localStorage.setItem(K.LK_STATE, JSON.stringify(s)); } catch (e) {}
  }

  function getChatIntervalMs() {
    try {
      var raw = localStorage.getItem('sg_config_intervals');
      if (raw) {
        var c = JSON.parse(raw);
        var minM = parseInt(c.chat_cooldown_min_min, 10);
        var maxM = parseInt(c.chat_cooldown_max_min, 10);
        if (!isNaN(minM) && !isNaN(maxM) && maxM >= minM) {
          return (minM + Math.floor(Math.random() * (maxM - minM + 1))) * 60 * 1000;
        }
      }
    } catch (e) {}
    return (50 + Math.floor(Math.random() * 11)) * 60 * 1000;
  }

  function recordFollowDuration(startedAt) {
    if (!startedAt) return;
    var dur = Math.floor((Date.now() - startedAt) / 1000);
    if (dur <= 0) return;
    try {
      var sg = readSgState();
      var today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
      if (sg.followDate !== today) { sg.followTotalToday = 0; sg.followDate = today; }
      sg.followTotalToday = (sg.followTotalToday || 0) + dur;
      writeSgState(sg);
      Logger.info('Coor', '关注累计用时 +' + dur + 's, 今日 ' + sg.followTotalToday + 's');
    } catch (e) {}
  }

  function recordNurtureDuration(startedAt) {
    if (!startedAt) return;
    var dur = Math.floor((Date.now() - startedAt) / 1000);
    if (dur <= 0) return;
    try {
      var sg = readSgState();
      var today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
      if (sg.nurtureDate !== today) { sg.nurtureTotalToday = 0; sg.nurtureDate = today; }
      sg.nurtureTotalToday = (sg.nurtureTotalToday || 0) + dur;
      writeSgState(sg);
      Logger.info('Coor', '养号累计用时 +' + dur + 's, 今日 ' + sg.nurtureTotalToday + 's');
    } catch (e) {}
  }

  // ==================== 持久化 ====================
  function ensureStageDetectorLoaded() {
    if (typeof StageDetector === 'undefined') { Logger.error('Coor', 'StageDetector 未加载'); return false; }
    return true;
  }

  function loadPrev() {
    try {
      var sg = readSgState();
      prev.stage = sg.coStage || 'S0';
      if (sg.coModules) {
        for (var k in sg.coModules) {
          if (modules[k]) modules[k]._state = sg.coModules[k].state || 'stopped';
        }
      }
    } catch (e) {}
  }

  function savePrev() {
    try {
      var sg = readSgState();
      var modSnap = {};
      for (var k in modules) modSnap[k] = { state: modules[k]._state || 'stopped' };
      sg.coStage = prev.stage;
      sg.coModules = modSnap;
      writeSgState(sg);
    } catch (e) {}
  }

  function stopAllModules() { for (var k in modules) stopModule(k); }

  // ==================== 面板 ====================
  function getV5State() {
    try {
      var h = (localStorage.getItem(K.LK_MY_HANDLE) || '').replace('@','').replace('#guard','').toLowerCase();
      if (!h) h = 'unknown';
      var stats = {};
      try { stats = JSON.parse(localStorage.getItem('matrix_stats_' + h) || '{}'); } catch (e) {}
      return {
        dayCount: stats.day_count || 1, followedToday: stats.follows_today || 0,
        followLimit: (function () {
          try {
            var locked = parseInt(stats.daily_limit, 10);
            var todayKey = '';
            try { todayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }); } catch (eT) {}
            var stDay = String(stats.date || '');
            var mD = stDay.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
            var stKey = mD ? (mD[1] + '-' + String(mD[2]).padStart(2, '0') + '-' + String(mD[3]).padStart(2, '0')) : stDay;
            if (!isNaN(locked) && locked > 0 && stKey && todayKey && stKey === todayKey) return locked;
            if (typeof RemoteSettings !== 'undefined' && RemoteSettings.followDayRange) {
              var rg = RemoteSettings.followDayRange(stats.day_count || 1);
              if (rg && rg.max) return Math.round((rg.min + rg.max) / 2);
            }
            if (typeof RemoteSettings !== 'undefined' && RemoteSettings.followDailyLimit) {
              var rl = RemoteSettings.followDailyLimit(stats.day_count || 1);
              if (rl != null && rl > 0) return rl;
            }
            return (JSON.parse(localStorage.getItem(K.LK_CONSOLE_SETTINGS) || '{}')).followLimit || 255;
          } catch (_) { return 255; }
        })(),
        currentCreator: (localStorage.getItem(K.LK_CURRENT_CREATOR) || ''),
        followRunning: localStorage.getItem(K.LK_FOLLOW_RUNNING) === 'true',
        chatRunning: sessionStorage.getItem('dan_auto_run') === 'true' || localStorage.getItem('dan_chat_status') === 'running',
        nurtureRunning: sessionStorage.getItem('sg_nurture_running') === 'true',
        url: window.location.href
      };
    } catch (e) { return { dayCount:1,followedToday:0,followLimit:200,currentCreator:'',followRunning:false,chatRunning:false,nurtureRunning:false,url:window.location.href }; }
  }

  function updatePanel(ctx) {
    try {
      var v5 = getV5State();
      var modStatus = {};
      var runningModule = null;
      for (var k in modules) {
        var ms = readModuleState(k);
        modStatus[k] = { state: modules[k]._state || 'stopped', phase: ms.phase || 'idle' };
        if (isModuleRunning(k)) runningModule = k;
      }
      window.dispatchEvent(new CustomEvent('sg-coordinator-tick', { detail: {
        engine: 'coor', stage: prev.stage, autoMode: running, runningModule: runningModule,
        followRunning: v5.followRunning, chatRunning: v5.chatRunning, nurtureRunning: v5.nurtureRunning,
        dayCount: v5.dayCount, followedToday: v5.followedToday, followLimit: v5.followLimit,
        currentCreator: v5.currentCreator, url: v5.url,
        isWorkTime: (typeof StageDetector !== 'undefined') ? StageDetector.isWorkTime() : true,
        isChatTime: (typeof StageDetector !== 'undefined') ? StageDetector.isChatTime() : false,
        modules: modStatus, ctx: ctx || {}
      }}));
    } catch (e) {}
  }

  // ==================== 核心 Tick ====================
  function onTick() {
    if (tickLock) return;
    tickLock = true;
    lastTick = Date.now();
    try {
      // 1) 阶段检测
      var stage = 'S0', priority = [];
      if (ensureStageDetectorLoaded()) {
        var result = StageDetector.detect();
        stage = result.stage; priority = result.priority || [];
      }
      prev.stage = stage;
      if (!running) { updatePanel(); return; }

      // 2) S0 全停
      if (stage === 'S0') { stopAllModules(); savePrev(); updatePanel(); return; }

      // 3) 同步运行状态
      var hasRunning = false;
      for (var k in modules) {
        var ms = readModuleState(k);
        if (ms.running) {
          modules[k]._state = 'running';
          hasRunning = true;
        } else if (modules[k]._state === 'running') {
          modules[k]._state = 'stopped';
          if (k === 'follow' && modules[k]._startedAt) {
            recordFollowDuration(modules[k]._startedAt);
          }
          if (k === 'nurture' && modules[k]._startedAt) {
            recordNurtureDuration(modules[k]._startedAt);
          }
        }
      }

      // 4) 养号15min打断 → 重检
      var ns = readModuleState('nurture');
      if (ns.running && ns.startedAt && Date.now() - ns.startedAt > 15 * 60 * 1000) {
        Logger.info('Coor', '养号 超15min → 打断重检');
        if (modules['nurture'] && modules['nurture']._startedAt) recordNurtureDuration(modules['nurture']._startedAt);
        stopModule('nurture');
        for (var kk in modules) {
          if (isModuleRunning(kk)) { modules[kk]._state = 'running'; hasRunning = true; }
          else if (modules[kk]._state === 'running') modules[kk]._state = 'stopped';
        }
      }

      // 5) 检查不兼容模块（阶段变更）
      if (hasRunning) {
        for (var ak in modules) {
          var am = modules[ak];
          if (!am || !isModuleRunning(ak)) continue;
          if (typeof am.canRun === 'function' && !am.canRun(stage)) {
            Logger.info('Coor', '阶段变更 → 停止 ' + ak);
            stopModule(ak);
            hasRunning = false;
          }
        }
      }

      // 6) 超时轮转
      if (hasRunning) {
        for (var i = 0; i < priority.length; i++) {
          var name = priority[i];
          var m = modules[name];
          if (!m || !isModuleRunning(name)) continue;
          var rms = readModuleState(name);
          var maxTime = MODULE_MAX_RUNTIME[name] || 30 * 60 * 1000;
          if (rms.startedAt && Date.now() - rms.startedAt > maxTime) {
            Logger.info('Coor', name + ' 超时 ' + Math.floor(maxTime/60000) + 'min → 轮转');
            stopModule(name);
            hasRunning = false;
            break;
          }
          updateModuleActive(name);
        }
      }

      if (hasRunning) {
        savePrev();
        updatePanel({ currentStage: stage, runningModule: findRunningModuleName(), trusting: true });
        tickLock = false; return;
      }

      // 7) 启动下一个模块
      var sg = readSgState();
      var now = Date.now();

      for (var j = 0; j < priority.length; j++) {
        var c = priority[j];
        var cm = modules[c];
        if (!cm || typeof cm.canRun !== 'function' || !cm.canRun(stage)) continue;

        var canGo = false;
        if (c === 'follow') {
          canGo = now > (sg.followNextDelayUntil || 0);
        } else if (c === 'chat') {
          // 4.1.38：仅尊重显式 chatNextAllowedAt；废除 LastEnd+55m 兜底
          var nextAt = sg.chatNextAllowedAt || 0;
          canGo = !nextAt || now >= nextAt;
          // SCRM 闸门：检测通过且在线才放行（与 scheduler-core / OPS 45 分钟对齐）
          if (canGo) {
            try {
              var cg = null;
              try { cg = JSON.parse(sessionStorage.getItem('sg_scrm_gate_cache') || 'null'); } catch (eC) {}
              var SCRM_GATE_CACHE_MS = 45 * 60 * 1000;
              if (cg && cg.at && (Date.now() - cg.at) <= SCRM_GATE_CACHE_MS) {
                if (!cg.allow) canGo = false;
              } else if (cg && cg.at && (Date.now() - cg.at) > SCRM_GATE_CACHE_MS) {
                canGo = false; // 与 OPS 快照过期一致
              }
            } catch (eSg) {}
          }
        } else if (c === 'nurture') {
          canGo = true;
        }

        if (canGo) {
          var targetUrl = typeof PageRouter !== 'undefined' ? PageRouter.homeUrlFor(c) : '';
          startModule(c, targetUrl);
          savePrev();
          updatePanel({ currentStage: stage, started: c });
          tickLock = false; return;
        }
      }

      updatePanel({ currentStage: stage, reason: 'all_waiting' });
      savePrev();
    } finally {
      tickLock = false;
    }
  }

  function findRunningModuleName() {
    for (var k in modules) { if (isModuleRunning(k)) return k; }
    return null;
  }

  function updateModuleActive(name) {
    var ms = readModuleState(name);
    ms.lastActive = Date.now();
    writeModuleState(name, ms);
    try { if (window._lastModuleAction) window._lastModuleAction[name] = Date.now(); } catch (e) {}
  }

  // ==================== 外部接口 ====================
  function cStart() { loadPrev(); running = true; Logger.info('Coor', 'Coordinator 启动 (V3精简)'); savePrev(); onTick(); }
  function cStop() { running = false; stopAllModules(); Logger.info('Coor', 'Coordinator 停止'); savePrev(); updatePanel(); }
  function cPause() { running = false; Logger.info('Coor', 'Coordinator 暂停'); savePrev(); updatePanel(); }
  function cResume() { running = true; Logger.info('Coor', 'Coordinator 恢复'); savePrev(); onTick(); }
  function getMod(name) { return modules[name] || null; }

  function startInterval(intMs) {
    if (interval) clearInterval(interval);
    interval = setInterval(function () { loadPrev(); onTick(); }, intMs || 10000);
    if (wdTimer) clearInterval(wdTimer);
    wdTimer = setInterval(function () {
      if (Date.now() - lastTick > 30000 && !tickLock) { lastTick = Date.now(); Logger.warn('Coor', '看门狗重启'); onTick(); }
      else if (Date.now() - lastTick > 60000) { tickLock = false; Logger.warn('Coor', '看门狗清理 tickLock'); lastTick = Date.now(); onTick(); }
    }, 30000);
    // 每日工作统计上报（每 5 分钟）
    if (window._dailyStatsTimer) clearInterval(window._dailyStatsTimer);
    window._dailyStatsTimer = setInterval(reportDailyStats, 5 * 60 * 1000);
    reportDailyStats();
  }

  function reportDailyStats() {
    try {
      var sg = readSgState();
      var v5 = getV5State();
      var h = (localStorage.getItem(K.LK_MY_HANDLE) || 'unknown').replace('@','').replace('#guard','').toLowerCase();
      var nurtureLikes = 0, nurtureComments = 0;
      try {
        if (typeof NurtureTracker !== 'undefined' && NurtureTracker.getStats) {
          var ns = NurtureTracker.getStats();
          nurtureLikes = (ns.daily && ns.daily.used) ? (ns.daily.used.likes || 0) : 0;
          nurtureComments = (ns.daily && ns.daily.used) ? (ns.daily.used.comments || 0) : 0;
        }
      } catch (e) {}
      // 如果 nurture 已经写完 sg_state，优先用那里的值
      if (sg.nurtureLikesTotal) nurtureLikes = sg.nurtureLikesTotal;
      if (sg.nurtureCommentsTotal) nurtureComments = sg.nurtureCommentsTotal;
      var payload = {
        worker_id: '@' + h + '#guard',
        follow_count: v5.followedToday || 0,
        follow_duration_sec: sg.followTotalToday || 0,
        chat_rounds: sg.chatRoundsToday || 0,
        chat_duration_sec: sg.chatTotalToday || 0,
        nurture_likes: nurtureLikes,
        nurture_comments: nurtureComments,
        nurture_duration_sec: sg.nurtureTotalToday || 0
      };
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ action: 'report_daily_stats', payload: payload });
      }
    } catch (e) {}
  }

  function init() {
    startInterval(10000);
    Logger.info('Coor', '调度中心已加载 (V3精简)');
    if (typeof window !== 'undefined' && window.SG_DEBUG) {
      clearInterval(interval);
      interval = setInterval(function () { loadPrev(); onTick(); }, 2000);
      console.log('[Coor] DEBUG: 2s tick');
    }
  }

  var Coordinator = {
    register: register, start: cStart, stop: cStop, pause: cPause, resume: cResume,
    init: init, getModule: getMod, startInterval: startInterval,
    readModuleState: readModuleState, writeModuleState: writeModuleState
  };

  if (typeof window !== 'undefined') { window.Coordinator = Coordinator; }
  if (typeof self !== 'undefined') { self.Coordinator = Coordinator; }
})();

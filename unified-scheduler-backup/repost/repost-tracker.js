// =============================================================================
// 转帖 Tracker：来源号、已发/跳过 ID、日限额、定时自动状态、配置
// 自动门禁：固定开跑时刻 + 每日条数；仍由调度仅在 S0 拉起
// =============================================================================
(function () {
  'use strict';
  if (window.RepostTracker) return;

  var TARGETS_KEY = 'sg_repost_targets';
  var POSTED_KEY = 'sg_repost_posted_ids';
  var SKIP_KEY = 'sg_repost_skip_ids';
  var CONFIG_KEY = 'sg_repost_config';
  var DAILY_KEY = 'sg_repost_daily';
  var CURRENT_KEY = 'sg_repost_current';
  var COMPLETED_KEY = 'sg_repost_completed_round';
  var AUTO_DATE_KEY = 'sg_repost_auto_date';
  var AUTO_STATUS_KEY = 'sg_repost_auto_status';
  var AUTO_STARTED_KEY = 'sg_repost_auto_started_at';

  var DEFAULT_CONFIG = {
    postType: 'text_or_image', // text | image | text_or_image
    banVideo: true,
    postsPerHandle: 1,
    cooldownMin: 30,
    cooldownMax: 90,
    dailyCap: 50,
    // dailyQuota 仅作 OPS/本地兜底展示；真正收工条数见 getDailyQuota（按日龄）
    dailyQuota: 2,
    maxMinutes: 60,
    // 开跑时刻（上海）；followWorkEnd=true 时跟 stage 的 workHours.end
    // 凌晨场默认 06:00 且不跟随下班（须 S0=上班前）
    followWorkEnd: false,
    startHour: 6,
    startMin: 0,
    // 旧双窗字段仅兼容旧 LS，门禁不再使用
    eveEndHour: 23,
    eveEndMin: 0,
    mornStartHour: 3,
    mornStartMin: 0,
    mornEndHour: 5,
    mornEndMin: 0,
    appendLink: ''
  };

  function shanghaiDate() {
    try {
      return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    } catch (e) {
      try {
        if (typeof TimeUtil !== 'undefined' && TimeUtil.shanghaiDate) return TimeUtil.shanghaiDate();
      } catch (e2) {}
      return new Date().toLocaleDateString('zh-CN');
    }
  }

  function loadJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (e) { return fallback; }
  }

  function saveJson(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  function normHandle(h) {
    return String(h || '').replace(/^@/, '').toLowerCase().trim();
  }

  function getConfig() {
    var cfg = Object.assign({}, DEFAULT_CONFIG, loadJson(CONFIG_KEY, {}) || {});
    cfg.cooldownMin = Math.max(30, parseInt(cfg.cooldownMin, 10) || 30);
    cfg.cooldownMax = Math.max(cfg.cooldownMin, parseInt(cfg.cooldownMax, 10) || 90);
    try {
      if (!cfg.appendLink) {
        chrome.storage.local.get(['dynamic_append_link'], function (r) {
          if (r && r.dynamic_append_link) {
            cfg.appendLink = r.dynamic_append_link;
            saveJson(CONFIG_KEY, cfg);
          }
        });
      }
    } catch (e) {}
    return cfg;
  }

  var LAST_OK_KEY = 'sg_repost_last_ok_at';
  function getLastOkAt() {
    try { return parseInt(localStorage.getItem(LAST_OK_KEY) || '0', 10) || 0; } catch (e) { return 0; }
  }
  function markLastOkAt(ts) {
    try { localStorage.setItem(LAST_OK_KEY, String(ts || Date.now())); } catch (e) {}
  }
  function msUntilNextPostAllowed() {
    var cfg = getConfig();
    var minMs = Math.max(30, cfg.cooldownMin || 30) * 60000;
    var last = getLastOkAt();
    if (!last) return 0;
    return Math.max(0, last + minMs - Date.now());
  }

  function setConfig(partial) {
    var cfg = Object.assign(getConfig(), partial || {});
    saveJson(CONFIG_KEY, cfg);
    return cfg;
  }

  function getTargets() {
    var list = loadJson(TARGETS_KEY, []);
    if (!Array.isArray(list)) list = [];
    return list.map(normHandle).filter(Boolean);
  }

  function resolveBotId() {
    try {
      if (typeof window !== 'undefined' && window.__SG_WORKER_ID) return String(window.__SG_WORKER_ID);
    } catch (e0) {}
    var h = '';
    try {
      h = (localStorage.getItem('my_handle') || localStorage.getItem('matrix_my_handle') || '').replace(/^@/, '').trim();
    } catch (e1) {}
    if (h && h !== 'unknown') return '@' + h + '#guard';
    try {
      var w = localStorage.getItem('matrix_worker_id') || localStorage.getItem('sg_worker_id') || '';
      if (w) return w;
    } catch (e2) {}
    return '';
  }

  function pushTargetsToOps(out) {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
      var botId = resolveBotId();
      if (!botId) return;
      chrome.runtime.sendMessage({
        action: 'ops_repost_targets_push',
        bot_id: botId,
        targets: out || []
      }, function () { void chrome.runtime.lastError; });
    } catch (ePush) {}
  }

  function setTargets(list, opts) {
    var out = [];
    (list || []).forEach(function (h) {
      h = normHandle(h);
      if (h && out.indexOf(h) < 0) out.push(h);
    });
    saveJson(TARGETS_KEY, out);
    try { chrome.storage.local.set({ matrix_repost_targets: out }); } catch (e) {}
    // 默认不回写 OPS（后台为准）；仅显式 forcePush 时上传
    if (opts && opts.forcePush) pushTargetsToOps(out);
    return out;
  }

  function hasLocalTargets() {
    return getTargets().length > 0;
  }

  function getPostedIds() { return loadJson(POSTED_KEY, []); }
  function isPosted(id) { return !!id && getPostedIds().indexOf(String(id)) >= 0; }
  function markPosted(id) {
    if (!id) return;
    var ids = getPostedIds();
    id = String(id);
    if (ids.indexOf(id) < 0) {
      ids.push(id);
      if (ids.length > 800) ids = ids.slice(-600);
      saveJson(POSTED_KEY, ids);
    }
  }

  function getSkipIds() { return loadJson(SKIP_KEY, []); }
  function isSkipped(id) { return !!id && getSkipIds().indexOf(String(id)) >= 0; }
  function markSkipped(id, reason) {
    if (!id) return;
    var ids = getSkipIds();
    id = String(id);
    if (ids.indexOf(id) < 0) {
      ids.push(id);
      if (ids.length > 400) ids = ids.slice(-300);
      saveJson(SKIP_KEY, ids);
    }
    try { console.log('[转帖] skip', id, reason || ''); } catch (e) {}
  }

  function getDaily() {
    var d = loadJson(DAILY_KEY, { date: '', count: 0 }) || { date: '', count: 0 };
    var today = shanghaiDate();
    if (d.date !== today) return { date: today, count: 0 };
    return d;
  }

  function bumpDaily() {
    var d = getDaily();
    d.count = (d.count || 0) + 1;
    saveJson(DAILY_KEY, d);
    return d;
  }

  function myHandle() {
    try {
      if (typeof EngineUtils !== 'undefined' && EngineUtils.getHandle) {
        var h = EngineUtils.getHandle();
        if (h) return String(h).replace(/^@/, '').toLowerCase();
      }
    } catch (e0) {}
    try {
      var m = (location.pathname || '').match(/^\/([A-Za-z0-9_]+)/);
      if (m && m[1] && !/^(home|explore|search|i|settings|messages|notifications)$/i.test(m[1])) {
        return m[1].toLowerCase();
      }
    } catch (e1) {}
    try {
      var keys = Object.keys(localStorage || {});
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf('matrix_stats_') === 0) {
          return keys[i].slice('matrix_stats_'.length);
        }
      }
    } catch (e2) {}
    return '';
  }

  /** 本号运营日龄（matrix_stats.day_count，至少 1） */
  function getAccountDayCount() {
    try {
      var h = myHandle();
      if (!h) return 1;
      var st = JSON.parse(localStorage.getItem('matrix_stats_' + h) || '{}');
      var d = parseInt(st.day_count, 10);
      return d > 0 ? d : 1;
    } catch (e) { return 1; }
  }

  /**
   * 业务日限额（优先于 OPS dailyQuota）：
   * Day 1–4 → 2 条/天；Day ≥5 → 1 条/天。去重靠 posted/skip ids。
   */
  function getDailyQuota() {
    return getAccountDayCount() >= 5 ? 1 : 2;
  }

  /** 当日有效上限：日龄配额与 dailyCap（>0）取更严 */
  function getEffectiveDailyLimit() {
    var quota = getDailyQuota();
    var cap = Number(getConfig().dailyCap) || 0;
    if (cap > 0) return Math.min(quota, cap);
    return quota;
  }

  function remainingDaily() {
    return Math.max(0, getEffectiveDailyLimit() - (getDaily().count || 0));
  }

  function dailyExhausted() {
    return remainingDaily() <= 0;
  }

  function getCurrent() { return normHandle(localStorage.getItem(CURRENT_KEY) || ''); }
  function setCurrent(h) {
    h = normHandle(h);
    if (h) localStorage.setItem(CURRENT_KEY, h);
    else localStorage.removeItem(CURRENT_KEY);
  }

  function getCompletedRound() { return loadJson(COMPLETED_KEY, []); }
  function markCompletedRound(h) {
    h = normHandle(h);
    var list = getCompletedRound();
    if (h && list.indexOf(h) < 0) {
      list.push(h);
      saveJson(COMPLETED_KEY, list);
    }
  }
  function clearCompletedRound() { saveJson(COMPLETED_KEY, []); }

  /** 定时自动：按上海日重置 */
  function ensureAutoDay() {
    var today = shanghaiDate();
    var d = localStorage.getItem(AUTO_DATE_KEY) || '';
    if (d !== today) {
      localStorage.setItem(AUTO_DATE_KEY, today);
      localStorage.setItem(AUTO_STATUS_KEY, 'idle');
      localStorage.removeItem(AUTO_STARTED_KEY);
      try { sessionStorage.removeItem('sg_repost_round_boot'); } catch (e) {}
      try { sessionStorage.removeItem('sg_repost_auto_slot'); } catch (e2) {}
    }
    return today;
  }

  function getAutoStatus() {
    ensureAutoDay();
    return localStorage.getItem(AUTO_STATUS_KEY) || 'idle';
  }

  function isAutoFinishedToday() {
    var st = getAutoStatus();
    return st === 'done' || st === 'timeout';
  }

  function getAutoStartedAt() {
    ensureAutoDay();
    return parseInt(localStorage.getItem(AUTO_STARTED_KEY) || '0', 10) || 0;
  }

  function getMaxMinutes() {
    var m = Number(getConfig().maxMinutes);
    return m > 0 ? m : 60;
  }

  function cfgStartHm() {
    var cfg = getConfig();
    return {
      h: Math.min(23, Math.max(0, parseInt(cfg.startHour, 10) || 6)),
      m: Math.min(59, Math.max(0, parseInt(cfg.startMin, 10) || 0))
    };
  }

  /** 解析开跑 HH:MM；followWorkEnd 时用 workHours.end（test24h / end≥24 回退 startHour） */
  function getStartHm() {
    var cfg = getConfig();
    var follow = cfg.followWorkEnd;
    if (follow === false || follow === 0 || follow === '0' || follow === 'false') {
      return cfgStartHm();
    }
    try {
      var test24 = false;
      try {
        if (typeof TimeUtil !== 'undefined' && TimeUtil.isTest24h) test24 = !!TimeUtil.isTest24h();
      } catch (eT) {}
      if (test24) return cfgStartHm();
      var p = null;
      try {
        if (typeof StageDetector !== 'undefined' && StageDetector.getStagePolicy) {
          p = StageDetector.getStagePolicy() || null;
        }
      } catch (eSd) {}
      if (!p) {
        try { p = JSON.parse(localStorage.getItem('sg_stage_policy') || 'null'); } catch (eLs) { p = null; }
      }
      if (p && p.workHours && p.workHours.end) {
        var eh = parseInt(p.workHours.end[0], 10);
        var em = parseInt(p.workHours.end[1], 10) || 0;
        // 24:00 / 非法小时：跟班下班点无意义，回退固定开跑（默认 21:00）
        if (!isFinite(eh) || eh < 0 || eh >= 24) return cfgStartHm();
        return { h: eh, m: Math.min(59, Math.max(0, em)) };
      }
    } catch (e) {}
    return cfgStartHm();
  }

  function shanghaiHm() {
    try {
      if (typeof TimeUtil !== 'undefined' && TimeUtil.shanghaiParts) {
        var sp = TimeUtil.shanghaiParts();
        if (sp) return { h: sp.h, m: sp.m };
      }
    } catch (e) {}
    try {
      var parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
      }).formatToParts(new Date());
      var hh = 0, mm = 0;
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === 'hour') hh = parseInt(parts[i].value, 10);
        if (parts[i].type === 'minute') mm = parseInt(parts[i].value, 10);
      }
      if (hh === 24) hh = 0;
      return { h: hh, m: mm };
    } catch (e2) {}
    try {
      var u = new Date(Date.now() + 8 * 3600 * 1000);
      return { h: u.getUTCHours(), m: u.getUTCMinutes() };
    } catch (e3) {
      return { h: 12, m: 0 };
    }
  }

  function hmToMin(h, m) {
    return (Number(h) || 0) * 60 + (Number(m) || 0);
  }

  /** @deprecated 兼容旧调用；双窗已废弃 */
  function getEveEndHm() {
    var cfg = getConfig();
    return {
      h: Math.min(23, Math.max(0, parseInt(cfg.eveEndHour, 10) || 23)),
      m: Math.min(59, Math.max(0, parseInt(cfg.eveEndMin, 10) || 0))
    };
  }

  /** @deprecated 兼容旧调用；双窗已废弃 */
  function getMornWindow() {
    var cfg = getConfig();
    return {
      start: {
        h: Math.min(23, Math.max(0, parseInt(cfg.mornStartHour, 10) || 3)),
        m: Math.min(59, Math.max(0, parseInt(cfg.mornStartMin, 10) || 0))
      },
      end: {
        h: Math.min(23, Math.max(0, parseInt(cfg.mornEndHour, 10) || 5)),
        m: Math.min(59, Math.max(0, parseInt(cfg.mornEndMin, 10) || 0))
      }
    };
  }

  function workStartHm() {
    var h = 7;
    var m = 0;
    try {
      var p = null;
      if (typeof StageDetector !== 'undefined' && StageDetector.getStagePolicy) {
        p = StageDetector.getStagePolicy();
      } else {
        p = JSON.parse(localStorage.getItem('sg_stage_policy') || 'null');
      }
      if (p && p.workHours && p.workHours.start) {
        h = parseInt(p.workHours.start[0], 10);
        m = parseInt(p.workHours.start[1], 10) || 0;
        if (!isFinite(h) || h < 0 || h > 23) h = 7;
      }
    } catch (e) {}
    return { h: h, m: Math.min(59, Math.max(0, m)) };
  }

  function morningJitterCap() {
    var maxJ = 15;
    try {
      var start = getStartHm();
      var ws = workStartHm();
      var startM0 = hmToMin(start.h, start.m);
      var workStartM0 = hmToMin(ws.h, ws.m);
      if (startM0 < workStartM0) {
        var gap = workStartM0 - startM0;
        maxJ = Math.max(0, Math.min(15, gap - 15));
      }
    } catch (eG) {}
    return maxJ;
  }

  function startJitterMin() {
    var maxJ = morningJitterCap();
    try {
      var cached = localStorage.getItem('sg_repost_start_jitter_min');
      if (cached != null && cached !== '') {
        var n = parseInt(cached, 10);
        if (isFinite(n) && n >= 0 && n <= 15) {
          if (n > maxJ) {
            n = maxJ;
            try { localStorage.setItem('sg_repost_start_jitter_min', String(n)); } catch (eC2) {}
          }
          return n;
        }
      }
    } catch (eC) {}
    var seed = '';
    try {
      seed = localStorage.getItem('matrix_bit_id')
        || localStorage.getItem('matrix_my_handle')
        || localStorage.getItem('sg_installation_id')
        || '';
    } catch (eS) {}
    if (!seed) seed = 'x';
    var h = 2166136261;
    for (var i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    var j = maxJ <= 0 ? 0 : ((h >>> 0) % (maxJ + 1));
    try { localStorage.setItem('sg_repost_start_jitter_min', String(j)); } catch (eW) {}
    return j;
  }

  function isPastStartClock() {
    var now = shanghaiHm();
    var start = getStartHm();
    var nowM = hmToMin(now.h, now.m);
    var startM = hmToMin(start.h, start.m);
    var ws = workStartHm();
    var workStartM = hmToMin(ws.h, ws.m);
    var jitter = startJitterMin();
    var effectiveStartM = startM + jitter;

    // 凌晨开跑（开跑点 < 上班点，如 05:00/06:00）：仅 [开跑+jitter, 上班) 算已到点
    // 避免 start=6 时 23:00>=6 为真、又在 S0 里被误拉起
    if (startM < workStartM) {
      if (effectiveStartM >= workStartM) effectiveStartM = Math.max(startM, workStartM - 1);
      return nowM >= effectiveStartM && nowM < workStartM;
    }

    if (nowM >= effectiveStartM) return true;
    // 晚间开跑跨午夜：已过 0 点且未到上班点 → 仍算已到开跑之后
    if (effectiveStartM >= 12 * 60 && nowM < workStartM) return true;
    return false;
  }

  /**
   * 可开跑窗：已到固定开跑时刻，且本日自动未收工，且不在私信时段。
   * 4.3.23：转帖可与私信零撞车——私信时段内窗=关；其它时间只要过开跑钟即可。
   * 收工靠 dailyQuota / maxMinutes / 扫完。
   */
  function isChatTimeNowRt() {
    try {
      if (typeof StageDetector !== 'undefined' && StageDetector.isChatTime) {
        try { if (StageDetector.detect) StageDetector.detect(); } catch (eD) {}
        return !!StageDetector.isChatTime();
      }
    } catch (e) {}
    try {
      if (typeof TimeUtil !== 'undefined' && TimeUtil.readChatHours && TimeUtil.inRange) {
        var th = TimeUtil.readChatHours();
        return !!TimeUtil.inRange(th.startH, th.startM || 0, th.endH, th.endM || 0);
      }
    } catch (e2) {}
    return false;
  }

  function getActiveWindow() {
    // 硬闸：私信时段绝不转帖
    if (isChatTimeNowRt()) return null;
    var st = getAutoStatus();
    if (st === 'done' || st === 'timeout') return null;
    if (st === 'running' && getAutoStartedAt() && !isAutoTimedOut()) {
      return { name: 'scheduled', endH: 23, endM: 59 };
    }
    if (!isPastStartClock()) return null;
    return { name: 'scheduled', endH: 23, endM: 59 };
  }

  function isInRepostWindowNow() {
    return !!getActiveWindow();
  }

  /** 兼容旧调用：视为「是否在可开跑窗内」 */
  function isPastStartTime() {
    return isInRepostWindowNow();
  }

  function msUntilWindowEnd() {
    if (!isInRepostWindowNow()) return 0;
    var started = getAutoStartedAt();
    if (started) {
      var left = started + getMaxMinutes() * 60 * 1000 - Date.now();
      return left > 0 ? left : 0;
    }
    var now = shanghaiHm();
    var leftMin = hmToMin(23, 59) - hmToMin(now.h, now.m);
    return leftMin > 0 ? leftMin * 60 * 1000 : 0;
  }

  function isPastWindowEnd() {
    return !isInRepostWindowNow() && getAutoStatus() === 'running';
  }

  function isAutoTimedOut() {
    var started = getAutoStartedAt();
    if (!started) return false;
    if (getAutoStatus() !== 'running') return false;
    if (Date.now() - started >= getMaxMinutes() * 60 * 1000) return true;
    return false;
  }

  function markAutoRunning() {
    ensureAutoDay();
    localStorage.setItem(AUTO_STATUS_KEY, 'running');
    if (!getAutoStartedAt()) {
      localStorage.setItem(AUTO_STARTED_KEY, String(Date.now()));
    }
    try { sessionStorage.setItem('sg_repost_auto_slot', '1'); } catch (e) {}
  }

  function markAutoDone() {
    ensureAutoDay();
    localStorage.setItem(AUTO_STATUS_KEY, 'done');
    try { sessionStorage.removeItem('sg_repost_auto_slot'); } catch (e) {}
    try { sessionStorage.removeItem('sg_repost_round_boot'); } catch (e2) {}
  }

  function markAutoTimeout() {
    ensureAutoDay();
    localStorage.setItem(AUTO_STATUS_KEY, 'timeout');
    try { sessionStorage.removeItem('sg_repost_auto_slot'); } catch (e) {}
    try { sessionStorage.removeItem('sg_repost_round_boot'); } catch (e2) {}
  }

  /** 0 条假收工：清回 idle，允许 S0 重试 */
  function resetAutoIdle(why) {
    ensureAutoDay();
    localStorage.setItem(AUTO_STATUS_KEY, 'idle');
    localStorage.removeItem(AUTO_STARTED_KEY);
    try { sessionStorage.removeItem('sg_repost_auto_slot'); } catch (e) {}
    try { sessionStorage.removeItem('sg_repost_round_boot'); } catch (e2) {}
    try {
      if (typeof Logger !== 'undefined' && Logger.info) {
        Logger.info('转帖', 'resetAutoIdle why=' + (why || ''));
      }
    } catch (eL) {}
  }

  function isAutoSlot() {
    try { return sessionStorage.getItem('sg_repost_auto_slot') === '1'; } catch (e) { return false; }
  }

  function clearAutoSlotFlag() {
    try { sessionStorage.removeItem('sg_repost_auto_slot'); } catch (e) {}
  }

  window.RepostTracker = {
    getConfig: getConfig,
    setConfig: setConfig,
    getTargets: getTargets,
    setTargets: setTargets,
    hasLocalTargets: hasLocalTargets,
    isPosted: isPosted,
    markPosted: markPosted,
    getLastOkAt: getLastOkAt,
    markLastOkAt: markLastOkAt,
    msUntilNextPostAllowed: msUntilNextPostAllowed,
    isSkipped: isSkipped,
    markSkipped: markSkipped,
    getDaily: getDaily,
    bumpDaily: bumpDaily,
    getAccountDayCount: getAccountDayCount,
    getDailyQuota: getDailyQuota,
    getEffectiveDailyLimit: getEffectiveDailyLimit,
    remainingDaily: remainingDaily,
    dailyExhausted: dailyExhausted,
    getCurrent: getCurrent,
    setCurrent: setCurrent,
    getCompletedRound: getCompletedRound,
    markCompletedRound: markCompletedRound,
    clearCompletedRound: clearCompletedRound,
    shanghaiDate: shanghaiDate,
    ensureAutoDay: ensureAutoDay,
    getAutoStatus: getAutoStatus,
    isAutoFinishedToday: isAutoFinishedToday,
    getAutoStartedAt: getAutoStartedAt,
    getMaxMinutes: getMaxMinutes,
    getStartHm: getStartHm,
    getStartJitterMin: startJitterMin,
    isPastStartClock: isPastStartClock,
    getEveEndHm: getEveEndHm,
    getMornWindow: getMornWindow,
    getActiveWindow: getActiveWindow,
    isInRepostWindowNow: isInRepostWindowNow,
    isPastStartTime: isPastStartTime,
    msUntilWindowEnd: msUntilWindowEnd,
    isPastWindowEnd: isPastWindowEnd,
    isAutoTimedOut: isAutoTimedOut,
    markAutoRunning: markAutoRunning,
    markAutoDone: markAutoDone,
    markAutoTimeout: markAutoTimeout,
    resetAutoIdle: resetAutoIdle,
    isAutoSlot: isAutoSlot,
    clearAutoSlotFlag: clearAutoSlotFlag,
    DEFAULT_CONFIG: DEFAULT_CONFIG
  };
})();

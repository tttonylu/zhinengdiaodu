(function () {
  'use strict';

  var K = SKeys;

  var DEFAULT_POLICY = {
    workHours: { start: [8, 0], end: [23, 0] },
    chatHours:  { start: [8, 0], end: [18, 0] },
    stages: {
      S0: { priority: [] },
      S1: { dayMax: 2, quotaFull: true, priority: ['nurture'] },
      S2: { dayMin: 3, dayMax: 6, priority: ['follow', 'nurture'] },
      S3: { dayMin: 7, priority: ['chat', 'follow', 'nurture'] },
      S4: { maxOccupyMin: 30, priority: ['chat'] }
    },
    cooldown: { stallCooldownSec: 180, tickIntervalMs: 10000, watchdogMs: 30000 }
  };

  function inRange(hS, mS, hE, mE) {
    var s = new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour12: false });
    var m = s.match(/(\d+):(\d+)/);
    if (!m) return false;
    var t = parseInt(m[1]) * 60 + parseInt(m[2]);
    return t >= (hS * 60 + mS) && t < (hE * 60 + mE);
  }

  function getDayCount() {
    try {
      var h = localStorage.getItem(K.LK_MY_HANDLE) || 'unknown';
      h = h.replace('@', '').replace('#guard', '').toLowerCase();
      return (JSON.parse(localStorage.getItem('matrix_stats_' + h) || '{}')).day_count || 1;
    } catch (e) { return 1; }
  }

  function getFollowedToday() {
    try {
      var h = localStorage.getItem(K.LK_MY_HANDLE) || 'unknown';
      h = h.replace('@', '').replace('#guard', '').toLowerCase();
      return (JSON.parse(localStorage.getItem('matrix_stats_' + h) || '{}')).follows_today || 0;
    } catch (e) { return 0; }
  }

  function getLimit() {
    try {
      if (localStorage.getItem(K.LK_ANTIBAN_ENABLED) === 'true') {
        var d = Math.max(0, getDayCount() - 1);
        return d === 0 ? rnd(10, 20) : Math.min(50 * d, 200);
      }
      return (JSON.parse(localStorage.getItem(K.LK_CONSOLE_SETTINGS) || '{}')).followLimit || 200;
    } catch (e) { return 200; }
  }

  function rnd(m, x) { return Math.floor(Math.random() * (x - m + 1)) + m; }

  function loadPolicy() {
    try {
      var raw = localStorage.getItem('sg_stage_policy');
      if (raw) {
        var p = JSON.parse(raw);
        return deepMerge(DEFAULT_POLICY, p);
      }
    } catch (e) {}
    return deepMerge({}, DEFAULT_POLICY);
  }

  function deepMerge(target, source) {
    var out = {};
    for (var k in target) { out[k] = target[k]; }
    for (var k in source) {
      if (source[k] && typeof source[k] === 'object' && !Array.isArray(source[k]) && target[k] && typeof target[k] === 'object') {
        out[k] = deepMerge(target[k], source[k]);
      } else {
        out[k] = source[k];
      }
    }
    return out;
  }

  var g_isWorkTime = false;
  var g_isChatTime = false;

  function detect() {
    var policy = loadPolicy();
    g_isWorkTime = inRange(policy.workHours.start[0], policy.workHours.start[1], policy.workHours.end[0], policy.workHours.end[1]);
    g_isChatTime = inRange(policy.chatHours.start[0], policy.chatHours.start[1], policy.chatHours.end[0], policy.chatHours.end[1]);
    var dayCount = getDayCount();
    var quotaFull = getFollowedToday() >= getLimit();
    var pausedTill = parseInt(sessionStorage.getItem(K.SK_PAUSED_TILL) || '0') || 0;
    var inRetreat = pausedTill > Date.now();

    if (!g_isWorkTime) return { stage: 'S0', priority: policy.stages.S0.priority };

    if (dayCount < 3 || quotaFull || inRetreat) {
      return { stage: 'S1', priority: policy.stages.S1.priority.concat() };
    }

    if (dayCount >= 3 && dayCount <= 6) {
      return { stage: 'S2', priority: policy.stages.S2.priority.concat() };
    }

    if (dayCount >= 7 && g_isChatTime && !quotaFull) {
      return { stage: 'S3', priority: policy.stages.S3.priority.concat() };
    }

    return { stage: 'S2', priority: policy.stages.S2.priority.concat() };
  }

  function getStagePolicy() { return loadPolicy(); }

  function isWorkTime() { return g_isWorkTime; }
  function isChatTime() { return g_isChatTime; }

  var StageDetector = { detect: detect, getStagePolicy: getStagePolicy, isWorkTime: isWorkTime, isChatTime: isChatTime };
  if (typeof window !== 'undefined') { window.StageDetector = StageDetector; }
  if (typeof self !== 'undefined') { self.StageDetector = StageDetector; }
})();

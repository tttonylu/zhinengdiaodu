// =============================================================================
// 智能调度 — 养号预算追踪器
// 三层预算: 每日 → 每小时 → 每15分钟分片
// =============================================================================

var NurtureTracker = (function () {
  'use strict';

  var dailyBudget = {};
  var dailyUsed = {};
  var dailyStart = 0;

  var hourlyBudget = {};
  var hourlyUsed = {};
  var hourlyStart = 0;

  var segmentStart = 0;
  var segmentUsed = {};

  function getCfg() {
    if (typeof NurtureConfig !== 'undefined') return NurtureConfig.getCfg();
    if (typeof MatrixConfig !== 'undefined' && MatrixConfig.nurture) return MatrixConfig.nurture;
    return {
      dailyBudget: { likes: { min: 12, max: 12 }, comments: { min: 2, max: 2 }, reposts: { min: 1, max: 2 }, trends: { min: 5, max: 10 }, profiles: { min: 2, max: 5 }, enters: { min: 5, max: 8 } },
      hourlyBudget: { likes: { min: 2, max: 2 }, comments: { min: 1, max: 1 }, reposts: { min: 0, max: 2 }, trends: { min: 1, max: 2 }, profiles: { min: 0, max: 1 }, enters: { min: 1, max: 2 } },
      likeCooldownMin: 8,
      commentCooldownMin: 45,
      segmentMinutes: 15,
    };
  }

  function randInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  function val(v, d) { return (v != null) ? v : d; }

  /** 上海自然日 YYYY-MM-DD，用于跨日零点重置 */
  function shanghaiDateKey() {
    try {
      return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    } catch (e) {
      var d = new Date(Date.now() + 8 * 3600 * 1000);
      return d.toISOString().slice(0, 10);
    }
  }

  function toShanghaiDateKey(ts) {
    if (!ts) return '';
    try {
      return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    } catch (e) {
      var d = new Date(ts + 8 * 3600 * 1000);
      return d.toISOString().slice(0, 10);
    }
  }

  /** 兼容后台单值(30) 与 {min,max} */
  function rangeOf(field, dMin, dMax) {
    if (field == null) return { min: dMin, max: dMax };
    if (typeof field === 'number') return { min: field, max: field };
    if (typeof field === 'object') {
      return { min: val(field.min, dMin), max: val(field.max, dMax) };
    }
    var n = parseInt(field, 10);
    if (!isNaN(n)) return { min: n, max: n };
    return { min: dMin, max: dMax };
  }

  // ==================== 每日预算 ====================
  function resetDaily() {
    var cfg = getCfg();
    var b = cfg.dailyBudget || {};
    var likes = rangeOf(b.likes, 12, 12);
    var comments = rangeOf(b.comments, 2, 2);
    var reposts = rangeOf(b.reposts, 1, 2);
    var trends = rangeOf(b.trends, 5, 10);
    var profiles = rangeOf(b.profiles, 2, 5);
    var enters = rangeOf(b.enters, 8, 12);
    dailyBudget = {
      likes:    randInt(likes.min, likes.max),
      comments: randInt(comments.min, comments.max),
      reposts:  randInt(reposts.min, reposts.max),
      trends:   randInt(trends.min, trends.max),
      profiles: randInt(profiles.min, profiles.max),
      enters:   randInt(enters.min, enters.max),
    };
    dailyUsed = { likes: 0, comments: 0, reposts: 0, trends: 0, profiles: 0, enters: 0 };
    dailyStart = Date.now();
  }

  function isDailyExhausted() {
    for (var k in dailyBudget) {
      if (dailyUsed[k] < dailyBudget[k]) return false;
    }
    return true;
  }

  // ==================== 每小时预算 ====================
  function resetHourly() {
    var cfg = getCfg();
    var b = cfg.hourlyBudget || {};
    var likes = rangeOf(b.likes, 2, 2);
    var comments = rangeOf(b.comments, 1, 1);
    var reposts = rangeOf(b.reposts, 0, 2);
    var trends = rangeOf(b.trends, 1, 2);
    var profiles = rangeOf(b.profiles, 0, 1);
    var enters = rangeOf(b.enters, 1, 2);
    hourlyBudget = {
      likes:    randInt(likes.min, likes.max),
      comments: randInt(comments.min, comments.max),
      reposts:  randInt(reposts.min, reposts.max),
      trends:   randInt(trends.min, trends.max),
      profiles: randInt(profiles.min, profiles.max),
      enters:   randInt(enters.min, enters.max),
    };
    hourlyUsed = { likes: 0, comments: 0, reposts: 0, trends: 0, profiles: 0, enters: 0 };
    hourlyStart = Date.now();
    // 分片也重置
    initSegment();
  }

  function isHourlyExhausted() {
    for (var k in hourlyBudget) {
      if (hourlyUsed[k] < hourlyBudget[k]) return false;
    }
    return true;
  }

  // ==================== 分片策略 ====================
  function initSegment() {
    segmentStart = Date.now();
    segmentUsed = { likes: 0, maxLikes: Math.max(1, Math.ceil((hourlyBudget.likes || 1) / 4)), lastLike: 0 };
  }

  function canLikeNow() {
    if ((segmentUsed.likes || 0) >= (segmentUsed.maxLikes || 1)) return false;
    var cd = (getCfg().likeCooldownMin || 8) * 60000;
    if (Date.now() - (segmentUsed.lastLike || 0) < cd) return false;
    return true;
  }

  function readLastCommentAt() {
    try {
      return parseInt(localStorage.getItem('sg_nurture_last_comment_at') || '0', 10) || 0;
    } catch (e) { return 0; }
  }

  function writeLastCommentAt(ts) {
    try { localStorage.setItem('sg_nurture_last_comment_at', String(ts || Date.now())); } catch (e) {}
  }

  /** 评论冷却：默认 45 分钟一条，避免短时连评触发平台自动化条 */
  function canCommentNow() {
    if (!canDo('comments')) return false;
    var cdMin = getCfg().commentCooldownMin;
    if (cdMin == null || cdMin === '') cdMin = 45;
    cdMin = parseInt(cdMin, 10);
    if (isNaN(cdMin) || cdMin < 0) cdMin = 45;
    if (cdMin === 0) return true;
    var last = readLastCommentAt();
    if (last > 0 && Date.now() - last < cdMin * 60000) return false;
    return true;
  }

  // ==================== 配额检查/消耗 ====================
  function canDo(action) {
    // 检查每日预算
    if ((dailyUsed[action] || 0) >= (dailyBudget[action] || 0)) return false;
    // 检查每小时预算
    if ((hourlyUsed[action] || 0) >= (hourlyBudget[action] || 0)) return false;
    return true;
  }

  function didOne(action) {
    dailyUsed[action] = (dailyUsed[action] || 0) + 1;
    hourlyUsed[action] = (hourlyUsed[action] || 0) + 1;
    if (action === 'likes') {
      segmentUsed.likes = (segmentUsed.likes || 0) + 1;
      segmentUsed.lastLike = Date.now();
    }
    if (action === 'comments') {
      writeLastCommentAt(Date.now());
    }
    try {
      var today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
      localStorage.setItem('sg_newacct_nurture_ok_' + today, '1');
    } catch (eOk) {}
    saveState();
  }

  // ==================== 持久化 ====================
  function saveState() {
    try {
      var state = {
        dailyBudget: dailyBudget, dailyUsed: dailyUsed, dailyStart: dailyStart,
        hourlyBudget: hourlyBudget, hourlyUsed: hourlyUsed, hourlyStart: hourlyStart,
        segmentStart: segmentStart, segmentUsed: segmentUsed,
        date: new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })
      };
      localStorage.setItem('sg_nurture_state', JSON.stringify(state));
    } catch (e) {}
  }

  function loadState() {
    try {
      var raw = localStorage.getItem('sg_nurture_state');
      if (!raw) return false;
      var state = JSON.parse(raw);
      var today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
      if (state.date !== today) { localStorage.removeItem('sg_nurture_state'); return false; }
      dailyBudget = state.dailyBudget || {}; dailyUsed = state.dailyUsed || {}; dailyStart = state.dailyStart;
      hourlyBudget = state.hourlyBudget || {}; hourlyUsed = state.hourlyUsed || {}; hourlyStart = state.hourlyStart;
      segmentStart = state.segmentStart; segmentUsed = state.segmentUsed;
      // 兼容旧状态：补齐 enters
      if (dailyBudget.enters == null) dailyBudget.enters = randInt(8, 12);
      if (dailyUsed.enters == null) dailyUsed.enters = 0;
      if (hourlyBudget.enters == null) hourlyBudget.enters = randInt(1, 2);
      if (hourlyUsed.enters == null) hourlyUsed.enters = 0;
      return true;
    } catch (e) { return false; }
  }

  // ==================== 时段管理 ====================
  function maybeReset() {
    var now = Date.now();
    // 跨天（上海自然日零点重置）
    var today = shanghaiDateKey();
    var lastDate = toShanghaiDateKey(dailyStart);
    if (today !== lastDate) resetDaily();
    // 跨小时
    if (now - hourlyStart > 3600000) resetHourly();
    // 跨分片
    var segMin = (getCfg().segmentMinutes || 15) * 60000;
    if (now - segmentStart > segMin || !segmentStart) initSegment();
  }

  // ==================== 统计 ====================
  function getStats() {
    return {
      daily:   { budget: dailyBudget,   used: dailyUsed,   exhausted: isDailyExhausted() },
      hourly:  { budget: hourlyBudget,  used: hourlyUsed,  exhausted: isHourlyExhausted() },
      segment: { maxLikes: segmentUsed.maxLikes, used: segmentUsed.likes || 0, canLike: canLikeNow() },
    };
  }

  /** 远程配置变更后：重算预算上限，保留已用量（不超过新上限） */
  function applyRemoteBudgets() {
    var cfg = getCfg();
    var b = cfg.dailyBudget || {};
    var likes = rangeOf(b.likes, 12, 12);
    var comments = rangeOf(b.comments, 2, 2);
    var reposts = rangeOf(b.reposts, 1, 2);
    var trends = rangeOf(b.trends, 5, 10);
    var profiles = rangeOf(b.profiles, 2, 5);
    var enters = rangeOf(b.enters, 8, 12);

    function pickCap(range, oldCap) {
      // 精确控（min===max）直接用；否则保留旧值若仍在区间内
      if (range.min === range.max) return range.min;
      if (oldCap != null && oldCap >= range.min && oldCap <= range.max) return oldCap;
      return randInt(range.min, range.max);
    }

    if (!dailyStart) {
      resetDaily();
    } else {
      dailyBudget = {
        likes:    pickCap(likes, dailyBudget.likes),
        comments: pickCap(comments, dailyBudget.comments),
        reposts:  pickCap(reposts, dailyBudget.reposts),
        trends:   pickCap(trends, dailyBudget.trends),
        profiles: pickCap(profiles, dailyBudget.profiles),
        enters:   pickCap(enters, dailyBudget.enters)
      };
      for (var dk in dailyBudget) {
        if ((dailyUsed[dk] || 0) > dailyBudget[dk]) dailyUsed[dk] = dailyBudget[dk];
      }
    }

    var hb = cfg.hourlyBudget || {};
    var hLikes = rangeOf(hb.likes, 2, 2);
    var hComments = rangeOf(hb.comments, 1, 1);
    var hReposts = rangeOf(hb.reposts, 0, 2);
    var hTrends = rangeOf(hb.trends, 1, 2);
    var hProfiles = rangeOf(hb.profiles, 0, 1);
    var hEnters = rangeOf(hb.enters, 1, 2);

    if (!hourlyStart) {
      resetHourly();
    } else {
      hourlyBudget = {
        likes:    pickCap(hLikes, hourlyBudget.likes),
        comments: pickCap(hComments, hourlyBudget.comments),
        reposts:  pickCap(hReposts, hourlyBudget.reposts),
        trends:   pickCap(hTrends, hourlyBudget.trends),
        profiles: pickCap(hProfiles, hourlyBudget.profiles),
        enters:   pickCap(hEnters, hourlyBudget.enters)
      };
      for (var hk in hourlyBudget) {
        if ((hourlyUsed[hk] || 0) > hourlyBudget[hk]) hourlyUsed[hk] = hourlyBudget[hk];
      }
      segmentUsed.maxLikes = Math.max(1, Math.ceil((hourlyBudget.likes || 1) / 4));
      if ((segmentUsed.likes || 0) > segmentUsed.maxLikes) segmentUsed.likes = segmentUsed.maxLikes;
    }
    saveState();
    console.log('[NurtureTracker] 已套用远程预算', { daily: dailyBudget, hourly: hourlyBudget });
  }

  // 初始化
  if (!loadState()) {
    resetDaily();
    resetHourly();
  }

  try {
    window.addEventListener('sg-config-synced', function () {
      try { applyRemoteBudgets(); } catch (e) {}
    });
  } catch (eSync) {}

  return {
    resetDaily: resetDaily,
    resetHourly: resetHourly,
    initSegment: initSegment,
    isDailyExhausted: isDailyExhausted,
    isHourlyExhausted: isHourlyExhausted,
    canLikeNow: canLikeNow,
    canCommentNow: canCommentNow,
    canDo: canDo,
    didOne: didOne,
    maybeReset: maybeReset,
    getStats: getStats,
    applyRemoteBudgets: applyRemoteBudgets
  };
})();

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
      dailyBudget: { likes: { min: 40, max: 80 }, comments: { min: 3, max: 8 }, reposts: { min: 1, max: 5 }, trends: { min: 5, max: 10 }, profiles: { min: 2, max: 5 } },
      hourlyBudget: { likes: { min: 5, max: 15 }, comments: { min: 0, max: 3 }, reposts: { min: 0, max: 2 }, trends: { min: 1, max: 2 }, profiles: { min: 0, max: 1 } },
      likeCooldownMin: 3,
      segmentMinutes: 15,
    };
  }

  function randInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  function val(v, d) { return (v != null) ? v : d; }

  // ==================== 每日预算 ====================
  function resetDaily() {
    var cfg = getCfg();
    var b = cfg.dailyBudget || {};
    dailyBudget = {
      likes:    randInt(val(b.likes.min,    40), val(b.likes.max,    80)),
      comments: randInt(val(b.comments.min,  3), val(b.comments.max,  8)),
      reposts:  randInt(val(b.reposts.min,   1), val(b.reposts.max,   5)),
      trends:   randInt(val(b.trends.min,    5), val(b.trends.max,   10)),
      profiles: randInt(val(b.profiles.min,  2), val(b.profiles.max,  5)),
    };
    dailyUsed = { likes: 0, comments: 0, reposts: 0, trends: 0, profiles: 0 };
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
    hourlyBudget = {
      likes:    randInt(val(b.likes.min,     5), val(b.likes.max,    15)),
      comments: randInt(val(b.comments.min,  0), val(b.comments.max,  3)),
      reposts:  randInt(val(b.reposts.min,   0), val(b.reposts.max,   2)),
      trends:   randInt(val(b.trends.min,    1), val(b.trends.max,    2)),
      profiles: randInt(val(b.profiles.min,  0), val(b.profiles.max,  1)),
    };
    hourlyUsed = { likes: 0, comments: 0, reposts: 0, trends: 0, profiles: 0 };
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
    var cd = (getCfg().likeCooldownMin || 3) * 60000;
    if (Date.now() - (segmentUsed.lastLike || 0) < cd) return false;
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
  }

  // ==================== 时段管理 ====================
  function maybeReset() {
    var now = Date.now();
    // 跨天
    if (now - dailyStart > 86400000) resetDaily();
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

  // 初始化
  resetDaily();
  resetHourly();

  return {
    resetDaily: resetDaily,
    resetHourly: resetHourly,
    initSegment: initSegment,
    isDailyExhausted: isDailyExhausted,
    isHourlyExhausted: isHourlyExhausted,
    canLikeNow: canLikeNow,
    canDo: canDo,
    didOne: didOne,
    maybeReset: maybeReset,
    getStats: getStats,
  };
})();

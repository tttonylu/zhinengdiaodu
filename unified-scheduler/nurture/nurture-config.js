// =============================================================================
// 智能调度 — 养号独立配置模块
// 存储 key: sg_nurture_settings（chrome.storage.local）
// 支持从 MatrixConfig.nurture 继承默认值，用户设置覆盖
// =============================================================================

var NurtureConfig = (function () {
  'use strict';

  var DEFAULTS = {
    dailyBudget: {
      likes:     { min: 40, max: 80 },
      comments:  { min:  3, max:  8 },
      reposts:   { min:  1, max:  5 },
      trends:    { min:  5, max: 10 },
      profiles:  { min:  2, max:  5 },
    },
    hourlyBudget: {
      likes:     { min:  5, max: 15 },
      comments:  { min:  0, max:  3 },
      reposts:   { min:  0, max:  2 },
      trends:    { min:  1, max:  2 },
      profiles:  { min:  0, max:  1 },
    },
    actionGapSec:   { min: 10, max: 20 },
    actionWeights:  { like: 0.60, comment: 0.04, repost: 0.03, trend: 0.04, profile: 0.02 },
    activeHours:    { start: { hour: 8, minute: 0 }, end: { hour: 23, minute: 0 } },
    likeCooldownMin: 3,
    segmentMinutes: 15,
  };

  var _cfg = JSON.parse(JSON.stringify(DEFAULTS));

  function deepClone(obj) {
    try { return JSON.parse(JSON.stringify(obj)); } catch (e) { return obj; }
  }

  function deepMerge(target, source) {
    var result = deepClone(target);
    for (var key in source) {
      if (source.hasOwnProperty(key)) {
        if (result[key] && typeof result[key] === 'object' && !Array.isArray(result[key]) &&
            typeof source[key] === 'object' && !Array.isArray(source[key])) {
          result[key] = deepMerge(result[key], source[key]);
        } else {
          result[key] = source[key];
        }
      }
    }
    return result;
  }

  function loadUserSettings() {
    // 1) 先同步合并 MatrixConfig.nurture（如果有）
    var cfg = deepClone(DEFAULTS);
    try {
      if (typeof MatrixConfig !== 'undefined' && MatrixConfig.nurture) {
        cfg = deepMerge(cfg, MatrixConfig.nurture);
      }
    } catch (e) {}
    _cfg = cfg;

    // 2) 再异步叠加用户单独保存的养号设置（优先级最高）
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get('sg_nurture_settings', function (r) {
          if (r && r.sg_nurture_settings) {
            _cfg = deepMerge(_cfg, r.sg_nurture_settings);
          }
        });
      }
    } catch (e) {}
  }

  function getCfg() {
    return deepClone(_cfg);
  }

  loadUserSettings();

  return {
    DEFAULTS: DEFAULTS,
    getCfg: getCfg,
    loadUserSettings: loadUserSettings,
  };
})();

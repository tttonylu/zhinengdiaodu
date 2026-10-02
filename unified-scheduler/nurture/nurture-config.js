// =============================================================================
// 智能调度 — 养号独立配置模块
// 优先级：远程后台(sg_nurture_remote_cfg) > 本机 sg_nurture_settings > 默认
// =============================================================================

var NurtureConfig = (function () {
  'use strict';

  var DEFAULTS = {
    dailyBudget: {
      likes:     { min: 12, max: 12 },
      comments:  { min:  2, max:  2 },
      reposts:   { min:  1, max:  2 },
      trends:    { min:  5, max: 10 },
      profiles:  { min:  2, max:  5 },
      enters:    { min:  5, max:  8 },
    },
    hourlyBudget: {
      likes:     { min:  2, max:  2 },
      comments:  { min:  1, max:  1 },
      reposts:   { min:  0, max:  2 },
      trends:    { min:  1, max:  2 },
      profiles:  { min:  0, max:  1 },
      enters:    { min:  1, max:  2 },
    },
    actionGapSec:   { min: 45, max: 90 },
    actionWeights:  { like: 0.55, comment: 0.015, repost: 0, trend: 0.04, profile: 0.02, enter: 0.10 },
    activeHours:    { start: { hour: 7, minute: 0 }, end: { hour: 21, minute: 0 } },
    likeCooldownMin: 8,
    commentCooldownMin: 45,
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

  function loadRemoteNurture() {
    try {
      if (typeof RemoteSettings !== 'undefined' && RemoteSettings.nurtureRemoteCfg) {
        var r = RemoteSettings.nurtureRemoteCfg();
        if (r) return r;
      }
    } catch (e) {}
    try {
      var raw = localStorage.getItem('sg_nurture_remote_cfg');
      if (raw) return JSON.parse(raw);
    } catch (e2) {}
    return null;
  }

  function loadUserSettings() {
    var cfg = deepClone(DEFAULTS);

    // 1) 本机养号微调（可被远程覆盖）
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        // 同步路径先读 localStorage 镜像；异步再叠 chrome.storage
      }
    } catch (e) {}

    // 2) 远程后台（矩阵主控，优先）
    var remote = loadRemoteNurture();
    if (remote) {
      cfg = deepMerge(cfg, remote);
    } else {
      try {
        if (typeof MatrixConfig !== 'undefined' && MatrixConfig.getConfigValue) {
          var mn = MatrixConfig.getConfigValue('nurture');
          if (mn) cfg = deepMerge(cfg, mn);
        } else if (typeof MatrixConfig !== 'undefined' && MatrixConfig.nurture) {
          cfg = deepMerge(cfg, MatrixConfig.nurture);
        }
      } catch (e3) {}
    }

    _cfg = cfg;

    // 3) 异步叠本机 chrome.storage（仅补远程没有的字段；远程已存在时不覆盖数值）
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['sg_nurture_settings', 'sg_nurture_remote_cfg'], function (r) {
          var next = deepClone(_cfg);
          if (r && r.sg_nurture_remote_cfg) {
            next = deepMerge(DEFAULTS, r.sg_nurture_remote_cfg);
          } else if (r && r.sg_nurture_settings) {
            next = deepMerge(next, r.sg_nurture_settings);
          }
          _cfg = next;
        });
      }
    } catch (e4) {}
  }

  function getCfg() {
    return deepClone(_cfg);
  }

  loadUserSettings();

  try {
    window.addEventListener('sg-config-synced', function () {
      loadUserSettings();
    });
  } catch (e5) {}

  return {
    DEFAULTS: DEFAULTS,
    getCfg: getCfg,
    loadUserSettings: loadUserSettings,
  };
})();

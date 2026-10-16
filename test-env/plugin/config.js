// =============================================================================
// 智能调度中心 v3 — 统一配置文件
// 所有参数都在这里改，不用翻代码
// 支持从设置页 (options.html) 保存的用户参数覆盖默认值
// =============================================================================

(function () {
  'use strict';

  // ==================== 默认配置 ====================
  const DEFAULTS = {
    server: {
      pool: 'http://192.168.0.100:15678',
      ops:  'http://192.168.0.100:15680',
      timeoutMs: 5000,
    },
    time: {
      timezone: 'Asia/Shanghai',
      autoStart:  { hour: 8,  minute: 0 },
      chatStop:   { hour: 18, minute: 0 },
      allStop:    { hour: 23, minute: 0 },
    },
    follow: {
      dailyCap: 200,
      batchSize: 15,
      intervalSec: { min: 12, max: 19 },
      rampUp: [15, 30, 60, 120, 200],
      restBetweenMin: { min: 30, max: 50 },
    },
    nurture: {
      hourlyBudget: {
        likes:     { min: 5,  max: 15 },
        comments:  { min: 0,  max: 3 },
        reposts:   { min: 0,  max: 2 },
        trends:    { min: 1,  max: 2 },
        profiles:  { min: 0,  max: 1 },
      },
      actionGapSec: { min: 10, max: 20 },
    },
    chat: {
      batchPerRound: { min: 1, max: 3 },
      iceToAdMin:  { min: 15, max: 25 },
      adToKickMin: { min: 25, max: 45 },
      maxRoundsPerUser: 3,
      scanIntervalMin: 3,
    },
    linkGuard: {
      retryIntervalMin: 5,
      giveUpTime: { hour: 14, minute: 0 },
    },
    scheduler: {
      tickIntervalMin: 3,
    },
    version: 'V3.0.0',
  };

  var CFG = deepClone(DEFAULTS);
  var _loaded = false;

  function deepClone(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
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

  // ==================== 从 chrome.storage 加载用户设置 ====================
  function loadUserSettings() {
    if (_loaded) return;
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get('sg_settings', function (r) {
          if (r && r.sg_settings) {
            CFG = deepMerge(CFG, userToConfig(r.sg_settings));
            console.log('[配置] 已加载用户设置');
          }
        });
      }
    } catch (e) {}
    _loaded = true;
  }

  function userToConfig(us) {
    var c = {};
    if (us.poolServer) { c.server = c.server || {}; c.server.pool = us.poolServer; }
    if (us.opsServer)  { c.server = c.server || {}; c.server.ops = us.opsServer; }
    if (us.followCap !== undefined) { c.follow = c.follow || {}; c.follow.dailyCap = us.followCap; }
    if (us.followBatch !== undefined) { c.follow = c.follow || {}; c.follow.batchSize = us.followBatch; }
    if (us.followMin !== undefined || us.followMax !== undefined) {
      c.follow = c.follow || {}; c.follow.intervalSec = c.follow.intervalSec || {};
      if (us.followMin !== undefined) c.follow.intervalSec.min = us.followMin;
      if (us.followMax !== undefined) c.follow.intervalSec.max = us.followMax;
    }
    if (us.restMin !== undefined || us.restMax !== undefined) {
      c.follow = c.follow || {}; c.follow.restBetweenMin = c.follow.restBetweenMin || {};
      if (us.restMin !== undefined) c.follow.restBetweenMin.min = us.restMin;
      if (us.restMax !== undefined) c.follow.restBetweenMin.max = us.restMax;
    }
    if (us.nLikeMin !== undefined || us.nLikeMax !== undefined) {
      c.nurture = c.nurture || {}; c.nurture.hourlyBudget = c.nurture.hourlyBudget || {};
      c.nurture.hourlyBudget.likes = c.nurture.hourlyBudget.likes || {};
      if (us.nLikeMin !== undefined) c.nurture.hourlyBudget.likes.min = us.nLikeMin;
      if (us.nLikeMax !== undefined) c.nurture.hourlyBudget.likes.max = us.nLikeMax;
    }
    if (us.nCommentMin !== undefined || us.nCommentMax !== undefined) {
      c.nurture = c.nurture || {}; c.nurture.hourlyBudget = c.nurture.hourlyBudget || {};
      c.nurture.hourlyBudget.comments = c.nurture.hourlyBudget.comments || {};
      if (us.nCommentMin !== undefined) c.nurture.hourlyBudget.comments.min = us.nCommentMin;
      if (us.nCommentMax !== undefined) c.nurture.hourlyBudget.comments.max = us.nCommentMax;
    }
    if (us.nRepostMin !== undefined || us.nRepostMax !== undefined) {
      c.nurture = c.nurture || {}; c.nurture.hourlyBudget = c.nurture.hourlyBudget || {};
      c.nurture.hourlyBudget.reposts = c.nurture.hourlyBudget.reposts || {};
      if (us.nRepostMin !== undefined) c.nurture.hourlyBudget.reposts.min = us.nRepostMin;
      if (us.nRepostMax !== undefined) c.nurture.hourlyBudget.reposts.max = us.nRepostMax;
    }
    if (us.cBatchMin !== undefined || us.cBatchMax !== undefined) {
      c.chat = c.chat || {}; c.chat.batchPerRound = c.chat.batchPerRound || {};
      if (us.cBatchMin !== undefined) c.chat.batchPerRound.min = us.cBatchMin;
      if (us.cBatchMax !== undefined) c.chat.batchPerRound.max = us.cBatchMax;
    }
    if (us.cIceMin !== undefined || us.cIceMax !== undefined) {
      c.chat = c.chat || {}; c.chat.iceToAdMin = c.chat.iceToAdMin || {};
      if (us.cIceMin !== undefined) c.chat.iceToAdMin.min = us.cIceMin;
      if (us.cIceMax !== undefined) c.chat.iceToAdMin.max = us.cIceMax;
    }
    if (us.cAdMin !== undefined || us.cAdMax !== undefined) {
      c.chat = c.chat || {}; c.chat.adToKickMin = c.chat.adToKickMin || {};
      if (us.cAdMin !== undefined) c.chat.adToKickMin.min = us.cAdMin;
      if (us.cAdMax !== undefined) c.chat.adToKickMin.max = us.cAdMax;
    }
    return c;
  }

  // ==================== 快捷函数 ====================
  function getServer(path) {
    if (!path) return CFG.server.pool;
    if (path.startsWith('/pool/')) return CFG.server.pool;
    if (path.startsWith('/api/'))  return CFG.server.ops;
    if (path.startsWith('/health')) return CFG.server.pool;
    return CFG.server.pool;
  }

  function buildUrl(path) {
    return getServer(path) + path;
  }

  // ==================== 导出 ====================
  function isSW() {
    return typeof window === 'undefined' && typeof self !== 'undefined';
  }

  var api = {
    CFG,
    getServer,
    buildUrl,
    version: '3.0.0',
  };

  if (isSW()) {
    self.SchedulerConfig = api;
  } else {
    window.SchedulerConfig = api;
  }

  loadUserSettings();

  // 监听 storage 变化，即时更新
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (changes, namespace) {
        if (namespace === 'local' && changes.sg_settings && changes.sg_settings.newValue) {
          CFG = deepMerge(deepClone(DEFAULTS), userToConfig(changes.sg_settings.newValue));
          console.log('[配置] 设置已更新');
        }
      });
    }
  } catch (e) {}

  console.log('[配置] 智能调度中心 3.0.0 | pool:', CFG.server.pool, '| ops:', CFG.server.ops);
})();

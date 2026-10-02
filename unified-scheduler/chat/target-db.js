// =============================================================================
// C1 · 粉丝目标库 chat_target_db（按 bot 隔离）
// 工作指导：入库字段、round；禁止调度 priority
// =============================================================================
(function () {
  'use strict';
  if (typeof window !== 'undefined' && window.__sg_target_db_loaded__) return;
  if (typeof window !== 'undefined') window.__sg_target_db_loaded__ = true;

  var TARGET_DB_KEY = 'chat_target_db';
  var FALLBACK_BOT_KEY = '_unknown_bot';
  var FLEET_HANDLES_KEY = 'sg_fleet_handles';

  var hooks = {
    getMyHandle: null,
    saveToDB: null
  };

  function callHook(name) {
    var fn = hooks[name];
    if (typeof fn !== 'function') return undefined;
    try {
      return fn.apply(null, Array.prototype.slice.call(arguments, 1));
    } catch (e) {
      return undefined;
    }
  }

  function bind(next) {
    if (!next) return api;
    Object.keys(hooks).forEach(function (k) {
      if (typeof next[k] === 'function') hooks[k] = next[k];
    });
    return api;
  }

  function normalizeChatHandle(h) {
    return String(h || '').replace(/^@/, '').replace(/#guard$/i, '').toLowerCase().trim();
  }

  function getBotKey() {
    var live = '';
    try {
      var hooked = callHook('getMyHandle');
      if (hooked) live = normalizeChatHandle(hooked);
    } catch (eH) {}
    if (!live) {
      try {
        var mh = localStorage.getItem('matrix_my_handle') || localStorage.getItem('matrix_extracted_handle');
        if (mh) live = normalizeChatHandle(mh);
      } catch (e1) {}
    }
    var fromDan = '';
    try {
      fromDan = normalizeChatHandle(sessionStorage.getItem('dan_target_username') || '');
    } catch (e0) {}
    // 换号残留：dan 与 live 不一致时以 live 为准，避免写进上一号桶
    if (live && fromDan && live !== fromDan) return live;
    if (fromDan) return fromDan;
    if (live) return live;
    return '';
  }

  function loadRootTargetDB() {
    try { return JSON.parse(localStorage.getItem(TARGET_DB_KEY) || '{}') || {}; } catch (e) { return {}; }
  }

  function isFlatTargetEntry(v) {
    return !!(v && typeof v === 'object' && ('round' in v || 'firstSeen' in v || 'done' in v || 'lastDM' in v));
  }

  function migrateRootTargetDB(root) {
    var bot = getBotKey();
    if (!bot) return root;
    var hasFlat = false;
    var hasNested = false;
    for (var k in root) {
      if (!Object.prototype.hasOwnProperty.call(root, k)) continue;
      var v = root[k];
      if (isFlatTargetEntry(v)) hasFlat = true;
      else if (v && typeof v === 'object') {
        for (var k2 in v) {
          if (isFlatTargetEntry(v[k2])) { hasNested = true; break; }
        }
      }
      if (hasFlat && hasNested) break;
    }
    if (hasFlat && !hasNested) {
      var migrated = {};
      migrated[bot] = root;
      try { localStorage.setItem(TARGET_DB_KEY, JSON.stringify(migrated)); } catch (eM) {}
      return migrated;
    }
    return root;
  }

  function loadTargetDB() {
    var root = migrateRootTargetDB(loadRootTargetDB());
    var bot = getBotKey() || FALLBACK_BOT_KEY;
    if (!root[bot] || typeof root[bot] !== 'object' || isFlatTargetEntry(root[bot])) {
      root[bot] = {};
    }
    return root[bot];
  }

  function saveTargetDB(db) {
    try {
      var bot = getBotKey() || FALLBACK_BOT_KEY;
      var root = migrateRootTargetDB(loadRootTargetDB());
      root[bot] = db || {};
      localStorage.setItem(TARGET_DB_KEY, JSON.stringify(root));
    } catch (e) {}
  }

  function getFleetHandleSet() {
    var set = new Set();
    try {
      var arr = JSON.parse(localStorage.getItem(FLEET_HANDLES_KEY) || '[]');
      if (Array.isArray(arr)) {
        for (var i = 0; i < arr.length; i++) {
          var h = normalizeChatHandle(arr[i]);
          if (h) set.add(h);
        }
      }
    } catch (e) {}
    var me = getBotKey();
    if (me) set.add(me);
    return set;
  }

  function saveFleetHandles(list) {
    try {
      if (!Array.isArray(list)) return;
      var cleaned = list.map(normalizeChatHandle).filter(Boolean);
      localStorage.setItem(FLEET_HANDLES_KEY, JSON.stringify(cleaned));
    } catch (e) {}
  }

  function isFleetHandle(handle) {
    handle = normalizeChatHandle(handle);
    if (!handle) return true;
    var me = getBotKey();
    if (me && handle === me) return true;
    return getFleetHandleSet().has(handle);
  }

  function rejectFleetHandle(handle) {
    handle = normalizeChatHandle(handle);
    if (!handle) return;
    try { callHook('saveToDB', 'dan_reject_users', handle); } catch (e) {}
  }

  function getUserRound(userHandle) {
    userHandle = normalizeChatHandle(userHandle);
    var db = loadTargetDB();
    var entry = db[userHandle];
    return entry ? (entry.round || 0) : 0;
  }

  function ensureIceEvidenceOnEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    var round = Number(entry.round) || 0;
    if (round < 1) return false;
    var dirty = false;
    if (!entry.iceSentAt) {
      entry.iceSentAt = entry.lastDM || entry.firstSeen || Date.now();
      dirty = true;
    }
    if (!entry.lastDM) {
      entry.lastDM = entry.iceSentAt;
      dirty = true;
    }
    if (round === 1 && !entry.slaDueAt && entry.iceSentAt) {
      entry.slaDueAt = entry.iceSentAt + 90 * 60 * 1000;
      dirty = true;
    }
    return dirty;
  }

  function setUserRound(userHandle, round) {
    userHandle = normalizeChatHandle(userHandle);
    try {
      var db = loadTargetDB();
      if (!db[userHandle]) db[userHandle] = { round: 0, firstSeen: Date.now(), lastDM: null };
      var prev = Number(db[userHandle].round) || 0;
      var next = Math.max(0, Number(round) || 0);
      db[userHandle].round = Math.max(prev, next);
      if (db[userHandle].round >= 3) db[userHandle].done = true;
      ensureIceEvidenceOnEntry(db[userHandle]);
      saveTargetDB(db);
    } catch (e) {}
  }

  function repairMissingIceSentAtInDb() {
    try {
      var root = migrateRootTargetDB(loadRootTargetDB());
      var n = 0;
      var bots = 0;
      for (var bot in root) {
        if (!Object.prototype.hasOwnProperty.call(root, bot)) continue;
        var bucket = root[bot];
        if (!bucket || typeof bucket !== 'object' || isFlatTargetEntry(bucket)) continue;
        bots++;
        var dirtyBot = false;
        for (var h in bucket) {
          if (!Object.prototype.hasOwnProperty.call(bucket, h)) continue;
          if (ensureIceEvidenceOnEntry(bucket[h])) {
            n++;
            dirtyBot = true;
          }
        }
        if (dirtyBot) root[bot] = bucket;
      }
      if (n > 0) {
        localStorage.setItem(TARGET_DB_KEY, JSON.stringify(root));
        console.log('[私信] 回填 iceSentAt/lastDM 共 ' + n + ' 个目标（扫 ' + bots + ' 个 bot 桶）');
      }
      return n;
    } catch (e) {
      console.warn('[私信] iceSentAt 回填失败', e);
      return 0;
    }
  }

  function applyOpsMaxRound(userHandle, opsMax) {
    userHandle = normalizeChatHandle(userHandle);
    opsMax = Number(opsMax) || 0;
    if (opsMax <= 0) return;
    try {
      var db = loadTargetDB();
      // 禁止 OPS 轮次表凭空新建本地债（会把历史 pending_leads 灌成 ad/kick 假债）
      // ice 跳过仍走 sessionStorage ops_target_rounds / getOpsMaxRound
      if (!db[userHandle]) return;
      var local = Number(db[userHandle].round) || 0;
      if (opsMax > local) {
        db[userHandle].round = opsMax;
        if (opsMax >= 3) db[userHandle].done = true;
        ensureIceEvidenceOnEntry(db[userHandle]);
        saveTargetDB(db);
      }
    } catch (e) {}
  }

  function mergeTargetRoundsMap(map) {
    if (!map || typeof map !== 'object') return;
    for (var th in map) {
      if (!Object.prototype.hasOwnProperty.call(map, th)) continue;
      applyOpsMaxRound(th, map[th]);
    }
  }

  var api = {
    bind: bind,
    TARGET_DB_KEY: TARGET_DB_KEY,
    normalizeChatHandle: normalizeChatHandle,
    getBotKey: getBotKey,
    loadTargetDB: loadTargetDB,
    saveTargetDB: saveTargetDB,
    getFleetHandleSet: getFleetHandleSet,
    saveFleetHandles: saveFleetHandles,
    isFleetHandle: isFleetHandle,
    rejectFleetHandle: rejectFleetHandle,
    getUserRound: getUserRound,
    setUserRound: setUserRound,
    ensureIceEvidenceOnEntry: ensureIceEvidenceOnEntry,
    repairMissingIceSentAtInDb: repairMissingIceSentAtInDb,
    applyOpsMaxRound: applyOpsMaxRound,
    mergeTargetRoundsMap: mergeTargetRoundsMap,
    loadRootTargetDB: loadRootTargetDB,
    migrateRootTargetDB: migrateRootTargetDB,
    isFlatTargetEntry: isFlatTargetEntry
  };

  if (typeof window !== 'undefined') window.SgTargetDb = api;
  console.log('[C1] target-db.js loaded');
})();

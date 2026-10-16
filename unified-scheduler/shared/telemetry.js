// =============================================================================
// 统一观测总线 — 事件目录 + 本地缓冲 + OPS 批量上报
// =============================================================================
(function () {
  'use strict';

  var BUFFER_KEY = 'sg_telemetry_buffer';
  var SESSION_KEY = 'sg_telemetry_session';
  var MAX_BUFFER = 2000;
  var BATCH_SIZE = 40;
  var MIN_FLUSH_INTERVAL_MS = 30000;
  var MAX_FLUSH_INTERVAL_MS = 60000;
  var MAX_BACKOFF_MS = 120000;

  var SEVERITY_RANK = { debug: 0, info: 1, warn: 2, error: 3 };

  var DEFAULT_CATALOG = {
    events: [
      { id: 'system.logger_warn', label_zh: '系统警告', category: 'system', severity: 'warn', upload: true, push: false },
      { id: 'system.logger_error', label_zh: '系统错误', category: 'system', severity: 'error', upload: true, push: true },
      { id: 'scheduler.round_start', label_zh: '指挥发租约', category: 'scheduler', severity: 'info', upload: true, push: false },
      { id: 'scheduler.round_complete', label_zh: '指挥收工', category: 'scheduler', severity: 'info', upload: true, push: false },
      { id: 'scheduler.chat_zombie_reclaim', label_zh: '假活回收', category: 'scheduler', severity: 'warn', upload: true, push: true },
      { id: 'scheduler.diag_anomaly', label_zh: '诊断异常', category: 'scheduler', severity: 'warn', upload: true, push: true },
      { id: 'scheduler.diag_freeze', label_zh: '诊断告警(上报)', category: 'scheduler', severity: 'warn', upload: true, push: false },
      { id: 'scheduler.diag_unfreeze', label_zh: '解除诊断冻结', category: 'scheduler', severity: 'info', upload: true, push: false },
      { id: 'scheduler.diag_auto_repaired', label_zh: '诊断自愈', category: 'scheduler', severity: 'info', upload: true, push: false },
      { id: 'chat.round_plan', label_zh: '私信轮计划名单', category: 'chat', severity: 'info', upload: true, push: false },
      { id: 'chat.round_progress', label_zh: '私信轮逐条进度', category: 'chat', severity: 'info', upload: true, push: false },
      { id: 'chat.round_result', label_zh: '私信轮结果', category: 'chat', severity: 'info', upload: true, push: false },
      { id: 'chat.task_queue_keep', label_zh: '保留任务队列', category: 'chat', severity: 'info', upload: true, push: false }
    ]
  };

  var catalogMap = {};
  var remoteMinLevel = 'info';
  var disabledEvents = {};
  var flushTimer = null;
  var retryTimer = null;
  var uploadLock = false;
  var flushing = false;
  var failStreak = 0;

  function trimStr(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function trimSnapshot(snap) {
    snap.recent_events = (snap.recent_events || []).slice(-300);
    snap.console_lines = (snap.console_lines || []).slice(-200).map(function (l) {
      return Object.assign({}, l, { message: trimStr(l.message, 400) });
    });
    try {
      snap.logger_history = (snap.logger_history || []).slice(-100);
      snap.error_log = (snap.error_log || []).slice(-100);
    } catch (eTrim) {}
    return snap;
  }

  function shanghaiTime() {
    try {
      return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    } catch (e) {
      return new Date().toISOString();
    }
  }

  function resolveHandleFromDom() {
    try {
      var el = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
      if (el) {
        var href = el.href || el.getAttribute('href') || '';
        var abs = href.match(/x\.com\/([^\/\?]+)/i);
        var rel = href.match(/^\/([^\/\?]+)/);
        var m = abs || rel;
        if (m && m[1]) {
          var raw = String(m[1]).toLowerCase().replace(/[^a-z0-9_]/g, '');
          if (raw && raw !== 'i' && raw !== 'home' && raw !== 'unknown' && !/^\d{4,5}$/.test(raw)) {
            return '@' + raw + '#guard';
          }
        }
      }
    } catch (eDom) {}
    return '';
  }

  function getBotId() {
    try {
      var h = localStorage.getItem('matrix_my_handle');
      if (h && h !== 'unknown') return h;
      h = sessionStorage.getItem('dan_worker_id');
      if (h && h !== 'unknown' && h.indexOf('null') < 0) return h;
      var extracted = localStorage.getItem('matrix_extracted_handle');
      if (extracted) {
        var clean = String(extracted).replace(/^@/, '').replace(/#guard$/i, '').toLowerCase().trim();
        if (clean && clean !== 'unknown') return '@' + clean + '#guard';
      }
      h = resolveHandleFromDom();
      if (h) {
        try { localStorage.setItem('matrix_my_handle', h); } catch (eSet) {}
        return h;
      }
    } catch (e0) {}
    return 'unknown';
  }

  function ensureSessionId() {
    try {
      var sid = sessionStorage.getItem(SESSION_KEY);
      if (!sid) {
        sid = 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        sessionStorage.setItem(SESSION_KEY, sid);
      }
      return sid;
    } catch (e) {
      return 's_unknown';
    }
  }

  function loadCatalogFromRemote() {
    try {
      var raw = localStorage.getItem('sg_telemetry_catalog');
      if (raw) mergeCatalog(JSON.parse(raw));
    } catch (e) {}
    try {
      var cfg = JSON.parse(localStorage.getItem('sg_config_thresholds') || '{}');
      if (cfg.telemetry_upload_min_level) remoteMinLevel = String(cfg.telemetry_upload_min_level);
      if (cfg.telemetry_disabled_events) {
        var list = String(cfg.telemetry_disabled_events).split(/[,，\s]+/).filter(Boolean);
        disabledEvents = {};
        list.forEach(function (id) { disabledEvents[id] = true; });
      }
    } catch (e2) {}
  }

  function mergeCatalog(cat) {
    if (!cat || !cat.events) return;
    cat.events.forEach(function (ev) {
      if (ev && ev.id) catalogMap[ev.id] = ev;
    });
  }

  function initCatalog() {
    mergeCatalog(DEFAULT_CATALOG);
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
        var url = chrome.runtime.getURL('obs/event-catalog.json');
        fetch(url).then(function (r) { return r.json(); }).then(function (j) {
          mergeCatalog(j);
          try { localStorage.setItem('sg_telemetry_catalog', JSON.stringify(j)); } catch (e) {}
        }).catch(function () {});
      }
    } catch (eFetch) {}
    loadCatalogFromRemote();
  }

  function resolveEvent(eventId) {
    var ev = catalogMap[eventId] || {
      id: eventId,
      label_zh: eventId,
      category: 'system',
      severity: 'info',
      upload: true,
      push: false
    };
    return ev;
  }

  function shouldUpload(ev) {
    if (disabledEvents[ev.id]) return false;
    if (!ev.upload) return false;
    var min = SEVERITY_RANK[remoteMinLevel] || 1;
    var sev = SEVERITY_RANK[ev.severity] || 1;
    return sev >= min;
  }

  // 缓冲使用 sessionStorage：每个标签页独立，避免 30-50 实例共享
  // chrome.storage.local 时的读改写竞争导致日志互相覆盖丢失。
  function readBuffer(cb) {
    var buf = [];
    try {
      var raw = sessionStorage.getItem(BUFFER_KEY);
      if (raw) buf = JSON.parse(raw);
    } catch (e) {}
    if (!Array.isArray(buf)) buf = [];
    if (cb) cb(buf);
  }

  function writeBuffer(buf, cb) {
    try {
      if (buf && buf.length) {
        sessionStorage.setItem(BUFFER_KEY, JSON.stringify(buf));
      } else {
        sessionStorage.removeItem(BUFFER_KEY);
      }
    } catch (e) {}
    if (cb) cb();
  }

  function pushLocal(entry) {
    readBuffer(function (buf) {
      buf.push(entry);
      if (buf.length > MAX_BUFFER) buf = buf.slice(-MAX_BUFFER);
      writeBuffer(buf);
    });
  }

  function sendToBackground(payload) {
    return new Promise(function (resolve) {
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage(payload, function (res) {
            if (chrome.runtime.lastError) {
              resolve({ ok: false, error: chrome.runtime.lastError.message || 'no_sw' });
              return;
            }
            resolve(res || { ok: false });
          });
          return;
        }
      } catch (e) {}
      resolve({ ok: false, error: 'no_runtime' });
    });
  }

  // 精确确认：后端已入库 + 即将幂等去重 = 整批都已交代
  function accounted(batch, res) {
    if (!res || !res.ok) return false;
    // 新协议：返回 ingested + deduped (后端去重后)
    if (res.ingested != null || res.deduped != null) {
      var ingested = Number(res.ingested || 0);
      var deduped = Number(res.deduped || 0);
      return ingested + deduped >= batch.length;
    }
    // 兼容旧协议：只返回 count
    var n = Number(res.count != null ? res.count : 0);
    return n >= batch.length;
  }

  function markUploaded(ids) {
    return new Promise(function (resolve) {
      if (!ids || !ids.length) {
        resolve();
        return;
      }
      readBuffer(function (buf) {
        buf.forEach(function (e) {
          if (ids.indexOf(e._id) >= 0) e.uploaded = true;
        });
        writeBuffer(buf, resolve);
      });
    });
  }

  function scheduleRetry() {
    if (retryTimer) return;
    // 指数退避：5s → 10s → 20s → 40s → 80s → 120s max
    var delay = Math.min(5000 * Math.pow(2, Math.min(failStreak - 1, 5)), MAX_BACKOFF_MS) + Math.random() * 3000;
    retryTimer = setTimeout(function () {
      retryTimer = null;
      flushUploadBatch();
    }, delay);
  }

  function flushUploadBatch() {
    return new Promise(function (resolve) {
      if (flushing) {
        resolve({ ok: true, count: 0, skipped: true });
        return;
      }
      flushing = true;
      readBuffer(function (buf) {
        var pending = buf.filter(function (e) { return e && e.upload && !e.uploaded; });
        if (!pending.length) {
          flushing = false;
          resolve({ ok: true, count: 0 });
          return;
        }
        pending.sort(function (a, b) {
          var pa = COMMAND_LOOP_PRIORITY[a.event_id] || 9;
          var pb = COMMAND_LOOP_PRIORITY[b.event_id] || 9;
          if (pa !== pb) return pa - pb;
          return (a.ts || 0) - (b.ts || 0);
        });
        var batch = pending.slice(0, BATCH_SIZE);
        var ids = batch.map(function (e) { return e._id; });
        sendToBackground({
          action: 'telemetry_emit',
          payload: { events: batch }
        }).then(function (res) {
          flushing = false;
          if (accounted(batch, res)) {
            failStreak = 0;
            markUploaded(ids).then(function () { resolve(res); });
          } else {
            failStreak += 1;
            scheduleRetry();
            resolve(res || { ok: false });
          }
        }).catch(function (err) {
          flushing = false;
          failStreak += 1;
          scheduleRetry();
          resolve({ ok: false, error: (err && err.message) || 'flush_catch' });
        });
      });
    });
  }

  function flushAllPending(maxRounds) {
    maxRounds = maxRounds == null ? 12 : maxRounds;
    if (maxRounds <= 0) return Promise.resolve({ ok: true, partial: true });
    return flushUploadBatch().then(function (res) {
      if (!res || !res.ok) return res;
      return new Promise(function (resolve) {
        readBuffer(function (buf) {
          var still = buf.filter(function (e) { return e && e.upload && !e.uploaded; });
          if (still.length) {
            flushAllPending(maxRounds - 1).then(resolve);
          } else {
            resolve(res);
          }
        });
      });
    });
  }

  // 指挥闭环关键节点：优先出队 + 短延迟 flush，避免断链只在本地缓冲
  var COMMAND_LOOP_PRIORITY = {
    'scheduler.round_start': 1,
    'scheduler.round_complete': 1,
    'scheduler.chat_zombie_reclaim': 1,
    'chat.round_plan': 1,
    'chat.round_progress': 2,
    'chat.round_result': 1,
    'scheduler.command_loop_gap': 1,
    'scheduler.diag_anomaly': 1,
    'scheduler.diag_freeze': 1
  };

  function scheduleFlush() {
    if (flushTimer || flushing) return;
    flushTimer = setTimeout(function () {
      flushTimer = null;
      flushUploadBatch();
    }, 2000 + Math.random() * 3000);
  }

  function scheduleCommandLoopFlush() {
    if (flushing) return;
    if (flushTimer) {
      try { clearTimeout(flushTimer); } catch (eClr) {}
      flushTimer = null;
    }
    flushTimer = setTimeout(function () {
      flushTimer = null;
      flushUploadBatch();
    }, 200 + Math.random() * 300);
  }

  function scheduleIntervalFlush() {
    var delay = MIN_FLUSH_INTERVAL_MS + Math.random() * (MAX_FLUSH_INTERVAL_MS - MIN_FLUSH_INTERVAL_MS);
    setTimeout(function () {
      flushUploadBatch();
      scheduleIntervalFlush();
    }, delay);
  }

  function emit(eventId, meta, opts) {
    opts = opts || {};
    var ev = resolveEvent(eventId);
    var entryId = Date.now() + '_' + Math.random().toString(36).slice(2, 9);
    var entry = {
      _id: entryId,
      client_event_id: entryId,
      event_id: ev.id,
      label_zh: ev.label_zh,
      category: ev.category,
      severity: opts.severity || ev.severity || 'info',
      meta: meta || {},
      ts: Date.now(),
      time_zh: shanghaiTime(),
      session_id: ensureSessionId(),
      account_handle: getBotId(),
      upload: shouldUpload(ev),
      uploaded: false,
      push: ev.push || false
    };
    pushLocal(entry);
    if (entry.upload) {
      if (COMMAND_LOOP_PRIORITY[ev.id]) scheduleCommandLoopFlush();
      else scheduleFlush();
    }
    try {
      window.dispatchEvent(new CustomEvent('sg-telemetry', { detail: entry }));
    } catch (eEv) {}
    return entry;
  }

  function exportRecent(n) {
    n = n || 200;
    return new Promise(function (resolve) {
      readBuffer(function (buf) {
        resolve(buf.slice(-n));
      });
    });
  }

  function buildSnapshot(extra) {
    extra = extra || {};
    var handle = getBotId();
    var snap = {
      ts: Date.now(),
      time_zh: shanghaiTime(),
      session_id: ensureSessionId(),
      account_handle: handle,
      extension_version: (function () {
        try { return chrome.runtime.getManifest().version; } catch (e) { return ''; }
      })(),
      url: (function () { try { return window.location.href; } catch (e2) { return ''; } })(),
      extra: extra
    };
    if (handle === 'unknown') snap._warn = 'account_unknown';
    return snap;
  }

  function uploadSnapshot(extra) {
    if (uploadLock) {
      return Promise.reject(new Error('upload_in_progress'));
    }
    uploadLock = true;
    var handle = getBotId();
    if (handle === 'unknown') {
      uploadLock = false;
      return Promise.reject(new Error('account_unknown'));
    }
    try { flushAllPending(3).catch(function () {}); } catch (eFl) {}

    var snap = buildSnapshot(extra);
    return exportRecent(200).then(function (events) {
      snap.recent_events = events;
      try {
        snap.error_log = JSON.parse(localStorage.getItem('sg_error_log') || '[]');
      } catch (e) { snap.error_log = []; }
      try {
        snap.logger_history = JSON.parse(localStorage.getItem('sg_log') || '[]');
      } catch (e2) { snap.logger_history = []; }
      if (typeof SgDebugLog !== 'undefined' && SgDebugLog.exportRecent) {
        return SgDebugLog.exportRecent(200).then(function (lines) {
          snap.console_lines = lines;
          return snap;
        });
      }
      snap.console_lines = [];
      return snap;
    }).then(function (snapReady) {
      snapReady = trimSnapshot(snapReady);
      return sendToBackground({ action: 'telemetry_snapshot', payload: snapReady }).then(function (res) {
        if (!res || !res.ok) {
          var err = new Error((res && (res.error || res.msg)) || 'upload_failed');
          err.response = res;
          throw err;
        }
        try { emit('system.diag_uploaded', { snapshot_id: res.snapshot_id }); } catch (eEm) {}
        return { snap: snapReady, response: res };
      });
    }).finally(function () {
      uploadLock = false;
    });
  }

  function copySnapshotText(extra) {
    return uploadSnapshot(extra).then(function (result) {
      var text = JSON.stringify(result.snap, null, 2);
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(text).then(function () { return text; });
        }
      } catch (e) {}
      return text;
    });
  }

  var ROUND_START_DEDUP_KEY = 'sg_chat_round_start_emitted_pulse';

  /** 同 pulseId 只上报一次 round_start（force 与 coStart 去重） */
  function emitRoundStart(meta) {
    meta = meta || {};
    var pulseId = String(meta.pulseId || '');
    try {
      if (pulseId) {
        var prev = sessionStorage.getItem(ROUND_START_DEDUP_KEY) || '';
        if (prev === pulseId) {
          return { skipped: true, reason: 'dup_pulse', pulseId: pulseId };
        }
        sessionStorage.setItem(ROUND_START_DEDUP_KEY, pulseId);
      }
    } catch (eD) {}
    return emit('scheduler.round_start', meta);
  }

  function clearRoundStartDedupe() {
    try { sessionStorage.removeItem(ROUND_START_DEDUP_KEY); } catch (e) {}
  }

  function getRecentSummaries(n) {
    n = n || 5;
    return new Promise(function (resolve) {
      readBuffer(function (buf) {
        var list = buf.slice(-n).reverse().map(function (e) {
          var m = e.meta || {};
          // Logger.warn/error 写的是 mod+msg（不是 message）；丢掉则面板只剩「系统警告」
          var hint = '';
          if (m.mod || m.msg) {
            hint = String(m.mod || '') + (m.mod && m.msg ? ' ' : '') + String(m.msg || '');
            if (m.detail) hint += ' ' + String(m.detail).slice(0, 40);
          } else {
            hint = m.target || m.reason || m.message || m.latency_ms || '';
          }
          hint = String(hint || '').trim().slice(0, 80);
          return (e.time_zh || '') + ' ' + (e.label_zh || e.event_id) + (hint ? ' ' + hint : '');
        });
        resolve(list);
      });
    });
  }

  initCatalog();
  try {
    window.addEventListener('sg-config-synced', function () { loadCatalogFromRemote(); });
  } catch (eL) {}
  scheduleIntervalFlush();

  var SgTelemetry = {
    emit: emit,
    emitRoundStart: emitRoundStart,
    clearRoundStartDedupe: clearRoundStartDedupe,
    exportRecent: exportRecent,
    buildSnapshot: buildSnapshot,
    uploadSnapshot: uploadSnapshot,
    copySnapshotText: copySnapshotText,
    getRecentSummaries: getRecentSummaries,
    flush: flushAllPending,
    getCatalog: function () { return catalogMap; },
    getBotId: getBotId
  };

  if (typeof window !== 'undefined') window.SgTelemetry = SgTelemetry;
  if (typeof self !== 'undefined') self.SgTelemetry = SgTelemetry;
})();

// =============================================================================
// 日志常态采集器 — 常驻记录调度状态、关键事件、错误与检查点
// 加载即自动启动（无需手动开关），关键记录经 SgTelemetry 管道自动批量上报。
// 存储使用 sessionStorage：每个标签页独立，避免多实例共享 storage 的读写竞争。
// =============================================================================
(function () {
  'use strict';

  var STORAGE_KEY = 'sg_test_monitor';
  var MAX_RECORDS = 1500;
  var MAX_ERRORS = 500;
  var MAX_CHECKPOINTS = 300;
  var CHECKPOINT_MS = 30000;
  var CHECKPOINT_UPLOAD_EVERY = 10; // 每 10 次 checkpoint（约 5 分钟）上报一次摘要
  var TICK_SAVE_INTERVAL_MS = 15000; // co-tick 无变化时最多 15s 落盘一次

  var session = null;
  var lastState = null;
  var lastErrorCount = 0;
  var checkpointTimer = null;
  var listenersBound = false;
  var bridgeListening = false;
  var checkpointCount = 0;
  var lastTickSaveTs = 0;

  function shanghaiTime() {
    try {
      return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    } catch (e) {
      return new Date().toISOString();
    }
  }

  function newSessionId() {
    return 'tm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  function newClientEventId() {
    return 'evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  }

  function defaultSession() {
    return {
      session_id: newSessionId(),
      started_at: Date.now(),
      ended_at: 0,
      label: 'auto',
      active: true,
      records: [],
      errors: [],
      checkpoints: [],
      summary: {
        co_ticks: 0,
        soft_risk_enters: 0,
        follow_round_ends: 0,
        chat_blocked: 0,
        errors: 0,
        state_changes: 0
      }
    };
  }

  function loadSession() {
    try {
      var raw = sessionStorage.getItem(STORAGE_KEY);
      session = raw ? JSON.parse(raw) : defaultSession();
      if (!session.summary) session.summary = defaultSession().summary;
      if (!session.records) session.records = [];
      if (!session.errors) session.errors = [];
      if (!session.checkpoints) session.checkpoints = [];
      if (!raw) {
        // 一次性迁移旧 localStorage 数据到本标签页
        try {
          var legacy = localStorage.getItem(STORAGE_KEY);
          if (legacy) {
            var old = JSON.parse(legacy);
            if (old && old.records && old.records.length) {
              session.records = old.records.slice(-MAX_RECORDS);
              session.errors = (old.errors || []).slice(-MAX_ERRORS);
              session.summary = old.summary || session.summary;
            }
            localStorage.removeItem(STORAGE_KEY);
          }
        } catch (eLg) {}
      }
    } catch (e) {
      session = defaultSession();
    }
    try {
      lastErrorCount = (JSON.parse(localStorage.getItem('sg_error_log') || '[]') || []).length;
    } catch (e2) {
      lastErrorCount = 0;
    }
    if (session.lastWatchState) lastState = session.lastWatchState;
    return session;
  }

  function saveSession() {
    try {
      if (session && lastState) session.lastWatchState = lastState;
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } catch (e) {}
    notifyUpdate();
  }

  function notifyUpdate() {
    try {
      window.dispatchEvent(new CustomEvent('sg-test-monitor-update', {
        detail: { session_id: session.session_id, active: session.active, summary: session.summary }
      }));
    } catch (e) {}
  }

  function trimArrays() {
    if (session.records.length > MAX_RECORDS) session.records = session.records.slice(-MAX_RECORDS);
    if (session.errors.length > MAX_ERRORS) session.errors = session.errors.slice(-MAX_ERRORS);
    if (session.checkpoints.length > MAX_CHECKPOINTS) session.checkpoints = session.checkpoints.slice(-MAX_CHECKPOINTS);
  }

  function emitTelemetry(eventId, meta, severity) {
    try {
      if (typeof SgTelemetry !== 'undefined' && SgTelemetry.emit) {
        SgTelemetry.emit(eventId, Object.assign({ _from_monitor: true }, meta || {}), { severity: severity || 'info' });
      }
    } catch (e) {}
  }

  function baseRecord(type, severity) {
    return {
      client_event_id: newClientEventId(),
      ts: Date.now(),
      time_zh: shanghaiTime(),
      type: type,
      severity: severity || 'info'
    };
  }

  function pushRecord(rec) {
    if (!session || !session.active) return;
    session.records.push(rec);
    trimArrays();
    saveSession();
  }

  function pushError(err) {
    if (!session || !session.active) return;
    var item = {
      ts: Date.now(),
      time_zh: shanghaiTime(),
      message: String((err && err.message) || err || ''),
      stack: err && err.stack ? String(err.stack).slice(0, 800) : '',
      source: (err && err.source) || 'unknown'
    };
    session.errors.push(item);
    session.summary.errors = (session.summary.errors || 0) + 1;
    pushRecord(Object.assign(baseRecord('error', 'error'), {
      event_id: 'test.error',
      label_zh: '运行错误',
      data: item
    }));
    emitTelemetry('test.error', { message: item.message, source: item.source }, 'error');
  }

  function getDiagFn() {
    try {
      if (typeof window.__matrix_console__ !== 'undefined' && window.__matrix_console__.diag) {
        return window.__matrix_console__.diag;
      }
      if (typeof window.__sgDiag === 'function') return window.__sgDiag;
    } catch (e) {}
    return null;
  }

  function extractWatchState(detail) {
    detail = detail || {};
    var cd = detail.chatDiag || {};
    var sr = detail.softRisk || {};
    var matrixFollow = false;
    try { matrixFollow = localStorage.getItem('matrix_follow_running') === 'true'; } catch (eM) {}
    var danAuto = false;
    try { danAuto = sessionStorage.getItem('dan_auto_run') === 'true'; } catch (eD) {}
    return {
      stage: detail.stage || '?',
      runningModule: detail.runningModule || null,
      whyIdle: detail.whyIdle || '',
      softRiskMode: sr.mode || '',
      softRiskRemainSec: sr.remainSec != null ? sr.remainSec : (sr.remainMs != null ? Math.round(sr.remainMs / 1000) : 0),
      followRoundActive: !!cd.followRoundActive,
      actionableAdDebt: cd.actionableAdDebt != null ? cd.actionableAdDebt : 0,
      actionableKickDebt: cd.actionableKickDebt != null ? cd.actionableKickDebt : 0,
      followRunning: !!detail.followRunning,
      chatRunning: !!detail.chatRunning,
      matrix_follow: matrixFollow,
      dan_auto_run: danAuto
    };
  }

  function stateDiff(prev, next) {
    if (!prev) return { changed: true, fields: next };
    var keys = Object.keys(next);
    var diff = {};
    var changed = false;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (prev[k] !== next[k]) {
        diff[k] = { from: prev[k], to: next[k] };
        changed = true;
      }
    }
    return { changed: changed, fields: diff };
  }

  function pollNewErrors() {
    var errLog = [];
    try { errLog = JSON.parse(localStorage.getItem('sg_error_log') || '[]'); } catch (e) {}
    if (errLog.length <= lastErrorCount) return;
    for (var i = lastErrorCount; i < errLog.length; i++) {
      var e = errLog[i];
      pushError({
        message: (e && (e.msg || e.message)) || JSON.stringify(e),
        stack: e && e.stack,
        source: 'sg_error_log'
      });
    }
    lastErrorCount = errLog.length;
  }

  function shouldCaptureTelemetry(entry) {
    if (!entry) return false;
    var sev = entry.severity || 'info';
    if (sev === 'warn' || sev === 'error') return true;
    var id = String(entry.event_id || '');
    if (id.indexOf('test.') === 0) return true;
    if (id.indexOf('scheduler.') === 0 && (id.indexOf('blocked') >= 0 || id.indexOf('ghost') >= 0)) return true;
    return false;
  }

  function onCoTick(e) {
    if (!session || !session.active) return;
    session.summary.co_ticks = (session.summary.co_ticks || 0) + 1;
    var watch = extractWatchState(e.detail || {});
    var diff = stateDiff(lastState, watch);
    lastState = watch;
    if (session) session.lastWatchState = watch;
    pollNewErrors();
    var now = Date.now();
    if (diff.changed) {
      session.summary.state_changes = (session.summary.state_changes || 0) + 1;
      pushRecord(Object.assign(baseRecord('state_change', 'info'), {
        event_id: 'test.state_change',
        label_zh: '状态变化',
        data: { diff: diff.fields }
      }));
    } else if (now - lastTickSaveTs > TICK_SAVE_INTERVAL_MS) {
      lastTickSaveTs = now;
      saveSession();
    }
  }

  function onTelemetry(e) {
    if (!session || !session.active) return;
    var entry = (e && e.detail) || {};
    if (entry.meta && entry.meta._from_monitor) return; // 本采集器上报的事件，避免回环
    if (!shouldCaptureTelemetry(entry)) return;
    if (String(entry.event_id || '').indexOf('scheduler.chat_blocked') >= 0) {
      session.summary.chat_blocked = (session.summary.chat_blocked || 0) + 1;
    }
    if (String(entry.event_id || '').indexOf('system.logger_error') >= 0) {
      pushError({ message: (entry.meta && (entry.meta.message || entry.meta.msg)) || entry.label_zh, source: 'telemetry' });
    }
    pushRecord(Object.assign(baseRecord('telemetry', entry.severity || 'info'), {
      event_id: entry.event_id || '',
      label_zh: entry.label_zh || entry.event_id || '',
      data: { event_id: entry.event_id, label_zh: entry.label_zh, meta: entry.meta || {} }
    }));
  }

  function onDiagnostic(e) {
    if (!session || !session.active) return;
    var text = (e && e.detail && e.detail.text) ? String(e.detail.text) : '';
    if (!text) return;
    pushRecord(Object.assign(baseRecord('diagnostic', 'info'), {
      event_id: 'test.diagnostic',
      label_zh: '诊断文本',
      data: { text: text.slice(0, 500) }
    }));
  }

  function onLifecycle(name, e) {
    if (!session || !session.active) return;
    var detail = (e && e.detail) || {};
    if (name === 'sg-soft-risk-entered') {
      session.summary.soft_risk_enters = (session.summary.soft_risk_enters || 0) + 1;
    }
    if (name === 'sg-follow-round-end') {
      session.summary.follow_round_ends = (session.summary.follow_round_ends || 0) + 1;
    }
    pushRecord(Object.assign(baseRecord('lifecycle', 'info'), {
      event_id: 'test.' + name.replace(/^sg-/, ''),
      label_zh: name,
      data: { event: name, detail: detail }
    }));
    emitTelemetry('test.lifecycle', { event: name }, 'info');
  }

  function buildCheckpoint() {
    var fn = getDiagFn();
    var full = null;
    try { full = fn ? fn() : null; } catch (e) { full = { error: e.message }; }
    if (!full) return null;
    var cd = full.chatDiag || {};
    var sr = cd.softRisk || {};
    return {
      ts: Date.now(),
      time_zh: shanghaiTime(),
      stage: full.stage,
      runningModule: full.coPageOwner,
      engine: full.engine,
      followPhase: full.followPhase,
      chatPhase: full.chatPhase,
      followedToday: full.followedToday,
      followLimit: full.followLimit,
      softRiskMode: sr.mode || '',
      chatDebt: cd.actionableAdDebt != null ? cd.actionableAdDebt : 0,
      url: full.url,
      // 指挥闭环快照（4.0.24+）
      inboxPhase: (function () {
        try { return sessionStorage.getItem('dan_inbox_phase') || ''; } catch (e) { return ''; }
      })(),
      chatLeasePulseId: (function () {
        try {
          var L = JSON.parse(sessionStorage.getItem('sg_chat_lease') || 'null');
          return (L && L.pulseId) || sessionStorage.getItem('dan_inbox_queue_pulse') || '';
        } catch (e2) { return ''; }
      })(),
      chatProgressAgeSec: (function () {
        try {
          var t = parseInt(sessionStorage.getItem('sg_chat_last_progress_at') || '0', 10) || 0;
          if (!t) return null;
          return Math.round((Date.now() - t) / 1000);
        } catch (e3) { return null; }
      })()
    };
  }

  function runCheckpoint() {
    if (!session || !session.active) return;
    pollNewErrors();
    var cp = buildCheckpoint();
    if (!cp) return;
    session.checkpoints.push(cp);
    checkpointCount += 1;
    trimArrays();
    saveSession();
    if (checkpointCount % CHECKPOINT_UPLOAD_EVERY === 0) {
      emitTelemetry('test.checkpoint', cp, 'info');
    }
  }

  function startCheckpointInterval() {
    stopCheckpointInterval();
    checkpointTimer = setInterval(runCheckpoint, CHECKPOINT_MS);
  }

  function stopCheckpointInterval() {
    if (checkpointTimer) {
      clearInterval(checkpointTimer);
      checkpointTimer = null;
    }
  }

  function onSoftRiskEntered(e) { onLifecycle('sg-soft-risk-entered', e); }
  function onSoftRiskChatStart(e) { onLifecycle('sg-soft-risk-chat-start', e); }
  function onFollowRoundEnd(e) { onLifecycle('sg-follow-round-end', e); }

  function registerListeners() {
    if (listenersBound) return;
    listenersBound = true;
    window.addEventListener('sg-coordinator-tick', onCoTick);
    window.addEventListener('sg-telemetry', onTelemetry);
    window.addEventListener('sg-soft-risk-entered', onSoftRiskEntered);
    window.addEventListener('sg-soft-risk-chat-start', onSoftRiskChatStart);
    window.addEventListener('sg-follow-round-end', onFollowRoundEnd);
    document.addEventListener('matrix-diagnostic', onDiagnostic);
  }

  function unregisterListeners() {
    if (!listenersBound) return;
    listenersBound = false;
    window.removeEventListener('sg-coordinator-tick', onCoTick);
    window.removeEventListener('sg-telemetry', onTelemetry);
    window.removeEventListener('sg-soft-risk-entered', onSoftRiskEntered);
    window.removeEventListener('sg-soft-risk-chat-start', onSoftRiskChatStart);
    window.removeEventListener('sg-follow-round-end', onFollowRoundEnd);
    document.removeEventListener('matrix-diagnostic', onDiagnostic);
    stopCheckpointInterval();
  }

  function getHandle() {
    try {
      if (typeof SgTelemetry !== 'undefined' && SgTelemetry.getBotId) {
        var h = SgTelemetry.getBotId();
        if (h && h !== 'unknown') return String(h).replace(/[@#]/g, '');
      }
    } catch (e) {}
    try {
      var m = localStorage.getItem('matrix_my_handle');
      if (m) return String(m).replace(/[@#]/g, '');
    } catch (e2) {}
    return 'unknown';
  }

  function start(label) {
    loadSession();
    session = defaultSession();
    session.active = true;
    session.started_at = Date.now();
    session.label = label ? String(label) : 'auto';
    lastState = null;
    session.lastWatchState = null;
    checkpointCount = 0;
    lastTickSaveTs = 0;
    try {
      lastErrorCount = (JSON.parse(localStorage.getItem('sg_error_log') || '[]') || []).length;
    } catch (e) { lastErrorCount = 0; }
    saveSession();
    registerListeners();
    startCheckpointInterval();
    runCheckpoint();
    emitTelemetry('test.monitor_started', { label: session.label, session_id: session.session_id }, 'info');
    return session;
  }

  function stop() {
    if (!session) loadSession();
    var rec = Object.assign(baseRecord('lifecycle', 'info'), {
      event_id: 'test.monitor_stopped',
      label_zh: '日志采集暂停',
      data: { event: 'test.monitor_stopped', detail: { session_id: session.session_id } }
    });
    session.records.push(rec);
    session.active = false;
    session.ended_at = Date.now();
    unregisterListeners();
    saveSession();
    emitTelemetry('test.monitor_stopped', { session_id: session.session_id }, 'info');
    return session;
  }

  function isActive() {
    loadSession();
    return !!(session && session.active);
  }

  function getSession() {
    loadSession();
    return session;
  }

  function exportJson() {
    loadSession();
    var fn = getDiagFn();
    var diag = null;
    try { diag = fn ? fn() : null; } catch (e) { diag = { error: e.message }; }
    return {
      exported_at: Date.now(),
      exported_at_zh: shanghaiTime(),
      extension_version: (function () {
        try { return chrome.runtime.getManifest().version; } catch (e) { return ''; }
      })(),
      account_handle: getHandle(),
      session: session,
      current_diag: diag
    };
  }

  function downloadJson() {
    var pack = exportJson();
    var text = JSON.stringify(pack, null, 2);
    var handle = getHandle();
    var fname = 'sg-log-' + handle + '-' + Date.now() + '.json';
    try {
      var blob = new Blob([text], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = fname;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch (e) {}
      }, 200);
    } catch (e) {
      return Promise.reject(e);
    }
    emitTelemetry('test.monitor_exported', { session_id: session.session_id, file: fname }, 'info');
    return Promise.resolve({ ok: true, file: fname, pack: pack });
  }

  function copyJson() {
    var pack = exportJson();
    var text = JSON.stringify(pack, null, 2);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(function () { return pack; });
      }
    } catch (e) {}
    return Promise.resolve(pack);
  }

  function uploadOps() {
    if (typeof SgTelemetry === 'undefined' || !SgTelemetry.uploadSnapshot) {
      return Promise.reject(new Error('telemetry_unavailable'));
    }
    var pack = exportJson();
    var extra = { test_monitor: pack };
    if (pack.current_diag) extra.diag = pack.current_diag;
    return SgTelemetry.uploadSnapshot(extra).then(function (result) {
      emitTelemetry('test.monitor_uploaded', {
        session_id: session.session_id,
        snapshot_id: result && result.response && result.response.snapshot_id
      }, 'info');
      return result;
    });
  }

  function clear() {
    loadSession();
    var sid = session.session_id;
    var active = session.active;
    var label = session.label;
    session.records = [];
    session.errors = [];
    session.checkpoints = [];
    session.summary = defaultSession().summary;
    session.session_id = sid;
    session.active = active;
    session.label = label;
    lastState = null;
    saveSession();
    return session;
  }

  function getRecent(n) {
    loadSession();
    n = n || 3;
    return (session.records || []).slice(-n).reverse();
  }

  function handleBridgeRequest(data) {
    var action = data.action;
    var args = data.args || {};
    try {
      switch (action) {
        case 'start': return start(args.label);
        case 'stop': return stop();
        case 'isActive': return isActive();
        case 'getSession': return getSession();
        case 'exportJson': return exportJson();
        case 'downloadJson': return { pending: true };
        case 'copyJson': return { pending: true };
        case 'uploadOps': return { pending: true };
        case 'clear': return clear();
        case 'getRecent': return getRecent(args.n);
        default: return { error: 'unknown_action' };
      }
    } catch (e) {
      return { error: e.message };
    }
  }

  function installPageBridge() {
    if (bridgeListening) return;
    bridgeListening = true;
    window.addEventListener('message', function (e) {
      if (e.source !== window || !e.data || e.data.type !== '__sg_test_monitor_request') return;
      var action = e.data.action;
      var id = e.data.id;
      if (action === 'downloadJson') {
        downloadJson().then(function (res) {
          window.postMessage({ type: '__sg_test_monitor_result', id: id, payload: res }, '*');
        }).catch(function (err) {
          window.postMessage({ type: '__sg_test_monitor_result', id: id, payload: { error: err.message } }, '*');
        });
        return;
      }
      if (action === 'copyJson') {
        copyJson().then(function (res) {
          window.postMessage({ type: '__sg_test_monitor_result', id: id, payload: res }, '*');
        }).catch(function (err) {
          window.postMessage({ type: '__sg_test_monitor_result', id: id, payload: { error: err.message } }, '*');
        });
        return;
      }
      if (action === 'uploadOps') {
        uploadOps().then(function (res) {
          window.postMessage({ type: '__sg_test_monitor_result', id: id, payload: res }, '*');
        }).catch(function (err) {
          window.postMessage({ type: '__sg_test_monitor_result', id: id, payload: { error: err.message } }, '*');
        });
        return;
      }
      var payload = handleBridgeRequest(e.data);
      window.postMessage({ type: '__sg_test_monitor_result', id: id, payload: payload }, '*');
    });
  }

  var SgTestMonitor = {
    start: start,
    stop: stop,
    isActive: isActive,
    getSession: getSession,
    exportJson: exportJson,
    downloadJson: downloadJson,
    copyJson: copyJson,
    uploadOps: uploadOps,
    clear: clear,
    getRecent: getRecent
  };

  if (typeof window !== 'undefined') window.SgTestMonitor = SgTestMonitor;
  if (typeof self !== 'undefined') self.SgTestMonitor = SgTestMonitor;

  loadSession();
  installPageBridge();
  if (session.active) {
    registerListeners();
    startCheckpointInterval();
  } else {
    start('auto');
  }
})();

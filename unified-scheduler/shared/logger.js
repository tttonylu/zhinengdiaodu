// =============================================================================
// 智能调度 — 统一日志（本地 + telemetry 双写）
// =============================================================================

var Logger = (function () {
  'use strict';

  function shanghaiTime() {
    return new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  }

  function telemetryEmit(eventId, meta, severity) {
    try {
      if (typeof SgTelemetry !== 'undefined' && SgTelemetry.emit) {
        SgTelemetry.emit(eventId, meta, { severity: severity });
      }
    } catch (e) {}
  }

  function logToConsole(level, mod, msg, detail) {
    var prefix = '[' + mod + ']';
    if (level === 'error') console.error(prefix, msg, detail || '');
    else if (level === 'warn') console.warn(prefix, msg, detail || '');
    else console.log(prefix, msg, detail || '');
  }

  function logToLocal(mod, msg, level) {
    try {
      var t = shanghaiTime();
      var raw = localStorage.getItem('sg_log');
      var hist = raw ? JSON.parse(raw) : [];
      hist.unshift({ time: t, mod: mod, level: level || 'info', msg: msg });
      if (hist.length > 80) hist.length = 80;
      localStorage.setItem('sg_log', JSON.stringify(hist));
    } catch (e) {}
  }

  function logToServer(mod, msg, level, detail) {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime) {
        chrome.runtime.sendMessage({
          action: 'report_log',
          bot_id: localStorage.getItem('matrix_my_handle') || 'unknown',
          action_type: level.toUpperCase(),
          detail: '[' + mod + '] ' + (detail || ''),
          message: msg,
        }).catch(function () {});
      }
    } catch (e) {}
  }

  return {
    info: function (mod, msg, detail) {
      logToConsole('info', mod, msg, detail);
      logToLocal(mod, msg, 'info');
    },
    warn: function (mod, msg, detail) {
      logToConsole('warn', mod, msg, detail);
      logToLocal(mod, msg, 'warn');
      telemetryEmit('system.logger_warn', { mod: mod, msg: msg, detail: detail || '' }, 'warn');
      logToServer(mod, msg, 'warn', detail);
    },
    error: function (mod, msg, detail) {
      logToConsole('error', mod, msg, detail);
      logToLocal(mod, msg, 'error');
      telemetryEmit('system.logger_error', { mod: mod, msg: msg, detail: detail || '' }, 'error');
      logToServer(mod, msg, 'error', detail);
    },
    debug: function (mod, msg) {
      if (window.SG_DEBUG) {
        logToConsole('info', mod, msg);
        logToLocal(mod, msg, 'debug');
      }
    },
    getHistory: function () {
      try { return JSON.parse(localStorage.getItem('sg_log') || '[]'); } catch (e) { return []; }
    },
    clearHistory: function () {
      localStorage.removeItem('sg_log');
    },
  };
})();

// =============================================================================
// 全局错误捕获 — 防止 setInterval/setTimeout 回调中的异常静默丢失
// =============================================================================
(function () {
  'use strict';

  var MAX_ERRORS = 20;

  function captureError(msg, src, line, col, stack) {
    try {
      var raw = localStorage.getItem('sg_error_log');
      var errLog = raw ? JSON.parse(raw) : [];
      errLog.push({
        t: Date.now(),
        msg: String(msg || 'Unknown error').substring(0, 200),
        src: String(src || '').substring(0, 120),
        line: line || 0,
        col: col || 0,
        stack: String(stack || '').substring(0, 300)
      });
      if (errLog.length > MAX_ERRORS) errLog = errLog.slice(-MAX_ERRORS);
      localStorage.setItem('sg_error_log', JSON.stringify(errLog));
      try {
        if (typeof SgTelemetry !== 'undefined' && SgTelemetry.emit) {
          SgTelemetry.emit('system.logger_error', {
            msg: String(msg || '').substring(0, 200),
            src: src,
            line: line,
            stack: String(stack || '').substring(0, 300)
          }, { severity: 'error' });
        }
      } catch (eT) {}
    } catch (_) {}
  }

  window.addEventListener('error', function (e) {
    captureError(
      e.message || 'Unknown error',
      e.filename || '',
      e.lineno || 0,
      e.colno || 0,
      (e.error && e.error.stack) ? e.error.stack : ''
    );
    console.warn('[ErrCap] ' + e.message + '  ' + e.filename + ':' + e.lineno);
  });

  window.addEventListener('unhandledrejection', function (e) {
    var reason = e.reason;
    var msg = reason instanceof Error ? reason.message : String(reason || 'Unhandled rejection');
    var stack = (reason && reason.stack) ? reason.stack : '';
    captureError(msg, '', 0, 0, stack);
    console.warn('[ErrCap] Unhandled rejection: ' + msg);
  });
})();

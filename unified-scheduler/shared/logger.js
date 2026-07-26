// =============================================================================
// 智能调度 — 统一日志（本地 + 服务器双写）
// =============================================================================

var Logger = (function () {
  'use strict';

  function shanghaiTime() {
    return new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
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
      logToServer(mod, msg, 'warn', detail);
    },
    error: function (mod, msg, detail) {
      logToConsole('error', mod, msg, detail);
      logToLocal(mod, msg, 'error');
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

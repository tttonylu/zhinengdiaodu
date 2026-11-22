// =============================================================================
// SgDebugLog — console/调试行环形缓冲 + 可选上报 telemetry
// =============================================================================
(function () {
  'use strict';

  var BUFFER_KEY = 'sg_debug_log_buffer';
  var MAX_LINES = 300;

  function shanghaiTime() {
    try {
      return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    } catch (e) {
      return new Date().toISOString();
    }
  }

  function readBuffer(cb) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get([BUFFER_KEY], function (r) {
          cb(Array.isArray(r[BUFFER_KEY]) ? r[BUFFER_KEY] : []);
        });
        return;
      }
    } catch (e) {}
    cb([]);
  }

  function writeBuffer(buf) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [BUFFER_KEY]: buf });
      }
    } catch (e) {}
  }

  function emitChatLog(type, data) {
    try {
      document.dispatchEvent(new CustomEvent('matrix-chat-log', {
        detail: { type: type || 'debug', data: data || {} }
      }));
    } catch (e) {}
  }

  function push(source, level, message, meta) {
    source = source || 'chat';
    level = level || 'info';
    message = String(message || '');
    meta = meta || {};
    var entry = {
      ts: Date.now(),
      time_zh: shanghaiTime(),
      source: source,
      level: level,
      message: message,
      meta: meta
    };
    readBuffer(function (buf) {
      buf.push(entry);
      if (buf.length > MAX_LINES) buf = buf.slice(-MAX_LINES);
      writeBuffer(buf);
    });
    // 仅本地缓冲；上报走快照 console_lines，避免每条日志再生成 telemetry 事件导致二次上报卡住
    if (source === 'chat') {
      emitChatLog('debug', { step: meta.step || 'log', message: message });
    }
    try {
      window.dispatchEvent(new CustomEvent('sg-debug-log', { detail: entry }));
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

  var SgDebugLog = {
    push: push,
    exportRecent: exportRecent
  };

  if (typeof window !== 'undefined') window.SgDebugLog = SgDebugLog;
  if (typeof self !== 'undefined') self.SgDebugLog = SgDebugLog;
})();

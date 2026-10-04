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

  var MAX_ERRORS = 50;
  var MSG_LIMIT = 4000;
  var STACK_LIMIT = 8000;

  // 板块映射：错误来源文件名 → 分板块责任归属（§A–§K）
  var BOARD_RULES = [
    { re: /(background\.js|^chrome-extension:|service[_ -]?worker)/, board: 'H', name: 'OPS 后台 / 心跳' },
    { re: /(scheduler-core|scheduler[\\/]|stage-detector|page-router|time-budget|chat-strategy|soft-risk-fallback-decision|coordinator|diag-contract)/, board: 'A', name: '调度控制面' },
    { re: /(content_follow|follow[\\/]|risk_control|push_blogger|follow-back-detect|pool-api|soft-risk)/, board: 'B', name: '关注引擎' },
    { re: /(content_chat|chat[\\/]|target-db|promo-links|chat-gates|dm-pin|inbox-watch|age-parse)/, board: 'C', name: '私信引擎' },
    { re: /(nurture|养号)/, board: 'D', name: '养号' },
    { re: /(repost|profile-clone|转帖)/, board: 'E', name: '转帖' },
    { re: /(config-sync|remote-settings|storage-keys|config\.js|soft-fill-mode|scheduler-gate)/, board: 'F', name: '配置同步' },
    { re: /(^ui[\\/]|panel\.js|follow-btn|telemetry|logger|debug-log|page-diag|test-monitor|event-catalog|obs[\\/])/, board: 'G', name: '面板与观测' },
    { re: /(challenge-guard|media-block|challenge|heal)/, board: 'K', name: '自愈 / 多开' },
    { re: /(scrm)/, board: 'J', name: 'SCRM' },
    { re: /(pool)#/i, board: 'I', name: '号池' }
  ];

  function resolveBoard(src, stack) {
    var hay = String((src || '') + ' ' + (stack || ''));
    for (var i = 0; i < BOARD_RULES.length; i++) {
      if (BOARD_RULES[i].re.test(hay)) {
        return { board: BOARD_RULES[i].board, board_name: BOARD_RULES[i].name };
      }
    }
    return { board: 'G', board_name: '面板与观测' };
  }

  function runtimeContext() {
    var ctx = {
      url: (function () { try { return window.location.href; } catch (e) { return ''; } })(),
      version: (function () {
        try { return chrome.runtime.getManifest().version; } catch (e) { return ''; }
      })(),
      handle: (function () {
        try {
          var h = localStorage.getItem('matrix_my_handle');
          if (h && h !== 'unknown') return String(h).replace(/[@#]/g, '');
          var el = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
          if (el) {
            var m = (el.href || '').match(/x\.com\/([^\/\?]+)/i);
            if (m && m[1]) return String(m[1]).toLowerCase();
          }
        } catch (e) {}
        return '';
      })()
    };
    return ctx;
  }

  function captureError(msg, src, line, col, stack) {
    try {
      var fullMsg = String(msg || 'Unknown error');
      var fullStack = String(stack || '');
      if (fullMsg.length > MSG_LIMIT) fullMsg = fullMsg.slice(0, MSG_LIMIT) + '…[trunc]';
      if (fullStack.length > STACK_LIMIT) fullStack = fullStack.slice(0, STACK_LIMIT) + '…[trunc]';
      var board = resolveBoard(src, fullStack);
      var ctx = runtimeContext();
      var entry = {
        t: Date.now(),
        msg: fullMsg,
        src: String(src || '').slice(0, 300),
        line: line || 0,
        col: col || 0,
        stack: fullStack,
        board: board.board,
        board_name: board.board_name,
        url: ctx.url,
        version: ctx.version,
        handle: ctx.handle
      };
      var raw = localStorage.getItem('sg_error_log');
      var errLog = raw ? JSON.parse(raw) : [];
      errLog.push(entry);
      if (errLog.length > MAX_ERRORS) errLog = errLog.slice(-MAX_ERRORS);
      localStorage.setItem('sg_error_log', JSON.stringify(errLog));
      try {
        if (typeof SgTelemetry !== 'undefined' && SgTelemetry.emit) {
          SgTelemetry.emit('system.logger_error', {
            msg: fullMsg,
            src: src,
            line: line,
            stack: fullStack,
            board: board.board,
            board_name: board.board_name,
            url: ctx.url,
            version: ctx.version,
            handle: ctx.handle
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

// =============================================================================
// 调度门禁 — 自动模式下「默认全关，仅调度可开」
// 规则：
//   1. isAutoMode() 时，引擎不得自行 tryAutoStart / recover
//   2. 跳页仅当本模块已被调度授权（running 旗标）或非自动模式
//   3. 调度通过 sg-*-command 写旗标后再允许该模块导航
// =============================================================================

var SchedulerGate = (function () {
  'use strict';

  var K = typeof SKeys !== 'undefined' ? SKeys : null;

  function stateKey() {
    return (K && K.LK_STATE) || 'sg_state';
  }

  function isAutoMode() {
    try {
      if (typeof window !== 'undefined' && typeof window.__sgIsAutoMode === 'function') {
        return !!window.__sgIsAutoMode();
      }
    } catch (e) {}
    try {
      return !!(JSON.parse(localStorage.getItem(stateKey()) || '{}').running);
    } catch (e2) {
      return false;
    }
  }

  /** 调度是否已授权该模块运行 */
  function isModuleOn(name) {
    try {
      if (name === 'follow') {
        var tab = sessionStorage.getItem((K && K.SK_TAB_RUNNING) || 'matrix_tab_running');
        if (tab === 'stopped_by_user' || tab === 'soft_fill') return false;
        return localStorage.getItem((K && K.LK_FOLLOW_RUNNING) || 'matrix_follow_running') === 'true';
      }
      if (name === 'chat') {
        return sessionStorage.getItem((K && K.SK_CHAT_AUTO_RUN) || 'dan_auto_run') === 'true';
      }
      if (name === 'nurture') {
        return sessionStorage.getItem((K && K.SK_NURTURE_RUNNING) || 'sg_nurture_running') === 'true';
      }
      if (name === 'repost') {
        return sessionStorage.getItem((K && K.SK_REPOST_RUNNING) || 'sg_repost_running') === 'true';
      }
    } catch (e) {}
    return false;
  }

  function isUserPaused() {
    try {
      var k = (K && K.LK_USER_PAUSED) || 'sg_user_paused';
      return localStorage.getItem(k) === '1';
    } catch (e) { return false; }
  }

  /** 用户暂停期间禁止自启；自动模式下禁止自启；手动模式允许 */
  function canSelfStart(name) {
    if (isUserPaused()) return false;
    if (!isAutoMode()) return true;
    return false;
  }

  /** 自动模式下仅已授权模块可跳页；手动模式放行 */
  function canNavigate(name) {
    if (!isAutoMode()) return true;
    return isModuleOn(name);
  }

  function isDmComposer(el) {
    if (!el || !el.closest) return false;
    try {
      if (el.closest('[data-testid="dmComposerTextInput"]')) return true;
      if (el.closest('[data-testid="dmComposerSendButton"]')) return true;
      if (el.getAttribute && String(el.getAttribute('data-testid') || '').indexOf('dmComposer') >= 0) return true;
      // 私信会话 / 抽屉内的编辑器一律不动（清空会把 Draft 标脏，跳页反弹「离开此网站？」）
      if (el.closest('[data-testid="DMDrawer"]')) return true;
      if (el.closest('[data-testid="DmActivityContainer"]')) return true;
      if (el.closest('aside[role="complementary"]')) {
        var aside = el.closest('aside[role="complementary"]');
        if (aside && aside.querySelector('[data-testid="dmComposerTextInput"]')) return true;
      }
      var path = '';
      try { path = (window.location.pathname || '').toLowerCase(); } catch (eP) {}
      if (path.indexOf('/messages') >= 0 || path.indexOf('/i/chat') >= 0) return true;
    } catch (e) {}
    return false;
  }

  /** 跳页前：只清推文回复草稿（绝不碰私信框）+ 关回复弹层 + 主世界 unload 抑制 */
  function prepareLeave() {
    try {
      document.documentElement.setAttribute('data-sg-suppress-unload', '1');
    } catch (e0) {}
    try { window.onbeforeunload = null; } catch (e4) {}

    var clearedTweetBox = false;
    try {
      // 收窄：只动推文回复框。旧版 .public-DraftEditor-content / dialog contenteditable
      // 会误伤私信输入框，清空后 React/Draft 仍标脏 → 跳私信页连环弹窗。
      var boxes = document.querySelectorAll(
        '[data-testid^="tweetTextarea_"][contenteditable="true"]'
      );
      for (var i = 0; i < boxes.length; i++) {
        var el = boxes[i];
        if (isDmComposer(el)) continue;
        try {
          el.focus();
          el.textContent = '';
          try { el.innerHTML = ''; } catch (eHtml) {}
          el.dispatchEvent(new Event('input', { bubbles: true }));
          clearedTweetBox = true;
        } catch (e1) {}
      }
    } catch (e2) {}

    // 仅在存在推文回复框时关弹层，避免关掉私信会话
    if (clearedTweetBox) {
      try {
        var replyScope =
          document.querySelector('[data-testid="tweetTextarea_0"]') &&
          (document.querySelector('[data-testid="sheetDialog"]') ||
            document.querySelector('[aria-modal="true"]') ||
            document.querySelector('[role="dialog"]'));
        if (replyScope) {
          var close =
            replyScope.querySelector('[data-testid="app-bar-close"]') ||
            document.querySelector('[data-testid="app-bar-close"]');
          if (close) close.click();
        }
      } catch (e3) {}
    }
  }

  function navMinIntervalMs() {
    try {
      var t = JSON.parse(localStorage.getItem('sg_config_thresholds') || '{}');
      var n = parseInt(t.nav_min_interval_ms, 10);
      // 4.6.101：残留 13s 旧默认当无效，抬到 45s
      if (isFinite(n) && n === 13000) return 45000;
      if (isFinite(n) && n >= 2000 && n <= 120000) return n;
    } catch (e) {}
    return 45000; // 4.6.101：30s→45s，给比特/慢网足够加载再跳
  }

  var _lastNavAt = 0;
  try {
    _lastNavAt = parseInt(sessionStorage.getItem('sg_last_nav_at') || '0', 10) || 0;
  } catch (e0) { _lastNavAt = 0; }

  var _queuedTimer = null;
  var _queuedNav = null;

  function lastNavAt() { return _lastNavAt || 0; }

  function markNav() {
    _lastNavAt = Date.now();
    try { sessionStorage.setItem('sg_last_nav_at', String(_lastNavAt)); } catch (e) {}
  }

  /** 跳页落地后引擎应等待的截止时间（防未加载完就动作） */
  function markArriveSettle(ms) {
    var wait = (typeof ms === 'number' && ms > 0) ? ms : 5000;
    try {
      sessionStorage.setItem('sg_nav_settle_until', String(Date.now() + wait));
    } catch (e) {}
  }

  function arriveSettleLeftMs() {
    try {
      var until = parseInt(sessionStorage.getItem('sg_nav_settle_until') || '0', 10) || 0;
      return Math.max(0, until - Date.now());
    } catch (e2) { return 0; }
  }

  function remainGapMs() {
    var minGap = navMinIntervalMs();
    if (!_lastNavAt) return 0;
    var since = Date.now() - _lastNavAt;
    return since < minGap ? (minGap - since) : 0;
  }

  function clearQueuedNav() {
    if (_queuedTimer) {
      try { clearTimeout(_queuedTimer); } catch (eC) {}
    }
    _queuedTimer = null;
    _queuedNav = null;
  }

  function queueNav(name, url, opts, delayMs) {
    clearQueuedNav();
    _queuedNav = { name: name || null, url: url, opts: opts || {} };
    var wait = Math.max(500, delayMs || 0);
    // 4.6.102：排队期间也占 settle，防止引擎在旧页继续跑
    markArriveSettle(wait + ((opts && opts.settleMs) || 5000));
    try {
      if (typeof Logger !== 'undefined' && Logger.info) {
        Logger.info('Gate', (name || 'raw') + ' 排队跳页 ' + Math.ceil(wait / 1000) + 's → ' + url);
      }
    } catch (eLog) {}
    _queuedTimer = setTimeout(function () {
      _queuedTimer = null;
      var q = _queuedNav;
      _queuedNav = null;
      if (!q || !q.url) return;
      var o = {};
      try {
        var src = q.opts || {};
        for (var k in src) {
          if (Object.prototype.hasOwnProperty.call(src, k)) o[k] = src[k];
        }
      } catch (eCp) {}
      o.skipThrottle = true;
      if (q.name) go(q.name, q.url, o);
      else goRaw(q.url, o);
    }, wait);
  }

  function urlsRoughlySame(a, b) {
    try {
      var x = String(a || '').split('#')[0].replace(/\/$/, '');
      var y = String(b || '').split('#')[0].replace(/\/$/, '');
      return !!x && x === y;
    } catch (e) { return false; }
  }

  function executeHref(url, opts) {
    prepareLeave();
    markNav();
    markArriveSettle((opts && opts.settleMs) || (5000 + Math.floor(Math.random() * 2000)));
    if (opts && opts.replace) window.location.replace(url);
    else window.location.href = url;
    return true;
  }

  /**
   * 无模块鉴权的节流跳页（PageRouter / 资料克隆等）。
   * force=true 且撞间隔 → 排队延后跳，返回 true（已受理）。
   */
  function goRaw(url, opts) {
    opts = opts || {};
    if (!url) return false;
    try {
      if (urlsRoughlySame(location.href, url)) {
        markNav();
        return true;
      }
    } catch (eSame) {}
    if (!opts.skipThrottle) {
      var rem = remainGapMs();
      if (rem > 0) {
        if (opts.force) {
          queueNav(null, url, opts, rem);
          return true;
        }
        try {
          if (typeof Logger !== 'undefined' && Logger.info) {
            Logger.info('Gate', 'raw 跳页节流 ' + Math.ceil(rem / 1000) + 's → ' + url);
          }
        } catch (eL) {}
        return false;
      }
    }
    try {
      return executeHref(url, opts);
    } catch (e2) {
      return false;
    }
  }

  function go(name, url, opts) {
    opts = opts || {};
    if (!url) return false;
    // #region agent log
    var __dbgMinGap = navMinIntervalMs();
    var __dbgSince = (_lastNavAt > 0) ? (Date.now() - _lastNavAt) : -1;
    // #endregion
    if (!canNavigate(name)) {
      try {
        if (typeof Logger !== 'undefined' && Logger.warn) {
          Logger.warn('Gate', name + ' 未授权，拦截跳转 → ' + url);
        } else {
          console.warn('[SchedulerGate] blocked nav', name, url);
        }
      } catch (e) {}
      // #region agent log
      fetch('http://127.0.0.1:7924/ingest/779b7217-8303-4852-a4fb-c13d7a13aca7',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'b0fa6d'},body:JSON.stringify({sessionId:'b0fa6d',runId:'pre-fix',hypothesisId:'H1_H4_H5',location:'scheduler-gate.js:go',message:'nav_blocked_auth',data:{name:String(name||''),url:String(url||'').slice(0,120),force:!!opts.force,minGap:__dbgMinGap,since:__dbgSince},timestamp:Date.now()})}).catch(function(){});
      // #endregion
      return false;
    }
    try {
      if (urlsRoughlySame(location.href, url)) {
        markNav();
        return true;
      }
    } catch (eSame) {}
    // 4.6.102：force 也吃间隔（排队延后），禁止瞬间硬跳压 CPU
    if (!opts.skipThrottle) {
      var rem = remainGapMs();
      if (rem > 0) {
        try {
          if (typeof Logger !== 'undefined' && Logger.info) {
            Logger.info('Gate', name + (opts.force ? ' Force排队 ' : ' 跳页节流 ') + Math.ceil(rem / 1000) + 's → ' + url);
          }
        } catch (eLog) {}
        // #region agent log
        fetch('http://127.0.0.1:7924/ingest/779b7217-8303-4852-a4fb-c13d7a13aca7',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'b0fa6d'},body:JSON.stringify({sessionId:'b0fa6d',runId:'pre-fix',hypothesisId:'H1_H4',location:'scheduler-gate.js:go',message:opts.force ? 'nav_force_queued' : 'nav_throttled',data:{name:String(name||''),url:String(url||'').slice(0,120),force:!!opts.force,minGap:__dbgMinGap,since:__dbgSince,remain:rem},timestamp:Date.now()})}).catch(function(){});
        // #endregion
        if (opts.force) {
          queueNav(name, url, opts, rem);
          return true;
        }
        return false;
      }
    }
    try {
      // #region agent log
      fetch('http://127.0.0.1:7924/ingest/779b7217-8303-4852-a4fb-c13d7a13aca7',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'b0fa6d'},body:JSON.stringify({sessionId:'b0fa6d',runId:'pre-fix',hypothesisId:'H1_H4_H5',location:'scheduler-gate.js:go',message:'nav_execute',data:{name:String(name||''),url:String(url||'').slice(0,120),force:!!opts.force,minGap:__dbgMinGap,since:__dbgSince,path:(function(){try{return location.pathname;}catch(e){return'';}})()},timestamp:Date.now()})}).catch(function(){});
      // #endregion
      return executeHref(url, opts);
    } catch (e2) {
      return false;
    }
  }

  function blockReloadInAuto(reason) {
    if (!isAutoMode()) return false;
    try {
      console.warn('[SchedulerGate] auto mode: skip reload —', reason || '');
    } catch (e) {}
    return true;
  }

  var api = {
    isAutoMode: isAutoMode,
    isUserPaused: isUserPaused,
    isModuleOn: isModuleOn,
    canSelfStart: canSelfStart,
    canNavigate: canNavigate,
    prepareLeave: prepareLeave,
    go: go,
    goRaw: goRaw,
    blockReloadInAuto: blockReloadInAuto,
    lastNavAt: lastNavAt,
    navMinIntervalMs: navMinIntervalMs,
    markNav: markNav,
    markArriveSettle: markArriveSettle,
    arriveSettleLeftMs: arriveSettleLeftMs,
    remainGapMs: remainGapMs
  };

  if (typeof window !== 'undefined') window.SchedulerGate = api;
  return api;
})();

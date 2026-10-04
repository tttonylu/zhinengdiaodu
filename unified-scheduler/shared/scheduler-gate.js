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
      if (isFinite(n) && n >= 2000 && n <= 120000) return n;
    } catch (e) {}
    return 30000; // 4.6.23：13s→30s，减少连环跳转/握手数
  }

  var _lastNavAt = 0;
  try {
    _lastNavAt = parseInt(sessionStorage.getItem('sg_last_nav_at') || '0', 10) || 0;
  } catch (e0) { _lastNavAt = 0; }

  function lastNavAt() { return _lastNavAt || 0; }

  function markNav() {
    _lastNavAt = Date.now();
    try { sessionStorage.setItem('sg_last_nav_at', String(_lastNavAt)); } catch (e) {}
  }

  function urlsRoughlySame(a, b) {
    try {
      var x = String(a || '').split('#')[0].replace(/\/$/, '');
      var y = String(b || '').split('#')[0].replace(/\/$/, '');
      return !!x && x === y;
    } catch (e) { return false; }
  }

  function go(name, url, opts) {
    opts = opts || {};
    if (!url) return false;
    if (!canNavigate(name)) {
      try {
        if (typeof Logger !== 'undefined' && Logger.warn) {
          Logger.warn('Gate', name + ' 未授权，拦截跳转 → ' + url);
        } else {
          console.warn('[SchedulerGate] blocked nav', name, url);
        }
      } catch (e) {}
      return false;
    }
    try {
      if (urlsRoughlySame(location.href, url)) {
        markNav();
        return true;
      }
    } catch (eSame) {}
    // 慢网多号：整页跳最小间隔，避免 SPA 未就绪连环跳
    if (!opts.force && isAutoMode()) {
      var minGap = navMinIntervalMs();
      var since = Date.now() - (_lastNavAt || 0);
      if (_lastNavAt > 0 && since < minGap) {
        try {
          if (typeof Logger !== 'undefined' && Logger.info) {
            Logger.info('Gate', name + ' 跳页节流 ' + Math.ceil((minGap - since) / 1000) + 's → ' + url);
          }
        } catch (eLog) {}
        return false;
      }
    }
    try {
      prepareLeave();
      markNav();
      if (opts.replace) window.location.replace(url);
      else window.location.href = url;
      return true;
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
    blockReloadInAuto: blockReloadInAuto,
    lastNavAt: lastNavAt,
    navMinIntervalMs: navMinIntervalMs,
    markNav: markNav
  };

  if (typeof window !== 'undefined') window.SchedulerGate = api;
  return api;
})();

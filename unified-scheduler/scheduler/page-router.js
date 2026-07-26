(function () {
  'use strict';

  var K = SKeys;

  var _lastJumpAt = 0;
  var _jumpCount = 0;

  function getMyHandle() {
    var h = localStorage.getItem(K.LK_MY_HANDLE);
    if (h) return h.replace('@', '').replace('#guard', '').toLowerCase();
    var el = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    if (el && el.href) { h = el.href.split('/').pop().toLowerCase(); return h; }
    return 'unknown';
  }

  function getCurrentBlogger() {
    return (localStorage.getItem(K.LK_CURRENT_CREATOR) || '').toLowerCase();
  }

  function fromUrl(url) {
    var parsed = url || window.location.href;
    var myH = getMyHandle();
    if (myH === 'unknown') return 'none';

    if (parsed.indexOf('/' + myH + '/followers') >= 0) return 'chat';

    var blogger = getCurrentBlogger();
    if (blogger && parsed.indexOf('/' + blogger + '/followers') >= 0) return 'follow';

    var lower = parsed.toLowerCase();
    if (lower.indexOf('/home') >= 0 || lower.indexOf('/explore') >= 0 || lower.indexOf('/i/trend') >= 0) return 'nurture';

    var xDomain = lower.indexOf('x.com') >= 0 || lower.indexOf('twitter.com') >= 0;
    if (xDomain) {
      if (lower.match(/\/[\w]+\/followers$/) && blogger && lower.indexOf('/' + blogger + '/') >= 0) return 'follow';
      if (lower.match(/\/[\w]+\/followers$/) && lower.indexOf('/' + myH + '/') >= 0) return 'chat';
      return 'nurture';
    }

    return 'none';
  }

  function homeUrlFor(moduleName) {
    var myH = getMyHandle();
    switch (moduleName) {
      case 'follow':
        var blogger = getCurrentBlogger();
        return 'https://x.com/' + (blogger || myH) + '/followers';
      case 'chat':
        return 'https://x.com/' + myH + '/followers?_t=' + Date.now();
      case 'nurture':
        return 'https://x.com/home';
      case 'none':
        return '';
      default:
        return 'https://x.com/' + myH;
    }
  }

  function canHandoverTo(moduleName, url) {
    var targetUrl = homeUrlFor(moduleName);
    if (!targetUrl) return false;
    return targetUrl.indexOf('/') >= 0;
  }

  function jumpTo(targetUrl) {
    if (!targetUrl) return false;
    var now = Date.now();
    if (now - _lastJumpAt > 2000) {
      _jumpCount = 0;
    }
    _jumpCount++;
    _lastJumpAt = now;
    if (_jumpCount > 3) {
      Logger.warn('PageRouter', '3次连续跳页, 进入180s冷却');
      sessionStorage.setItem(K.SK_PAUSED_TILL, String(Date.now() + 180000));
      return false;
    }
    window.location.href = targetUrl;
    return true;
  }

  function alignIfDrifted() {
    var stage = null;
    try {
      stage = JSON.parse(localStorage.getItem(K.LK_STATE) || '{}').stage;
    } catch (e) {}

    if (!stage) return false;

    var policy = null;
    try {
      policy = JSON.parse(localStorage.getItem('sg_stage_policy') || 'null');
    } catch (e) {}

    if (!policy || !policy.stages || !policy.stages[stage]) return false;

    var priority = policy.stages[stage].priority;
    if (!priority || priority.length === 0) return false;

    var desiredOwner = priority[0];
    var pageOwner = fromUrl();

    if (pageOwner !== desiredOwner && pageOwner !== 'none') {
      Logger.warn('PageRouter', '漂移检测: ' + pageOwner + ' -> ' + desiredOwner);
      return jumpTo(homeUrlFor(desiredOwner));
    }

    return false;
  }

  var PageRouter = { fromUrl: fromUrl, homeUrlFor: homeUrlFor, jumpTo: jumpTo, canHandoverTo: canHandoverTo, alignIfDrifted: alignIfDrifted };
  if (typeof window !== 'undefined') { window.PageRouter = PageRouter; }
  if (typeof self !== 'undefined') { self.PageRouter = PageRouter; }
})();

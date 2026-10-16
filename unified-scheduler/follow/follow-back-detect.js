// =============================================================================
// 回关检测：A1 被动（通知 SPA + 观察器 + 自粉列表）+ A2 轻量主动扫通知
// 入库仍由 OPS 过滤「须本账号曾关注」
// =============================================================================
(function () {
  'use strict';
  if (window.__sg_follow_back_detect__) return;
  window.__sg_follow_back_detect__ = true;

  var DEDUPE_KEY = 'sg_follow_back_notified';
  var HOLD_KEY = 'sg_fb_scan_hold';
  var TRIP_KEY = 'sg_fb_scan_trip';
  var LAST_ACTIVE_KEY = 'sg_fb_last_active_scan_at';
  var CFG_ENABLE_KEY = 'sg_fb_active_scan';
  var CFG_INTERVAL_KEY = 'sg_fb_active_scan_min';

  var DEFAULT_INTERVAL_MIN = 240;
  var _notifObserver = null;
  var _scanTimer = null;
  var _lastPath = '';
  var _passiveFollowersAt = 0;

  function myHandle() {
    try {
      var h = localStorage.getItem('matrix_my_handle') || '';
      return String(h).replace(/^@/, '').toLowerCase().trim();
    } catch (e) {
      return '';
    }
  }

  function loadDedupe() {
    try {
      return JSON.parse(sessionStorage.getItem(DEDUPE_KEY) || '{}') || {};
    } catch (e) {
      return {};
    }
  }

  function saveDedupe(map) {
    try {
      var keys = Object.keys(map);
      if (keys.length > 400) {
        var trimmed = {};
        keys.slice(-300).forEach(function (k) { trimmed[k] = map[k]; });
        map = trimmed;
      }
      sessionStorage.setItem(DEDUPE_KEY, JSON.stringify(map));
    } catch (e) {}
  }

  function isReservedPath(h) {
    return !h || /^(i|home|explore|notifications|messages|settings|search|compose|login|signup|intent|hashtag|tos|privacy)$/i.test(h);
  }

  function extractHandlesFromNotifications() {
    var found = [];
    var seen = {};
    var me = myHandle();
    var cells = document.querySelectorAll('[data-testid="notification"]');
    if (!cells.length) {
      cells = document.querySelectorAll('article, [data-testid="cellInnerDiv"]');
    }
    var reFollow = /followed you|フォローしました|关注了你|開始關注你|started following you/i;
    cells.forEach(function (cell) {
      var text = (cell.innerText || cell.textContent || '');
      if (!reFollow.test(text)) return;
      var links = cell.querySelectorAll('a[href^="/"]');
      for (var i = 0; i < links.length; i++) {
        var href = links[i].getAttribute('href') || '';
        var m = href.match(/^\/([A-Za-z0-9_]{1,40})(?:\/|$|\?)/);
        if (!m) continue;
        var h = m[1].toLowerCase();
        if (isReservedPath(h)) continue;
        if (me && h === me) continue; // 过滤自身
        if (seen[h]) continue;
        seen[h] = true;
        found.push(h);
      }
    });
    return found;
  }

  function reportFollowBack(handle, via) {
    var bot = myHandle();
    if (!bot || !handle) return;
    if (String(handle).toLowerCase() === bot) return;
    try {
      chrome.runtime.sendMessage({
        action: 'ops_activity_report',
        payload: {
          account_handle: '@' + bot + '#guard',
          target_handle: handle,
          action_type: 'follow_back',
          result: 'success',
          source: 'plugin',
          meta: { via: via || 'notifications' }
        }
      }, function () {});
    } catch (e) {}
  }

  function scanNotificationsPage(via) {
    if (!/\/notifications/i.test(location.pathname || '')) return 0;
    var dedupe = loadDedupe();
    var handles = extractHandlesFromNotifications();
    var n = 0;
    handles.forEach(function (h) {
      if (dedupe[h]) return;
      dedupe[h] = Date.now();
      reportFollowBack(h, via || 'notifications');
      n += 1;
    });
    if (n) saveDedupe(dedupe);
    if (n) console.log('[回关检测] 通知上报', n, '个 via=' + (via || 'notifications'));
    return n;
  }

  function extractFollowerHandles() {
    var found = [];
    var seen = {};
    var cells = document.querySelectorAll('[data-testid="UserCell"]');
    for (var i = 0; i < cells.length; i++) {
      var link = cells[i].querySelector('a[href^="/"]');
      if (!link) continue;
      var href = link.getAttribute('href') || '';
      var m = href.match(/^\/([A-Za-z0-9_]{1,40})(?:\/|$|\?)/);
      if (!m) continue;
      var h = m[1].toLowerCase();
      if (isReservedPath(h) || seen[h]) continue;
      seen[h] = true;
      found.push(h);
    }
    return found;
  }

  function onOwnFollowersPage() {
    var me = myHandle();
    if (!me) return false;
    var p = (location.pathname || '').toLowerCase();
    return p.indexOf('/' + me + '/followers') === 0;
  }

  function scanOwnFollowersPassive() {
    if (!onOwnFollowersPage()) return;
    var now = Date.now();
    if (now - _passiveFollowersAt < 8000) return;
    _passiveFollowersAt = now;
    var list = extractFollowerHandles();
    if (!list.length) return;
    if (window.SgFollowBack && typeof window.SgFollowBack.reportFromFollowers === 'function') {
      window.SgFollowBack.reportFromFollowers(list);
    }
  }

  function stopNotifObserver() {
    if (_notifObserver) {
      try { _notifObserver.disconnect(); } catch (e) {}
      _notifObserver = null;
    }
    if (_scanTimer) {
      clearInterval(_scanTimer);
      _scanTimer = null;
    }
  }

  function startNotifObserver() {
    stopNotifObserver();
    scanNotificationsPage('notifications_enter');
    var root = document.querySelector('main') || document.body;
    if (root && typeof MutationObserver !== 'undefined') {
      var debounce = null;
      _notifObserver = new MutationObserver(function () {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(function () {
          scanNotificationsPage('notifications_mut');
        }, 1200);
      });
      try {
        _notifObserver.observe(root, { childList: true, subtree: true });
      } catch (eObs) {}
    }
    _scanTimer = setInterval(function () {
      if (!/\/notifications/i.test(location.pathname || '')) {
        stopNotifObserver();
        return;
      }
      scanNotificationsPage('notifications_tick');
    }, 10000);
  }

  function onRouteMaybe() {
    var path = location.pathname || '';
    if (path === _lastPath) return;
    var prev = _lastPath;
    _lastPath = path;
    if (/\/notifications/i.test(path)) {
      startNotifObserver();
      maybeFinishActiveTrip();
    } else if (/\/notifications/i.test(prev)) {
      stopNotifObserver();
    }
    if (onOwnFollowersPage()) scanOwnFollowersPassive();
  }

  function hookSpaNavigation() {
    try {
      var wrap = function (fnName) {
        var orig = history[fnName];
        if (typeof orig !== 'function' || orig.__sg_fb_hooked) return;
        var wrapped = function () {
          var ret = orig.apply(this, arguments);
          setTimeout(onRouteMaybe, 50);
          setTimeout(onRouteMaybe, 800);
          return ret;
        };
        wrapped.__sg_fb_hooked = true;
        history[fnName] = wrapped;
      };
      wrap('pushState');
      wrap('replaceState');
    } catch (e) {}
    window.addEventListener('popstate', function () {
      setTimeout(onRouteMaybe, 50);
      setTimeout(onRouteMaybe, 800);
    });
  }

  function moduleRunning(name) {
    try {
      var raw = sessionStorage.getItem('sg_module_' + name);
      if (raw) {
        var o = JSON.parse(raw);
        if (o && o.running === true) return true;
      }
    } catch (e) {}
    try {
      if (name === 'follow' && localStorage.getItem('matrix_follow_running') === 'true') {
        if (sessionStorage.getItem('matrix_tab_running') !== 'stopped_by_user') return true;
      }
      if (name === 'chat' && sessionStorage.getItem('dan_auto_run') === 'true') return true;
    } catch (e2) {}
    return false;
  }

  function activeScanEnabled() {
    try {
      return localStorage.getItem(CFG_ENABLE_KEY) !== '0';
    } catch (e) {
      return true;
    }
  }

  function activeScanIntervalMs() {
    var min = DEFAULT_INTERVAL_MIN;
    try {
      var v = parseInt(localStorage.getItem(CFG_INTERVAL_KEY) || '', 10);
      // 允许 10–480 分；默认 240（一天约几次通知扫）
      if (!isNaN(v) && v >= 10) min = Math.min(480, v);
    } catch (e) {}
    return min * 60 * 1000;
  }

  function lastActiveScanAt() {
    try {
      return parseInt(localStorage.getItem(LAST_ACTIVE_KEY) || '0', 10) || 0;
    } catch (e) {
      return 0;
    }
  }

  /** 首次安装/无记录：写入 now，避免加载后几十秒就跳通知 */
  function seedLastActiveScanIfNeeded() {
    try {
      var cur = localStorage.getItem(LAST_ACTIVE_KEY);
      if (cur == null || cur === '' || cur === '0') {
        localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now()));
      }
    } catch (e) {}
  }

  function setHold(on) {
    try {
      if (on) sessionStorage.setItem(HOLD_KEY, '1');
      else sessionStorage.removeItem(HOLD_KEY);
    } catch (e) {}
  }

  function readTrip() {
    try {
      return JSON.parse(sessionStorage.getItem(TRIP_KEY) || 'null');
    } catch (e) {
      return null;
    }
  }

  function clearTrip() {
    try { sessionStorage.removeItem(TRIP_KEY); } catch (e) {}
  }

  function softScrollNotifications() {
    try {
      window.scrollBy(0, Math.floor(400 + Math.random() * 400));
    } catch (e) {}
  }

  function finishActiveTrip() {
    var trip = readTrip();
    setHold(false);
    clearTrip();
    try {
      localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now()));
    } catch (e) {}
    var ret = (trip && trip.returnTo) || 'https://x.com/home';
    // 避免回到通知自己
    if (/\/notifications/i.test(ret)) ret = 'https://x.com/home';
    console.log('[回关检测] 主动扫完成，返回', ret);
    try {
      if (typeof SchedulerGate !== 'undefined' && SchedulerGate.prepareLeave) {
        SchedulerGate.prepareLeave();
      }
    } catch (e2) {}
    setTimeout(function () {
      try {
        if (typeof SchedulerGate !== 'undefined' && SchedulerGate.go) {
          SchedulerGate.go('follow', ret);
        } else {
          window.location.href = ret;
        }
      } catch (e3) {}
    }, 2500);
  }

  function maybeFinishActiveTrip() {
    var trip = readTrip();
    if (!trip || !trip.startedAt) return;
    // 超时保护：超过 90s 强制回
    if (Date.now() - trip.startedAt > 90000) {
      console.warn('[回关检测] 主动扫超时，强制返回');
      finishActiveTrip();
      return;
    }
    if (trip.finishing) return;
    trip.finishing = true;
    try { sessionStorage.setItem(TRIP_KEY, JSON.stringify(trip)); } catch (e) {}

    setTimeout(function () {
      scanNotificationsPage('active_trip');
      softScrollNotifications();
      setTimeout(function () {
        scanNotificationsPage('active_trip_scroll');
        finishActiveTrip();
      }, 2500);
    }, 2200);
  }

  function canStartActiveTrip() {
    if (!activeScanEnabled()) return false;
    if (!myHandle()) return false;
    // 养号也是主任务：跑着时禁止抢页（否则 hold 空转 + 总跳通知）
    if (moduleRunning('follow') || moduleRunning('chat') || moduleRunning('nurture')) return false;
    if (/\/messages|\/i\/chat/i.test(location.pathname || '')) return false;
    if (/\/notifications/i.test(location.pathname || '')) return false;
    // 已在行程中
    if (readTrip()) return false;
    if (sessionStorage.getItem(HOLD_KEY) === '1') return false;
    var elapsed = Date.now() - lastActiveScanAt();
    if (elapsed < activeScanIntervalMs()) return false;
    return true;
  }

  /** 行程已离开通知页 / 从未到达：尽快清 hold，避免养号被 sg_fb_scan_hold 锁死 */
  function cleanupOrphanTrip(reason) {
    var trip = readTrip();
    var holdOn = false;
    try { holdOn = sessionStorage.getItem(HOLD_KEY) === '1'; } catch (eH) {}
    if (!trip && !holdOn) return false;
    var onNotif = /\/notifications/i.test(location.pathname || '');
    if (onNotif && trip) return false; // 正常扫，交给 maybeFinish
    var age = trip && trip.startedAt ? (Date.now() - trip.startedAt) : 0;
    // 给跳转留足加载（对齐 nav_min_interval）；超时仍非通知页 → 残留
    if (trip && age > 0 && age < 45000) return false;
    console.warn('[回关检测] 行程残留清理', reason || 'orphan', 'age=' + Math.round(age / 1000) + 's path=' + (location.pathname || ''));
    setHold(false);
    clearTrip();
    return true;
  }

  function startActiveTrip() {
    if (!canStartActiveTrip()) return false;
    var returnTo = location.href || 'https://x.com/home';
    try {
      sessionStorage.setItem(TRIP_KEY, JSON.stringify({
        returnTo: returnTo,
        startedAt: Date.now(),
        finishing: false
      }));
    } catch (e) {
      return false;
    }
    setHold(true);
    console.log('[回关检测] 主动扫通知页…');
    try {
      if (typeof SchedulerGate !== 'undefined' && SchedulerGate.go) {
        var ok = SchedulerGate.go('follow', 'https://x.com/notifications');
        if (ok) return true;
        // 节流未放行：延后到间隔后再跳，禁止裸 href 绕过
        var gap = 45000;
        try { gap = SchedulerGate.navMinIntervalMs() || 45000; } catch (eG) {}
        var last = 0;
        try { last = SchedulerGate.lastNavAt() || 0; } catch (eL) {}
        var wait = Math.max(2000, gap - (Date.now() - last));
        setTimeout(function () {
          try {
            if (typeof SchedulerGate !== 'undefined' && SchedulerGate.go) {
              SchedulerGate.go('follow', 'https://x.com/notifications', { force: true });
            } else {
              window.location.href = 'https://x.com/notifications';
            }
          } catch (e4) {
            setHold(false);
            clearTrip();
          }
        }, wait);
        return true;
      }
    } catch (e2) {}
    try {
      window.location.href = 'https://x.com/notifications';
    } catch (e3) {
      setHold(false);
      clearTrip();
      return false;
    }
    return true;
  }

  function activeScanTick() {
    // 页面已在行程目的地：由 maybeFinishActiveTrip 收尾
    if (readTrip() && /\/notifications/i.test(location.pathname || '')) {
      maybeFinishActiveTrip();
      return;
    }
    cleanupOrphanTrip('tick');
    if (canStartActiveTrip()) startActiveTrip();
    if (onOwnFollowersPage()) scanOwnFollowersPassive();
  }

  // 主路径：私信模块 syncFanScanToBackend → reportFromFollowers
  window.SgFollowBack = {
    reportFromFollowers: function (handles) {
      var bot = myHandle();
      if (!bot || !handles || !handles.length) return;
      var list = handles.map(function (h) {
        return String(h || '').replace(/^@/, '').toLowerCase().trim();
      }).filter(Boolean);
      if (!list.length) return;
      try {
        chrome.runtime.sendMessage({
          action: 'ops_follow_back_from_followers',
          payload: {
            account_handle: '@' + bot + '#guard',
            handles: list
          }
        }, function (r) {
          if (r && r.ok && r.marked) {
            console.log('[回关检测] 粉丝交叉标记', r.marked, '/', r.candidates);
          }
        });
      } catch (e) {}
    },
    scanNotifications: scanNotificationsPage,
    startActiveScan: startActiveTrip,
    isHold: function () {
      try { return sessionStorage.getItem(HOLD_KEY) === '1'; } catch (e) { return false; }
    }
  };

  // ---- boot ----
  seedLastActiveScanIfNeeded();
  hookSpaNavigation();
  _lastPath = location.pathname || '';
  // 立刻清一次残留 hold（常见：跳通知失败/被拽回 home，养号锁死）
  cleanupOrphanTrip('boot');
  setInterval(function () { if (document.hidden) return; cleanupOrphanTrip('watch'); }, 5000);
  if (/\/notifications/i.test(_lastPath)) {
    setTimeout(function () {
      startNotifObserver();
      maybeFinishActiveTrip();
    }, 2000);
  } else if (onOwnFollowersPage()) {
    setTimeout(scanOwnFollowersPassive, 2500);
  }

  // 主动扫心跳（抖动，避免多标签整齐跳）；首次已 seed lastActive，需等满间隔
  var bootDelay = 45000 + Math.floor(Math.random() * 30000);
  setTimeout(function () {
    activeScanTick();
    setInterval(activeScanTick, 60000);
  }, bootDelay);
})();

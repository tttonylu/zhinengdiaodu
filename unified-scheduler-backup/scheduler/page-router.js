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

    // 资料克隆占页：源号主页 /settings/profile 归 profile_clone，防漂移拽走
    try {
      // 优先走 ProfileClone.isRunning（会清幽灵旗）；勿只信残留 session 键
      if (typeof ProfileClone !== 'undefined' && ProfileClone.isRunning && ProfileClone.isRunning()) {
        return 'profile_clone';
      }
      if (sessionStorage.getItem((K.SK_PROFILE_CLONE_RUNNING) || 'sg_profile_clone_running') === 'true' ||
          (typeof EngineUtils !== 'undefined' && EngineUtils.isRunning && EngineUtils.isRunning('profile_clone'))) {
        return 'profile_clone';
      }
    } catch (ePc) {}

    // 转帖活跃时，来源博主主页归 repost，避免被养号拽回 /home
    try {
      if (sessionStorage.getItem('sg_repost_running') === 'true' ||
          (typeof EngineUtils !== 'undefined' && EngineUtils.isActive && EngineUtils.isActive('repost'))) {
        var rh = '';
        try { rh = (localStorage.getItem('sg_repost_current') || '').toLowerCase(); } catch (eR) {}
        if (rh) {
          var low = parsed.toLowerCase();
          if (low.indexOf('x.com/' + rh) >= 0 || low.indexOf('twitter.com/' + rh) >= 0) {
            if (low.indexOf('/followers') < 0 && low.indexOf('/following') < 0) return 'repost';
          }
        }
        // 无 current 时任意非自己/非系统页也暂认 repost，防止 nurture 抢页
        if (!/\/(home|explore|notifications|messages|i\/|i\/chat)/i.test(parsed)) {
          var pathM = parsed.match(/https?:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]+)/i);
          if (pathM && pathM[1] && pathM[1].toLowerCase() !== myH) return 'repost';
        }
      }
    } catch (eRep) {}

    if (parsed.indexOf('/' + myH + '/followers') >= 0) return 'chat';
    if (parsed.indexOf('/messages') >= 0 || parsed.indexOf('/i/chat') >= 0) return 'chat';

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
        try {
          var sgChat = JSON.parse(localStorage.getItem('sg_state') || '{}');
          var todayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
          var inboxSec = (sgChat.chatDate === todayKey) ? (sgChat.chatInboxToday || 0) : 0;
          var debt = 0;
          try {
            var root = JSON.parse(localStorage.getItem('chat_target_db') || '{}');
            var bucket = root[myH];
            if (bucket && typeof bucket === 'object' && bucket.round === undefined) {
              for (var dk in bucket) {
                var de = bucket[dk];
                if (!de || de.done) continue;
                var dr = de.round || 0;
                if (dr === 1 || dr === 2) debt++;
              }
            }
          } catch (eDebt) {}
          if (debt > 0 && inboxSec < 120 * 60) return 'https://x.com/i/chat';
        } catch (eChat) {}
        return 'https://x.com/' + myH + '/followers';
      case 'nurture':
        return 'https://x.com/home';
      case 'repost':
        var rh2 = '';
        try { rh2 = (localStorage.getItem('sg_repost_current') || '').toLowerCase(); } catch (e) {}
        if (!rh2) {
          try {
            var list = JSON.parse(localStorage.getItem('sg_repost_targets') || '[]');
            if (list && list[0]) rh2 = String(list[0]).replace(/^@/, '').toLowerCase();
          } catch (e2) {}
        }
        return rh2 ? ('https://x.com/' + rh2) : 'https://x.com/home';
      case 'profile_clone':
        try {
          var jobPc = JSON.parse(sessionStorage.getItem(K.SK_PROFILE_CLONE_JOB || 'sg_profile_clone_job') || 'null');
          if (jobPc && jobPc.step === 'apply') return 'https://x.com/settings/profile';
          if (jobPc && jobPc.source) return 'https://x.com/' + String(jobPc.source).replace(/^@/, '');
        } catch (ePcU) {}
        return 'https://x.com/settings/profile';
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
      var stallSec = 180;
      try {
        var raw = localStorage.getItem('sg_stall_cooldown_sec');
        if (raw) stallSec = parseInt(raw, 10) || 180;
        else {
          var t = JSON.parse(localStorage.getItem('sg_config_thresholds') || '{}');
          if (t.stage_stall_cooldown_sec != null) stallSec = parseInt(t.stage_stall_cooldown_sec, 10) || 180;
        }
      } catch (eStall) {}
      stallSec = Math.max(30, stallSec);
      Logger.warn('PageRouter', '3次连续跳页, 进入' + stallSec + 's冷却');
      sessionStorage.setItem(K.SK_PAUSED_TILL, String(Date.now() + stallSec * 1000));
      return false;
    }
    try {
      if (typeof SchedulerGate !== 'undefined' && SchedulerGate.prepareLeave) SchedulerGate.prepareLeave();
    } catch (ePrep) {}
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

    if (pageOwner === 'profile_clone' || pageOwner === 'repost') return false;
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

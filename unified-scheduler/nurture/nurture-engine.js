// =============================================================================
// 智能调度 — 养号引擎（独立模块）
// 每小时预算制：点赞/评论/转发/看趋势/进主页
// 动作间隔10~20秒，避开广告内容，匹配推文内容选评论
// 受调度器命令控制：sg_nurture_start / sg_nurture_stop / sg_nurture_pause
// =============================================================================

(function () {
  'use strict';

  if (window.NurtureEngine) return;

  var NAME = 'nurture';
  var tickTimer = null;
  var wdTimer = null;

  // ==================== 工具 ====================
  function gapMs() {
    var cfg = NurtureConfig ? NurtureConfig.getCfg() : {};
    var g = cfg.actionGapSec || { min: 10, max: 20 };
    return (g.min + Math.random() * (g.max - g.min)) * 1000;
  }

  function emitStatus() {
    try {
      var st = NurtureTracker ? NurtureTracker.getStats() : {};
      window.dispatchEvent(new CustomEvent('matrix-nurture-log', { detail: {
        running: EngineUtils.isActive(NAME),
        stats: st,
      }}));
    } catch (e) {}
  }

  function activeHoursCfg() {
    var cfg = NurtureConfig ? NurtureConfig.getCfg() : {};
    return cfg.activeHours || { start: { hour: 8, minute: 0 }, end: { hour: 23, minute: 0 } };
  }

  function isInActiveHours() {
    var ah = activeHoursCfg();
    var s = new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour12: false });
    var m = s.match(/(\d+):(\d+)/);
    if (!m) return true;
    var now = parseInt(m[1]) * 60 + parseInt(m[2]);
    var start = ah.start.hour * 60 + ah.start.minute;
    var end = ah.end.hour * 60 + ah.end.minute;
    return now >= start && now < end;
  }

  // ==================== 广告检测 ====================
  function isAdTweet(el) {
    if (!el) return true;
    var txt = (el.innerText || '').toLowerCase();
    if (txt.includes('promoted')) return true;
    if (txt.includes('プロモーション')) return true;
    if (txt.includes('広告')) return true;
    var badges = el.querySelectorAll('[data-testid="badge"]');
    for (var i = 0; i < badges.length; i++) {
      if ((badges[i].innerText || '').toLowerCase().includes('ad')) return true;
    }
    return false;
  }

  function getVisibleTweet() {
    var articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    var valid = articles.filter(function (a) {
      if (isAdTweet(a)) return false;
      var rect = a.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.top > 0 && rect.top < window.innerHeight;
    });
    if (valid.length === 0) return null;
    return valid[Math.floor(Math.random() * valid.length)];
  }

  // ==================== DOM 操作函数 ====================
  function clickLike() {
    var tweet = getVisibleTweet();
    if (!tweet) return false;
    var btn = tweet.querySelector('[data-testid="like"]');
    if (!btn) return false;
    var label = btn.getAttribute('aria-label') || '';
    if (label.includes('Liked') || label.includes('いいねを取り消す')) return false;
    try {
      btn.click();
      NurtureTracker.didOne('likes');
      EngineUtils.ping(NAME);
      var likeStats = NurtureTracker.getStats();
      Logger.info('养号', '点赞 (' + (likeStats.daily.used.likes || 0) + '/' + (likeStats.daily.budget.likes || 0) + ')');
      emitStatus();
      return true;
    } catch (e) { return false; }
  }

  function postComment() {
    if (!NurtureTracker.canDo('comments')) return false;
    var tweet = getVisibleTweet();
    if (!tweet) return false;
    var replyBtn = tweet.querySelector('[data-testid="reply"]');
    if (!replyBtn) return false;
    replyBtn.click();

    setTimeout(function () {
      var input = document.querySelector('[data-testid="tweetTextarea_0"]') ||
                  document.querySelector('[role="textbox"][aria-label*="回复" i]');
      if (!input) return;
      var comment = NurtureComments.pick(tweet);
      if (!comment) return;
      try {
        input.focus();
        if (document.execCommand) {
          document.execCommand('insertText', false, comment);
        } else {
          input.textContent = comment;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        NurtureTracker.didOne('comments');
        EngineUtils.ping(NAME);
        var cmtStats = NurtureTracker.getStats();
        Logger.info('养号', '评论(' + (cmtStats.daily.used.comments || 0) + '/' + (cmtStats.daily.budget.comments || 0) + '): ' + comment);
        emitStatus();
      } catch (e) {}
    }, 1000);
    return true;
  }

  function repostTweet() {
    if (!NurtureTracker.canDo('reposts')) return false;
    var tweet = getVisibleTweet();
    if (!tweet) return false;
    var btn = tweet.querySelector('[data-testid="retweet"]');
    if (!btn) return false;
    try {
      // 点击 retweet 打开菜单
      btn.click();
      NurtureTracker.didOne('reposts');
      EngineUtils.ping(NAME);
      var rpStats = NurtureTracker.getStats();
      Logger.info('养号', '转发 (' + (rpStats.daily.used.reposts || 0) + '/' + (rpStats.daily.budget.reposts || 0) + ')');
      emitStatus();
      // Twitter 弹出下拉菜单，等待后点击"转推"确认
      setTimeout(function () {
        var confirm = document.querySelector('[data-testid="Dropdown"] [role="menuitem"]:first-child');
        if (!confirm) confirm = document.querySelector('[data-testid="retweetConfirm"]');
        if (confirm) confirm.click();
        // 如果出现"引用"弹窗，点 X 关闭
        setTimeout(function () {
          var close = document.querySelector('[aria-label="关闭" i]') || document.querySelector('[data-testid="app-bar-close"]');
          if (close) close.click();
        }, 300);
      }, 500);
      return true;
    } catch (e) { return false; }
  }

  function viewTrends() {
    if (!NurtureTracker.canDo('trends')) return false;
    var trendEl = document.querySelector('[data-testid="trend"]') ||
                  document.querySelector('a[href*="/i/trends"]');
    if (!trendEl) return false;
    try {
      trendEl.click();
      NurtureTracker.didOne('trends');
      EngineUtils.ping(NAME);
      var trStats = NurtureTracker.getStats();
      Logger.info('养号', '看趋势 (' + (trStats.daily.used.trends || 0) + '/' + (trStats.daily.budget.trends || 0) + ')');
      emitStatus();
      setTimeout(function () { window.scrollBy(0, 300); }, 2000);
      setTimeout(function () { window.history.back(); }, 8000);
      return true;
    } catch (e) { return false; }
  }

  function visitProfile() {
    if (!NurtureTracker.canDo('profiles')) return false;
    var tweet = getVisibleTweet();
    if (!tweet) return false;
    var links = tweet.querySelectorAll('a[role="link"][href^="/"]');
    var profileLink = null;
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href');
      if (!href) continue;
      if (href.includes('/status/') || href.includes('/hashtag/') || href.includes('/i/')) continue;
      if (href.split('/').filter(Boolean).length === 1) { profileLink = links[i]; break; }
    }
    if (!profileLink) return false;
    try {
      profileLink.click();
      NurtureTracker.didOne('profiles');
      EngineUtils.ping(NAME);
      var pfStats = NurtureTracker.getStats();
      Logger.info('养号', '进主页 (' + (pfStats.daily.used.profiles || 0) + '/' + (pfStats.daily.budget.profiles || 0) + ')');
      emitStatus();
      setTimeout(function () { window.history.back(); }, 5000);
      return true;
    } catch (e) { return false; }
  }

  function scrollRandomly() {
    var dir = Math.random() > 0.3 ? 1 : -0.5;
    var amount = Math.floor(150 + Math.random() * 400) * dir;
    window.scrollBy({ top: amount, behavior: 'smooth' });
    EngineUtils.ping(NAME);
  }

  // ==================== 行为权重 ====================
  function getWeights() {
    var cfg = NurtureConfig ? NurtureConfig.getCfg() : {};
    return cfg.actionWeights || { like: 0.60, comment: 0.04, repost: 0.03, trend: 0.04, profile: 0.02 };
  }

  function doRandomAction() {
    var w = getWeights();
    // 非活跃时段降低互动频率
    if (!isInActiveHours()) {
      w = { like: 0.25, comment: 0.01, repost: 0.01, trend: 0.01, profile: 0.01 };
    }

    var roll = Math.random();
    var cum = 0;

    cum += w.like;
    if (roll < cum && NurtureTracker.canLikeNow() && clickLike()) return;

    cum += w.comment;
    if (roll < cum && NurtureTracker.canDo('comments')) { postComment(); return; }

    cum += w.repost;
    if (roll < cum && NurtureTracker.canDo('reposts')) { repostTweet(); return; }

    cum += w.trend;
    if (roll < cum && NurtureTracker.canDo('trends')) { viewTrends(); return; }

    cum += w.profile;
    if (roll < cum && NurtureTracker.canDo('profiles')) { visitProfile(); return; }
  }

  // ==================== 主循环 ====================
  function tick() {
    if (!EngineUtils.isActive(NAME)) return;

    NurtureTracker.maybeReset();

    if (NurtureTracker.isDailyExhausted()) {
      Logger.info('养号', '今日配额用完，上报调度器');
      if (tickTimer && tickTimer.cancel) tickTimer.cancel();
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime) {
          chrome.runtime.sendMessage({ action: 'sg_nurture_throttled' });
        }
      } catch (e) {}
      EngineUtils.stop(NAME);
      return;
    }

    scrollRandomly();
    EngineUtils.ping(NAME);

    setTimeout(function () {
      if (!EngineUtils.isActive(NAME)) return;
      doRandomAction();

      if (!EngineUtils.isActive(NAME)) return;
      // 非活跃时段延长间隔
      var ms = gapMs();
      if (!isInActiveHours()) ms = ms * 2;
      tickTimer = EngineUtils.createTimeout(tick, ms);
    }, 800);
  }

  function restartTick() {
    if (tickTimer && tickTimer.cancel) tickTimer.cancel();
    tick();
  }

  // ==================== 对外接口 ====================
  function start() {
    if (EngineUtils.isRunning(NAME)) return;
    EngineUtils.start(NAME);
    Logger.info('养号', '引擎启动');
    restartTick();
  }

  function stop() {
    EngineUtils.stop(NAME);
    if (tickTimer && tickTimer.cancel) tickTimer.cancel();
    tickTimer = null;
    EngineUtils.clearWatchdog(wdTimer);
    wdTimer = null;
    Logger.info('养号', '引擎停止');
  }

  function pause() {
    EngineUtils.pause(NAME);
    if (tickTimer && tickTimer.cancel) tickTimer.cancel();
    EngineUtils.clearWatchdog(wdTimer);
    Logger.info('养号', '引擎暂停');
  }

  function recover() {
    var wasRunning = sessionStorage.getItem('sg_' + NAME + '_running') === 'true';
    var wasPaused = sessionStorage.getItem('sg_' + NAME + '_paused') === 'true';
    if (!wasRunning || wasPaused) {
      sessionStorage.removeItem('sg_' + NAME + '_running');
      sessionStorage.removeItem('sg_' + NAME + '_paused');
      return;
    }
    EngineUtils.start(NAME);
    restartTick();
    Logger.info('养号', '从断点恢复');
  }

  // 看门狗
  wdTimer = EngineUtils.createWatchdog(NAME, 90000, restartTick);

  // ==================== 命令监听（通过 window 事件，同页通信） ====================
  window.addEventListener('sg-nurture-command', function (e) {
    var cmd = e.detail && e.detail.command;
    if (cmd === 'start') { start(); }
    else if (cmd === 'stop') { stop(); }
    else if (cmd === 'pause') { pause(); }
    else if (cmd === 'resume') { EngineUtils.resume(NAME); restartTick(); }
  });

  // ==================== 模块导出 + 初始化 ====================
  window.NurtureEngine = { start: start, stop: stop, pause: pause, getStatus: function () { return EngineUtils.isActive(NAME) ? 'running' : 'idle'; }, isActive: function () { return EngineUtils.isActive(NAME); } };

  recover();
  Logger.info('养号', '模块已加载 V3.0.0');
})();

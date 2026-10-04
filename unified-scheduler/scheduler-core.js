// =============================================================================
// 智能调度 — 调度核心 V3.3
// 改动：
//   1. Logger + SKeys 替换硬编码
//   2. prev 三字段持久化 → 跨页面边沿检测不丢
  // chatLastEndAt / chatNextAllowedAt → 仅显式 nextAt 冷却（4.1.38 废除 55 分兜底）
// =============================================================================

(function () {
  'use strict';

  var K = SKeys;
  var S = {};
  var prev = { followActive: false, nurturing: false, chatRunning: false };
  var g_stage = 'S0';
  var _lastCoorNurtureStart = 0;

  // ==================== 工具 ====================
  function inRange(hS, mS, hE, mE) {
    if (typeof TimeUtil !== 'undefined' && TimeUtil.inRange) return TimeUtil.inRange(hS, mS, hE, mE);
    try {
      var parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
      }).formatToParts(new Date());
      var hh = 0, mm = 0;
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === 'hour') hh = parseInt(parts[i].value, 10);
        if (parts[i].type === 'minute') mm = parseInt(parts[i].value, 10);
      }
      if (hh === 24) hh = 0;
      var t = hh * 60 + mm;
      var start = hS * 60 + mS;
      var end = hE * 60 + mE;
      if (end >= 24 * 60) end = 24 * 60;
      if (end <= start) return t >= start || t < end;
      return t >= start && t < end;
    } catch (e) {
      return false;
    }
  }
  function getMyHandle() {
    var h = localStorage.getItem(K.LK_MY_HANDLE);
    if (h) {
      h = h.replace('@', '').replace('#guard', '').toLowerCase();
      if (h && h !== 'unknown' && !/^\d{4,5}$/.test(h) && !/^(account|home|explore|settings|i)$/.test(h)) return h;
    }
    var el = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    if (el && el.href) {
      h = el.href.split('/').pop().toLowerCase();
      if (h && !/^\d{4,5}$/.test(h) && !/^(account|home|explore|settings|i|null|undefined)$/.test(h)) {
        localStorage.setItem(K.LK_MY_HANDLE, '@' + h + '#guard');
        return h;
      }
    }
    return 'unknown';
  }
  /** 号池 worker_id；勿依赖 follow IIFE 内的同名函数（跨作用域会 ReferenceError → 静默卡在「领号中」） */
  function getWorkerId() {
    var h = getMyHandle();
    if (!h || h === 'unknown') return '';
    return '@' + h + '#guard';
  }
  function readWorkChatHours() {
    try {
      if (typeof StageDetector !== 'undefined' && StageDetector.isWorkTime && StageDetector.isChatTime) {
        // detect() 会刷新 g_isWorkTime；先 detect 一次更准
        if (StageDetector.detect) StageDetector.detect();
        return { isWorkTime: !!StageDetector.isWorkTime(), isChatTime: !!StageDetector.isChatTime() };
      }
    } catch (e) {}
    try {
      var p = JSON.parse(localStorage.getItem('sg_stage_policy') || '{}');
      var test24 = isTest24h();
      var wh = test24 ? { start: [0, 0], end: [24, 0] } : ((p.workHours && p.workHours.start) ? p.workHours : { start: [6, 0], end: [2, 0] });
      var ch;
      if (test24) {
        ch = { start: [0, 0], end: [24, 0] };
      } else if (typeof TimeUtil !== 'undefined' && TimeUtil.readChatHours) {
        try {
          var th = TimeUtil.readChatHours();
          ch = { start: [th.startH, th.startM || 0], end: [th.endH, th.endM || 0] };
        } catch (eTh) {
          ch = (p.chatHours && p.chatHours.start) ? p.chatHours : { start: [8, 0], end: [18, 0] };
        }
      } else {
        ch = (p.chatHours && p.chatHours.start) ? p.chatHours : { start: [8, 0], end: [18, 0] };
      }
      return {
        isWorkTime: inRange(wh.start[0], wh.start[1], wh.end[0], wh.end[1]),
        isChatTime: inRange(ch.start[0], ch.start[1], ch.end[0], ch.end[1])
      };
    } catch (e2) {
      var test24b = isTest24h();
      if (test24b) return { isWorkTime: true, isChatTime: true };
      return { isWorkTime: inRange(6, 0, 2, 0), isChatTime: inRange(8, 0, 18, 0) };
    }
  }

  function isTest24h() {
    try {
      if (typeof TimeUtil !== 'undefined' && TimeUtil.isTest24h) return !!TimeUtil.isTest24h();
    } catch (e) {}
    try {
      return localStorage.getItem('sg_test_24h') === 'true';
    } catch (e2) { return false; }
  }

  /** 产品工作窗 06:00–02:00（跨夜）：用 UTC+8 墙钟，不依赖可能脏的 sg_stage_policy */
  function productWorkWindowNow() {
    if (isTest24h()) return true;
    var t = -1;
    try {
      if (typeof TimeUtil !== 'undefined' && TimeUtil.shanghaiParts) {
        var p = TimeUtil.shanghaiParts();
        if (p && p.minutes != null) t = p.minutes;
      }
    } catch (e0) {}
    if (t < 0) {
      try {
        var utc = Date.now() + 8 * 3600 * 1000;
        var d = new Date(utc);
        t = d.getUTCHours() * 60 + d.getUTCMinutes();
      } catch (e1) { return false; }
    }
    return t >= 6 * 60 || t < 2 * 60;
  }

  /** S0 误判自愈：产品窗内仍报 S0 时写回 06–02 并重 detect；仍失败则强制 S1 */
  function coerceStageOutOfFalseS0(stage, priority) {
    if (stage !== 'S0' || !productWorkWindowNow()) {
      return { stage: stage, priority: priority || [] };
    }
    try {
      var raw = JSON.parse(localStorage.getItem('sg_stage_policy') || '{}') || {};
      raw.workHours = { start: [6, 0], end: [2, 0] };
      localStorage.setItem('sg_stage_policy', JSON.stringify(raw));
    } catch (eLs) {}
    try {
      if (typeof ConfigSync !== 'undefined' && ConfigSync.fetchRemote) ConfigSync.fetchRemote();
    } catch (eSync) {}
    try {
      if (typeof StageDetector !== 'undefined' && StageDetector.detect) {
        var r2 = StageDetector.detect();
        if (r2 && r2.stage && r2.stage !== 'S0') {
          Logger.info('Coor', 'S0 脏窗自愈 → ' + r2.stage);
          return { stage: r2.stage, priority: r2.priority || [] };
        }
      }
    } catch (eDet) {}
    var day = 1;
    try { day = getDayCount(); } catch (eD) {}
    var forced = day <= 2 ? 'S1' : 'S2';
    var pri = day <= 2 ? ['nurture', 'follow'] : ['follow', 'nurture'];
    Logger.warn('Coor', 'S0 脏窗强制 ' + forced + '（产品窗 06-02 内）');
    return { stage: forced, priority: pri };
  }

  try {
    var _mv = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest)
      ? String(chrome.runtime.getManifest().version || '') : '';
    if (_mv) {
      window.__SG_SCHED_BUILD__ = _mv;
      localStorage.setItem('sg_ext_version', _mv);
      localStorage.setItem('sg_ext_build', _mv);
      localStorage.setItem('sg_ext_loaded_at', String(Date.now()));
    }
  } catch (eVerLs) {}

  /** 插件内置默认：tick 10s / watchdog 30s / stall 180s；后台可覆盖 */
  function readCoTiming() {
    var tick = 10000, wd = 30000, stallSec = 180;
    try {
      var t = JSON.parse(localStorage.getItem('sg_config_thresholds') || '{}');
      if (t.stage_tick_interval_ms != null) tick = parseInt(t.stage_tick_interval_ms, 10) || tick;
      if (t.stage_watchdog_ms != null) wd = parseInt(t.stage_watchdog_ms, 10) || wd;
      if (t.stage_stall_cooldown_sec != null) stallSec = parseInt(t.stage_stall_cooldown_sec, 10) || stallSec;
    } catch (e1) {}
    try {
      var p = JSON.parse(localStorage.getItem('sg_stage_policy') || '{}');
      if (p.cooldown) {
        if (p.cooldown.tickIntervalMs != null) tick = parseInt(p.cooldown.tickIntervalMs, 10) || tick;
        if (p.cooldown.watchdogMs != null) wd = parseInt(p.cooldown.watchdogMs, 10) || wd;
        if (p.cooldown.stallCooldownSec != null) stallSec = parseInt(p.cooldown.stallCooldownSec, 10) || stallSec;
      }
    } catch (e2) {}
    tick = Math.max(3000, tick);
    wd = Math.max(tick, wd);
    stallSec = Math.max(30, stallSec);
    try { localStorage.setItem('sg_stall_cooldown_sec', String(stallSec)); } catch (e3) {}
    return { tick: tick, watchdog: wd, stallSec: stallSec };
  }

  function isSchedulerModuleEnabled() {
    try {
      var raw = localStorage.getItem('sg_module_switches');
      if (!raw) return true;
      var sw = JSON.parse(raw);
      if (sw && Object.prototype.hasOwnProperty.call(sw, 'scheduler')) return sw.scheduler !== false;
    } catch (e) {}
    return true;
  }

  function installCoTimers() {
    var tm = readCoTiming();
    if (coTimer) clearInterval(coTimer);
    if (coWdTimer) clearInterval(coWdTimer);
    coTimer = setInterval(function () { coTick(); }, tm.tick);
    coWdTimer = setInterval(function () {
      if (Date.now() - coLastTick > tm.watchdog && !coTickLock) { coLastTick = Date.now(); coTick(); }
      else if (Date.now() - coLastTick > tm.watchdog * 2) { coTickLock = false; coLastTick = Date.now(); coTick(); }
    }, tm.watchdog);
    Logger.info('Coor', '定时器 tick=' + tm.tick + 'ms watchdog=' + tm.watchdog + 'ms stall=' + tm.stallSec + 's');
  }

  // ----- 白屏自愈探针（方案 B：只 request_heal，由 SW 熔断裁决） -----
  var HEAL_UNHEALTHY_MS = 45000;
  var HEAL_LOADING_SHELL_MS = 105000; // loading_shell 宽限 ~90–120s，纯延迟别 45s 就 recreate
  // 4.3.9：已取消冷启动 4min idle（见 coBootIdleActive）
  var _healLastUrl = '';
  var _healLastHealthyAt = Date.now();
  var _healRequestAt = 0;
  var _healPauseLogAt = 0;
  var _memPurgeAt = 0;

  /** 调度在跑时堆≈300MB / DOM≥6000 → 仅清媒体缓存（15min 防抖在 SW） */
  function coProbeMemoryPurge() {
    if (!coRunning) return;
    if (Date.now() - _memPurgeAt < 60000) return;
    try {
      if (!window.performance || !window.performance.memory) return;
      var usedMB = Math.round(window.performance.memory.usedJSHeapSize / 1024 / 1024);
      var domCount = document.getElementsByTagName('*').length;
      if (usedMB < 300 && domCount < 6000) return;
      if (usedMB > 400 || domCount > 8000) return; // 交给 heal recreate，避免双通道
      _memPurgeAt = Date.now();
      chrome.runtime.sendMessage({ action: 'sg_purge_cache', reason: 'heap_300_coor' }, function () { /* ignore */ });
      Logger.info('Heal', '堆/DOM 偏高，请求清媒体缓存 usedMB=' + usedMB + ' dom=' + domCount);
    } catch (e) {}
  }

  /**
   * 健康 = 主栏有真内容。禁止单靠侧栏 AppTabBar：纯白 SPA 卡死时常残留导航壳，
   * 旧逻辑会永久「健康」导致看门狗永不请求 heal。
   * 禁图模式下不得依赖 img 数量（L5）。
   */
  function isPageHealthyDom() {
    try {
      if (document.querySelector('[data-testid="UserCell"]')) return true;
      if (document.querySelector('[data-testid="dmComposerTextInput"]')) return true;
      if (document.querySelector('article[data-testid="tweet"]')) return true;
      if (document.querySelector('[data-testid="tweetTextarea_0"]')) return true;
      if (document.querySelector('[data-testid="primaryColumn"] [data-testid="UserName"]')) return true;
      if (document.querySelector('[data-testid="sendDMFromProfile"]')) return true;
      if (document.querySelector('input[name="displayName"]')) return true;
      if (document.querySelector('[data-testid="conversation"], [data-testid="DMConversation"]')) return true;
      if (document.querySelector('[data-testid^="dm-conversation-item-"]')) return true;
      var col = document.querySelector('[data-testid="primaryColumn"]');
      if (col) {
        var t = String(col.innerText || '').replace(/\s+/g, '');
        // 空壳/骨架通常几乎无字；首页/列表/资料主栏远超此阈值
        if (t.length >= 80) return true;
      }
    } catch (e) {}
    return false;
  }

  /** 加载中空壳：有导航/主栏壳 + spinner/重试，非真白屏 */
  function isLoadingShellDom() {
    try {
      if (isPageHealthyDom()) return false;
      var hasChrome = !!(
        document.querySelector('[data-testid="AppTabBar_Home_Link"], [data-testid="SideNav_AccountSwitcher_Button"]') ||
        document.querySelector('[data-testid="primaryColumn"]') ||
        document.querySelector('nav[role="navigation"]')
      );
      if (!hasChrome) return false;
      var spin = document.querySelector('[role="progressbar"], [data-testid="Spinner-icon"], svg[aria-label*="Loading"], svg[aria-label*="加载"]');
      var retry = false;
      try {
        var bodyTxt = String((document.body && document.body.innerText) || '').slice(0, 4000);
        retry = /重试|再试一次|Try again|Something went wrong|出了点问题|Retry/i.test(bodyTxt);
      } catch (eT) {}
      return !!(spin || retry);
    } catch (e) {}
    return false;
  }

  function coBootIdleActive() {
    // 4.3.9：已废冷启动 idle；保留函数避免调用点炸
    return false;
  }

  function coBootIdleRemainSec() {
    return 0;
  }

  function coProbeWhiteScreen() {
    if (!coRunning) return;
    // CF / 人机验证：绝对禁止当成白屏硬刷
    try {
      if (typeof ChallengeGuard !== 'undefined' && ChallengeGuard.shouldBlockHeal && ChallengeGuard.shouldBlockHeal()) {
        if (!_healPauseLogAt || Date.now() - _healPauseLogAt > 60000) {
          Logger.warn('Heal', '验证/熔断中，跳过白屏 heal');
          _healPauseLogAt = Date.now();
        }
        return;
      }
    } catch (eCg) {}
    var url = '';
    try { url = window.location.href || ''; } catch (eUrl) {}
    if (url !== _healLastUrl) {
      _healLastUrl = url;
      _healLastHealthyAt = Date.now();
    }
    if (isPageHealthyDom()) {
      _healLastHealthyAt = Date.now();
      return;
    }
    var pausedTill = 0;
    try { pausedTill = parseInt(sessionStorage.getItem(K.SK_PAUSED_TILL) || '0', 10) || 0; } catch (ePt) {}
    if (pausedTill > Date.now()) {
      if (!_healPauseLogAt || Date.now() - _healPauseLogAt > 60000) {
        Logger.info('Heal', '白屏探针：跳转冷却中，跳过 heal');
        _healPauseLogAt = Date.now();
      }
      return;
    }
    var unhealthyFor = Date.now() - _healLastHealthyAt;
    var shell = isLoadingShellDom();
    var needMs = shell ? HEAL_LOADING_SHELL_MS : HEAL_UNHEALTHY_MS;
    if (unhealthyFor < needMs) return;
    if (Date.now() - _healRequestAt < 60000) return;
    _healRequestAt = Date.now();
    var healReason = shell ? 'loading_shell' : 'white_screen';
    Logger.warn('Heal', (shell ? '加载壳' : '白屏') + '≥' + Math.round(needMs / 1000) + 's，请求 sg_request_heal reason=' + healReason + ' unhealthyFor=' + Math.round(unhealthyFor / 1000) + 's');
    try {
      chrome.runtime.sendMessage({
        action: 'sg_request_heal',
        reason: healReason,
        pausedTill: pausedTill,
        challenge: false
      }, function (r) {
        var err = chrome.runtime.lastError;
        if (err) {
          Logger.warn('Heal', 'request 失败: ' + err.message);
          return;
        }
        if (r && r.ok) Logger.info('Heal', '已批准 ' + ((r && r.mode) || 'reload'));
        else Logger.info('Heal', '被拒绝: ' + ((r && r.reason) || 'unknown') + '（SW 熔断：10min间隔 / 1h内最多2次）');
      });
    } catch (eSend) {
      Logger.warn('Heal', 'sendMessage 异常: ' + (eSend && eSend.message));
    }
  }

  function stopAllEnginesForChallenge() {
    try { stopFollow(); } catch (e1) {}
    try { stopChat(); } catch (e2) {}
    try { stopNurture(); } catch (e3) {}
    try { stopRepost('challenge'); } catch (e4) {}
    ['follow', 'chat', 'nurture', 'repost'].forEach(function (n) {
      try { coStop(n); } catch (e5) {}
    });
  }

  function challengeSnapshotSafe() {
    try {
      if (typeof ChallengeGuard !== 'undefined' && ChallengeGuard.snapshot) {
        return ChallengeGuard.tick ? ChallengeGuard.tick() : ChallengeGuard.snapshot();
      }
    } catch (e) {}
    return { active: false, onChallenge: false, fused: false, msg: '' };
  }

  function getDayCount() {
    try { return (JSON.parse(localStorage.getItem('matrix_stats_' + getMyHandle()) || '{}')).day_count || 1; } catch (e) { return 1; }
  }
  try { window.__sgGetDayCount = getDayCount; } catch (eDayExp) {}
  function getFollowedToday() {
    try { return (JSON.parse(localStorage.getItem('matrix_stats_' + getMyHandle()) || '{}')).follows_today || 0; } catch (e) { return 0; }
  }
  function getLimit() {
    try {
      // 优先用关注引擎「当日」已锁定的配额（过期 date 不算）
      var st = JSON.parse(localStorage.getItem('matrix_stats_' + getMyHandle()) || '{}') || {};
      var locked = parseInt(st.daily_limit, 10);
      var todayKey = '';
      try { todayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }); } catch (eT) {}
      var stDay = String(st.date || '');
      var mD = stDay.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
      var stKey = mD ? (mD[1] + '-' + String(mD[2]).padStart(2, '0') + '-' + String(mD[3]).padStart(2, '0')) : stDay;
      if (!isNaN(locked) && locked > 0 && stKey && todayKey && stKey === todayKey) return locked;

      var day = Math.max(1, getDayCount());
      if (typeof RemoteSettings !== 'undefined' && RemoteSettings.followDayRange) {
        var r = RemoteSettings.followDayRange(day);
        if (r && r.max) return Math.round((r.min + r.max) / 2);
      }
      if (typeof RemoteSettings !== 'undefined' && RemoteSettings.followDailyLimit) {
        var rl = RemoteSettings.followDailyLimit(day);
        if (rl != null && rl > 0) return rl;
      }
      var table = { 1: 85, 2: 145, 3: 202, 4: 255, 5: 292, 6: 300 };
      return table[day >= 6 ? 6 : day] || 300;
    } catch (e) { return 255; }
  }
  function rnd(m, x) { return Math.floor(Math.random() * (x - m + 1)) + m; }
  function shanghaiDate() { return new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }); }

  /** 上海自然日 YYYY-MM-DD（与 ConfigSync 一致，避免格式不一致导致跨日失效） */
  function shanghaiDayKey() {
    try {
      return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    } catch (e) {
      var d = new Date(Date.now() + 8 * 3600 * 1000);
      return d.toISOString().slice(0, 10);
    }
  }

  /** 归一化日期字符串为 YYYY-MM-DD，兼容 zh-CN / 缺零格式 */
  function toShanghaiDayKey(raw) {
    if (!raw) return '';
    var s = String(raw).trim();
    var m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
    if (m) {
      return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
    }
    return s;
  }

  /**
   * 本地跨日兜底清零关注配额（不等 ConfigSync 也能自动清）。
   * 场景：关注配额耗尽后引擎闲置，ConfigSync 可能失败或 OPS 日数未推进，
   *       此时靠调度器 tick 定期检测上海日期变更，本地直接清零。
   */
  function ensureFollowDailyRollover() {
    try {
      var h = String(getMyHandle() || '').replace(/^@/, '').replace(/#guard$/i, '').toLowerCase();
      if (!h || h === 'unknown' || h === '未知账号') return false;
      var key = 'matrix_stats_' + h;
      var st = {};
      try { st = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (eSt) { st = {}; }
      var today = shanghaiDayKey();
      var lastDate = toShanghaiDayKey(st.date);
      if (!lastDate || lastDate === today) return false;

      // 跨日：清零今日关注数、解除旧配额锁
      st.follows_today = 0;
      delete st.daily_limit;
      st.date = today;
      localStorage.setItem(key, JSON.stringify(st));

      // 清掉 quota_exhausted / quota 终止态，允许新一天重跑
      try {
        var ms = JSON.parse(sessionStorage.getItem('sg_module_follow') || '{}') || {};
        if (ms.phase === 'quota_exhausted' || ms.phase === 'quota') {
          ms.phase = 'idle';
          ms.running = false;
          sessionStorage.setItem('sg_module_follow', JSON.stringify(ms));
        }
      } catch (eMs) {}

      // 清掉 followNextDelayUntil 冷却锁
      try {
        var sg = JSON.parse(localStorage.getItem(K.LK_STATE) || '{}') || {};
        if (sg.followNextDelayUntil && sg.followNextDelayUntil > Date.now()) {
          sg.followNextDelayUntil = 0;
          localStorage.setItem(K.LK_STATE, JSON.stringify(sg));
        }
      } catch (eSg) {}

      Logger.info('调度', '本地跨日清零关注配额: ' + lastDate + ' → ' + today + ' @' + h);
      return true;
    } catch (e) {
      Logger.warn('调度', '本地跨日清零关注配额失败: ' + e.message);
      return false;
    }
  }

  /**
   * 本地跨日重置养号配额（不等引擎启动也能自动清）。
   * 场景：养号配额用完后引擎停止，跨日后 NurtureTracker.maybeReset 无人调用，
   *       调度器 tick 定期检测并触发重置，同时清 quota_exhausted 终止态。
   */
  function ensureNurtureDailyRollover() {
    try {
      if (typeof NurtureTracker === 'undefined' || !NurtureTracker.maybeReset) return false;
      var h = String(getMyHandle() || '').replace(/^@/, '').replace(/#guard$/i, '').toLowerCase();

      // 先调用 maybeReset（其内部已改为上海日期比较，跨日会自动 resetDaily）
      var statsBefore = NurtureTracker.getStats();
      NurtureTracker.maybeReset();
      var statsAfter = NurtureTracker.getStats();

      // 判断是否真的发生了跨日重置：每日已用量从 >0 变为 0
      var wasUsed = false;
      if (statsBefore && statsBefore.daily && statsBefore.daily.used) {
        for (var k in statsBefore.daily.used) {
          if ((statsBefore.daily.used[k] || 0) > 0) { wasUsed = true; break; }
        }
      }
      var nowZero = true;
      if (statsAfter && statsAfter.daily && statsAfter.daily.used) {
        for (var k2 in statsAfter.daily.used) {
          if ((statsAfter.daily.used[k2] || 0) > 0) { nowZero = false; break; }
        }
      }

      if (wasUsed && nowZero) {
        // 清掉 quota_exhausted 终止态，允许新一天重跑
        try {
          var ms = JSON.parse(sessionStorage.getItem('sg_module_nurture') || '{}') || {};
          if (ms.phase === 'quota_exhausted' || ms.phase === 'done' || ms.phase === 'completed') {
            ms.phase = 'idle';
            ms.running = false;
            sessionStorage.setItem('sg_module_nurture', JSON.stringify(ms));
          }
        } catch (eMs) {}
        Logger.info('调度', '本地跨日重置养号配额 @' + (h || 'unknown'));
        return true;
      }
      return false;
    } catch (e) {
      Logger.warn('调度', '本地跨日重置养号配额失败: ' + e.message);
      return false;
    }
  }

  /** 自动模式：以 sg_state.running 为准（供调度与引擎共用） */
  function isAutoMode() {
    try {
      if (S && S.running) return true;
      return !!(JSON.parse(localStorage.getItem(K.LK_STATE) || '{}').running);
    } catch (e) { return false; }
  }
  try { window.__sgIsAutoMode = isAutoMode; } catch (e) {}

  // ==================== 状态持久化(含 prev 边沿快照 + 私信管控) ====================
  function loadSG() {
    try {
      var raw = JSON.parse(localStorage.getItem(K.LK_STATE)) || {};
      S.running = raw.running || false;
      S.engine = raw.engine || 'idle';
      S.followRound = raw.followRound || 0;
      S.followPhase = raw.followPhase || 'idle';
      S.currentBlogger = raw.currentBlogger || '';
      S.warmupEndAt = raw.warmupEndAt || 0;
      S.chatPhase = raw.chatPhase || 'idle';
      S.suspendedBlogger = raw.suspendedBlogger || '';
      S.pendingChat = raw.pendingChat || false;
      S.followRoundsToday = raw.followRoundsToday || 0;
      // 跨页边沿
      prev.followActive = raw.pvFa || false;
      prev.nurturing = raw.pvNr || false;
      prev.chatRunning = raw.pvCr || false;
      // 私信管控
      S.chatRoundsToday = raw.chatRoundsToday || 0;
      S.chatLastEndAt = raw.chatLastEndAt || 0;
      S.chatDate = raw.chatDate || '';
      S.nurtureOnly = raw.nurtureOnly || false;
    } catch (e) {}
  }
  function saveSG() {
    try {
      var base = JSON.parse(localStorage.getItem(K.LK_STATE) || '{}');
      base.running = S.running; base.engine = S.engine; base.followRound = S.followRound; base.followPhase = S.followPhase;
      base.currentBlogger = S.currentBlogger; base.warmupEndAt = S.warmupEndAt; base.chatPhase = S.chatPhase;
      base.suspendedBlogger = S.suspendedBlogger; base.pendingChat = S.pendingChat; base.followRoundsToday = S.followRoundsToday;
      base.pvFa = prev.followActive; base.pvNr = prev.nurturing; base.pvCr = prev.chatRunning;
      base.chatRoundsToday = S.chatRoundsToday; base.chatLastEndAt = S.chatLastEndAt; base.chatDate = S.chatDate;
      base.nurtureOnly = S.nurtureOnly;
      localStorage.setItem(K.LK_STATE, JSON.stringify(base));
    } catch (e) {}
  }

  // ==================== 引擎控制 ====================
  function stopFollow() {
    sessionStorage.setItem(K.SK_TAB_RUNNING, 'stopped_by_user');
    localStorage.removeItem(K.LK_FOLLOW_RUNNING);
    try {
      window.dispatchEvent(new CustomEvent('sg-follow-command', { detail: { command: 'stop' } }));
    } catch (e) {}
  }
  function stopChat() {
    sessionStorage.setItem(K.SK_CHAT_AUTO_RUN, 'false');
    localStorage.setItem(K.LK_CHAT_STATUS, 'stopped');
    localStorage.removeItem(K.LK_CHAT_RECOVERY);
    try {
      window.dispatchEvent(new CustomEvent('sg-chat-command', { detail: { command: 'stop' } }));
    } catch (e) {}
  }
  function startNurtureDirect(targetUrl) {
    try {
      // 不要先写 running 旗标：否则 nurture startWithTarget 会以为已在跑而跳过 restartTick
      window.dispatchEvent(new CustomEvent('sg-nurture-command', { detail: { command: 'start', targetUrl: targetUrl || 'https://x.com/home' } }));
      Logger.info('调度', '启动养号引擎 → ' + (targetUrl || 'https://x.com/home'));
    } catch (e) {}
  }
  /** 资料克隆完成后由 ProfileClone 回调，跳过前置闸 */
  try { window.__sgStartNurtureDirect = startNurtureDirect; } catch (eHook) {}

  function startNurture(targetUrl) {
    var url = targetUrl || 'https://x.com/home';
    try {
      if (typeof ProfileClone !== 'undefined' && ProfileClone.ensureBeforeNurture) {
        if (ProfileClone.isRunning && ProfileClone.isRunning()) {
          Logger.info('调度', '资料克隆进行中，暂缓养号');
          return;
        }
        if (ProfileClone.needsRun && ProfileClone.needsRun()) {
          var gate = ProfileClone.ensureBeforeNurture(url);
          if (gate && gate.started) {
            Logger.info('调度', '养号前置：资料克隆 → @' + (gate.source || ''));
            return;
          }
          if (gate && gate.busy) {
            Logger.info('调度', '资料克隆忙，暂缓养号');
            return;
          }
        }
      }
    } catch (ePc) {
      Logger.warn('调度', '资料克隆闸异常，放行养号: ' + (ePc && ePc.message ? ePc.message : ePc));
    }
    startNurtureDirect(url);
  }
  function stopNurture() {
    try {
      sessionStorage.removeItem(K.SK_NURTURE_RUNNING);
      window.dispatchEvent(new CustomEvent('sg-nurture-command', { detail: { command: 'stop' } }));
      Logger.info('调度', '停止养号引擎');
    } catch (e) {}
  }
  function startRepost(targetUrl, opts) {
    try {
      opts = opts || {};
      window.dispatchEvent(new CustomEvent('sg-repost-command', {
        detail: {
          command: 'start',
          targetUrl: targetUrl || '',
          autoSlot: !!opts.autoSlot,
          freshRound: !!opts.freshRound
        }
      }));
      Logger.info('调度', '启动转帖引擎' + (opts.autoSlot ? '(定时)' : '') + (opts.freshRound ? '(新一轮)' : ''));
    } catch (e) {}
  }
  function stopRepost(reason) {
    try {
      // 不直接删 sg_repost_running key：repost-engine 在 isProcessing 中会延迟 stop，
      // 直接删 key 会让 EngineUtils.isActive 返回 false，打断 repostTweet 流程。
      // 改为只派发 stop 命令事件，由 repost-engine 的 stop() 函数决定何时真正清理 key。
      window.dispatchEvent(new CustomEvent('sg-repost-command', {
        detail: { command: 'stop', reason: reason || 'cmd' }
      }));
      Logger.info('调度', '停止转帖引擎' + (reason === 'cmd' ? '' : '(' + reason + ')'));
    } catch (e) {}
  }
  function repostStatusSnap() {
    var out = { running: false, current: '', daily: { used: 0, cap: 3 } };
    try {
      out.running = sessionStorage.getItem(K.SK_REPOST_RUNNING || 'sg_repost_running') === 'true';
      out.current = localStorage.getItem('sg_repost_current') || '';
      var cfg = {};
      try {
        if (typeof RepostTracker !== 'undefined' && RepostTracker.getConfig) cfg = RepostTracker.getConfig() || {};
        else cfg = JSON.parse(localStorage.getItem('sg_repost_config') || '{}') || {};
      } catch (eC) {}
      var used = 0;
      try {
        if (typeof RepostTracker !== 'undefined' && RepostTracker.getDaily) {
          used = (RepostTracker.getDaily() || {}).count || 0;
        } else {
          used = (JSON.parse(localStorage.getItem('sg_repost_daily') || '{}') || {}).count || 0;
        }
      } catch (eD) {}
      var cap = 3;
      try {
        if (typeof RepostTracker !== 'undefined' && RepostTracker.getEffectiveDailyLimit) {
          cap = RepostTracker.getEffectiveDailyLimit();
        } else {
          var q = Number(cfg.dailyQuota) || 3;
          var c = Number(cfg.dailyCap) || 0;
          cap = c > 0 ? Math.min(q, c) : q;
        }
      } catch (eL) {}
      out.daily = { used: used, cap: cap };
    } catch (e) {}
    return out;
  }
  function profileCloneSnap() {
    var out = { running: false, label: '', needsRun: false, done: false, lastError: '' };
    try {
      if (typeof ProfileClone !== 'undefined') {
        out.running = !!(ProfileClone.isRunning && ProfileClone.isRunning());
        out.label = (ProfileClone.statusLabel && ProfileClone.statusLabel()) || '';
        out.needsRun = !!(ProfileClone.needsRun && ProfileClone.needsRun());
        var st = ProfileClone.getState ? ProfileClone.getState() : null;
        if (st) {
          out.done = !!st.done;
          out.skipped = !!st.skipped;
          out.failed = !!st.failed;
          out.source = st.source || '';
          out.attempts = st.attempts || 0;
          out.lastError = st.lastError || '';
          out.textDone = !!st.textDone;
          out.mediaDone = !!st.mediaDone;
          out.mediaPartial = !!st.mediaPartial;
        }
      } else {
        out.running = sessionStorage.getItem(K.SK_PROFILE_CLONE_RUNNING || 'sg_profile_clone_running') === 'true';
      }
    } catch (e) {}
    return out;
  }
  function stopAll() {
    stopFollow(); stopChat(); stopNurture(); stopRepost();
    try {
      if (typeof ProfileClone !== 'undefined' && ProfileClone.abort) ProfileClone.abort('stop_all');
    } catch (ePc) {}
    ['follow', 'chat', 'nurture', 'repost'].forEach(function (n) {
      try { coStop(n); } catch (eCs) {}
    });
  }

  // =============================================================================
  // 新号自动上路（onboarding）：Day1 未就绪时，自动克隆资料 → 转帖 → 就绪
  // 无来源则等待，超时后养号兜底
  // =============================================================================
  var ONBOARD_MAX_ATTEMPTS = 3;
  var ONBOARD_SOURCE_WAIT_MS = 90 * 60 * 1000; // 等来源最多 90 分钟
  var ONBOARD_SOURCE_CHECK_MS = 2 * 60 * 1000;  // 每 2 分钟查一次来源

  function onboardKey() {
    try {
      var h = (localStorage.getItem(K.LK_MY_HANDLE) || 'unknown').replace(/@|#guard/gi, '').toLowerCase().trim();
      return (K.LK_ONBOARDING_STATE || 'sg_onboarding_state_') + h;
    } catch (e) { return 'sg_onboarding_state_unknown'; }
  }
  function getOnboardState() {
    try { return JSON.parse(localStorage.getItem(onboardKey())) || null; } catch (e) { return null; }
  }
  function saveOnboardState(st) {
    try { localStorage.setItem(onboardKey(), JSON.stringify(st)); } catch (e) {}
  }
  function clearOnboardState() {
    try { localStorage.removeItem(onboardKey()); } catch (e) {}
    try { sessionStorage.removeItem(K.SK_ONBOARDING_ACTIVE || 'sg_onboarding_active'); } catch (e) {}
  }

  function onboardHasSource() {
    try {
      var targets = JSON.parse(localStorage.getItem(K.LK_REPOST_TARGETS || 'sg_repost_targets') || '[]') || [];
      return targets.length > 0;
    } catch (e) { return false; }
  }

  function onboardTick() {
    try {
      var day = getDayCount();
      if (day >= 2) { clearOnboardState(); return false; }
      if (typeof StageDetector !== 'undefined' && StageDetector.isNewAccountReady && StageDetector.isNewAccountReady()) {
        clearOnboardState();
        return false;
      }
      if (typeof ProfileClone === 'undefined') return false;
    } catch (eChk) { return false; }

    var st = getOnboardState() || {
      phase: 'idle',
      startedAt: Date.now(),
      sourceWaitStartedAt: 0,
      cloneAttempts: 0,
      repostAttempts: 0,
      repostLastAttemptAt: 0,
      lastError: '',
      lastErrorPhase: ''
    };

    try { sessionStorage.setItem(K.SK_ONBOARDING_ACTIVE || 'sg_onboarding_active', 'true'); } catch (eSk) {}

    var pcSnap = profileCloneSnap();
    var rpSnap = repostStatusSnap();
    var now = Date.now();

    // ---------- idle：首次进入，判断起点 ----------
    if (st.phase === 'idle') {
      // 克隆已经完成 → 直接进转帖
      if (pcSnap.done && !pcSnap.failed) {
        st.phase = 'reposting';
        saveOnboardState(st);
        Logger.info('新号上路', '资料克隆已完成，直接进入转帖阶段');
        // fall through to reposting
      } else if (!onboardHasSource()) {
        // 无来源 → 等待
        st.phase = 'waiting_source';
        st.sourceWaitStartedAt = now;
        saveOnboardState(st);
        Logger.info('新号上路', '无转帖来源，等待中（最长 90 分钟）');
        return 'idle_with_nurture';
      } else {
        // 有来源 + 克隆没完成 → 开始克隆
        st.phase = 'cloning';
        saveOnboardState(st);
        Logger.info('新号上路', '检测到来源，开始资料克隆');
        try {
          ProfileClone.ensureBeforeNurture('https://x.com/home', { nurtureAfter: false, force: true });
        } catch (eStartCl) {}
        return true;
      }
    }

    // ---------- waiting_source：等来源 ----------
    if (st.phase === 'waiting_source') {
      if (onboardHasSource()) {
        // 来源来了 → 开始克隆
        st.phase = 'cloning';
        st.sourceWaitStartedAt = 0;
        saveOnboardState(st);
        Logger.info('新号上路', '检测到新来源，开始资料克隆');
        try {
          ProfileClone.ensureBeforeNurture('https://x.com/home', { nurtureAfter: false, force: true });
        } catch (eStartCl) {}
        return true;
      }
      var waited = now - (st.sourceWaitStartedAt || 0);
      if (waited >= ONBOARD_SOURCE_WAIT_MS) {
        // 超时 → 养号兜底
        st.phase = 'fallback_nurture';
        st.lastError = 'source_wait_timeout';
        saveOnboardState(st);
        Logger.warn('新号上路', '等来源超时（' + Math.round(waited/60000) + ' 分钟），进入养号兜底');
        return false;
      }
      try {
        if (!coPrev._onboardSrcLogAt || now - coPrev._onboardSrcLogAt > ONBOARD_SOURCE_CHECK_MS) {
          Logger.info('新号上路', '等待来源中 ' + Math.round(waited/60000) + '/' + Math.round(ONBOARD_SOURCE_WAIT_MS/60000) + ' 分钟');
          coPrev._onboardSrcLogAt = now;
        }
      } catch (eLg) {}
      return 'idle_with_nurture';
    }

    // ---------- cloning：资料克隆中 ----------
    if (st.phase === 'cloning') {
      if (pcSnap.running) {
        try {
          if (!coPrev._onboardLogAt || now - coPrev._onboardLogAt > 60000) {
            Logger.info('新号上路', '资料克隆中 ' + (pcSnap.label || '') + ' attempt=' + (st.cloneAttempts + 1));
            coPrev._onboardLogAt = now;
          }
        } catch (eLg) {}
        return true;
      }
      // 克隆成功（done 且非 failed）
      if (pcSnap.done && !pcSnap.failed) {
        st.phase = 'reposting';
        st.cloneAttempts = 0;
        saveOnboardState(st);
        Logger.info('新号上路', '资料克隆完成，进入转帖阶段');
        // fall through to reposting
      } else if (pcSnap.skipped) {
        // 克隆被跳过
        var skipReason = pcSnap.lastError || 'skipped';
        if (skipReason === 'no_source' || !onboardHasSource()) {
          st.phase = 'waiting_source';
          st.sourceWaitStartedAt = now;
          st.cloneAttempts = 0;
          st.lastError = 'clone_skipped:' + skipReason;
          saveOnboardState(st);
          Logger.info('新号上路', '克隆因无来源被跳过，进入等来源阶段');
          return 'idle_with_nurture';
        }
        // 其他原因跳过 → 当失败处理
        st.cloneAttempts = (st.cloneAttempts || 0) + 1;
        st.lastError = 'clone_skipped:' + skipReason;
        st.lastErrorPhase = 'clone';
        if (st.cloneAttempts >= ONBOARD_MAX_ATTEMPTS) {
          st.phase = 'failed';
          st.lastError = 'clone_exhausted:' + st.cloneAttempts + ':' + skipReason;
          saveOnboardState(st);
          Logger.warn('新号上路', '克隆连续跳过 ' + st.cloneAttempts + ' 次，放弃 reason=' + skipReason);
          return false;
        }
        // 重试
        saveOnboardState(st);
        Logger.info('新号上路', '克隆被跳过（' + skipReason + '），第 ' + st.cloneAttempts + ' 次重试');
        try {
          if (ProfileClone.resetMedia) ProfileClone.resetMedia();
          ProfileClone.ensureBeforeNurture('https://x.com/home', { nurtureAfter: false, force: true });
        } catch (eRetry) {}
        return true;
      } else if (pcSnap.failed || !pcSnap.done) {
        // 克隆失败 或 未在运行且未完成（异常终止）
        st.cloneAttempts = (st.cloneAttempts || 0) + 1;
        st.lastError = pcSnap.lastError || 'clone_failed';
        st.lastErrorPhase = 'clone';
        if (st.cloneAttempts >= ONBOARD_MAX_ATTEMPTS) {
          // 3 次都失败 → 如果文本已完成（只是图片挂了），仍然进转帖（资料部分成功总比全失败好）
          if (pcSnap.textDone) {
            st.phase = 'reposting';
            st.lastError = 'clone_media_failed:' + (pcSnap.lastError || '');
            saveOnboardState(st);
            Logger.warn('新号上路', '资料克隆图片部分失败，但文本已完成，继续转帖阶段 err=' + pcSnap.lastError);
            // fall through to reposting
          } else {
            st.phase = 'failed';
            st.lastError = 'clone_exhausted:' + st.cloneAttempts + ':' + (pcSnap.lastError || 'unknown');
            saveOnboardState(st);
            Logger.warn('新号上路', '资料克隆耗尽 ' + st.cloneAttempts + ' 次，最后错误=' + st.lastError);
            return false;
          }
        } else {
          // 重试
          saveOnboardState(st);
          Logger.info('新号上路', '资料克隆失败，第 ' + st.cloneAttempts + ' 次重试 err=' + (pcSnap.lastError || ''));
          try {
            if (ProfileClone.resetMedia) ProfileClone.resetMedia();
            ProfileClone.ensureBeforeNurture('https://x.com/home', { nurtureAfter: false, force: true });
          } catch (eRetry) {}
          return true;
        }
      }
    }

    // ---------- reposting：转帖中 ----------
    if (st.phase === 'reposting') {
      if (rpSnap.running) {
        try {
          if (!coPrev._onboardRpLogAt || now - coPrev._onboardRpLogAt > 60000) {
            Logger.info('新号上路', '转帖中 @' + (rpSnap.current || '') + ' ' + (rpSnap.daily.used || 0) + '/' + (rpSnap.daily.cap || 0));
            coPrev._onboardRpLogAt = now;
          }
        } catch (eLg) {}
        return true;
      }
      // 检查是否已发过帖
      var postedOk = false;
      try {
        var h4 = (localStorage.getItem(K.LK_MY_HANDLE) || 'unknown').replace(/@|#guard/gi, '').toLowerCase();
        postedOk = localStorage.getItem('sg_repost_posted_ok_' + h4) === '1';
      } catch (ePo) {}
      if (postedOk) {
        st.phase = 'done';
        saveOnboardState(st);
        clearOnboardState();
        Logger.info('新号上路', '资料+转帖完成，新号就绪！');
        return false;
      }
      // 转帖未跑或已停但没成功
      // 节流：两次启动之间至少隔 3 分钟，避免 3 次重试 30 秒内烧完
      var timeSinceLastRp = now - (st.repostLastAttemptAt || 0);
      if (timeSinceLastRp < 3 * 60 * 1000 && st.repostAttempts > 0) {
        // 冷却期，先养号并行
        return 'idle_with_nurture';
      }
      // 检查日限：如果今日已达上限但 postedOk 还是 false
      // 正常情况下 dailyUsed>0 意味着 postedOk 也应该是 true（markPosted 和 bumpDaily 同路径）
      // 如果不一致，说明是旧数据或异常，不烧重试次数，等明天日限重置
      var dailyUsed = rpSnap.daily.used || 0;
      var dailyCap = rpSnap.daily.cap || 3;
      if (dailyUsed >= dailyCap && dailyCap > 0) {
        try {
          if (!coPrev._onboardRpWaitLogAt || now - coPrev._onboardRpWaitLogAt > 300000) {
            Logger.info('新号上路', '转帖日限 ' + dailyUsed + '/' + dailyCap + ' 已用完，等待次日重置');
            coPrev._onboardRpWaitLogAt = now;
          }
        } catch (eLg) {}
        return 'idle_with_nurture';
      }
      // 启动转帖
      st.repostAttempts = (st.repostAttempts || 0) + 1;
      st.repostLastAttemptAt = now;
      if (st.repostAttempts >= ONBOARD_MAX_ATTEMPTS) {
        st.phase = 'failed';
        st.lastError = 'repost_exhausted:' + st.repostAttempts;
        st.lastErrorPhase = 'repost';
        saveOnboardState(st);
        Logger.warn('新号上路', '转帖耗尽 ' + st.repostAttempts + ' 次，放弃');
        return false;
      }
      saveOnboardState(st);
      Logger.info('新号上路', '启动转帖（第 ' + st.repostAttempts + ' 次）— 19:00-23:00 必须发帖时段');
      try {
        // 新号上路转帖设 manual_slot：跳过时段判定，避免 19:00 前被协调器误杀
        sessionStorage.setItem('sg_repost_manual_slot', '1');
        startRepost('', { autoSlot: false, freshRound: true });
      } catch (eStartRp) {}
      return true;
    }

    // done / failed / fallback_nurture → 不再参与调度
    return false;
  }
  function onboardIsActive() {
    try { return sessionStorage.getItem(K.SK_ONBOARDING_ACTIVE || 'sg_onboarding_active') === 'true'; } catch (e) { return false; }
  }

  function setUserPaused(on) {
    try {
      var key = (K && K.LK_USER_PAUSED) || 'sg_user_paused';
      if (on) localStorage.setItem(key, '1');
      else localStorage.removeItem(key);
    } catch (e) {}
  }

  /** pool_pop 飞行窗：防短 tick 双领号；与 coEngineAlive starting/popping 宽限对齐 */
  var FOLLOW_POP_FLIGHT_KEY = 'sg_follow_pop_inflight';
  var MODULE_START_GRACE_MS = 30000; // 4.6.23：10s→30s，页面加载慢时给引擎足够心跳宽限，避免误判幽灵导致连环跳转
  function clearFollowPopFlight() {
    try { sessionStorage.removeItem(FOLLOW_POP_FLIGHT_KEY); } catch (eClrF) {}
  }
  function isFollowPopFlight() {
    try {
      var until = parseInt(sessionStorage.getItem(FOLLOW_POP_FLIGHT_KEY) || '0', 10) || 0;
      return until > Date.now();
    } catch (eF) { return false; }
  }
  function markFollowPopFlight() {
    try {
      sessionStorage.setItem(FOLLOW_POP_FLIGHT_KEY, String(Date.now() + MODULE_START_GRACE_MS));
    } catch (eM) {}
  }
  /** coStart 刚写 starting/popping、引擎旗标尚未落地时判活，避免幽灵清标 */
  function coModuleStartingGrace(name) {
    try {
      var msG = coRead(name);
      var phG = msG.phase || '';
      if (phG !== 'starting' && phG !== 'popping') return false;
      var atG = parseInt(msG.startedAt, 10) || 0;
      return atG > 0 && (Date.now() - atG) < MODULE_START_GRACE_MS;
    } catch (eG) { return false; }
  }

  function startFollow(targetUrl) {
    stopChat();
    try {
      if (sessionStorage.getItem(K.SK_TAB_RUNNING) === 'stopped_by_user') {
        sessionStorage.setItem(K.SK_TAB_RUNNING, 'true');
      }
    } catch (eTabHeal) {}
    try {
      var sgBlock = coLoadSg();
      if (softRiskActive(sgBlock, Date.now())) {
        Logger.warn('调度', '软风控窗口内拒绝领号');
        clearFollowPopFlight();
        try { coStop('follow'); } catch (eB) {}
        return;
      }
    } catch (eSoft) {}
    // 有未完成号池任务时只恢复，禁止再次 pool_pop（否则会遗弃半成品，到期回流后再点同一批「正在关注」）
    var lockedId = localStorage.getItem(K.LK_CURRENT_TASK_ID);
    var lockedCreator = (localStorage.getItem(K.LK_CURRENT_CREATOR) || '').replace(/^@/, '');
    if (lockedId && !lockedCreator) {
      // 半残锁：只有 task_id 无法恢复页面 → fail 释放，避免再 pop 造成双 assigned
      Logger.warn('调度', '残留半残锁 #' + lockedId + ' 无 creator，pool_fail 后重领');
      try {
        chrome.runtime.sendMessage({ action: 'pool_fail', id: lockedId }, function () {});
      } catch (eOrph) {}
      try {
        localStorage.removeItem(K.LK_CURRENT_TASK_ID);
        localStorage.removeItem('matrix_current_task_assigned_at');
      } catch (eClr2) {}
      lockedId = null;
    }
    if (lockedId && lockedCreator) {
      clearFollowPopFlight();
      S.currentBlogger = lockedCreator;
      S.followPhase = 'active';
      localStorage.setItem(K.LK_FOLLOW_RUNNING, 'true');
      sessionStorage.setItem(K.SK_TAB_RUNNING, 'true');
      // 调度恢复直达粉丝页，统一 SCAN，避免残留 PROFILE 走错分支
      try { localStorage.setItem('matrix_step', 'SCAN'); } catch (eSt) {}
      Logger.info('调度', '恢复未完成任务 → @' + lockedCreator + ' (id:' + lockedId + ')，不重新领号');
      window.dispatchEvent(new CustomEvent('sg-follow-command', {
        detail: { command: 'start', targetUrl: 'https://x.com/' + lockedCreator + '/followers' }
      }));
      return;
    }

    // 单飞：上一趟 pool_pop 未结案则禁止再 pop（防双 assigned）
    if (isFollowPopFlight()) {
      Logger.warn('调度', '领号进行中，跳过重复 pool_pop');
      return;
    }

    // 领号窗内保持 LK + phase=popping，避免 coStart 写 running 后下一 tick 幽灵清标
    markFollowPopFlight();
    try {
      localStorage.setItem(K.LK_FOLLOW_RUNNING, 'true');
      sessionStorage.setItem(K.SK_TAB_RUNNING, 'true');
      coWrite('follow', {
        running: true,
        phase: 'popping',
        targetUrl: '',
        startedAt: Date.now(),
        lastActive: Date.now()
      });
    } catch (ePopPh) {}

    Logger.info('调度', '领号中');
    var popSettled = false;
    var popTimer = setTimeout(function () {
      if (popSettled) return;
      popSettled = true;
      clearFollowPopFlight();
      Logger.warn('调度', '领号超时(8s)，交回调度；若晚到成功响应将 pool_fail 释放');
      S.engine = 'idle';
      try {
        var sgTo = coLoadSg();
        sgTo.followNextDelayUntil = Date.now() + 30 * 1000;
        coSaveSg(sgTo);
      } catch (eTo) {}
      saveSG();
      try { coStop('follow'); } catch (eStop) {}
    }, 8000);

    try {
      chrome.runtime.sendMessage({ action: 'pool_pop', worker_id: getWorkerId() }, function (r) {
        // 超时后晚到的成功包：服务端可能已 assigned → 必须 fail，勿写锁
        if (popSettled) {
          if (r && r.id && !(r.ok === false && r.error)) {
            Logger.warn('调度', '领号超时后晚到成功 #' + r.id + '，pool_fail 防占坑');
            try {
              chrome.runtime.sendMessage({ action: 'pool_fail', id: r.id }, function () {});
            } catch (eLate) {}
          }
          return;
        }
        popSettled = true;
        clearTimeout(popTimer);
        clearFollowPopFlight();

        if (chrome.runtime.lastError) {
          Logger.warn('调度', '领号失败: ' + chrome.runtime.lastError.message);
          S.engine = 'idle';
          try { coStop('follow'); } catch (e1) {}
          return;
        }

        if (r && r.ok === false && r.error) {
          Logger.warn('调度', '领号网络错误: ' + r.error);
          S.engine = 'idle';
          try {
            var sgNe = coLoadSg();
            sgNe.followNextDelayUntil = Date.now() + 60 * 1000;
            coSaveSg(sgNe);
          } catch (eNe) {}
          saveSG();
          try { coStop('follow'); } catch (e2) {}
          return;
        }

        if (r && r.handle) {
          var h = r.handle.replace(/^@/, '');
          localStorage.setItem(K.LK_CURRENT_CREATOR, h);
          if (r.id) localStorage.setItem(K.LK_CURRENT_TASK_ID, String(r.id));
          try { localStorage.setItem('matrix_current_task_assigned_at', String(Date.now())); } catch (eAt) {}
          // 直达粉丝列表，步骤必须是 SCAN（勿留旧 PROFILE）
          try { localStorage.setItem('matrix_step', 'SCAN'); } catch (eStep) {}
          S.currentBlogger = h; S.followPhase = 'active';
          localStorage.setItem(K.LK_FOLLOW_RUNNING, 'true');
          sessionStorage.setItem(K.SK_TAB_RUNNING, 'true');
          Logger.info('调度', '领号成功 → @' + h + ' (id:' + (r.id || '?') + ')');
          window.dispatchEvent(new CustomEvent('sg-follow-command', { detail: { command: 'start', targetUrl: 'https://x.com/' + h + '/followers' } }));
        } else if (r && r.ok === false) {
          Logger.warn('调度', '领号失败: ' + (r.error || r.reason || 'unknown'));
          S.engine = 'idle';
          try {
            var sgFail = coLoadSg();
            sgFail.followNextDelayUntil = Date.now() + 60 * 1000;
            coSaveSg(sgFail);
          } catch (eFail) {}
          saveSG();
          try { coStop('follow'); } catch (e2b) {}
        } else {
          // 真·暂无 pending（不是号池整体报废；轮换中 completed/assigned 不算可领）
          Logger.warn('调度', '暂无 pending' + (r && r.empty ? ' (empty)' : ''));
          S.engine = 'idle';
          try {
            var retryDelaySec = 300;
            try {
              var cfgIntv = JSON.parse(localStorage.getItem('sg_config_intervals') || '{}');
              if (cfgIntv.followRetryDelaySec) retryDelaySec = cfgIntv.followRetryDelaySec;
            } catch (e1) {}
            var sgSt = coLoadSg();
            sgSt.followNextDelayUntil = Date.now() + retryDelaySec * 1000;
            coSaveSg(sgSt);
          } catch (e2) {}
          saveSG();
          // 消除幽灵 running：coStart 已写 running=true，池空必须交回调度
          coStop('follow');
        }
      });
    } catch (eSend) {
      if (popSettled) return;
      popSettled = true;
      clearTimeout(popTimer);
      clearFollowPopFlight();
      Logger.warn('调度', '领号异常: ' + (eSend && eSend.message ? eSend.message : eSend));
      S.engine = 'idle';
      try { coStop('follow'); } catch (e3) {}
    }
  }

  /**
   * SCRM 闸门缓存：只认客服在线，进线数字不参与。
   * 有效期与 OPS 快照过期一致（45 分钟），避免 75s 过期返回 null 导致私信中途被跳过。
   */
  var SCRM_GATE_CACHE_MS = 45 * 60 * 1000;
  var SCRM_GATE_REFRESH_MS = 10 * 60 * 1000;
  var _scrmGateCache = { at: 0, allow: false, reason: 'SCRM未上报', force: false, warn: '', until: '' };
  function getScrmGateSync() {
    if (!_scrmGateCache.at) return null; // 从未查到过：等首次 refresh
    var age = Date.now() - _scrmGateCache.at;
    if (age > SCRM_GATE_CACHE_MS) {
      return { allow_chat: false, reason: 'SCRM状态过期', force_allow: false, warn_reason: '' };
    }
    // 有效期内始终返回上次结果（后台定时刷新），不因「查询中」打断私信轮次
    return {
      allow_chat: !!_scrmGateCache.allow,
      reason: _scrmGateCache.reason || '',
      force_allow: !!_scrmGateCache.force,
      warn_reason: _scrmGateCache.warn || '',
      force_until: _scrmGateCache.until || ''
    };
  }
  function refreshScrmGate(cb) {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        _scrmGateCache = { at: Date.now(), allow: false, reason: 'SCRM未上报', force: false, warn: '', until: '' };
        if (cb) cb(_scrmGateCache);
        return;
      }
      chrome.runtime.sendMessage({ action: 'ops_scrm_chat_gate' }, function (r) {
        void chrome.runtime.lastError;
        var allow = !!(r && r.allow_chat);
        var force = !!(r && r.force_allow);
        var warn = (r && r.warn_reason) || '';
        var until = (r && r.force_until) || '';
        var reason = (r && r.reason) || (allow ? '' : 'SCRM未上报');
        if (force && warn && !reason) reason = '';
        _scrmGateCache = { at: Date.now(), allow: allow, reason: reason, force: force, warn: warn, until: until };
        try {
          sessionStorage.setItem('sg_scrm_gate_cache', JSON.stringify(_scrmGateCache));
        } catch (eSs) {}
        if (cb) cb(_scrmGateCache);
      });
    } catch (eG) {
      // 刷新失败：若尚有未过期缓存则保留，避免一轮私信中途被打成拦截
      if (!_scrmGateCache.at || (Date.now() - _scrmGateCache.at) > SCRM_GATE_CACHE_MS) {
        _scrmGateCache = { at: Date.now(), allow: false, reason: 'SCRM状态过期', force: false, warn: '', until: '' };
        try {
          sessionStorage.setItem('sg_scrm_gate_cache', JSON.stringify(_scrmGateCache));
        } catch (eSs2) {}
      }
      if (cb) cb(_scrmGateCache);
    }
  }
  // 后台预热 + 定时刷新（与 OPS 45 分钟窗口对齐，10 分钟拉一次最新闸门）
  try { setTimeout(function () { refreshScrmGate(); }, 2000); } catch (eWarm) {}
  try {
    if (!window._sgScrmGateTimer) {
      window._sgScrmGateTimer = setInterval(function () { refreshScrmGate(); }, SCRM_GATE_REFRESH_MS);
    }
  } catch (eT) {}

  function startChat(targetUrl) {
    stopFollow();
    var forceInbox = false;
    try { forceInbox = sessionStorage.getItem('sg_chat_force_inbox') === 'true'; } catch (eF) {}
    var h = getMyHandle();
    if (h && h !== 'unknown') {
      var already = !forceInbox
        && sessionStorage.getItem(K.SK_CHAT_AUTO_RUN) === 'true'
        && coIsRunning('chat')
        && coEngineAlive('chat');
      if (already) {
        Logger.info('调度', '私信已在运行，跳过重复 start');
        return;
      }
      // SCRM 门禁：常规模式执行；强制测试模式本地放行
      if (!forceInbox) {
        var gate = getScrmGateSync();
        if (gate && !gate.allow_chat) {
          Logger.info('调度', 'SCRM闸门拦截私信: ' + (gate.reason || '未放行'));
          refreshScrmGate();
          return;
        }
        // 4.4.1：fail-open —— 闸门未就绪不拦截，直接放行
        if (!gate) {
          refreshScrmGate(); // 后台异步刷新，不阻塞
        }
      }
      sessionStorage.setItem(K.SK_CHAT_AUTO_RUN, 'true');
      localStorage.setItem(K.LK_CHAT_STATUS, 'running');
      localStorage.setItem(K.LK_CHAT_RECOVERY, 'true');
      S.chatPhase = 'running';
      var dest = resolveChatStartUrl(targetUrl);
      if (!dest) {
        Logger.info('调度', '私信日帽已满，跳过启动');
        return;
      }
      Logger.info('调度', (forceInbox ? '私信测试' : '启动私信') + ' → ' + dest);
      window.dispatchEvent(new CustomEvent('sg-chat-command', { detail: { command: 'start', targetUrl: dest } }));
    }
  }

  // ==================== 主循环 ====================
  // V5 tick 已退役 — 由 Coordinator 全权接管

  // ==================== 控制接口 ====================
  /** 当前业务模块：chat > follow > nurture */
  function resolveRunningModule() {
    try {
      if (coEngineAlive('chat') || coIsRunning('chat')) return 'chat';
      if (coEngineAlive('follow') || coIsRunning('follow')) return 'follow';
      if (coEngineAlive('nurture') || coIsRunning('nurture')) return 'nurture';
      if (coEngineAlive('repost') || coIsRunning('repost')) return 'repost';
    } catch (eRm) {}
    try {
      if (sessionStorage.getItem(K.SK_CHAT_AUTO_RUN) === 'true') return 'chat';
      if (localStorage.getItem(K.LK_FOLLOW_RUNNING) === 'true') return 'follow';
      if (sessionStorage.getItem(K.SK_NURTURE_RUNNING) === 'true') return 'nurture';
      if (sessionStorage.getItem(K.SK_REPOST_RUNNING || 'sg_repost_running') === 'true') return 'repost';
    } catch (e2) {}
    return null;
  }

  function buildRuntimeHeartbeatPayload(kind) {
    var autoOn = !!(S.running || coRunning);
    var rn = resolveRunningModule();
    var st = coPrev.stage || 'S0';
    try { if (typeof StageDetector !== 'undefined') st = StageDetector.detect().stage || st; } catch (eSt) {}
    var why = '';
    try {
      if (!rn) why = computeWhyIdle({ autoMode: autoOn, stage: st, runningModule: rn });
    } catch (eWhy) {}
    var engine = rn || (autoOn ? 'coor' : 'idle');
    return {
      bot_id: getWorkerId(),
      heartbeat_kind: kind || 'full',
      engine: engine,
      stage: st,
      running_module: rn,
      why_idle: why || '',
      followed_today: getFollowedToday(),
      follow_limit: getLimit(),
      auto_mode: autoOn,
      url: (typeof location !== 'undefined' ? location.href : '') || '',
      chat_rounds_today: S.chatRoundsToday || 0
      // 转帖来源号以 OPS 为准，心跳不再回写 targets，避免冲掉后台配置
    };
  }

  var _sgHbLastAt = 0;
  function pushRuntimeHeartbeat(kind, force) {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
      if (!getWorkerId()) return; // 未提取合法 handle：不发心跳，防幽灵
      var now = Date.now();
      var k = kind || 'full';
      // full 默认 30s 节流；edge / force 立刻发
      if (!force && k === 'full' && _sgHbLastAt && (now - _sgHbLastAt) < 28000) return;
      _sgHbLastAt = now;
      var payload = buildRuntimeHeartbeatPayload(k);
      if (!payload.bot_id) return;
      chrome.runtime.sendMessage({ action: 'ops_account_heartbeat', payload: payload }, function () {
        void chrome.runtime.lastError;
      });
    } catch (eHb) {}
  }

  function ackRemoteCommand(cmd, ok) {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
      chrome.runtime.sendMessage({
        action: 'ops_remote_command_ack',
        bot_id: getWorkerId(),
        command: cmd,
        ok: ok !== false,
        auto_mode: !!(S.running || coRunning),
        running_module: resolveRunningModule()
      }, function () { void chrome.runtime.lastError; });
    } catch (eAck) {}
  }

  function schedulerStart() {
    setUserPaused(false);
    // 冻结账号禁止被远程/本地 start 再次拉起（需人工清 sg_state.accountFrozen）
    try {
      var fzFlag = !!S.accountFrozen;
      if (!fzFlag) {
        var sgFz = {};
        try { sgFz = JSON.parse(localStorage.getItem('sg_state') || '{}') || {}; } catch (eR) { sgFz = {}; }
        fzFlag = !!sgFz.accountFrozen;
      }
      if (fzFlag) {
        Logger.warn('调度', '账号已冻结，拒绝启动');
        S.accountFrozen = true;
        S.running = false;
        saveSG();
        try { coPauseScheduler(); } catch (eP) {}
        return false;
      }
    } catch (eFzGate) {}
    // 人机验证页禁止启动；仅冷却熔断时，人工点启动可解除
    try {
      if (typeof ChallengeGuard !== 'undefined') {
        var chNow = ChallengeGuard.detect ? ChallengeGuard.detect() : { hit: false };
        if (chNow && chNow.hit) {
          Logger.warn('调度', '仍在验证页，拒绝启动（请先完成验证）');
          return false;
        }
        if (ChallengeGuard.isFused && ChallengeGuard.isFused() && ChallengeGuard.clearFuse) {
          ChallengeGuard.clearFuse();
          Logger.info('调度', '人工启动，已解除验证熔断冷却');
        }
      }
    } catch (eChStart) {}
    try { sessionStorage.removeItem('sg_chat_force_inbox'); } catch (eFI) {}
    stopAll(); S.running = true; S.engine = 'idle'; S.followRound = 0; S.followPhase = 'idle';
    S.currentBlogger = ''; S.warmupEndAt = 0; S.chatPhase = 'idle'; S.suspendedBlogger = ''; S.pendingChat = false;
    S.nurtureOnly = false;
    Logger.info('调度', '自动模式启动');
    var regId = getWorkerId();
    if (!regId) {
      Logger.warn('调度', '尚未提取到合法账号 ID，跳过 OPS 注册（防幽灵）');
    } else {
    chrome.runtime.sendMessage({ action: 'ops_account_register', bot_id: regId }, function (r) {
      if (r && r.ok) {
        Logger.info('调度', 'OPS注册: Day ' + r.account.day_count);
        try {
          if (Array.isArray(r.fleet_handles)) {
            localStorage.setItem('sg_fleet_handles', JSON.stringify(
              r.fleet_handles.map(function (h) {
                return String(h || '').replace(/^@/, '').replace(/#guard$/i, '').toLowerCase().trim();
              }).filter(Boolean)
            ));
          }
        } catch (eFleet) {}
        try {
          if (r.account && r.account.day_count != null && typeof ConfigSync !== 'undefined' && ConfigSync.applyRemoteDayCount) {
            ConfigSync.applyRemoteDayCount(
              r.account.day_count,
              r.account.x_handle || getWorkerId(),
              r.account.today_follow_count != null ? r.account.today_follow_count : r.today_follow_count
            );
          } else if (r.account && r.account.day_count != null) {
            // ConfigSync 未暴露时直接写本地（跨日必须清零配额）
            var h = String(r.account.x_handle || getMyHandle() || '').replace(/^@/, '').replace(/#guard$/i, '').toLowerCase();
            if (h) {
              var key = 'matrix_stats_' + h;
              var stats = {};
              try { stats = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (eS) {}
              var todayKey = '';
              try { todayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }); } catch (eD) {}
              var prevD = String(stats.date || '');
              var prevKey = '';
              var mD = prevD.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
              if (mD) prevKey = mD[1] + '-' + String(mD[2]).padStart(2, '0') + '-' + String(mD[3]).padStart(2, '0');
              var rolledLocal = !prevKey || prevKey !== todayKey;
              if (rolledLocal) {
                stats.follows_today = 0;
                delete stats.daily_limit;
              }
              var ft = r.account.today_follow_count != null ? r.account.today_follow_count : r.today_follow_count;
              var localF = parseInt(stats.follows_today, 10) || 0;
              var resetDayHb = '';
              try {
                var rdRaw = String(stats.follows_reset_day || '');
                var mRd = rdRaw.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
                if (mRd) resetDayHb = mRd[1] + '-' + String(mRd[2]).padStart(2, '0') + '-' + String(mRd[3]).padStart(2, '0');
              } catch (eRd) {}
              var skipBoostHb = !!(resetDayHb && todayKey && resetDayHb === todayKey && !rolledLocal);
              if (ft != null) {
                var remoteF = parseInt(ft, 10) || 0;
                if (rolledLocal) {
                  stats.follows_today = remoteF;
                  try { delete stats.follows_reset_day; } catch (eDelHb) {}
                } else if (remoteF > localF && !skipBoostHb) {
                  stats.follows_today = remoteF;
                }
              }
              if (stats.follows_today == null) stats.follows_today = 0;
              stats.date = todayKey || stats.date;
              stats.day_count = parseInt(r.account.day_count, 10) || stats.day_count || 1;
              localStorage.setItem(key, JSON.stringify(stats));
            }
          }
        } catch (eDay) {}
      }
    });
    } // end else register
    saveSG();
    coStartScheduler({ forcePrepare: true });
    try { pushRuntimeHeartbeat('full', true); } catch (eHbS) {}
    return true;
  }
  function schedulerPause() {
    try { sessionStorage.removeItem('sg_chat_force_inbox'); } catch (e) {}
    try {
      if (typeof ProfileClone !== 'undefined' && ProfileClone.abort) ProfileClone.abort('user_stop');
    } catch (ePc2) {}
    stopAll(); S.running = false; S.engine = 'idle'; S.followPhase = 'idle';
    // 清掉软风控钉养号的残留状态，防止停后被 tick 余震拉起来
    try { S.nurtureOnly = false; } catch (eNo) {}
    try { sessionStorage.removeItem(K.SK_TAB_RUNNING); } catch (eTab) {}
    try { sessionStorage.removeItem('sg_debt_only'); } catch (eDebt) {}
    try { sessionStorage.removeItem('sg_repost_auto_slot'); } catch (eRpSlot) {}
    setUserPaused(true);
    Logger.info('调度', '暂停'); saveSG(); coPauseScheduler();
    try { sessionStorage.removeItem('sg_scheduler_booted'); } catch (e) {}
    try { pushRuntimeHeartbeat('full', true); } catch (eHbP) {}
  }

  // 关注引擎检测到「账号已被冻结」→ 停全模块（follow 侧也会发 runtime pause）
  try {
    document.addEventListener('sg-account-frozen', function (ev) {
      var h = (ev && ev.detail && ev.detail.handle) || getMyHandle();
      Logger.warn('调度', '账号冻结，停止所有模块 @' + h);
      schedulerPause();
      try {
        S.accountFrozen = true;
        saveSG();
      } catch (eFz) {}
    });
  } catch (eFzL) {}
  function manualFollow() { try { sessionStorage.removeItem('sg_chat_force_inbox'); } catch (e) {} stopChat(); stopNurture(); stopRepost(); S.running = false; coPauseScheduler(); saveSG(); startFollow(); }
  function manualChat() { try { sessionStorage.removeItem('sg_chat_force_inbox'); } catch (e) {} stopFollow(); stopNurture(); stopRepost(); S.running = false; coPauseScheduler(); saveSG(); startChat(); }
  /** 私信强制测试：绕过债务/日帽，走粉丝页 outbound 登记（非蓝点守箱） */
  function manualChatTest() {
    stopFollow(); stopNurture(); stopRepost();
    S.running = false; coPauseScheduler(); saveSG();
    try { sessionStorage.removeItem('sg_chat_force_inbox'); } catch (eF) {}
    try { sessionStorage.removeItem('sg_debt_only'); } catch (eD) {}
    try {
      var sgT = coLoadSg();
      sgT.softRiskUntil = Date.now() + 20 * 60 * 1000;
      sgT.softRiskMode = 'ice_then_scan';
      sgT.softRiskOutboundDone = false;
      sgT.softRiskChatDone = false;
      sgT.running = true;
      coSaveSg(sgT);
    } catch (eSg) {}
    try { sessionStorage.setItem('dan_chat_phase', 'outbound'); } catch (ePh) {}
    var host = '';
    try {
      host = (sessionStorage.getItem('dan_target_username') || localStorage.getItem('matrix_my_handle') || '')
        .replace('@', '').replace('#guard', '').toLowerCase();
    } catch (eH) { host = ''; }
    Logger.info('调度', '私信测试 → 粉丝页 outbound 登记（4.1.5 一窗一遍）');
    startChat(host ? ('https://x.com/' + host + '/followers') : 'https://x.com/home');
  }
  function manualNurture() { try { sessionStorage.removeItem('sg_chat_force_inbox'); } catch (e) {} stopFollow(); stopChat(); stopRepost(); S.running = false; coPauseScheduler(); saveSG(); startNurture(); }
  function manualRepost() {
    try { sessionStorage.removeItem('sg_chat_force_inbox'); } catch (e) {}
    stopFollow(); stopChat(); stopNurture();
    S.running = false;
    coPauseScheduler();
    saveSG();
    try {
      if (typeof RepostTracker !== 'undefined') {
        if (RepostTracker.clearAutoSlotFlag) RepostTracker.clearAutoSlotFlag();
        // 打断自动场时回到 idle，避免手动中途退出后夜场误续跑旧 running
        try {
          var st = RepostTracker.getAutoStatus && RepostTracker.getAutoStatus();
          if (st === 'running') {
            localStorage.setItem('sg_repost_auto_status', 'idle');
            localStorage.removeItem('sg_repost_auto_started_at');
            sessionStorage.removeItem('sg_repost_round_boot');
          }
        } catch (eSt) {}
        sessionStorage.setItem('sg_repost_manual_slot', '1');
      }
    } catch (e) {}
    startRepost('', { autoSlot: false, freshRound: true });
  }
  function toggleNurtureOnly() {
    S.nurtureOnly = !S.nurtureOnly;
    if (S.nurtureOnly) {
      stopFollow(); stopChat(); S.running = true; coPauseScheduler();
      Logger.info('调度', '养号独立模式: ON');
    } else {
      stopNurture(); S.engine = 'idle';
      Logger.info('调度', '养号独立模式: OFF');
    }
    saveSG();
  }

  // ==================== 面板 ====================
  function updatePanel() {
    try {
      var nuStats = {};
      try {
        if (typeof NurtureTracker !== 'undefined' && NurtureTracker.getStats) {
          var ns = NurtureTracker.getStats();
          if (ns.daily && ns.daily.used) {
            nuStats.likes = ns.daily.used.likes || 0;
            nuStats.comments = ns.daily.used.comments || 0;
            nuStats.likeBudget = (ns.daily.budget && ns.daily.budget.likes) ? ns.daily.budget.likes : 0;
            nuStats.commentBudget = (ns.daily.budget && ns.daily.budget.comments) ? ns.daily.budget.comments : 0;
          }
        }
      } catch (e) {}
      window.dispatchEvent(new CustomEvent('sg-scheduler-tick', { detail: {
        engine: S.engine, followRound: S.followRound, followPhase: S.followPhase,
        warmupEndAt: S.warmupEndAt, autoMode: S.running, pendingChat: S.pendingChat, chatPhase: S.chatPhase,
        chatRoundsToday: S.chatRoundsToday, nurtureOnly: S.nurtureOnly,
        followRunning: localStorage.getItem(K.LK_FOLLOW_RUNNING) === 'true',
        chatRunning: sessionStorage.getItem(K.SK_CHAT_AUTO_RUN) === 'true',
        nurtureRunning: sessionStorage.getItem(K.SK_NURTURE_RUNNING) === 'true',
        nurtureDaily: nuStats,
        profileClone: profileCloneSnap(),
        warmupNeeded: localStorage.getItem(K.LK_WARMUP_NEEDED) === 'true',
        dayCount: getDayCount(), followedToday: getFollowedToday(), followLimit: getLimit(),
        isChatTime: readWorkChatHours().isChatTime, isWorkTime: readWorkChatHours().isWorkTime,
        currentCreator: S.currentBlogger || localStorage.getItem(K.LK_CURRENT_CREATOR) || '',
        suspended: S.suspendedBlogger, url: window.location.href,
        stage: g_stage,
      }}));
    } catch (e) {}
  }

  // ==================== 初始化 ====================
  function init() {
    loadSG();
    saveSG(); updatePanel();

    // Coordinator — 智能调度唯一大脑
    window.addEventListener('sg-coordinator-tick', function (e) {
      if (e.detail && e.detail.stage) g_stage = e.detail.stage;
    });
    window.addEventListener('sg-coordinator-command', function (e) {
      var d = e.detail;
      if (d.action === 'stop') {
        if (d.module === 'nurture') { stopNurture(); if (window._lastModuleAction) window._lastModuleAction.nurture = Date.now(); }
        if (d.module === 'follow')  { stopFollow();  if (window._lastModuleAction) window._lastModuleAction.follow  = Date.now(); }
        if (d.module === 'chat')    { stopChat();    if (window._lastModuleAction) window._lastModuleAction.chat    = Date.now(); }
      }
      if (d.action === 'start') {
        if (d.module === 'nurture') {
          if (Date.now() - _lastCoorNurtureStart > 30000) { startNurture(); _lastCoorNurtureStart = Date.now(); }
          if (window._lastModuleAction) window._lastModuleAction.nurture = Date.now();
        }
        if (d.module === 'follow')  { startFollow(); if (window._lastModuleAction) window._lastModuleAction.follow = Date.now(); }
        if (d.module === 'chat')    { startChat();   if (window._lastModuleAction) window._lastModuleAction.chat   = Date.now(); }
      }
    });
    if (typeof Coordinator !== 'undefined') {
      var msCheckOld = function () {
        try {
          var raw = localStorage.getItem('sg_module_switches');
          if (raw) { var sw = JSON.parse(raw); return function (m) { return sw[m] !== false; }; }
        } catch (e) {}
        return function () { return true; };
      };
      window._lastModuleAction = { follow: Date.now(), chat: Date.now(), nurture: Date.now() };
      window.addEventListener('matrix-nurture-log', function () { if (window._lastModuleAction) window._lastModuleAction.nurture = Date.now(); });
      window.addEventListener('matrix-follow-status', function () { if (window._lastModuleAction) window._lastModuleAction.follow = Date.now(); });
      var msOnOld = msCheckOld();
      Coordinator.register('nurture', { canRun: function () { return msOnOld('nurture'); }, start: function (u) { startNurture(u); }, stop: function () { stopNurture(); } });
      Coordinator.register('follow',  { canRun: function (s) {
        if (!msOnOld('follow')) return false;
        try {
          if (isChatRushActive(coLoadSg())) return false;
          if (softRiskActive(coLoadSg(), Date.now())) return false;
        } catch (eF) {}
        return true;
      }, start: function (u) { startFollow(u); }, stop: function () { stopFollow(); } });
      Coordinator.register('chat',    { canRun: function (s) {
        if (!msOnOld('chat')) return false;
        try {
          if (isChatRushActive(coLoadSg())) return true;
          var sgC = coLoadSg();
          if (softRiskActive(sgC, Date.now()) && !sgC.softRiskChatDone) return true;
        } catch (eC) {}
        return s === 'S3';
      }, start: function (u) { startChat(u); }, stop: function () { stopChat(); } });
      Coordinator.init();
      Coordinator.start();
      Logger.info('调度','Coordinator 启动');
    }

    // 内置调度核心 (无条件启动，不依赖 Coordinator)
    coInit();
  }

  // ==================== 内置调度核心 ====================
  // 从 coordinator.js 合并进来，避免隔离世界加载问题
  var coModules = {};
  var coPrev = { stage: 'S0' };
  var coPrevStage = 'S0';
  var coFirstTick = true;
  var coPrevWorkTime = null; // 4.3.24：用「进工作窗」触发早间整页刷新（不再依赖 S0）
  var coTimer = null, coWdTimer = null, coLastTick = 0;
  var coTickLock = false, coRunning = false;
  var coMaxRun = { chat: 30 * 60 * 1000, follow: 90 * 60 * 1000, nurture: 15 * 60 * 1000, repost: 60 * 60 * 1000 };

  /** 关注配额完成度 0–1；未知当 1 */
  function followQuotaRatio() {
    try {
      var used = getFollowedToday();
      var lim = getLimit();
      if (!(lim > 0)) return 1;
      return Math.max(0, Math.min(1, used / lim));
    } catch (e) { return 1; }
  }

  /** 软风控只认平台蓝条；关注轮可长时间连续点，超时仅模块轮转不进软窗 */
  function followMaxRunMs() {
    return coMaxRun.follow;
  }

  try {
    if (typeof window !== 'undefined') {
      window.__sgGetFollowLimit = getLimit;
      window.__sgFollowQuotaRatio = followQuotaRatio;
    }
  } catch (eExp) {}

  function repostMaxRunMs() {
    try {
      if (typeof RepostTracker !== 'undefined' && RepostTracker.getMaxMinutes) {
        return Math.max(10, RepostTracker.getMaxMinutes()) * 60 * 1000;
      }
    } catch (e) {}
    return 60 * 60 * 1000;
  }

  function moduleSwitchOn(name) {
    try {
      var raw = localStorage.getItem('sg_module_switches');
      if (!raw) return true;
      var sw = JSON.parse(raw);
      // 转帖默认开：缺省键视为 true；显式 false 才关
      if (name === 'repost') return sw.repost !== false;
      return sw[name] !== false;
    } catch (e) { return true; }
  }

  /** 转帖：私信时段内禁止进 priority；非私信时段可由独占路径拉起 */
  function stripRepostFromPriority(list) {
    if (!list || !list.length) return list || [];
    var chatOn = false;
    try { chatOn = !!readWorkChatHours().isChatTime; } catch (e) { chatOn = false; }
    if (chatOn) return list.filter(function (n) { return n !== 'repost'; });
    return list;
  }

  /** 工作窗 end≥24（全天）时永不进 S0，与 test24h 一样：到期后仍须独占拉起转帖 */
  function workHoursEndFullDay() {
    try {
      var p = JSON.parse(localStorage.getItem('sg_stage_policy') || '{}');
      var eh = parseInt(p.workHours && p.workHours.end && p.workHours.end[0], 10);
      if (!isFinite(eh) || eh >= 24) return true;
    } catch (e) {}
    try {
      if (typeof StageDetector !== 'undefined' && StageDetector.getStagePolicy) {
        var p2 = StageDetector.getStagePolicy() || {};
        var eh2 = parseInt(p2.workHours && p2.workHours.end && p2.workHours.end[0], 10);
        if (!isFinite(eh2) || eh2 >= 24) return true;
      }
    } catch (e2) {}
    return false;
  }

  /** 转帖可跑：非私信时段 + 模块开 + 有博主 + 本日未完成 + 已到开跑时刻 */
  function nightRepostShouldRun() {
    try {
      // 硬闸：私信时段绝不转帖（与私信零撞车）
      try {
        if (readWorkChatHours().isChatTime) return false;
      } catch (eChat) {}
      if (!moduleSwitchOn('repost')) return false;
      if (typeof RepostTracker === 'undefined') return false;
      RepostTracker.ensureAutoDay();
      // 本日标成 done/timeout 但实际 0 条：多半是假收工，允许重试
      try {
        if (RepostTracker.isAutoFinishedToday && RepostTracker.isAutoFinishedToday()) {
          var used = 0;
          try { used = ((RepostTracker.getDaily && RepostTracker.getDaily()) || {}).count || 0; } catch (eU) {}
          if (used <= 0 && RepostTracker.resetAutoIdle) {
            RepostTracker.resetAutoIdle('zero_post_retry');
          } else if (used <= 0) {
            try {
              localStorage.setItem('sg_repost_auto_status', 'idle');
              localStorage.removeItem('sg_repost_auto_started_at');
              sessionStorage.removeItem('sg_repost_auto_slot');
              sessionStorage.removeItem('sg_repost_round_boot');
            } catch (eRst) {}
          }
        }
      } catch (eZero) {}
      if (RepostTracker.isAutoFinishedToday()) return false;
      if (!RepostTracker.getTargets().length) return false;
      if (RepostTracker.isAutoTimedOut()) return false;
      if (RepostTracker.dailyExhausted && RepostTracker.dailyExhausted()) return false;
      // 手动转帖：用户主动启动即放行，跳过 19:00 时段判定（避免白天手动测试被协调器误杀）
      var isManualSlot = false;
      try { isManualSlot = sessionStorage.getItem('sg_repost_manual_slot') === '1'; } catch (eMs) {}
      if (isManualSlot) return true;
      if (RepostTracker.isInRepostWindowNow && !RepostTracker.isInRepostWindowNow()) return false;
      else if (!RepostTracker.isInRepostWindowNow && RepostTracker.isPastStartTime && !RepostTracker.isPastStartTime()) return false;
      return true;
    } catch (e) { return false; }
  }

  function nightRepostForceTimeout() {
    try {
      if (typeof RepostTracker !== 'undefined' && RepostTracker.markAutoTimeout) {
        RepostTracker.markAutoTimeout();
      }
    } catch (e) {}
    stopRepost('timeout');
    try { coStop('repost'); } catch (e2) {}
  }

  function coStateKey(n) { return 'sg_module_' + n; }
  function coRead(n) { try { var r = sessionStorage.getItem(coStateKey(n)); return r ? JSON.parse(r) : { running: false, phase: 'idle', targetUrl: '', startedAt: 0, lastActive: 0 }; } catch (e) { return { running: false, phase: 'idle', targetUrl: '', startedAt: 0, lastActive: 0 }; } }
  function coWrite(n, s) { try { sessionStorage.setItem(coStateKey(n), JSON.stringify(s)); } catch (e) {} }
  function coIsRunning(n) { return coRead(n).running === true; }

  var CHAT_PROGRESS_STALE_MS = 45000;
  var CHAT_PROGRESS_KEY_CO = 'sg_chat_last_progress_at';
  var CHAT_LEASE_KEY_CO = 'sg_chat_lease';

  function readChatLeaseCo() {
    try { return JSON.parse(sessionStorage.getItem(CHAT_LEASE_KEY_CO) || 'null'); } catch (e) { return null; }
  }

  function writeChatLeaseCo(lease) {
    try { sessionStorage.setItem(CHAT_LEASE_KEY_CO, JSON.stringify(lease || {})); } catch (e) {}
  }

  function clearChatLeaseCo() {
    try { sessionStorage.removeItem(CHAT_LEASE_KEY_CO); } catch (e) {}
    try {
      if (typeof SgTelemetry !== 'undefined' && SgTelemetry.clearRoundStartDedupe) {
        SgTelemetry.clearRoundStartDedupe();
      } else {
        sessionStorage.removeItem('sg_chat_round_start_emitted_pulse');
      }
    } catch (eD) {}
  }

  function chatProgressAgeMsCo() {
    var t = 0;
    try { t = parseInt(sessionStorage.getItem(CHAT_PROGRESS_KEY_CO) || '0', 10) || 0; } catch (e) { t = 0; }
    if (!t) return 1e12;
    return Date.now() - t;
  }

  function isChatProgressAliveCo() {
    return chatProgressAgeMsCo() < CHAT_PROGRESS_STALE_MS;
  }

  function noteChatProgressCo(why) {
    try {
      sessionStorage.setItem(CHAT_PROGRESS_KEY_CO, String(Date.now()));
      sessionStorage.setItem('sg_chat_last_progress_why', String(why || ''));
    } catch (e) {}
  }

  /** 假活回收：停 chat、交回指挥权；未读未解不烧 softRiskChatDone；并诊断冻结取证 */
  function reclaimChatZombieCo(why) {
    var age = chatProgressAgeMsCo();
    var urlNow = '';
    var chatPh = '';
    try { urlNow = String((typeof location !== 'undefined' && location.href) || ''); } catch (eU) {}
    try { chatPh = sessionStorage.getItem('dan_chat_phase') || ''; } catch (eCp) {}
    var onPin = /\/i\/chat\/pin|passcode|dm_pin/i.test(urlNow)
      || (sessionStorage.getItem('sg_dm_pin_give_up') === '1');
    var freezeMod = 'chat_outbound';
    var label = '私信假活';
    if (onPin || why === 'pin_blocked') {
      freezeMod = 'chat_pin';
      label = 'PIN卡死';
    } else if (chatPh === 'outbound' || chatPh === 'followup') {
      freezeMod = 'chat_outbound';
      label = '出站假活';
    }
    Logger.warn('Coor', 'chat 假活回收 why=' + (why || '') + ' progressAge=' + Math.round(age / 1000) + 's label=' + label);
    try {
      if (typeof SgTelemetry !== 'undefined') {
        SgTelemetry.emit('scheduler.chat_zombie_reclaim', {
          why: why || '',
          progress_age_ms: age,
          url: urlNow,
          phase: chatPh || '',
          chat_phase: chatPh,
          label: label,
          pulseId: (function () {
            try {
              var L = readChatLeaseCo();
              if (L && L.pulseId) return L.pulseId;
            } catch (e1) {}
            return '';
          })(),
          unread_unresolved: !!softPulseUnreadUnresolved()
        });
      }
    } catch (eT) {}
    try {
      // PIN 运维卡死：停 chat 交回关注即可，避免整号诊断冻结到手动解冻
      var skipFreeze = (why === 'pin_blocked' || onPin);
      if (!skipFreeze && typeof SgDiagContract !== 'undefined' && SgDiagContract.enterFreeze) {
        SgDiagContract.enterFreeze({
          module: freezeMod,
          stage: chatPh || 'executing',
          reason: 'zombie_' + (why || 'stale'),
          code: 'diag_zombie',
          hint: label + '：' + (why || '') + ' 进度 ' + Math.round(age / 1000) + 's 无刷新 → 已冻结取证',
          pulseId: (function () {
            try {
              var L2 = readChatLeaseCo();
              return (L2 && L2.pulseId) || '';
            } catch (e3) { return ''; }
          })(),
          extra: { progress_age_ms: age, reclaim_why: why || '', chat_phase: chatPh, url: urlNow }
        });
      }
    } catch (eFz) {}
    try { sessionStorage.removeItem('sg_dm_pin_give_up'); } catch (eGu) {}
    try {
      // 未读未开：禁止异常路径烧尽软窗；其余假活必须推进软风控相位，否则无限 +5m 占死关注
      if (!softPulseUnreadUnresolved()) {
        var softNow = coLoadSg();
        var softPhNow = (softNow && softNow.softRiskPhase) || '';
        var inSoftChat = softRiskActive(softNow) && (softPhNow === 'chat1' || softPhNow === 'chat2');
        if (inSoftChat) {
          try { markSoftRiskChatDoneOnAbnormal(); } catch (eM) {}
        }
      }
    } catch (eAb) {}
    try { stopChat(); } catch (eS) {}
    try {
      coWrite('chat', { running: false, phase: 'idle', targetUrl: '', startedAt: 0, lastActive: Date.now() });
    } catch (eW) {}
    clearChatLeaseCo();
    try { sessionStorage.setItem(K.SK_CHAT_AUTO_RUN, 'false'); } catch (eA) {}
    // 假活回收时清挂起开人，避免 keep 永远卡在 opening 空转
    try {
      sessionStorage.removeItem('dan_auto_step');
      sessionStorage.removeItem('current_target');
    } catch (eOp) {}
  }

  try {
    if (typeof window !== 'undefined') {
      window.__sgReclaimChatZombie = reclaimChatZombieCo;
      window.__sgGetMyHandle = getMyHandle;
      if (!window.__sgDmPinGiveUpBound) {
        window.__sgDmPinGiveUpBound = true;
        window.addEventListener('sg-dm-pin-give-up', function () {
          try { sessionStorage.setItem('sg_dm_pin_give_up', '1'); } catch (e1) {}
          try { reclaimChatZombieCo('pin_blocked'); } catch (e2) {}
        });
      }
    }
  } catch (eExp) {}

  /** 引擎是否真在跑（不单信 sg_module_*.running） */
  function coEngineAlive(name) {
    if (name === 'follow') {
      // 领号/刚 coStart：LK 可能尚未由引擎心跳确认，宽限内判活防幽灵清标+双 pop
      if (coModuleStartingGrace('follow') || isFollowPopFlight()) return true;
      if (localStorage.getItem(K.LK_FOLLOW_RUNNING) !== 'true'
        || sessionStorage.getItem(K.SK_TAB_RUNNING) === 'stopped_by_user') {
        return false;
      }
      // 幽灵守卫：运行旗标在、但关注引擎心跳已写 phase=idle（引擎循环确认死亡）
      // 若仍判活，coTick 会一直 hasRun=true，永不重新拉起 → 永久卡在某个页面
      try {
        var fMs = JSON.parse(sessionStorage.getItem('sg_module_follow') || '{}');
        if (fMs.phase === 'idle') return false;
      } catch (eF) {}
      return true;
    }
    if (name === 'chat') {
      if (sessionStorage.getItem(K.SK_CHAT_AUTO_RUN) !== 'true') return false;
      try {
        var cMs = JSON.parse(sessionStorage.getItem('sg_module_chat') || '{}');
        var cPh = cMs.phase || '';
        if (cPh === 'idle' || cPh === 'completed' || cPh === 'done') return false;
      } catch (eC) {}
      var chatPhaseAlive = '';
      try { chatPhaseAlive = sessionStorage.getItem('dan_chat_phase') || ''; } catch (eP0) {}
      var sgAlive = coLoadSg();
      return true;
    }
    if (name === 'nurture') {
      if (coModuleStartingGrace('nurture')) return true;
      if (sessionStorage.getItem(K.SK_NURTURE_RUNNING) === 'true') return true;
      try {
        if (typeof EngineUtils !== 'undefined' && EngineUtils.isRunning) return !!EngineUtils.isRunning('nurture');
      } catch (e) {}
      return false;
    }
    if (name === 'repost') {
      if (sessionStorage.getItem(K.SK_REPOST_RUNNING || 'sg_repost_running') === 'true') return true;
      try {
        if (typeof EngineUtils !== 'undefined' && EngineUtils.isRunning) return !!EngineUtils.isRunning('repost');
      } catch (eR) {}
      return false;
    }
    return false;
  }

  function coGentleStopFollow() {
    var m = coModules.follow;
    if (m) { m._state = 'stopped'; m._startedAt = 0; }
    coWrite('follow', { running: false, phase: 'soft_cooldown', targetUrl: '', startedAt: 0, lastActive: Date.now() });
    try { localStorage.removeItem(K.LK_FOLLOW_RUNNING); } catch (eLf) {}
    Logger.info('Coor', '关注填窗：协调器轻量收尾');
  }

  function coStop(n) {
    var m = coModules[n]; try { if (m && typeof m.stop === 'function') m.stop(); } catch (e) {}
    if (m) { m._state = 'stopped'; m._startedAt = 0; }
    coWrite(n, { running: false, phase: 'idle', targetUrl: '', startedAt: 0, lastActive: Date.now() });
    Logger.info('Coor','停止: '+n);
  }

  function coStart(n, url) {
    var m = coModules[n]; if (!m) return;
    try {
      if (typeof SgDiagContract !== 'undefined' && SgDiagContract.isFrozen()) {
        Logger.warn('Coor', '诊断冻结中，拒绝启动 ' + n + ' — ' + ((SgDiagContract.readFreeze() || {}).hint || ''));
        return;
      }
    } catch (eFz) {}
    // 账号永久冻结：拒绝再启任何引擎
    try {
      var sgAf = coLoadSg();
      if (S.accountFrozen || sgAf.accountFrozen) {
        Logger.warn('Coor', '账号已冻结，拒绝启动 ' + n);
        return;
      }
    } catch (eAf) {}
    // 慢网跳页节流：距上次整页导航不足间隔则本 tick 推迟（避免连环 sg-*-command）
    try {
      if (isAutoMode() && url) {
        var minGap = 30000; // 4.6.23：10s→30s，减少连环跳转，给页面足够加载时间
        try {
          if (typeof SchedulerGate !== 'undefined' && SchedulerGate.navMinIntervalMs) {
            minGap = SchedulerGate.navMinIntervalMs();
          } else {
            var thr = JSON.parse(localStorage.getItem('sg_config_thresholds') || '{}');
            var ng = parseInt(thr.nav_min_interval_ms, 10);
            if (ng >= 2000 && ng <= 120000) minGap = ng;
          }
        } catch (eNg) {}
        var lastNav = 0;
        try {
          if (typeof SchedulerGate !== 'undefined' && SchedulerGate.lastNavAt) lastNav = SchedulerGate.lastNavAt() || 0;
          if (!lastNav) lastNav = parseInt(sessionStorage.getItem('sg_last_nav_at') || '0', 10) || 0;
        } catch (eLn) {}
        var needJump = true;
        try {
          var cur = String(location.href || '').split('#')[0].replace(/\/$/, '');
          var dest = String(url || '').split('#')[0].replace(/\/$/, '');
          if (cur && dest && cur === dest) needJump = false;
        } catch (eCmp) {}
        if (needJump && lastNav > 0 && (Date.now() - lastNav) < minGap) {
          Logger.info('Coor', '跳页节流中，推迟启动 ' + n + '（剩' + Math.ceil((minGap - (Date.now() - lastNav)) / 1000) + 's）');
          return;
        }
      }
    } catch (eDefer) {}
    // 4.3.32：取消私信天数限制，Day1 即可私信（原 Day≥3 闸门已移除）
    // 4.2.26：废除 Day≤2 须先养号才开关注（养号常空转导致整天 0 粉）；仍保留 prefer 养号在前
    if (!url && n !== 'chat') {
      Logger.warn('Coor', '拒绝启动 ' + n + '：目标页为空');
      return;
    }
    try { if (typeof m.start === 'function') m.start(url); } catch (e) {
      Logger.warn('Coor', '启动 ' + n + ' 异常: ' + (e && e.message ? e.message : e));
      return;
    }
    // follow：startFollow 若因软风控自停，禁止再强写 running（幽灵旗标根因之一）
    if (n === 'follow') {
      try {
        var sgAfter = coLoadSg();
        if (softRiskActive(sgAfter, Date.now())) {
          Logger.warn('Coor', '启动 follow 后仍在软风控，不置 running');
          try { localStorage.removeItem(K.LK_FOLLOW_RUNNING); } catch (eRm) {}
          return;
        }
      } catch (eAfter) {}
    }
    m._state = 'running'; m._startedAt = Date.now();
    coWrite(n, { running: true, phase: 'starting', targetUrl: url || '', startedAt: m._startedAt, lastActive: m._startedAt });
    if (n === 'follow') {
      try {
        var sgF = coLoadSg();
        sgF.followRoundStartedAt = m._startedAt;
        sgF.followRoundPlanMs = followMaxRunMs();
        coSaveSg(sgF);
      } catch (eFr) {}
    }
    if (n === 'chat') {
      try {
        var sgC = coLoadSg();
        var uChat = String(url || '').toLowerCase();
        var isInboxUrl = uChat.indexOf('/i/chat') >= 0 || uChat.indexOf('/messages') >= 0;
        var lease = {
          pulseId: 'lease_' + Date.now().toString(36),
          intent: isInboxUrl ? 'inbox' : 'outbound',
          startedAt: Date.now(),
          url: url || ''
        };
        writeChatLeaseCo(lease);
        noteChatProgressCo('co_start');
        try {
          if (typeof SgTelemetry !== 'undefined' && SgTelemetry.emitRoundStart) {
            SgTelemetry.emitRoundStart({
              module: 'chat',
              intent: lease.intent,
              pulseId: lease.pulseId,
              url: lease.url,
              via: 'coStart'
            });
          } else if (typeof SgTelemetry !== 'undefined') {
            SgTelemetry.emit('scheduler.round_start', {
              module: 'chat',
              intent: lease.intent,
              pulseId: lease.pulseId,
              url: lease.url
            });
          }
        } catch (eRs) {}
        if (softRiskActive(sgC, Date.now())) {
          // 4.1.36：守箱废除后粉丝队列两检都不要 soft drain(5开/4分) 帽，否则 chat2 被掐轮转不过来
          clearChatSessionCaps();
        } else if (isInboxUrl) {
          clearChatSessionCaps();
        } else {
          clearChatSessionCaps();
        }
      } catch (eCs) {}
    }
    Logger.info('Coor','启动: '+n);
  }

  function coLoadSg() { try { return JSON.parse(localStorage.getItem(K.LK_STATE) || '{}'); } catch (e) { return {}; } }
  function coSaveSg(s) { try { localStorage.setItem(K.LK_STATE, JSON.stringify(s)); } catch (e) {} }

  function softRiskActive(sg, now) {
    if (!sg) return false;
    now = now || Date.now();
    var until = sg.softRiskUntil || 0;
    // until 已清零却相位残留：不活跃（须由 apply/reconcile 清场），禁止永久挡关注
    if (!(until > 0)) return false;
    // 五段轮次：有 until 时以相位为准收尾（含已过期，靠加班/推进），不靠闹钟砍半截
    var phase = sg.softRiskPhase || '';
    if (phase === 'chat1' || phase === 'nurture' || phase === 'chat2') return true;
    return now < until;
  }

  /** until=0 或已非活跃但仍有相位/mode：强制清场回关注 */
  function purgeStaleSoftRisk(sg, reason) {
    if (!sg) return false;
    var phase = sg.softRiskPhase || '';
    var hasPhase = phase === 'chat1' || phase === 'nurture' || phase === 'chat2';
    var until = sg.softRiskUntil || 0;
    if (!hasPhase && !sg.softRiskMode && !(until > 0)) return false;
    if (until > 0 && softRiskActive(sg)) return false;
    try { if (coIsRunning('nurture')) coStop('nurture'); } catch (eN) {}
    try { if (coIsRunning('chat')) coStop('chat'); } catch (eC) {}
    clearSoftRiskFields(sg);
    sg.followNextDelayUntil = 0;
    sg.chatNextAllowedAt = 0;
    coSaveSg(sg);
    Logger.info('Coor', '软风控残留清场 → 回关注 reason=' + (reason || 'stale'));
    try {
      if (typeof SgTelemetry !== 'undefined') {
        SgTelemetry.emit('scheduler.soft_risk_round_end', { reason: reason || 'stale_purge' });
      }
    } catch (eT) {}
    return true;
  }
  /** 填窗：chat2 预留毫秒；剩余不足则跳过中间养号 */
  var SOFT_CHAT2_RESERVE_MS = 4 * 60 * 1000;
  var SOFT_SKIP_NURTURE_MS = 3 * 60 * 1000;
  /** chat1/chat2 超窗续跑：单次 +5m，累计封顶 15m（防无限续窗占死关注） */
  var SOFT_OVERTIME_SLICE_MS = 5 * 60 * 1000;
  var SOFT_OVERTIME_MAX_MS = 15 * 60 * 1000;

  function clearSoftRiskFields(sg) {
    if (!sg) return;
    sg.softRiskUntil = 0;
    sg.softRiskMode = '';
    sg.softRiskChatDone = false;
    sg.softRiskOutboundDone = false;
    sg.softRiskIceExtendMs = 0;
    sg.softRiskOvertimeMs = 0;
    sg.softRiskPhase = '';
    sg.softRiskChatPass = 0;
    sg.softRiskStartedAt = 0;
    sg.softFillMode = '';
    try {
      sessionStorage.removeItem('sg_soft_risk_pulse_retry');
      sessionStorage.removeItem('sg_soft_risk_pulse_reason');
      sessionStorage.removeItem('sg_soft_unread_retry');
    } catch (e) {}
    // 软风控窗结束：把关注模块从终态 soft_cooldown 收成 idle，避免幽灵旗标 ↔ 再启循环
    try {
      var ms = coRead('follow');
      if (ms && (ms.phase === 'soft_cooldown' || ms.phase === 'done' || ms.phase === 'completed') && !ms.running) {
        coWrite('follow', {
          running: false,
          phase: 'idle',
          targetUrl: '',
          startedAt: 0,
          lastActive: Date.now()
        });
      }
      if (sessionStorage.getItem(K.SK_TAB_RUNNING) === 'soft_fill') {
        sessionStorage.removeItem(K.SK_TAB_RUNNING);
      }
      // stopFollow 进软窗会写 stopped_by_user；清窗后若不摘掉，Gate 会一直「follow 未授权」
      if (sessionStorage.getItem(K.SK_TAB_RUNNING) === 'stopped_by_user') {
        sessionStorage.removeItem(K.SK_TAB_RUNNING);
      }
    } catch (eMs) {}
    try { clearChatSessionCaps(); } catch (eCap) {}
  }

  /** 有界私信会话：SOFT drain N/T；窗外短打断 M/T2 */
  var CHAT_SOFT_DRAIN_MAX_OPENS = 5;
  var CHAT_SOFT_DRAIN_MAX_MS = 4 * 60 * 1000;
  var CHAT_INTERRUPT_MAX_OPENS = 2;
  var CHAT_INTERRUPT_MAX_MS = 2 * 60 * 1000;
  var SOFT_ICE_EXTEND_SLICE_MS = 5 * 60 * 1000;
  var SOFT_ICE_EXTEND_MAX_MS = 30 * 60 * 1000;
  var SOFT_ICE_EXTEND_WHEN_LEFT_MS = 90 * 1000;

  function softIceExtendMaxMs() {
    return SOFT_ICE_EXTEND_MAX_MS;
  }

  function softOvertimeMaxMs() {
    return SOFT_OVERTIME_MAX_MS;
  }

  /**
   * 仅 chat1（第一检）未完成时顺延软窗，防到期砍半截。
   * chat2 / 养号中段不顺延。距到期 <90s：+5min，单窗累计上限 +30min。
   */
  function maybeExtendSoftRiskForIce(sg, now) {
    now = now || Date.now();
    if (!sg) return false;
    if (sg.softRiskChatDone) return false;
    var phase = sg.softRiskPhase || 'chat1';
    if (phase !== 'chat1') return false;
    if ((sg.softRiskChatPass || 0) >= 1) return false;
    var until = sg.softRiskUntil || 0;
    if (!(until > 0)) return false;
    var left = until - now;
    if (left >= SOFT_ICE_EXTEND_WHEN_LEFT_MS) return false;
    var used = sg.softRiskIceExtendMs || 0;
    var iceMax = softIceExtendMaxMs();
    if (used >= iceMax) return false;
    var add = Math.min(SOFT_ICE_EXTEND_SLICE_MS, iceMax - used);
    if (add <= 0) return false;
    sg.softRiskUntil = now + add;
    sg.softRiskIceExtendMs = used + add;
    if ((sg.followNextDelayUntil || 0) < sg.softRiskUntil) {
      sg.followNextDelayUntil = sg.softRiskUntil;
    }
    coSaveSg(sg);
    Logger.info('Coor', 'chat1 未完成顺延软窗 +' + Math.round(add / 60000) + 'm 累计=' + Math.round(sg.softRiskIceExtendMs / 60000) + 'm');
    try {
      if (typeof SgTelemetry !== 'undefined') {
        SgTelemetry.emit('scheduler.soft_ice_extend', {
          add_ms: add,
          total_extend_ms: sg.softRiskIceExtendMs,
          pass: 1
        });
      }
    } catch (eT) {}
    return true;
  }

  /**
   * chat1/chat2 闹钟已到但段未完：有限续窗。
   * @returns {'extended'|'capped'|'noop'}
   */
  function trySoftRiskOvertimeExtend(sg, now, phase) {
    now = now || Date.now();
    if (!sg) return 'noop';
    phase = phase || sg.softRiskPhase || '';
    if (phase !== 'chat1' && phase !== 'chat2') return 'noop';
    var used = parseInt(sg.softRiskOvertimeMs, 10) || 0;
    var otMax = softOvertimeMaxMs();
    if (used >= otMax) return 'capped';
    var add = Math.min(SOFT_OVERTIME_SLICE_MS, otMax - used);
    if (add <= 0) return 'capped';
    sg.softRiskUntil = now + add;
    sg.softRiskOvertimeMs = used + add;
    if ((sg.followNextDelayUntil || 0) < sg.softRiskUntil) {
      sg.followNextDelayUntil = sg.softRiskUntil;
    }
    coSaveSg(sg);
    Logger.info('Coor', phase + ' 超窗续预算 +' + Math.round(add / 60000) + 'm 累计加班=' + Math.round(sg.softRiskOvertimeMs / 60000) + 'm');
    try {
      if (typeof SgTelemetry !== 'undefined') {
        SgTelemetry.emit('scheduler.soft_overtime_extend', {
          phase: phase,
          add_ms: add,
          total_overtime_ms: sg.softRiskOvertimeMs
        });
      }
    } catch (eT) {}
    return 'extended';
  }

  /** 超窗加班封顶：推进相位，禁止无限占死关注 */
  function forceSoftRiskOvertimeCap(sg, phase, reason) {
    sg = sg || coLoadSg();
    phase = phase || sg.softRiskPhase || '';
    Logger.warn('Coor', '软风控加班封顶 → 推进相位 phase=' + phase + ' reason=' + (reason || ''));
    try {
      if (typeof SgTelemetry !== 'undefined') {
        SgTelemetry.emit('scheduler.soft_overtime_cap', {
          phase: phase,
          overtime_ms: sg.softRiskOvertimeMs || 0,
          reason: reason || ''
        });
      }
    } catch (eT) {}
    if (phase === 'chat2') {
      markSoftRiskChatPass2Done('overtime_cap_' + (reason || ''));
      return 'follow';
    }
    // chat1 封顶：跳进养号/chat2，勿继续占 chat
    markSoftRiskChatPass1Done('overtime_cap_' + (reason || ''));
    var sg2 = coLoadSg();
    return (sg2.softRiskPhase === 'chat2') ? 'chat' : 'nurture';
  }

  function clearChatSessionCaps() {
    try {
      sessionStorage.removeItem('sg_chat_session_kind');
      sessionStorage.removeItem('sg_chat_session_opens');
      sessionStorage.removeItem('sg_chat_session_deadline');
      sessionStorage.removeItem('sg_chat_session_max_opens');
      sessionStorage.removeItem('sg_chat_interrupt_until');
    } catch (e) {}
  }

  function resetChatSessionCaps(kind, maxOpens, maxMs) {
    try {
      sessionStorage.setItem('sg_chat_session_kind', String(kind || 'soft'));
      sessionStorage.setItem('sg_chat_session_opens', '0');
      sessionStorage.setItem('sg_chat_session_deadline', String(Date.now() + (maxMs || CHAT_SOFT_DRAIN_MAX_MS)));
      sessionStorage.setItem('sg_chat_session_max_opens', String(maxOpens || CHAT_SOFT_DRAIN_MAX_OPENS));
    } catch (e) {}
  }

  function getChatSessionOpenCount() {
    try { return parseInt(sessionStorage.getItem('sg_chat_session_opens') || '0', 10) || 0; } catch (e) { return 0; }
  }

  function chatSessionCapReached() {
    try {
      var maxO = parseInt(sessionStorage.getItem('sg_chat_session_max_opens') || '0', 10) || 0;
      var dl = parseInt(sessionStorage.getItem('sg_chat_session_deadline') || '0', 10) || 0;
      if (maxO > 0 && getChatSessionOpenCount() >= maxO) return true;
      if (dl > 0 && Date.now() >= dl) return true;
    } catch (e) {}
    return false;
  }

  function beginSoftRiskChatSession() {
    resetChatSessionCaps('soft', CHAT_SOFT_DRAIN_MAX_OPENS, CHAT_SOFT_DRAIN_MAX_MS);
  }

  function beginInterruptChatSession() {
    resetChatSessionCaps('interrupt', CHAT_INTERRUPT_MAX_OPENS, CHAT_INTERRUPT_MAX_MS);
    try {
      sessionStorage.setItem('sg_chat_interrupt_until', sessionStorage.getItem('sg_chat_session_deadline') || '');
    } catch (e) {}
  }

  if (typeof window !== 'undefined') {
    window.__sgBeginSoftRiskChatSession = beginSoftRiskChatSession;
    window.__sgBumpChatSessionOpen = function () {
      try {
        var n = getChatSessionOpenCount() + 1;
        sessionStorage.setItem('sg_chat_session_opens', String(n));
        return n;
      } catch (e) { return 0; }
    };
  }

  /** Day≤2（或 nurture-only 模式）：软窗到期清场回关注，绝不进 chat2 */
  function endSoftRiskNurtureOnly(sg, reason) {
    sg = sg || coLoadSg();
    try { if (coIsRunning('nurture')) coStop('nurture'); } catch (eN) {}
    try { if (coIsRunning('chat')) coStop('chat'); } catch (eC) {}
    clearSoftRiskFields(sg);
    sg.followNextDelayUntil = 0;
    sg.chatNextAllowedAt = 0;
    coSaveSg(sg);
    Logger.info('Coor', '软风控只养号结束 → 回关注 reason=' + (reason || ''));
    try {
      if (typeof SgTelemetry !== 'undefined') {
        SgTelemetry.emit('scheduler.soft_risk_round_end', { reason: reason || 'nurture_only', allow_chat: false });
      }
    } catch (eT) {}
  }

  /** 残留 chat 相位在 Day≤2 / 非私信时段时压成只养号 */
  function coerceSoftRiskNoChat(sg) {
    if (!sg) return sg;
    var ph = sg.softRiskPhase || '';
    if (ph === 'chat1' || ph === 'chat2' || sg.softRiskMode === 'chat_nurture_chat') {
      sg.softRiskMode = 'nurture';
      sg.softRiskPhase = 'nurture';
      sg.softRiskChatDone = true;
      sg.softRiskOutboundDone = true;
      sg.softRiskChatPass = 2;
      coSaveSg(sg);
      try { if (coIsRunning('chat')) coStop('chat'); } catch (eC) {}
      Logger.info('Coor', '非私信条件：软风控相位压成只养号（Day/时段）');
    }
    return sg;
  }

  /** SoftFillMode 单一能力闸：off / nurture_only / chat_fill（SCRM 不参与） */
  function resolveSoftFillModeCo(sg) {
    try {
      if (typeof SgSoftFillMode !== 'undefined' && SgSoftFillMode.resolve) {
        return SgSoftFillMode.resolve({
          day: getDayCount(),
          softRiskMode: sg && sg.softRiskMode
        });
      }
    } catch (e) {}
    var day = 1;
    try { day = getDayCount(); } catch (eD) {}
    var chatModOn = true;
    try { chatModOn = moduleSwitchOn('chat'); } catch (eM) {}
    var chatTimeOk = true;
    try { chatTimeOk = !!readWorkChatHours().isChatTime; } catch (eT) {}
    if (!chatModOn) return { mode: 'off', allowChat: false, reason: 'chat_module_off', day: day };
    if (sg && sg.softRiskMode === 'nurture') {
      return { mode: 'nurture_only', allowChat: false, reason: 'sticky_nurture', day: day };
    }
    // 4.3.32：Day1 即可私信，日龄不再挡
    if (!chatTimeOk) return { mode: 'nurture_only', allowChat: false, reason: 'outside_chat_hours', day: day };
    return { mode: 'chat_fill', allowChat: true, reason: '', day: day };
  }

  /** 窗口内：SoftFillMode=chat_fill → chat1→nurture→chat2；否则只 nurture */
  function applySoftRiskPriority(priority, sg, now) {
    now = now || Date.now();
    if (!sg) return priority || [];
    var until = sg.softRiskUntil || 0;
    var phaseEarly = sg.softRiskPhase || '';
    // until=0 相位/mode 残留：禁止永久挡关注
    if (purgeStaleSoftRisk(sg, 'apply_until0_phase')) {
      return priority || [];
    }
    var fill = resolveSoftFillModeCo(sg);
    var nurtureOnly = !fill.allowChat;

    if (nurtureOnly && softRiskActive(sg, now)) {
      sg = coerceSoftRiskNoChat(sg);
      phaseEarly = sg.softRiskPhase || 'nurture';
    }

    // 闹钟到
    if (until > 0 && now >= until) {
      if (nurtureOnly) {
        endSoftRiskNurtureOnly(sg, 'nurture_timer');
        return priority || [];
      }
      if (phaseEarly === 'chat1') {
        if (!maybeExtendSoftRiskForIce(sg, now)) {
          var ot1 = trySoftRiskOvertimeExtend(sg, now, 'chat1');
          if (ot1 === 'capped') {
            var next1 = forceSoftRiskOvertimeCap(sg, 'chat1', 'timer');
            return next1 === 'follow' ? (priority || []) : [next1];
          }
        }
      } else if (phaseEarly === 'nurture') {
        beginSoftRiskChat2(sg, 'nurture_timer');
        return ['chat'];
      } else if (phaseEarly === 'chat2') {
        var ot2 = trySoftRiskOvertimeExtend(sg, now, 'chat2');
        if (ot2 === 'capped') {
          forceSoftRiskOvertimeCap(sg, 'chat2', 'timer');
          return priority || [];
        }
        return ['chat'];
      } else {
        try { if (coIsRunning('nurture')) coStop('nurture'); } catch (eN0) {}
        try { if (coIsRunning('chat')) coStop('chat'); } catch (eC0) {}
        clearSoftRiskFields(sg);
        sg.followNextDelayUntil = 0;
        sg.chatNextAllowedAt = 0;
        coSaveSg(sg);
        Logger.info('Coor', '软风控无相位残留，清场回关注');
        return priority || [];
      }
    }
    if (!softRiskActive(sg, now)) return priority || [];

    // SoftFillMode≠chat_fill：窗内只养号
    if (nurtureOnly) {
      if (!sg.softRiskPhase || sg.softRiskPhase !== 'nurture') {
        sg.softRiskPhase = 'nurture';
        coSaveSg(sg);
      }
      return ['nurture'];
    }

    try { maybeExtendSoftRiskForIce(sg, now); } catch (eExt) {}
    try {
      if (typeof StageDetector !== 'undefined' && StageDetector.isMorningNurtureOnly && StageDetector.isMorningNurtureOnly()) {
        var phM = sg.softRiskPhase || 'chat1';
        if (phM === 'nurture') return ['nurture'];
      }
    } catch (eM) {}

    var phase = sg.softRiskPhase || 'chat1';
    var pass = parseInt(sg.softRiskChatPass, 10) || 0;
    var left = Math.max(0, (sg.softRiskUntil || 0) - now);

    // chatDone：含 chat2 必须清场回关注（禁止只排 chat 空转）
    if (sg.softRiskChatDone) {
      if (phase === 'chat2') {
        markSoftRiskChatPass2Done('chat_done_sticky');
        return priority || [];
      }
      clearSoftRiskFields(sg);
      sg.followNextDelayUntil = 0;
      sg.chatNextAllowedAt = 0;
      coSaveSg(sg);
      var srcDone = priority || [];
      var outDone = ['follow'];
      for (var id = 0; id < srcDone.length; id++) {
        if (srcDone[id] !== 'follow') outDone.push(srcDone[id]);
      }
      if (outDone.length === 1) outDone.push('nurture');
      return outDone;
    }

    if (phase === 'chat1' || (pass < 1 && phase !== 'nurture' && phase !== 'chat2')) {
      if (!sg.softRiskPhase) {
        sg.softRiskPhase = 'chat1';
        coSaveSg(sg);
      }
      return ['chat'];
    }

    if (phase === 'nurture') {
      if (left <= SOFT_CHAT2_RESERVE_MS) {
        beginSoftRiskChat2(sg, left <= 0 ? 'timer_edge' : 'reserve_hit');
        return ['chat'];
      }
      return ['nurture'];
    }

    if (phase === 'chat2') {
      return ['chat'];
    }

    return ['chat'];
  }

  /** chat1 完成 → 中间养号（时间紧则直接 chat2） */
  function markSoftRiskChatPass1Done(reason) {
    try {
      var sg = coLoadSg();
      var now = Date.now();
      if (!softRiskActive(sg, now)) return;
      if ((sg.softRiskChatPass || 0) >= 1) return;
      var left = Math.max(0, (sg.softRiskUntil || 0) - now);
      sg.softRiskChatPass = 1;
      sg.softRiskOutboundDone = true;
      sg.softRiskChatDone = false;
      if (left < SOFT_SKIP_NURTURE_MS) {
        coSaveSg(sg);
        Logger.info('Coor', 'chat1 完成 → 跳过养号直接 chat2 left=' + Math.round(left / 1000) + 's reason=' + (reason || ''));
        try {
          if (typeof SgTelemetry !== 'undefined') {
            SgTelemetry.emit('scheduler.soft_chat_pass', { pass: 1, next: 'chat2', skip_nurture: true, reason: reason || '' });
          }
        } catch (eT0) {}
        beginSoftRiskChat2(sg, 'skip_nurture_' + (reason || ''));
        return;
      }
      sg.softRiskPhase = 'nurture';
      coSaveSg(sg);
      try { if (coIsRunning('chat')) coStop('chat'); } catch (eSc) {}
      Logger.info('Coor', 'chat1 完成 → 养号中段 reason=' + (reason || ''));
      try {
        if (typeof SgTelemetry !== 'undefined') {
          SgTelemetry.emit('scheduler.soft_chat_pass', { pass: 1, next: 'nurture', reason: reason || '' });
        }
      } catch (eT1) {}
    } catch (e) {}
  }

  /** 进入 chat2：停养号、置相位（SoftFillMode≠chat_fill 禁止） */
  function beginSoftRiskChat2(sg, reason) {
    sg = sg || coLoadSg();
    if (!softRiskActive(sg)) return;
    var fill = resolveSoftFillModeCo(sg);
    if (!fill.allowChat || sg.softRiskMode === 'nurture') {
      endSoftRiskNurtureOnly(sg, 'block_chat2_' + (fill.reason || reason || 'gate'));
      return;
    }
    if (sg.softRiskPhase === 'chat2') return;
    sg.softRiskPhase = 'chat2';
    sg.softRiskChatPass = Math.max(1, parseInt(sg.softRiskChatPass, 10) || 1);
    sg.softRiskChatDone = false;
    coSaveSg(sg);
    try { if (coIsRunning('nurture')) coStop('nurture'); } catch (eN) {}
    Logger.info('Coor', '软风控 → chat2 reason=' + (reason || '') + ' SoftFill=' + fill.mode);
    try {
      if (typeof SgTelemetry !== 'undefined') {
        SgTelemetry.emit('scheduler.soft_chat_pass', { pass: 2, next: 'chat', reason: reason || '', softFillMode: fill.mode });
      }
    } catch (eT) {}
    try {
      window.dispatchEvent(new CustomEvent('sg-soft-risk-chat2-start', {
        detail: { reason: reason || '', until: sg.softRiskUntil || 0, softFillMode: fill.mode }
      }));
    } catch (eEv) {}
  }

  /** chat2 完成 → 本轮结束，清干净后回关注（新轮从关注重新计） */
  function markSoftRiskChatPass2Done(reason) {
    try {
      var sg = coLoadSg();
      try { if (coIsRunning('nurture')) coStop('nurture'); } catch (eN) {}
      try { if (coIsRunning('chat')) coStop('chat'); } catch (eC) {}
      clearSoftRiskFields(sg);
      sg.followNextDelayUntil = 0;
      sg.chatNextAllowedAt = 0;
      // 不留长冷却：下一轮只靠「再点满约 15 关注」触发
      coSaveSg(sg);
      try { sessionStorage.removeItem('sg_soft_chat2_prepared'); } catch (eP) {}
      Logger.info('Coor', '本轮软风控结束（chat2 完成）→ 回关注 reason=' + (reason || ''));
      try {
        if (typeof SgTelemetry !== 'undefined') {
          SgTelemetry.emit('scheduler.soft_chat_pass', { pass: 2, next: 'follow', reason: reason || '', round_end: true });
          SgTelemetry.emit('scheduler.soft_risk_round_end', { reason: reason || 'chat2_done' });
        }
      } catch (eT) {}
    } catch (e) {}
  }

  /**
   * 软风控窗内 priority 只有 chat，但 SCRM/预算/无 URL 等闸门挡死 → 空转。
   * chat1：走 markSoftRiskChatPass1Done（含近窗尾 skip→chat2）；chat2：清窗回关注。
   * 注意：markSoftRisk* 内部 coLoadSg，调用方必须在返回后 sg=coLoadSg()。
   * @returns {'nurture'|'follow'|null}
   */
  function softRiskChatBlockedFallback(sg, reason) {
    if (!sg || !softRiskActive(sg)) return null;
    var phase = sg.softRiskPhase || 'chat1';
    try {
      if (typeof SgTelemetry !== 'undefined') {
        SgTelemetry.emit('scheduler.soft_risk_chat_blocked_fallback', {
          reason: reason || '',
          phase: phase
        });
      }
    } catch (eT) {}
    var decide = null;
    try {
      if (typeof SgSoftRiskFallbackDecision !== 'undefined' && SgSoftRiskFallbackDecision.softRiskChatBlockedDecision) {
        decide = SgSoftRiskFallbackDecision.softRiskChatBlockedDecision;
      }
    } catch (eD) {}
    if (phase === 'chat2') {
      markSoftRiskChatPass2Done('chat_blocked_' + (reason || 'gate'));
      Logger.info('Coor', '软风控 chat2 被挡 → 清窗回关注 reason=' + (reason || ''));
      return (decide ? decide({ softRiskActive: true, phase: 'chat2' }) : 'follow');
    }
    // chat1 / 未知：与正常收工同路径（近窗尾会 skip nurture 直进 chat2）
    markSoftRiskChatPass1Done('chat_blocked_' + (reason || 'gate'));
    var after = coLoadSg();
    var phAfter = (after && after.softRiskPhase) || 'nurture';
    var out = decide
      ? decide({ softRiskActive: true, phase: phase, afterPhase: phAfter })
      : (phAfter === 'chat2' ? 'follow' : 'nurture');
    if (out === 'follow') {
      markSoftRiskChatPass2Done('chat_blocked_skip_' + (reason || 'gate'));
      Logger.info('Coor', '软风控 chat1 被挡且近窗尾→chat2 同挡 → 清窗回关注 reason=' + (reason || ''));
      return 'follow';
    }
    Logger.info('Coor', '软风控 chat 被挡 → 回退养号 reason=' + (reason || '') + ' phase=' + phase);
    return 'nurture';
  }

  function markSoftRiskChatDone() {
    // 兼容旧调用：仅 phase=chat2 才当第二检结束
    try {
      var sg = coLoadSg();
      var phase = sg.softRiskPhase || 'chat1';
      if (phase === 'chat2') markSoftRiskChatPass2Done('legacy_mark_done');
      else markSoftRiskChatPass1Done('legacy_mark_done');
    } catch (e) {}
  }

  /** 兼容旧名：破冰/第一检完成 → 进入养号（或时间紧则 chat2） */
  function markSoftRiskOutboundDone(reason) {
    markSoftRiskChatPass1Done(reason || 'outbound_done');
  }

  function isSoftRiskOutboundPhaseCo(sg) {
    sg = sg || coLoadSg();
    var phase = (sg && sg.softRiskPhase) || 'chat1';
    return softRiskActive(sg) && !sg.softRiskChatDone && phase === 'chat1';
  }

  if (typeof window !== 'undefined') {
    window.__sgMarkSoftRiskOutboundDone = markSoftRiskOutboundDone;
    window.__sgMarkSoftRiskChatDone = markSoftRiskChatDone;
    window.__sgMarkSoftRiskChatPass1Done = markSoftRiskChatPass1Done;
    window.__sgMarkSoftRiskChatPass2Done = markSoftRiskChatPass2Done;
  }

  /** 引擎假死/超时：按当前 phase 完结，不进收件箱 */
  function markSoftRiskChatDoneOnAbnormal() {
    try {
      if (!softRiskActive(coLoadSg(), Date.now())) return;
      var sgAb = coLoadSg();
      var phase = sgAb.softRiskPhase || 'chat1';
      if (phase === 'chat2') {
        markSoftRiskChatPass2Done('abnormal');
      } else if (phase === 'nurture') {
        // 养号中假死：直接进 chat2，勿当第二检结束清窗
        beginSoftRiskChat2(sgAb, 'abnormal_nurture');
      } else {
        markSoftRiskChatPass1Done('abnormal');
      }
    } catch (e) {
      markSoftRiskChatDone();
    }
  }
  function softRiskSnapshot(sg, now) {
    now = now || Date.now();
    sg = sg || coLoadSg();
    // 与 softRiskActive 同一套语义，避免面板「已结束」但调度仍挡关注
    if (!softRiskActive(sg, now)) {
      return { active: false, remainSec: 0, mode: '', chatDone: false, phase: '' };
    }
    var until = sg.softRiskUntil || 0;
    return {
      active: true,
      remainSec: until > now ? Math.ceil((until - now) / 1000) : 0,
      mode: sg.softRiskMode || 'chat_nurture_chat',
      chatDone: !!sg.softRiskChatDone,
      outboundDone: !!sg.softRiskOutboundDone,
      phase: sg.softRiskPhase || '',
      pass: parseInt(sg.softRiskChatPass, 10) || 0
    };
  }

  function isSoftRiskChatWindowCo(sg) {
    sg = sg || coLoadSg();
    var phase = sg.softRiskPhase || '';
    if (phase === 'chat1' || phase === 'chat2') return true;
    if (phase === 'nurture') return false;
    var now = Date.now();
    if (!(sg.softRiskUntil > now)) return false;
    return !sg.softRiskChatDone;
  }

  function isFollowPhaseTerminal(ph) {
    return ph === 'soft_cooldown' || ph === 'quota_exhausted' || ph === 'completed' || ph === 'done';
  }

  function isFollowRoundActiveCo() {
    try {
      var ms = JSON.parse(sessionStorage.getItem('sg_module_follow') || '{}');
      var ph = ms.phase || '';
      if (isFollowPhaseTerminal(ph)) return false;
      if (ms.running) return true;
      if (localStorage.getItem(K.LK_FOLLOW_RUNNING) === 'true') return true;
      return false;
    } catch (e) {}
    return false;
  }

  /** 与 content_chat shouldDeferChatForFollow 对齐 */
  function shouldDeferChatForFollowCo(sg) {
    if (isSoftRiskChatWindowCo(sg)) return false;
    if (!isFollowRoundActiveCo()) return false;
    // 引擎未活（即使 module.running 幽灵为真）：不当真关注轮，避免私信永久让路
    try {
      if (!coEngineAlive('follow')) return false;
    } catch (eAlive) {}
    try {
      if (typeof isAutoMode === 'function' && isAutoMode()) return true;
    } catch (eA) {}
    return false;
  }

  function reconcileGhostFollowFlags() {
    try {
      var now = Date.now();
      var sg = coLoadSg();
      var mfOn = localStorage.getItem(K.LK_FOLLOW_RUNNING) === 'true';
      var ms = coRead('follow');
      var ph = ms.phase || '';

      // 软风控扫箱段已废除：不再清幽灵 chat 以强拉 /i/chat

      // 过期/残缺软风控：有 until+相位时加班推进；until=0 相位残留强制清场
      var softPh = sg.softRiskPhase || '';
      if ((softPh === 'chat1' || softPh === 'nurture' || softPh === 'chat2') && !(sg.softRiskUntil > 0)) {
        purgeStaleSoftRisk(sg, 'reconcile_until0_phase');
        sg = coLoadSg();
        softPh = sg.softRiskPhase || '';
      } else if (sg.softRiskChatDone && softPh === 'chat2') {
        markSoftRiskChatPass2Done('reconcile_chat_done_sticky');
        sg = coLoadSg();
        softPh = sg.softRiskPhase || '';
      } else if (softPh === 'chat1' || softPh === 'nurture' || softPh === 'chat2') {
        if (sg.softRiskUntil > 0 && now >= sg.softRiskUntil) {
          if (softPh === 'chat1') {
            try { maybeExtendSoftRiskForIce(sg, now); } catch (eEx1) {}
            if ((sg.softRiskUntil || 0) <= now) {
              var otR1 = trySoftRiskOvertimeExtend(sg, now, 'chat1');
              if (otR1 === 'capped') {
                forceSoftRiskOvertimeCap(sg, 'chat1', 'reconcile');
              }
            }
          } else if (softPh === 'nurture') {
            beginSoftRiskChat2(sg, 'reconcile_nurture_timer');
          } else if (softPh === 'chat2') {
            var otR2 = trySoftRiskOvertimeExtend(sg, now, 'chat2');
            if (otR2 === 'capped') {
              forceSoftRiskOvertimeCap(sg, 'chat2', 'reconcile');
            }
          }
        } else if (softPh === 'chat1') {
          try { maybeExtendSoftRiskForIce(sg, now); } catch (eEx2) {}
        }
      } else if (sg.softRiskUntil > 0 && now >= sg.softRiskUntil) {
        clearSoftRiskFields(sg);
        sg.followNextDelayUntil = 0;
        sg.chatNextAllowedAt = 0;
        coSaveSg(sg);
        Logger.info('Coor', 'reconcile：无相位软风控已到期，清理字段');
      } else if (!softRiskActive(sg, now) && (sg.softRiskMode || softPh)) {
        purgeStaleSoftRisk(sg, 'reconcile_stale_mode');
      }

      // 幽灵 running 旗标 / 模块态：引擎未活则清 LK + 压回 module.running
      // 领号 popping/starting 宽限内勿清（否则假关注轮 + 双 pool_pop）
      var followAlive = false;
      try { followAlive = coEngineAlive('follow'); } catch (eFa) {}
      var followStartGrace = false;
      try { followStartGrace = coModuleStartingGrace('follow') || isFollowPopFlight(); } catch (eGr) {}
      if (!followStartGrace && mfOn && (!ms.running || isFollowPhaseTerminal(ph) || !followAlive)) {
        localStorage.removeItem(K.LK_FOLLOW_RUNNING);
        // 勿残留 stopped_by_user，否则下轮 startFollow 前的迟到 followGo 全被 Gate 挡
        try {
          if (sessionStorage.getItem(K.SK_TAB_RUNNING) === 'stopped_by_user') {
            sessionStorage.removeItem(K.SK_TAB_RUNNING);
          }
        } catch (eTabG) {}
        Logger.warn('Coor', '清除幽灵 matrix_follow_running（module 已停/终态/引擎未活）');
        try {
          if (typeof SgTelemetry !== 'undefined') SgTelemetry.emit('scheduler.ghost_follow_flag', {
            phase: ph || '',
            module_running: !!ms.running
          });
        } catch (eT) {}
        try {
          var coolUntil = now + 45 * 1000;
          sg = coLoadSg();
          if (!sg.followNextDelayUntil || sg.followNextDelayUntil < coolUntil) {
            sg.followNextDelayUntil = softRiskActive(sg, now) ? sg.followNextDelayUntil : coolUntil;
            coSaveSg(sg);
          }
        } catch (eCool) {}
        mfOn = false;
      }
      if (!followStartGrace && ms.running && !followAlive && !softRiskActive(sg, now)) {
        try {
          coWrite('follow', {
            running: false,
            phase: isFollowPhaseTerminal(ph) ? 'idle' : (ph === 'active' ? 'idle' : (ph || 'idle')),
            targetUrl: '',
            startedAt: 0,
            lastActive: now
          });
          ms = coRead('follow');
          ph = ms.phase || '';
          Logger.warn('Coor', '清除幽灵 sg_module_follow.running（引擎未活）');
        } catch (eMsClr) {}
      }

      // 非软风控下异常超长关注延迟（>3h）→ 清掉；短于 3h 的故意延迟（SOFT 填窗/HARD）保留
      sg = coLoadSg();
      if (!softRiskActive(sg, now) && sg.followNextDelayUntil && sg.followNextDelayUntil - now > 3 * 3600000) {
        Logger.warn('Coor', '清除异常超长 followNextDelayUntil remain=' + Math.round((sg.followNextDelayUntil - now) / 1000) + 's');
        sg.followNextDelayUntil = 0;
        coSaveSg(sg);
      }

      // 未满配额 + 非软风控 + 无引擎真活：清幽灵 followPhase，让下轮能拉回关注
      var underQuota = true;
      try { underQuota = getFollowedToday() < getLimit(); } catch (eQ) {}
      if (underQuota && !softRiskActive(sg, now)) {
        var anyAlive = false;
        try {
          for (var k in coModules) {
            if (coEngineAlive(k)) { anyAlive = true; break; }
          }
        } catch (eR) {}
        if (!anyAlive) {
          var cleared = false;
          if (S.followPhase === 'active' || S.followPhase === 'soft_cooldown') {
            S.followPhase = 'idle';
            cleared = true;
          }
          if (S.engine === 'follow') {
            S.engine = 'idle';
            cleared = true;
          }
          if (S.chatPhase === 'running' && !coEngineAlive('chat')) {
            S.chatPhase = 'idle';
            cleared = true;
          }
          if (ms.running || isFollowPhaseTerminal(ph) || ph === 'active') {
            try {
              coWrite('follow', {
                running: false,
                phase: 'idle',
                targetUrl: '',
                startedAt: 0,
                lastActive: now
              });
              cleared = true;
            } catch (eW) {}
          }
          if (sessionStorage.getItem(K.SK_TAB_RUNNING) === 'soft_fill' || sessionStorage.getItem(K.SK_TAB_RUNNING) === 'true') {
            try {
              if (!mfOn) sessionStorage.removeItem(K.SK_TAB_RUNNING);
            } catch (eSk) {}
          }
          if (cleared) {
            try { saveSG(); } catch (eSv) {}
            try {
              if (typeof SgTelemetry !== 'undefined') {
                SgTelemetry.emit('scheduler.follow_idle_recover', {
                  followed: getFollowedToday(),
                  limit: getLimit(),
                  phase_was: ph || S.followPhase || ''
                });
              }
            } catch (eTe) {}
            Logger.warn('Coor', '未满配额空转恢复：清幽灵 followPhase/终态，下轮拉回关注');
          }
        }
      }
    } catch (eG) {}
  }

  function isActionableAdEntryCo(entry) {
    if (!entry || entry.done || (entry.round || 0) !== 1) return false;
    var iceAt = entry.iceSentAt || 0;
    if (iceAt && entry.lastInboundAt && entry.lastInboundAt > iceAt) return true;
    try {
      if (typeof window !== 'undefined' && typeof window.__sgChatDebtCounts === 'function') {
        var c = window.__sgChatDebtCounts();
        if ((c.actionableAd || 0) > 0) return true;
      }
    } catch (eC) {}
    return false;
  }

  function countChatFreezePending(sg) {
    sg = sg || coLoadSg();
    var handles = sg.chatFreezeHandles;
    if (!Array.isArray(handles) || !handles.length) return 0;
    var db = loadChatTargetDBNested();
    var n = 0;
    for (var i = 0; i < handles.length; i++) {
      var h = handles[i];
      var e = db[h];
      if (!e || e.done || (e.round || 0) >= 3) continue;
      if ((e.round || 0) < 1) continue;
      if ((e.round || 0) === 1) {
        if (!isActionableAdEntryCo(e)) continue;
        n++;
        continue;
      }
      if ((e.round || 0) === 2 && !isActionableKickOrRepairCo(e)) continue;
      n++;
    }
    return n;
  }

  /** 读取当前 bot 嵌套 chat_target_db（兼容旧扁平结构） */
  function loadChatTargetDBNested() {
    var bot = getMyHandle();
    bot = String(bot || '').replace('@', '').replace('#guard', '').toLowerCase();
    if (!bot || bot === 'unknown') return {};
    var root = {};
    try { root = JSON.parse(localStorage.getItem('chat_target_db') || '{}'); } catch (e) {}
    var bucket = root[bot];
    if (bucket && typeof bucket === 'object' && bucket.round === undefined) return bucket;
    var flat = {};
    for (var k in root) {
      var v = root[k];
      if (v && typeof v === 'object' && (v.round !== undefined || v.done !== undefined || v.lastDM !== undefined)) {
        flat[k] = v;
      }
    }
    return flat;
  }

  function canSendKickNowCo(entry) {
    if (!entry || entry.done || (entry.round || 0) !== 2) return false;
    // 4.1.61：与 SgChatGates 对齐——按轮次，不看小时间隔
    return true;
  }

  /** round2 可进箱：催加就绪，或缺广告气泡需补发（与 content_chat isActionableKickEntry 对齐） */
  function isActionableKickOrRepairCo(entry) {
    if (!entry || entry.done || entry.blockedAt || entry.rejectSentAt || (entry.round || 0) !== 2) return false;
    if (!entry.adBubbleOk) return true;
    return canSendKickNowCo(entry);
  }

  /** 软风控 hold 专用：仅催加已就绪，不含「缺 adBubbleOk」脏 repair 堆（避免假债烧 5 开会话帽） */
  function isActionableKickHoldCo(entry) {
    if (!entry || entry.done || entry.blockedAt || entry.rejectSentAt || (entry.round || 0) !== 2) return false;
    return canSendKickNowCo(entry);
  }

  function countActionableKickDebtFromDB() {
    var db = loadChatTargetDBNested();
    var n = 0;
    for (var h in db) {
      if (isActionableKickOrRepairCo(db[h])) n++;
    }
    return n;
  }

  function countActionableKickHoldFromDB() {
    var db = loadChatTargetDBNested();
    var n = 0;
    for (var h in db) {
      if (isActionableKickHoldCo(db[h])) n++;
    }
    return n;
  }

  function softPulseUnreadUnresolved() {
    return false;
  }

  function countChatDebtFromDB() {
    try {
      if (typeof window !== 'undefined' && typeof window.__sgChatDebtCounts === 'function') {
        var c = window.__sgChatDebtCounts();
        return (c.actionableAd || 0) + (c.actionableKick || 0);
      }
    } catch (eWin) {}
    return countActionableKickDebtFromDB();
  }

  function countChatDebtBreakdown() {
    var db = loadChatTargetDBNested();
    var ad = 0, kick = 0, ice = 0;
    for (var h in db) {
      var e = db[h];
      if (!e || e.done) continue;
      var r = e.round || 0;
      if (r === 0) ice++;
      else if (r === 1) ad++;
      else if (r === 2) kick++;
    }
    return { adDebt: ad, kickDebt: kick, icePending: ice, targetCount: Object.keys(db).length };
  }

  function getSgParseAgeFn() {
    try {
      if (window.MatrixChatTemplates && typeof window.MatrixChatTemplates.parseAgeFromText === 'function') {
        return window.MatrixChatTemplates.parseAgeFromText;
      }
      if (window.__sgChatAge && typeof window.__sgChatAge.parseAgeFromText === 'function') {
        return window.__sgChatAge.parseAgeFromText;
      }
    } catch (e) {}
    return null;
  }

  function countSlaOverdue() {
    var db = loadChatTargetDBNested();
    var n = 0;
    var now = Date.now();
    for (var h in db) {
      var e = db[h];
      if (!e || e.done) continue;
      if ((e.round || 0) !== 1) continue;
      if ((e.slaDueAt || 0) > 0 && e.slaDueAt <= now) n++;
    }
    return n;
  }

  function buildProdVerifyChecklist(sg, debt) {
    sg = sg || coLoadSg();
    debt = debt || countChatDebtBreakdown();
    var freezePending = countChatFreezePending(sg);
    return [
      { id: 'ice_pending_pool', ok: debt.icePending > 0, label: '破冰池有目标', detail: 'icePending=' + debt.icePending },
      { id: 'ad_debt_watch', ok: debt.adDebt > 0 || debt.icePending > 0, label: 'adDebt 或待破冰', detail: 'adDebt=' + debt.adDebt + ' actionableAd=' + (typeof window.__sgChatDebtCounts === 'function' ? (window.__sgChatDebtCounts().actionableAd || 0) : '?') },
      { id: 'rush_freeze_pending', ok: freezePending >= 0, label: '赶工 pending', detail: 'pending=' + freezePending + ' (round≥1)' }
    ];
  }

  function applyModuleQualityPriority(priority) {
    try {
      if (typeof SgChatStrategy !== 'undefined' && SgChatStrategy.applyModuleQualityPriority) {
        return SgChatStrategy.applyModuleQualityPriority(priority);
      }
    } catch (e) {}
    return priority || [];
  }

  /** 白天养号时段帽让台：关注未满时把 follow 置顶，避免超帽后立刻再启 nurture 空转 */
  var NURTURE_YIELD_MS = 20 * 60 * 1000;
  function applyNurtureYieldPriority(priority, sg, now) {
    sg = sg || coLoadSg();
    now = now || Date.now();
    var src = priority || [];
    if (!src.length) return src;
    if (softRiskActive(sg, now)) return src;
    var until = sg.nurtureYieldUntil || 0;
    if (!(until > now)) return src;
    var followUnder = true;
    try { followUnder = getFollowedToday() < getLimit(); } catch (eL) {}
    if (!followUnder) return src;
    if (!moduleSwitchOn('follow')) return src;
    var hasFollow = false;
    for (var i = 0; i < src.length; i++) if (src[i] === 'follow') hasFollow = true;
    if (!hasFollow) return src;
    var out = ['follow'];
    for (var j = 0; j < src.length; j++) {
      if (src[j] !== 'follow') out.push(src[j]);
    }
    return out;
  }

  function buildChatDiag(sg) {
    sg = sg || coLoadSg();
    var debt = countChatDebtBreakdown();
    var nextAt = sg.chatNextAllowedAt || 0;
    var parseAge = {};
    var parseFn = getSgParseAgeFn();
    if (parseFn) {
      ['25', '二十五', '廿四', 'abc'].forEach(function (s) {
        parseAge[s] = parseFn(s);
      });
    }
    var scriptsVer = null;
    var scriptsSource = null;
    var icePreview = '';
    try {
        var cfgScr = JSON.parse(localStorage.getItem('dan_scripts') || '{}');
        scriptsVer = cfgScr.version;
        scriptsSource = cfgScr.source || (cfgScr.imported_from_json ? 'json' : 'local');
        icePreview = (cfgScr.templates && cfgScr.templates.icebreaker) || (cfgScr.scripts && cfgScr.scripts.v1 && cfgScr.scripts.v1.icebreaker) || '';
        if (icePreview.length > 48) icePreview = icePreview.slice(0, 48) + '…';
    } catch (eSv) {}
    var opsGateReason = null;
    try {
      var scrmG = getScrmGateSync();
      if (scrmG) {
        if (!scrmG.allow_chat) opsGateReason = scrmG.reason || 'scrm_blocked';
        else if (scrmG.force_allow && scrmG.warn_reason) opsGateReason = 'force:' + scrmG.warn_reason;
      }
    } catch (eGate) {}
    var chatPolicy = null;
    try {
      if (typeof SgChatStrategy !== 'undefined') {
        chatPolicy = SgChatStrategy.resolveChatPolicy({ sg: sg, debt: debt.adDebt + debt.kickDebt });
      }
    } catch (ePol) {}
    var timeBudget = null;
    try {
      if (typeof SgTimeBudget !== 'undefined' && SgTimeBudget.snapshot) timeBudget = SgTimeBudget.snapshot(sg);
    } catch (eTb) {}
    var debtOnly = false;
    var actionableAdDebt = 0;
    var actionableKickDebt = 0;
    try {
      debtOnly = sessionStorage.getItem('sg_debt_only') === 'true';
      if (typeof window.__sgChatDebtCounts === 'function') {
        var ac = window.__sgChatDebtCounts();
        actionableAdDebt = ac.actionableAd || 0;
        actionableKickDebt = ac.actionableKick || 0;
      }
    } catch (eSs) {}
    var followMod = null;
    try { followMod = coRead('follow'); } catch (eFm) {}
    var followRoundActive = false;
    try {
      var fph = (followMod && followMod.phase) || '';
      if (!isFollowPhaseTerminal(fph)) {
        if (followMod && followMod.running) followRoundActive = true;
        else if (localStorage.getItem('matrix_follow_running') === 'true') followRoundActive = true;
      }
    } catch (eFa) {}
    return {
      chatNextAllowedAt: nextAt,
      chatCooldownLeftMin: nextAt ? Math.ceil(Math.max(0, nextAt - Date.now()) / 60000) : 0,
      chatTotalTodayMin: Math.round((sg.chatTotalToday || 0) / 60),
      chatInboxTodayMin: Math.round((sg.chatInboxToday || 0) / 60),
      chatOutboundTodayMin: Math.round((sg.chatOutboundToday || 0) / 60),
      dailyCapMin: 240,
      inboxCapMin: 120,
      outboundCapMin: 150,
      adDebt: debt.adDebt,
      kickDebt: debt.kickDebt,
      actionableAdDebt: actionableAdDebt,
      actionableKickDebt: actionableKickDebt,
      icePending: debt.icePending,
      replyPending: countReplyPendingCo(),
      targetDbCount: debt.targetCount,
      slaOverdueCount: countSlaOverdue(),
      opsGateReason: opsGateReason,
      debtOnly: debtOnly,
      chatPolicy: chatPolicy,
      timeBudget: timeBudget,
      prodVerify: buildProdVerifyChecklist(sg, debt),
      scriptsVersion: scriptsVer,
      scriptsSource: scriptsSource,
      icebreakerPreview: icePreview,
      scriptsBootVer: (function () { try { return localStorage.getItem('dan_scripts_boot_ver'); } catch (e) { return null; } })(),
      parseAgeReady: !!parseFn,
      matrixChatTemplatesVersion: (window.MatrixChatTemplates && window.MatrixChatTemplates.version) || null,
      parseAgeSamples: parseAge,
      softRisk: {
        active: softRiskActive(sg),
        until: sg.softRiskUntil || 0,
        mode: sg.softRiskMode || '',
        chatDone: !!sg.softRiskChatDone,
        outboundDone: !!sg.softRiskOutboundDone,
        iceExtendMs: sg.softRiskIceExtendMs || 0,
        remainSec: sg.softRiskUntil ? Math.max(0, Math.ceil((sg.softRiskUntil - Date.now()) / 1000)) : 0
      },
      followRoundStartedAt: sg.followRoundStartedAt || null,
      followRoundPlanMs: sg.followRoundPlanMs || null,
      followRoundEndedAt: sg.followRoundEndedAt || null,
      followRoundActive: followRoundActive,
      replyState: (function () {
        try { return JSON.parse(sessionStorage.getItem('dan_reply_state') || 'null'); } catch (eRS) { return null; }
      })()
    };
  }

  function isChatDailyCapReachedCo(sg) {
    sg = sg || coLoadSg();
    var today = shanghaiDate();
    if (sg.chatDate !== today) return false;
    return (sg.chatTotalToday || 0) >= 240 * 60;
  }

  /** 破冰已发、仍在干等回复的 round1 数（仅统计，不驱动进箱） */
  function countReplyPendingCo() {
    var db = loadChatTargetDBNested();
    var n = 0;
    for (var h in db) {
      var e = db[h];
      if (!e || e.done || e.blockedAt || e.rejectSentAt) continue;
      if ((e.round || 0) !== 1) continue;
      if (!e.iceSentAt) continue;
      n++;
    }
    return n;
  }

  /** 已确认有回复、可行动广告债（驱动进箱 / hold） */
  function countActionableReplyCo() {
    var db = loadChatTargetDBNested();
    var n = 0;
    for (var h in db) {
      var e = db[h];
      if (!e || e.done || e.blockedAt || e.rejectSentAt) continue;
      if ((e.round || 0) !== 1) continue;
      if (!e.iceSentAt) continue;
      var inbound = e.lastInboundAt || 0;
      if (e.replySeenAt || (inbound > e.iceSentAt)) n++;
    }
    return n;
  }

  /**
   * 4.1.38：粉丝队列待处理债（含未写 lastInboundAt 的 need_probe）
   * 满配额后无法再靠关注进软风控时，用此放行窗外短私信。
   */
  function countFanRosterChatDebtCo() {
    var db = loadChatTargetDBNested();
    var n = 0;
    var maxK = 4;
    try {
      if (window.SgChatGates && window.SgChatGates.KICK_MAX_COUNT) maxK = window.SgChatGates.KICK_MAX_COUNT;
    } catch (eK) {}
    for (var h in db) {
      var e = db[h];
      if (!e || e.blockedAt || e.rejectSentAt || e.chatClosedAt) continue;
      var round = e.round || 0;
      if (round === 1 && e.iceSentAt && !e.adSentAt && !e.adBubbleOk) {
        n++;
        continue;
      }
      if (round === 2) {
        var kc = parseInt(e.kickCount, 10) || (e.kickSentAt ? 1 : 0);
        if (kc < maxK) n++;
      }
    }
    return n;
  }

  function hasQuotaFullChatDebtCo() {
    try {
      if (getFollowedToday() < getLimit()) return false;
    } catch (eQ) { return false; }
    try {
      if (countFanRosterChatDebtCo() > 0) return true;
      if (countActionableReplyCo() > 0) return true;
      if (countActionableKickDebtFromDB() > 0) return true;
    } catch (eD) {}
    return false;
  }

  /**
   * 私信启动 URL：守箱废除后永远粉丝页（force 测试也不进 /i/chat）
   */
  function resolveChatStartUrl(explicit) {
    if (explicit) {
      var ex = String(explicit).split('?')[0];
      if (/(?:i\/chat|messages)(?:\/|$|\?|#)/i.test(ex)) {
        var hEx = getMyHandle();
        return 'https://x.com/' + hEx + '/followers';
      }
      return ex;
    }
    try { sessionStorage.removeItem('sg_chat_force_inbox'); } catch (eF) {}
    if (isChatDailyCapReachedCo()) return null;
    var sg = coLoadSg();
    var kickReady = countActionableKickDebtFromDB();
    var actionReply = countActionableReplyCo();

    if (isSoftRiskChatWindowCo(sg)) {
      var hSoft = getMyHandle();
      return 'https://x.com/' + hSoft + '/followers';
    }

    try {
      if (typeof SgChatStrategy !== 'undefined') {
        var policy = SgChatStrategy.resolveChatPolicy({
          sg: sg,
          debt: kickReady,
          replyPending: actionReply,
          kickPending: kickReady
        });
        if (policy && !policy.allowChat) return null;
      }
    } catch (ePol) {}

    try {
      if (typeof SgTimeBudget !== 'undefined' && !SgTimeBudget.canStartPhase('outbound', sg)) {
        return null;
      }
    } catch (eTb2) {}
    var h = getMyHandle();
    return 'https://x.com/' + h + '/followers';
  }

  /** 调度侧也要定格：17 点时可能停在关注页，chat 引擎未跑 */
  function ensureChatFreezeSg(sg) {
    sg = sg || coLoadSg();
    var today = shanghaiDate();
    if (sg.chatFreezeDate && sg.chatFreezeDate !== today) {
      sg.chatFreezeDate = '';
      sg.chatFreezeAt = 0;
      sg.chatFreezeHandles = [];
      coSaveSg(sg);
    }
    var past = false;
    try {
      if (typeof TimeUtil !== 'undefined' && TimeUtil.isPastChatFreeze) past = !!TimeUtil.isPastChatFreeze();
    } catch (e0) {}
    if (!past) {
      // 24h 测试模式：清除已有定格快照，让所有目标可发
      if (sg.chatFreezeDate === today && Array.isArray(sg.chatFreezeHandles)) {
        sg.chatFreezeDate = '';
        sg.chatFreezeAt = 0;
        sg.chatFreezeHandles = [];
        coSaveSg(sg);
      }
      return sg;
    }
    if (sg.chatFreezeDate === today && Array.isArray(sg.chatFreezeHandles)) return sg;
    var db = loadChatTargetDBNested();
    var handles = [];
    for (var h in db) {
      var entry = db[h];
      if (!entry || entry.done || (entry.round || 0) >= 3) continue;
      handles.push(h);
    }
    sg.chatFreezeDate = today;
    sg.chatFreezeAt = Date.now();
    sg.chatFreezeHandles = handles;
    coSaveSg(sg);
    Logger.info('Coor', '私信定格 ' + handles.length + ' 人');
    return sg;
  }

  function isChatRushWindowNow() {
    try {
      return !!(typeof TimeUtil !== 'undefined' && TimeUtil.isChatRushWindow && TimeUtil.isChatRushWindow());
    } catch (e) { return false; }
  }

  /** 赶工中：定格窗内且定格名单仍有 pending */
  function isChatRushActive(sg) {
    if (!isChatRushWindowNow()) return false;
    sg = ensureChatFreezeSg(sg || coLoadSg());
    return countChatFreezePending(sg) > 0;
  }

  /** 赶工私信优先：已停用 */
  function applyChatRushPriority(priority, sg) {
    return priority || [];
  }

  /** S3 私信时段：关注配额未满时 follow 优先于 chat（非软风控/非赶工） */
  function applyFollowFirstInS3(priority, stage, sg) {
    if (stage !== 'S3') return priority || [];
    sg = sg || coLoadSg();
    var now = Date.now();
    if (softRiskActive(sg, now)) return priority || [];
    if (isChatRushActive(sg)) return priority || [];
    try {
      if (getFollowedToday() >= getLimit()) return priority || [];
    } catch (eL) {}
    var src = priority || [];
    var hasFollow = false;
    for (var i = 0; i < src.length; i++) if (src[i] === 'follow') hasFollow = true;
    if (!hasFollow) return src;
    var out = ['follow'];
    for (var j = 0; j < src.length; j++) {
      if (src[j] !== 'follow') out.push(src[j]);
    }
    return out;
  }

  function chatFreezeSnapshot(sg) {
    sg = ensureChatFreezeSg(sg || coLoadSg());
    var today = shanghaiDate();
    var frozen = sg.chatFreezeDate === today && Array.isArray(sg.chatFreezeHandles);
    var pending = frozen ? countChatFreezePending(sg) : 0;
    var rushWin = isChatRushWindowNow();
    return {
      frozen: frozen,
      total: frozen ? (sg.chatFreezeHandles || []).length : 0,
      pending: pending,
      rushing: !!(rushWin && pending > 0),
      rushWindow: rushWin
    };
  }

  function coChatInterval() {
    // 默认 25–35 分钟随机；可被 sg_config_intervals 覆盖
    var minM = 25, maxM = 35;
    try {
      var r = localStorage.getItem('sg_config_intervals');
      if (r) {
        var c = JSON.parse(r);
        if (c.chat_cooldown_min_min != null) minM = parseInt(c.chat_cooldown_min_min, 10) || minM;
        if (c.chat_cooldown_max_min != null) maxM = parseInt(c.chat_cooldown_max_min, 10) || maxM;
      }
    } catch (e) {}
    if (maxM < minM) { var t = minM; minM = maxM; maxM = t; }
    var mins = minM + Math.floor(Math.random() * (maxM - minM + 1));
    return mins * 60 * 1000;
  }

  function chatCooldownLeftMs(sg, now) {
    now = now || Date.now();
    sg = sg || coLoadSg();
    // 4.1.38：仅显式 chatNextAllowedAt 算冷却；废除 chatLastEndAt+55m 兜底（与五段零冷却打架）
    var nextAt = sg.chatNextAllowedAt || 0;
    if (!nextAt) return 0;
    return Math.max(0, nextAt - now);
  }

  /** 空闲原因：自动模式开着但没模块在跑时，给面板一句人话 */
  function computeWhyIdle(opts) {
    opts = opts || {};
    var autoOn = !!(opts.autoMode != null ? opts.autoMode : (coRunning || S.running));
    if (!autoOn) return '未启动自动模式';

    var stage = opts.stage || coPrev.stage || 'S0';
    // 4.3.23：下班仍跑关注/养号；仅真·空 S0（无 priority）才报静默
    if (stage === 'S0') {
      var pri0 = opts.priority || [];
      if (!pri0.length) {
        var nowLbl = '?';
        var workLbl = '?';
        try {
          if (typeof TimeUtil !== 'undefined') {
            nowLbl = TimeUtil.nowLabel() || '?';
            var wh = TimeUtil.readWorkHours ? TimeUtil.readWorkHours() : null;
            if (wh) {
              workLbl = TimeUtil.hmLabel(wh.startH, wh.startM) + '-' + TimeUtil.hmLabel(wh.endH, wh.endM);
            }
          }
        } catch (eWh) {}
        return 'S0待命 now=' + nowLbl + ' work=' + workLbl;
      }
    }

    if (opts.runningModule) return '';

    var sw = { nurture: true, follow: true, chat: true, repost: true };
    try {
      var raw = localStorage.getItem('sg_module_switches');
      if (raw) sw = Object.assign(sw, JSON.parse(raw));
    } catch (e1) {}
    if (sw.follow === false && sw.chat === false && sw.nurture === false && sw.repost === false) return '模块全部关闭';

    var followed = getFollowedToday();
    var limit = getLimit();
    if (followed >= limit) {
      // 限额满时通常仍可养号；若养号也关了才算限额挡死
      if (sw.nurture === false) return '关注已达限 ' + followed + '/' + limit;
    }

    var sg = opts.sg || coLoadSg();
    var now = Date.now();
    sg = ensureChatFreezeSg(sg);
    var priority = opts.priority || [];
    if (!priority.length && typeof StageDetector !== 'undefined') {
      try { priority = (StageDetector.detect().priority) || []; } catch (e2) {}
    }
    priority = applySoftRiskPriority(priority, sg, now);
    // note: computeWhyIdle may not have stage in applyChatFirst — reorder if chat present
    try {
      var stg = opts.stage || coPrev.stage || 'S0';
      priority = applyFollowFirstInS3(priority, stg, sg);
    } catch (eCf) {}
    priority = applyChatRushPriority(priority, sg);
    priority = stripRepostFromPriority(priority);
    priority = applyModuleQualityPriority(priority);
    priority = applyNurtureYieldPriority(priority, sg, now);

    var freezeSnap = chatFreezeSnapshot(sg);
    if (freezeSnap.rushing) {
      return '私信赶工 定格剩 ' + freezeSnap.pending + '/' + freezeSnap.total;
    }
    if (freezeSnap.frozen && !freezeSnap.rushWindow && freezeSnap.pending > 0) {
      return '定格后待明日 ' + freezeSnap.pending + ' 人';
    }

    var soft = softRiskSnapshot(sg, now);
    if (soft.active) {
      return '软风控 ' + soft.remainSec + 's | ' + soft.mode + (soft.chatDone ? '→脉冲完' : '扫描中');
    }

    // SCRM 仅在「本 tick 实际会排到 chat」时作为空闲主因；Day1 养号/关注空闲勿被 SCRM 文案盖住
    try {
      var scrmWhy = getScrmGateSync();
      var chatInPri = false;
      for (var ic = 0; ic < priority.length; ic++) {
        if (priority[ic] === 'chat') { chatInPri = true; break; }
      }
      if (chatInPri && scrmWhy && scrmWhy.force_allow && scrmWhy.warn_reason) {
        return '⚠强制放行: ' + scrmWhy.warn_reason;
      }
      if (chatInPri && scrmWhy && !scrmWhy.allow_chat && scrmWhy.reason) {
        // 若还有养号/关注可跑，先说可跑模块，SCRM 作后缀
        var otherGo = false;
        for (var jo = 0; jo < priority.length; jo++) {
          if (priority[jo] !== 'chat' && sw[priority[jo]] !== false) { otherGo = true; break; }
        }
        if (!otherGo) return scrmWhy.reason;
      }
    } catch (eScrmWhy) {}

    var reasons = [];
    for (var i = 0; i < priority.length; i++) {
      var name = priority[i];
      if (sw[name] === false) { reasons.push(name + '已关'); continue; }
      if (name === 'follow') {
        if (followed >= limit) { reasons.push('关注达限'); continue; }
        var delayUntil = sg.followNextDelayUntil || 0;
        if (now < delayUntil) {
          var left = Math.ceil((delayUntil - now) / 1000);
          reasons.push('池空/冷却 ' + left + 's');
          continue;
        }
        reasons.push('关注可跑');
      } else if (name === 'chat') {
        if (stage !== 'S3') { reasons.push('阶段' + stage + '不跑私信'); continue; }
        if (freezeSnap.rushing) { reasons.push('私信可跑'); continue; }
        var leftCd = chatCooldownLeftMs(sg, now);
        if (leftCd > 0) {
          reasons.push('私信冷却 ' + Math.ceil(leftCd / 60000) + '分');
          continue;
        }
        reasons.push('私信可跑');
      } else if (name === 'nurture') {
        reasons.push('养号可跑');
      } else if (name === 'repost') {
        try {
          var hasT = false;
          if (typeof RepostTracker !== 'undefined') {
            hasT = RepostTracker.getTargets().length > 0;
            if (RepostTracker.dailyExhausted && RepostTracker.dailyExhausted()) {
              reasons.push('转帖日额满');
              continue;
            }
          } else {
            var rt = localStorage.getItem('sg_repost_targets');
            hasT = !!(rt && rt !== '[]');
          }
          if (!hasT) { reasons.push('转帖无来源'); continue; }
        } catch (eRp) { reasons.push('转帖不可用'); continue; }
        reasons.push('转帖可跑');
      }
    }

    if (!priority.length) return '阶段' + stage + '无优先模块';

    // 若全是「可跑」却仍 idle → 调度刚交回 / 瞬时空窗
    var blocked = reasons.filter(function (r) { return r.indexOf('可跑') < 0; });
    if (blocked.length === reasons.length && reasons.length) return blocked[0];
    if (blocked.length) return blocked[0] + (blocked.length > 1 ? ' 等' : '');
    return '等待调度轮转';
  }

  function coRecordDur(kind, startedAt) {
    if (!startedAt) return; var dur = Math.floor((Date.now() - startedAt) / 1000); if (dur <= 0) return;
    try {
      var sg = coLoadSg(); var today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
      var key = kind === 'follow' ? 'followTotalToday' : 'nurtureTotalToday';
      var dk = kind === 'follow' ? 'followDate' : 'nurtureDate';
      if (sg[dk] !== today) { sg[key] = 0; sg[dk] = today; }
      sg[key] = (sg[key] || 0) + dur; coSaveSg(sg);
    } catch (e) {}
  }

  function coTick() {
    if (coTickLock) return; coTickLock = true; coLastTick = Date.now();
    try {
      // 纯维护任务（即使暂停也跑）：本地跨日兜底清零配额
      try { ensureFollowDailyRollover(); } catch (eRoll) {}
      try { ensureNurtureDailyRollover(); } catch (eNurtRoll) {}

      // 快速通道：用户暂停中 → 直接返回，不跑任何调度/检测
      // （避免停了之后 tick 还在做冻结检测、软风控拉养号等"余震"操作）
      if (!coRunning && !S.running) {
        // 仅做一件事：防假活——如果还有 module state 标记 running，清掉
        try {
          ['follow', 'chat', 'nurture', 'repost'].forEach(function (n) {
            try {
              var ms = coRead(n);
              if (ms && ms.running) coStop(n);
            } catch (eAl) {}
          });
        } catch (eAlign) {}
        return;
      }
      // 冻结心跳：自动模式即使停在 /home 养号也要扫永久冻结层（B3 导出）
      try {
        var sgFreeze = coLoadSg();
        if (S.accountFrozen || sgFreeze.accountFrozen) {
          try { if (coRunning || S.running) schedulerPause(); } catch (ePfz) {}
          coSave({ stage: coPrev.stage || 'S0' });
          return;
        }
        if (isAutoMode()) {
          var pathNow = '';
          try { pathNow = String(location.pathname || ''); } catch (eP) {}
          var onHome = pathNow === '/home' || pathNow === '/' || pathNow === '';
          var due = !coPrev._freezeCheckAt || (Date.now() - coPrev._freezeCheckAt >= 30000);
          if (onHome || due) {
            coPrev._freezeCheckAt = Date.now();
            var frozenHit = false;
            if (typeof window.__sgCheckAccountFrozen === 'function') {
              frozenHit = !!window.__sgCheckAccountFrozen(onHome ? 'scheduler_home' : 'scheduler_heartbeat');
            } else if (typeof window.SgFollowRisk !== 'undefined' && window.SgFollowRisk.checkAndHandleFrozen) {
              frozenHit = !!window.SgFollowRisk.checkAndHandleFrozen(onHome ? 'scheduler_home' : 'scheduler_heartbeat');
            }
            if (frozenHit) {
              try { S.accountFrozen = true; saveSG(); } catch (eSv) {}
              coSave({ stage: coPrev.stage || 'S0' });
              return;
            }
          }
        }
      } catch (eFreezeHb) {}

      var stage = 'S0', priority = [];
      if (typeof StageDetector !== 'undefined') { var r = StageDetector.detect(); stage = r.stage; priority = r.priority || []; }
      try {
        var coerced = coerceStageOutOfFalseS0(stage, priority);
        stage = coerced.stage;
        priority = coerced.priority || priority;
      } catch (eCoerceS0) {}
      priority = stripRepostFromPriority(priority);

      // 新号自动上路：Day1 未就绪时优先跑 onboarding（克隆→转帖→就绪）
      var onboardResult = false;
      try { onboardResult = onboardTick(); } catch (eOb) { onboardResult = false; }
      if (onboardResult === true) {
        // onboarding 进行中：独占，其它模块让路
        try {
          if (!coPrev._onboardTickLogAt || Date.now() - coPrev._onboardTickLogAt > 60000) {
            var obSt = getOnboardState() || {};
            Logger.info('Coor', '新号上路中 phase=' + (obSt.phase || '?'));
            coPrev._onboardTickLogAt = Date.now();
          }
        } catch (eObLg) {}
        try {
          var obSt2 = getOnboardState() || {};
          var obPhaseLabel = obSt2.phase || 'idle';
          if (obPhaseLabel === 'cloning') obPhaseLabel = '资料克隆中';
          else if (obPhaseLabel === 'reposting') obPhaseLabel = '转帖中';
          else if (obPhaseLabel === 'waiting_source') obPhaseLabel = '等来源';
          else if (obPhaseLabel === 'failed') obPhaseLabel = '失败:' + (obSt2.lastError || '').slice(0, 20);
          window.dispatchEvent(new CustomEvent('sg-coordinator-tick', {
            detail: {
              engine: 'coor', stage: stage, autoMode: coRunning, runningModule: 'onboarding',
              dayCount: getDayCount(), followedToday: getFollowedToday(), followLimit: getLimit(),
              isChatTime: readWorkChatHours().isChatTime, isWorkTime: readWorkChatHours().isWorkTime,
              followRunning: false, chatRunning: false, nurtureRunning: false,
              repostRunning: false, profileClone: profileCloneSnap(),
              whyIdle: '新号上路: ' + obPhaseLabel,
              onboarding: obSt2
            }
          }));
        } catch (eObTick) {}
        coSave(coPrev);
        return;
      } else if (onboardResult === 'idle_with_nurture') {
        // 等来源阶段：养号可正常排
        // 不拦截，继续走正常调度
      }
      var sgTick = coLoadSg();
      var nowTick = Date.now();
      sgTick = ensureChatFreezeSg(sgTick);
      priority = applyFollowFirstInS3(priority, stage, sgTick);
      priority = applySoftRiskPriority(priority, sgTick, nowTick);
      priority = applyChatRushPriority(priority, sgTick);
      priority = stripRepostFromPriority(priority);
      priority = applyModuleQualityPriority(priority);
      priority = applyNurtureYieldPriority(priority, sgTick, nowTick);
      var softSnap = softRiskSnapshot(sgTick, nowTick);
      // SoftFillMode≠chat_fill：软窗内强制只养号，并停掉已在跑的 chat
      try {
        if (softSnap.active && resolveSoftFillModeCo(sgTick).mode !== 'chat_fill') {
          sgTick = coerceSoftRiskNoChat(sgTick);
          try { if (coIsRunning('chat')) coStop('chat'); } catch (eStopCh) {}
          try { sessionStorage.setItem(K.SK_CHAT_AUTO_RUN, 'false'); } catch (eAuOff) {}
          try { stopChat(); } catch (eScOff) {}
          softSnap = softRiskSnapshot(sgTick, nowTick);
          priority = applySoftRiskPriority(priority, sgTick, nowTick);
          priority = stripRepostFromPriority(priority);
        }
      } catch (eChatOff) {}
      // 软窗内持续钉 soft_fill + 禁关注旗，防止 stopBot/自恢复盖旗后关注抢跑
      try {
        if (softSnap.active) {
          sessionStorage.setItem(K.SK_TAB_RUNNING, 'soft_fill');
          localStorage.removeItem(K.LK_FOLLOW_RUNNING);
          var softPhKick = sgTick.softRiskPhase || '';
          var nurtureOnlyKick = resolveSoftFillModeCo(sgTick).mode !== 'chat_fill';
          if ((softPhKick === 'nurture' || nurtureOnlyKick) && !coEngineAlive('nurture') && !coModuleStartingGrace('nurture')) {
            // 有 hasRun 幽灵时也要在后面启动环拉起；这里只标记，不抢锁
            if (!coPrev._softNurtureMissAt) coPrev._softNurtureMissAt = nowTick;
            if (nowTick - (coPrev._softNurtureMissAt || nowTick) >= 12000) {
              coPrev._softNurtureMissAt = nowTick;
              Logger.warn('Coor', '软窗养号未活，强制重拉 /home');
              try { if (coIsRunning('follow')) coGentleStopFollow(); } catch (eGf) {}
              // 清 hasRun 幽灵 follow，允许本 tick 启动环进 nurture
              try {
                var msF = coRead('follow');
                if (msF && msF.running) {
                  coWrite('follow', { running: false, phase: 'soft_cooldown', targetUrl: '', startedAt: 0, lastActive: nowTick });
                }
              } catch (eMsF) {}
            }
          } else {
            coPrev._softNurtureMissAt = 0;
          }
        }
      } catch (eSoftPin) {}
      var freezeSnap = chatFreezeSnapshot(sgTick);
      // 诊断冻结：停引擎、拒启动；保留现场供取证
      var diagFrozen = false;
      try {
        diagFrozen = typeof SgDiagContract !== 'undefined' && SgDiagContract.isFrozen();
        if (diagFrozen) {
          if (!coPrev._diagEnginesStopped) {
            try { stopChat(); } catch (eSc) {}
            try { coStop('follow'); } catch (eSf) {}
            try { coStop('nurture'); } catch (eSn) {}
            try { sessionStorage.setItem(K.SK_CHAT_AUTO_RUN, 'false'); } catch (eAu) {}
            coPrev._diagEnginesStopped = true;
            Logger.warn('Coor', '诊断冻结生效，已停引擎 — ' + ((SgDiagContract.readFreeze() || {}).hint || ''));
          }
        } else {
          coPrev._diagEnginesStopped = false;
        }
      } catch (eDiag) {}
      // 指挥对齐：auto 已关但 module 仍 running → 清旗；进度超时 → 假活回收（含 outbound/PIN，不只守箱）
      try {
        if (!diagFrozen) {
          var chatAutoOn = sessionStorage.getItem(K.SK_CHAT_AUTO_RUN) === 'true';
          if (!chatAutoOn && coIsRunning('chat')) {
            coWrite('chat', { running: false, phase: 'idle', targetUrl: '', startedAt: 0, lastActive: nowTick });
            clearChatLeaseCo();
          } else if (chatAutoOn) {
            var pinGiveUp = false;
            try { pinGiveUp = sessionStorage.getItem('sg_dm_pin_give_up') === '1'; } catch (ePg) {}
            if (pinGiveUp) {
              reclaimChatZombieCo('pin_blocked');
            } else if (!isChatProgressAliveCo()) {
              var phTick = '';
              var progWhy = '';
              try { phTick = sessionStorage.getItem('dan_chat_phase') || ''; } catch (ePh) {}
              try { progWhy = sessionStorage.getItem('sg_chat_last_progress_why') || ''; } catch (ePw) {}
              var pinGrace = progWhy.indexOf('pin') >= 0 && chatProgressAgeMsCo() < 180000;
              if (!pinGrace) {
                reclaimChatZombieCo('tick_progress_stale');
              }
            }
          }
        }
      } catch (eAlign) {}
      if (freezeSnap.rushing) {
        if (!coPrev._rushLogAt || nowTick - coPrev._rushLogAt > 60000) {
          Logger.info('Coor', '私信赶工 priority=chat 定格剩 ' + freezeSnap.pending + '/' + freezeSnap.total);
          coPrev._rushLogAt = nowTick;
        }
      } else if (softSnap.active) {
        if (!coPrev._softLogAt || nowTick - coPrev._softLogAt > 60000) {
          Logger.info('Coor', '软风控覆盖 priority=' + priority.join(',') + ' 剩余' + softSnap.remainSec + 's phase=' + (softSnap.phase || softSnap.mode) + ' pass=' + (softSnap.pass || 0));
          coPrev._softLogAt = nowTick;
        }
      }
      // 资料克隆占页：白天让路；S0/夜场转帖专场不因克隆幽灵挡死（否则 23 点后永无转帖）
      var pcRunning = false;
      try {
        if (typeof ProfileClone !== 'undefined' && ProfileClone.isRunning) {
          pcRunning = !!ProfileClone.isRunning();
        } else {
          pcRunning = sessionStorage.getItem(K.SK_PROFILE_CLONE_RUNNING || 'sg_profile_clone_running') === 'true';
        }
      } catch (ePcR) {
        try { pcRunning = sessionStorage.getItem(K.SK_PROFILE_CLONE_RUNNING || 'sg_profile_clone_running') === 'true'; } catch (e2) {}
      }
      var nightOkPeek = false;
      try { nightOkPeek = nightRepostShouldRun(); } catch (eNk) {}
      var chatOffPeek = true;
      try { chatOffPeek = !readWorkChatHours().isChatTime; } catch (eCp) {}
      // 非私信时段转帖可占坑：中止资料克隆（不再只认 S0）
      var nightSlotPeek = chatOffPeek && nightOkPeek;
      if (pcRunning && nightSlotPeek) {
        try {
          if (typeof ProfileClone !== 'undefined' && ProfileClone.abort) ProfileClone.abort('night_repost');
        } catch (eAb) {}
        try { sessionStorage.removeItem(K.SK_PROFILE_CLONE_RUNNING || 'sg_profile_clone_running'); } catch (eClr) {}
        pcRunning = false;
        Logger.warn('Coor', '转帖：中止资料克隆占坑');
      }
      if (pcRunning && !diagFrozen) {
        if (!coPrev._pcLogAt || nowTick - coPrev._pcLogAt > 60000) {
          Logger.info('Coor', '资料克隆进行中，暂缓其它模块');
          coPrev._pcLogAt = nowTick;
        }
        try {
          var pcSnapHold = profileCloneSnap();
          var hoursPc = readWorkChatHours();
          window.dispatchEvent(new CustomEvent('sg-coordinator-tick', {
            detail: {
              engine: 'coor', stage: stage, autoMode: coRunning, runningModule: 'profile_clone',
              dayCount: getDayCount(), followedToday: getFollowedToday(), followLimit: getLimit(),
              isChatTime: hoursPc.isChatTime, isWorkTime: hoursPc.isWorkTime,
              followRunning: false, chatRunning: false, nurtureRunning: false,
              repostRunning: false, profileClone: pcSnapHold, whyIdle: '资料克隆中'
            }
          }));
        } catch (ePcTick) {}
        return;
      }
      coPrev.stage = stage;
      // 早间自动刷新：进入工作窗（非工作→工作）清脏扩展上下文。4.3.23 后几乎不进 S0，改盯 isWorkTime。
      var workNowTick = false;
      try { workNowTick = !!readWorkChatHours().isWorkTime; } catch (eWn) { workNowTick = true; }
      if (coFirstTick) {
        coPrevStage = stage;
        coPrevWorkTime = workNowTick;
        coFirstTick = false;
      } else if (coPrevWorkTime === false && workNowTick === true) {
        try {
          if (typeof ChallengeGuard !== 'undefined' && ChallengeGuard.shouldBlockHeal && ChallengeGuard.shouldBlockHeal()) {
            Logger.warn('Coor', '验证/熔断中，跳过工作时段整页刷新');
            coPrevStage = stage;
            coPrevWorkTime = workNowTick;
            // 继续往下走，不 reload
          } else {
            Logger.info('Coor', '进入工作窗，刷新页面清脏上下文');
            try {
              if (typeof RepostTracker !== 'undefined' && RepostTracker.isAutoSlot && RepostTracker.isAutoSlot()) {
                nightRepostForceTimeout();
              }
            } catch (eNight) {}
            try { if (typeof SchedulerGate !== 'undefined' && SchedulerGate.prepareLeave) SchedulerGate.prepareLeave(); } catch (ePl) {}
            coPrevStage = stage;
            coPrevWorkTime = workNowTick;
            setTimeout(function () { window.location.reload(); }, 2000);
            return;
          }
        } catch (eChReload) {
          Logger.info('Coor', '进入工作窗，刷新页面清脏上下文');
          coPrevStage = stage;
          coPrevWorkTime = workNowTick;
          setTimeout(function () { window.location.reload(); }, 2000);
          return;
        }
      }
      coPrevStage = stage;
      coPrevWorkTime = workNowTick;
      if (!coRunning) return;

      reconcileGhostFollowFlags();

      var chSnap = challengeSnapshotSafe();
      if (chSnap.active) {
        stopAllEnginesForChallenge();
        coSave(coPrev);
        try {
          window.dispatchEvent(new CustomEvent('sg-coordinator-tick', { detail: {
            engine: 'coor', stage: stage, autoMode: coRunning,
            runningModule: null,
            dayCount: getDayCount(), followedToday: getFollowedToday(), followLimit: getLimit(),
            isChatTime: readWorkChatHours().isChatTime, isWorkTime: readWorkChatHours().isWorkTime,
            whyIdle: chSnap.msg || '人机验证保护中',
            challenge: chSnap,
            softRisk: softSnap, chatFreeze: freezeSnap,
            followRunning: false, chatRunning: false, nurtureRunning: false, repostRunning: false
          }}));
        } catch (eTickCh) {}
        return;
      }

      coProbeWhiteScreen();
      coProbeMemoryPurge();
      // 转帖独占：非私信时段 +（应跑或已在跑）。占用关注/养号/私信直到转完。
      // 私信时段绝不独占（与私信零撞车）。
      var rpAliveGate = coIsRunning('repost') || coEngineAlive('repost');
      var nightOkGate = nightRepostShouldRun();
      var chatTimeNow = false;
      try { chatTimeNow = !!readWorkChatHours().isChatTime; } catch (eCt) {}
      var repostExclusive = !chatTimeNow && (nightOkGate || rpAliveGate);
      // 私信时段若残留转帖真活：强制停掉，交回关注/养号
      if (chatTimeNow && rpAliveGate) {
        try {
          Logger.info('Coor', '私信时段到，停止转帖让路');
          nightRepostForceTimeout();
        } catch (eStopRpChat) {
          try { coStop('repost'); } catch (e2) {}
        }
        rpAliveGate = false;
        repostExclusive = false;
      }
      if (repostExclusive) {
        ['follow', 'chat', 'nurture'].forEach(function (n) {
          try { coStop(n); } catch (eStop) {}
        });
        var nightOk = nightOkGate;
        var rpAlive = rpAliveGate;
        try {
          if (rpAlive && typeof RepostTracker !== 'undefined' && RepostTracker.isAutoTimedOut && RepostTracker.isAutoTimedOut()) {
            Logger.info('Coor', '定时转帖满时，强制停止');
            nightRepostForceTimeout();
            rpAlive = false;
            nightOk = false;
          }
        } catch (eTo) {}
        if (nightOk && !rpAlive) {
          if (coBootIdleActive()) {
            try {
              var rpSnapIdle = repostStatusSnap();
              window.dispatchEvent(new CustomEvent('sg-coordinator-tick', { detail: {
                engine: 'coor', stage: stage, autoMode: coRunning, runningModule: null,
                dayCount: getDayCount(), followedToday: getFollowedToday(), followLimit: getLimit(),
                isChatTime: readWorkChatHours().isChatTime, isWorkTime: readWorkChatHours().isWorkTime,
                whyIdle: '冷启动错峰(' + coBootIdleRemainSec() + 's)',
                repostRunning: rpSnapIdle.running, repostCurrent: rpSnapIdle.current, repostDaily: rpSnapIdle.daily,
                modules: (function() { var o = {}; for (var ok in coModules) o[ok] = { state: coModules[ok]._state || 'stopped' }; return o; })()
              }}));
            } catch (eBi) {}
            coSave(coPrev);
            return;
          }
          try {
            // 夜场转帖优先：清掉未完软风控，避免继续占养号/私信
            var sgClr = coLoadSg();
            if (softRiskActive(sgClr, Date.now())) {
              clearSoftRiskFields(sgClr);
              sgClr.followNextDelayUntil = 0;
              coSaveSg(sgClr);
              Logger.info('Coor', '夜场转帖：清软风控让路');
            }
          } catch (eClrSr) {}
          try {
            if (typeof RepostTracker !== 'undefined' && RepostTracker.markAutoRunning) RepostTracker.markAutoRunning();
          } catch (eMr) {}
          var uRp = typeof PageRouter !== 'undefined' ? PageRouter.homeUrlFor('repost') : '';
          var fresh = true;
          try {
            var doneN = (RepostTracker.getCompletedRound && RepostTracker.getCompletedRound()) || [];
            fresh = doneN.length === 0 && sessionStorage.getItem('sg_repost_round_boot') !== '1';
          } catch (eFr) {}
          if (fresh) {
            try { sessionStorage.setItem('sg_repost_round_boot', '1'); } catch (eB) {}
          }
          Logger.info('Coor', '非私信时段定时启动转帖' + (fresh ? '(新一轮)' : '(续跑)'));
          startRepost(uRp, { autoSlot: true, freshRound: fresh });
          if (coModules.repost) {
            coModules.repost._state = 'running';
            coModules.repost._startedAt = Date.now();
          }
          coWrite('repost', { running: true, phase: 'starting', targetUrl: uRp || '', startedAt: Date.now(), lastActive: Date.now() });
        } else if (!nightOk && rpAlive) {
          try {
            var stAuto = typeof RepostTracker !== 'undefined' ? RepostTracker.getAutoStatus() : '';
            var inWin = true;
            try {
              if (typeof RepostTracker !== 'undefined' && RepostTracker.isInRepostWindowNow) {
                inWin = RepostTracker.isInRepostWindowNow();
              } else if (typeof RepostTracker !== 'undefined' && RepostTracker.isPastStartTime) {
                inWin = RepostTracker.isPastStartTime();
              }
            } catch (ePs) {}
            if (stAuto === 'done' || stAuto === 'timeout' || !moduleSwitchOn('repost') || !inWin) {
              if (!inWin && (stAuto === 'running' || stAuto === 'idle')) {
                try { if (RepostTracker.markAutoTimeout) RepostTracker.markAutoTimeout(); } catch (eTo2) {}
                stopRepost('timeout');
              }
              coStop('repost');
            }
          } catch (eSt) { try { coStop('repost'); } catch (e2) {} }
        }
        coSave(coPrev);
        try {
          var rpSnapS0 = repostStatusSnap();
          var stillRp = coIsRunning('repost') || coEngineAlive('repost');
          window.dispatchEvent(new CustomEvent('sg-coordinator-tick', { detail: {
            engine: 'coor', stage: stage, autoMode: coRunning,
            runningModule: stillRp ? 'repost' : null,
            dayCount: getDayCount(), followedToday: getFollowedToday(), followLimit: getLimit(),
            isChatTime: readWorkChatHours().isChatTime, isWorkTime: readWorkChatHours().isWorkTime,
            whyIdle: stillRp ? '' : (nightOk ? '转帖待启动' : (function () {
              try {
                if (chatTimeNow) return '私信时段禁转帖';
                if (!moduleSwitchOn('repost')) return '转帖模块已关';
                if (typeof RepostTracker !== 'undefined' && (!RepostTracker.getTargets || !RepostTracker.getTargets().length)) {
                  return '转帖无来源号';
                }
                if (typeof RepostTracker !== 'undefined' && RepostTracker.isAutoFinishedToday && RepostTracker.isAutoFinishedToday()) {
                  return '转帖本日已完成';
                }
                if (typeof RepostTracker !== 'undefined' && RepostTracker.dailyExhausted && RepostTracker.dailyExhausted()) {
                  return '转帖今日条数已满';
                }
                if (typeof RepostTracker !== 'undefined' && RepostTracker.isPastStartClock && !RepostTracker.isPastStartClock()) {
                  var hm = RepostTracker.getStartHm ? RepostTracker.getStartHm() : { h: 6, m: 0 };
                  var mm = (hm.m < 10 ? '0' : '') + hm.m;
                  return '未到开跑时刻(' + hm.h + ':' + mm + ')';
                }
                if (typeof RepostTracker !== 'undefined' && RepostTracker.isInRepostWindowNow && !RepostTracker.isInRepostWindowNow()) {
                  var hm2 = RepostTracker.getStartHm ? RepostTracker.getStartHm() : { h: 6, m: 0 };
                  var mm2 = (hm2.m < 10 ? '0' : '') + hm2.m;
                  return '未到开跑时刻(' + hm2.h + ':' + mm2 + ')';
                }
              } catch (eW) {}
              return '转帖待命';
            })()),
            repostRunning: rpSnapS0.running, repostCurrent: rpSnapS0.current, repostDaily: rpSnapS0.daily,
            modules: (function() { var o = {}; for (var ok in coModules) o[ok] = { state: coModules[ok]._state || 'stopped' }; return o; })()
          }}));
        } catch (eS0) {}
        return;
      }

      var hasRun = false;
      for (var k in coModules) {
        var ms = coRead(k);
        // 软窗内关注不得占 hasRun（否则养号永远启不了）
        if (softSnap.active && k === 'follow') {
          if (ms.running || localStorage.getItem(K.LK_FOLLOW_RUNNING) === 'true') {
            Logger.info('Coor', '软窗内清关注占坑 running/phase=' + (ms.phase || ''));
            try { coGentleStopFollow(); } catch (eGs) {}
            try { localStorage.removeItem(K.LK_FOLLOW_RUNNING); } catch (eLr) {}
            try { sessionStorage.setItem(K.SK_TAB_RUNNING, 'soft_fill'); } catch (eTb) {}
          }
          continue;
        }
        var terminal = ms.phase === 'pool_empty' || ms.phase === 'completed' || ms.phase === 'quota_exhausted' || ms.phase === 'warmup'
          || ms.phase === 'done' || ms.phase === 'timeout' || ms.phase === 'fuse' || ms.phase === 'quota'
          || ms.phase === 'soft_cooldown';
        if (ms.running && terminal) {
          Logger.info('Coor', k + ' 终止相位 ' + ms.phase + '，交回调度');
          if (k === 'chat') {
            if (isSoftRiskOutboundPhaseCo(coLoadSg())) markSoftRiskOutboundDone('terminal_phase');
            else markSoftRiskChatDone();
          }
          if (coModules[k] && coModules[k]._startedAt) {
            if (k === 'follow') coRecordDur('follow', coModules[k]._startedAt);
            if (k === 'nurture') coRecordDur('nurture', coModules[k]._startedAt);
          }
          coStop(k);
          continue;
        }
        if (ms.running) {
          // 幽灵 running：旗标在、引擎已死 → 清除并允许轮转（starting/popping 宽限内勿杀）
          if (!coEngineAlive(k) && !coModuleStartingGrace(k)) {
            Logger.info('Coor', k + ' 幽灵running（引擎未活），清除');
            if (k === 'chat') {
              reclaimChatZombieCo('ghost_running');
            } else {
              if (coModules[k] && coModules[k]._startedAt) {
                if (k === 'follow') coRecordDur('follow', coModules[k]._startedAt);
                if (k === 'nurture') coRecordDur('nurture', coModules[k]._startedAt);
              }
              coStop(k);
            }
            continue;
          }
          // 有界会话帽：仅 soft/interrupt 会话生效；outbound 无 kind 不掐
          if (k === 'chat' && chatSessionCapReached()) {
            var sessKind = '';
            try { sessKind = sessionStorage.getItem('sg_chat_session_kind') || ''; } catch (eSk) {}
            // 破冰段无会话帽 / 忽略触帽：扫完新粉再转扫箱
            if (isSoftRiskOutboundPhaseCo(coLoadSg())) {
              // no-op
            } else if (sessKind === 'soft' || sessKind === 'interrupt') {
              Logger.info('Coor', 'chat 会话帽到达 kind=' + sessKind + '，停止交回调度');
              try {
                if (typeof SgTelemetry !== 'undefined') {
                  SgTelemetry.emit('scheduler.chat_session_cap', {
                    reason: 'runtime_stop',
                    kind: sessKind,
                    opens: getChatSessionOpenCount()
                  });
                }
              } catch (eCapR) {}
              try {
                markSoftRiskChatDone();
              } catch (eMd) {}
              try {
                if (typeof window !== 'undefined' && typeof window.stopChat === 'function') window.stopChat();
              } catch (eSc) {}
              coStop(k);
              continue;
            }
          }
          // 4.6.30：心跳超时检测（10min 无更新 → 强制停止；follow/nurture 仅告警 + stop，不进冻结）
          if (ms.lastActive && Date.now() - ms.lastActive > 600000) {
            Logger.info('Coor', k + ' 心跳超时(10min)，强制停止');
            if (k === 'chat') {
              reclaimChatZombieCo('module_lastActive_10min');
            } else {
              if (coModules[k] && coModules[k]._startedAt) {
                if (k === 'follow') coRecordDur('follow', coModules[k]._startedAt);
                if (k === 'nurture') coRecordDur('nurture', coModules[k]._startedAt);
              }
              // follow/nurture：只停 + 遥测告警，冻结只留给明确异常证据场景（CMD-11）
              try {
                if (typeof SgTelemetry !== 'undefined') {
                  SgTelemetry.emit('scheduler.module_stuck', {
                    module: k,
                    reason: 'module_lastActive_10min',
                    lastActive: ms.lastActive,
                    elapsed: Date.now() - ms.lastActive,
                    stage: coModules[k]._startedAt ? 'running' : 'idle'
                  });
                }
              } catch (eTl) {}
              coStop(k);
            }
          } else {
            coModules[k]._state = 'running'; hasRun = true;
          }
        }
        else if (coModules[k]._state === 'running') {
          coModules[k]._state = 'stopped';
          if (k === 'follow' && coModules[k]._startedAt) coRecordDur('follow', coModules[k]._startedAt);
          if (k === 'nurture' && coModules[k]._startedAt) coRecordDur('nurture', coModules[k]._startedAt);
        }
      }

      var ns = coRead('nurture');
      // 软风控养号中段：撑到 chat2 预留点；chat1/chat2 相位强制停养号；Day≤2 只养号吃满窗
      var nurtureCap = 15 * 60 * 1000;
      if (softSnap.active) {
        var softPhase = sgTick.softRiskPhase || '';
        var nurtureOnlyCap = resolveSoftFillModeCo(sgTick).mode !== 'chat_fill';
        if (softPhase === 'chat1' || softPhase === 'chat2') {
          nurtureCap = 0;
        } else if (softPhase === 'nurture' && nurtureOnlyCap) {
          // 吃满软窗：帽 = until−startedAt。禁止用 softLeft 与 age 比（softLeft 递减 → ~半窗误触发 nurture_cap 清窗）
          nurtureCap = Math.max(30 * 1000, (sgTick.softRiskUntil || 0) - (ns.startedAt || Date.now()));
        } else if (softPhase === 'nurture') {
          var reserveAt = (sgTick.softRiskUntil || 0) - SOFT_CHAT2_RESERVE_MS;
          nurtureCap = Math.max(30 * 1000, reserveAt - (ns.startedAt || Date.now()));
        } else {
          var softLeft = Math.max(0, (sgTick.softRiskUntil || 0) - Date.now());
          nurtureCap = Math.max(nurtureCap, softLeft + 5000);
        }
      }
      if (ns.running && (nurtureCap <= 0 || (ns.startedAt && Date.now() - ns.startedAt > nurtureCap))) {
        Logger.info('Coor','养号超帽/相位打断 phase=' + (sgTick.softRiskPhase || ''));
        if (coModules['nurture'] && coModules['nurture']._startedAt) coRecordDur('nurture', coModules['nurture']._startedAt);
        coStop('nurture'); hasRun = false;
        try {
          if ((sgTick.softRiskPhase || '') === 'nurture') {
            if (resolveSoftFillModeCo(sgTick).mode !== 'chat_fill') {
              endSoftRiskNurtureOnly(sgTick, 'nurture_cap');
            } else {
              beginSoftRiskChat2(sgTick, 'nurture_cap');
            }
          } else if (!softSnap.active) {
            // 白天时段帽：写让台窗，禁止同 tick / 紧接着再启养号抢走关注
            sgTick = coLoadSg();
            var yieldUntil = Date.now() + NURTURE_YIELD_MS;
            if (!(sgTick.nurtureYieldUntil > yieldUntil)) {
              sgTick.nurtureYieldUntil = yieldUntil;
              coSaveSg(sgTick);
            }
            Logger.info('Coor', '养号时段帽让台关注 yield=' + Math.round((sgTick.nurtureYieldUntil - Date.now()) / 1000) + 's');
          }
        } catch (eB2) {}
      }

      if (hasRun) {
        for (var ak in coModules) {
          var am = coModules[ak]; if (!am || !coIsRunning(ak)) continue;
          // 软风控 / 赶工窗内不因阶段变更打断 chat/nurture；关私信时仍须能停 chat
          if (freezeSnap.rushing && ak === 'chat') continue;
          if (softSnap.active && ak === 'nurture') continue;
          if (softSnap.active && ak === 'chat') {
            var chatStillOn = true;
            try { chatStillOn = resolveSoftFillModeCo(sgTick).allowChat; } catch (eMsChat) {}
            if (chatStillOn) continue;
          }
          if (typeof am.canRun === 'function' && !am.canRun(stage)) { Logger.info('Coor','阶段变更停'+ak); coStop(ak); hasRun = false; }
        }
      }

      if (hasRun) {
        for (var i = 0; i < priority.length; i++) {
          var nm = priority[i]; var cm = coModules[nm]; if (!cm || !coIsRunning(nm)) continue;
          if (!coEngineAlive(nm)) {
            if (nm === 'chat') reclaimChatZombieCo('priority_alive_false');
            else coStop(nm);
            hasRun = false; break;
          }
          var cms = coRead(nm);
          var maxT = (nm === 'repost') ? repostMaxRunMs() : (nm === 'follow' ? followMaxRunMs() : (coMaxRun[nm] || 30 * 60 * 1000));
          if (cms.startedAt && Date.now() - cms.startedAt > maxT) {
            Logger.info('Coor', nm + '超时轮转' + (nm === 'follow' ? (' max=' + Math.round(maxT / 60000) + 'm') : ''));
            if (nm === 'follow') {
              try {
                window.dispatchEvent(new CustomEvent('sg-follow-round-end', { detail: { reason: 'co_timeout' } }));
              } catch (eFr) {}
              try { stopFollow(); } catch (eSf) {}
              coGentleStopFollow();
              hasRun = false;
              break;
            }
            if (nm === 'chat') {
              reclaimChatZombieCo('max_run_timeout');
            } else {
              coStop(nm);
            }
            hasRun = false; break;
          }
          // 仅引擎真活时刷新 lastActive，避免调度空刷掩盖假死
          cms.lastActive = Date.now(); coWrite(nm, cms);
        }
      }

      // 面板更新 (所有路径都发)
      var rn = null; for (var rk in coModules) { if (coIsRunning(rk)) { rn = rk; break; } }
      try { 
        var v5 = { dayCount: getDayCount(), followedToday: getFollowedToday(), followLimit: getLimit(),
          isChatTime: readWorkChatHours().isChatTime, isWorkTime: readWorkChatHours().isWorkTime,
          followRunning: localStorage.getItem(K.LK_FOLLOW_RUNNING) === 'true',
          chatRunning: sessionStorage.getItem(K.SK_CHAT_AUTO_RUN) === 'true',
          nurtureRunning: sessionStorage.getItem(K.SK_NURTURE_RUNNING) === 'true' };
        var rpSnap = repostStatusSnap();
        var whyIdle = '';
        var diagFr = null;
        try {
          if (typeof SgDiagContract !== 'undefined') diagFr = SgDiagContract.readFreeze();
        } catch (eDf) {}
        if (diagFr && diagFr.on) {
          whyIdle = '诊断冻结: ' + (diagFr.hint || diagFr.reason || diagFr.code || '');
        } else if (!rn) {
          whyIdle = computeWhyIdle({
            autoMode: coRunning, stage: stage, priority: priority,
            isWorkTime: v5.isWorkTime, runningModule: rn, sg: coLoadSg()
          });
        }
        window.dispatchEvent(new CustomEvent('sg-coordinator-tick', { detail: { 
          engine: 'coor', stage: coPrev.stage, autoMode: coRunning, runningModule: rn,
          dayCount: v5.dayCount, followedToday: v5.followedToday, followLimit: v5.followLimit,
          isChatTime: v5.isChatTime, isWorkTime: v5.isWorkTime,
          followRunning: v5.followRunning, chatRunning: v5.chatRunning, nurtureRunning: v5.nurtureRunning,
          repostRunning: rpSnap.running, repostCurrent: rpSnap.current, repostDaily: rpSnap.daily,
          profileClone: profileCloneSnap(),
          whyIdle: whyIdle,
          softRisk: softSnap,
          chatFreeze: freezeSnap,
          diagFreeze: diagFr,
          challenge: (function () {
            try {
              if (typeof ChallengeGuard !== 'undefined' && ChallengeGuard.snapshot) return ChallengeGuard.snapshot();
            } catch (eCh) {}
            return null;
          })(),
          modules: (function() { var o = {}; for (var ok in coModules) o[ok] = { state: coModules[ok]._state || 'stopped' }; return o; })(),
          chatDiag: buildChatDiag(coLoadSg())
        }})); 
      } catch (e) {}

      if (hasRun) { coSave(coPrev); return; }

      // 冷启动错峰：前 N 分钟只心跳/探针，不新启关注/养号/私信/转帖（O3）
      if (coBootIdleActive()) {
        var bootLeft = coBootIdleRemainSec();
        try {
          var rpSnapBoot = repostStatusSnap();
          window.dispatchEvent(new CustomEvent('sg-coordinator-tick', { detail: {
            engine: 'coor', stage: stage, autoMode: coRunning, runningModule: null,
            dayCount: getDayCount(), followedToday: getFollowedToday(), followLimit: getLimit(),
            isChatTime: readWorkChatHours().isChatTime, isWorkTime: readWorkChatHours().isWorkTime,
            whyIdle: '冷启动错峰(' + bootLeft + 's)',
            repostRunning: rpSnapBoot.running, repostCurrent: rpSnapBoot.current, repostDaily: rpSnapBoot.daily,
            modules: (function() { var o = {}; for (var ok in coModules) o[ok] = { state: coModules[ok]._state || 'stopped' }; return o; })()
          }}));
        } catch (eBoot) {}
        if (!_healPauseLogAt || Date.now() - _healPauseLogAt > 60000) {
          Logger.info('Coor', '冷启动错峰中 remain=' + bootLeft + 's，暂不启引擎');
          _healPauseLogAt = Date.now();
        }
        coSave(coPrev);
        return;
      }

      // 启动下一个模块
      var sg = coLoadSg(); var now = Date.now();
      sg = ensureChatFreezeSg(sg);
      // 软风控/赶工覆盖
      priority = applyFollowFirstInS3(priority, stage, sg);
      priority = applySoftRiskPriority(priority, sg, now);
      priority = applyChatRushPriority(priority, sg);
      priority = stripRepostFromPriority(priority);
      priority = applyModuleQualityPriority(priority);
      priority = applyNurtureYieldPriority(priority, sg, now);
      softSnap = softRiskSnapshot(sg, now);
      freezeSnap = chatFreezeSnapshot(sg);
      // 跨日重置私信会话统计（仅展示，不作闸门）
      try {
        var todayChat = shanghaiDate();
        if (sg.chatDate !== todayChat) {
          sg.chatDate = todayChat;
          sg.chatRoundsToday = 0;
          S.chatDate = todayChat;
          S.chatRoundsToday = 0;
          coSaveSg(sg);
        }
      } catch (eReset) {}
      var launchPolicy = null;
      try {
        if (typeof SgChatStrategy !== 'undefined') {
          launchPolicy = SgChatStrategy.resolveChatPolicy({
            sg: sg,
            debt: countChatDebtFromDB(),
            replyPending: countActionableReplyCo(),
            kickPending: countActionableKickDebtFromDB()
          });
        }
      } catch (eLp) {}
      for (var j = 0; j < priority.length; j++) {
        var c = priority[j]; var cm = coModules[c];
        if (!cm || typeof cm.canRun !== 'function') continue;
        var cr = cm.canRun(stage);
        if (!cr) { Logger.info('Coor','  跳过 '+c+' (canRun=false for stage='+stage+')'); continue; }
        var canGo = false;
        if (c === 'follow') {
          if (launchPolicy && launchPolicy.allowFollow === false) {
            canGo = false;
            Logger.info('Coor', '  follow: 策略禁止 (' + (launchPolicy.reason || '') + ')');
          } else if (softRiskActive(sg, now) || freezeSnap.rushing) {
            canGo = false;
            Logger.info('Coor','  follow: ' + (freezeSnap.rushing ? '赶工窗内禁止' : '软风控窗口内禁止'));
          } else {
            canGo = now > (sg.followNextDelayUntil || 0);
            Logger.info('Coor','  follow: delay='+(sg.followNextDelayUntil||0)+' now='+now+' diff='+(now - (sg.followNextDelayUntil||0))+' canGo='+canGo);
          }
        } else if (c === 'chat') {
              var chatBlockReason = '';
              // 4.1.64：非私信时段硬闸（默认 ≥18:00 / <08:00）— 不开私信、不灌债、不赶债
              var inChatHoursGate = true;
              try { inChatHoursGate = !!readWorkChatHours().isChatTime; } catch (eHg) { inChatHoursGate = true; }
              if (!inChatHoursGate) {
            canGo = false;
            chatBlockReason = 'outside_chat_hours';
            Logger.info('Coor', '  跳过 chat (非私信时段)');
            try {
              if (typeof SgTelemetry !== 'undefined') SgTelemetry.emit('scheduler.chat_blocked', { reason: 'outside_chat_hours' });
            } catch (eOh0) {}
            try {
              if (softRiskActive(sg, now)) {
                coerceSoftRiskNoChat(sg);
                try {
                  if (typeof SgTelemetry !== 'undefined') {
                    SgTelemetry.emit('scheduler.soft_risk_chat_blocked_fallback', { reason: 'outside_chat_hours', phase: 'nurture' });
                  }
                } catch (eFb0) {}
                if (priority.length === 1 && priority[0] === 'chat') {
                  priority = ['nurture'];
                  j = -1;
                  continue;
                }
              }
            } catch (eCoH) {}
          } else if (launchPolicy && !launchPolicy.allowChat) {
            canGo = false;
            chatBlockReason = launchPolicy.reason || 'policy';
            Logger.info('Coor', '  跳过 chat (策略: ' + (launchPolicy.reason || 'blocked') + ')');
            try {
              if (typeof SgTelemetry !== 'undefined') SgTelemetry.emit('scheduler.chat_blocked', { reason: launchPolicy.reason || 'policy' });
            } catch (ePol) {}
          } else if (isChatDailyCapReachedCo(sg)) {
            canGo = false;
            chatBlockReason = 'daily_cap';
            Logger.info('Coor', '  跳过 chat (日帽240分已满)');
            try {
              if (typeof SgTelemetry !== 'undefined') SgTelemetry.emit('scheduler.chat_blocked', { reason: 'daily_cap' });
            } catch (eCap) {}
          } else if (shouldDeferChatForFollowCo(sg)) {
            canGo = false;
            chatBlockReason = 'follow_round_active';
            Logger.info('Coor', '  跳过 chat (关注轮次进行中，私信让路)');
            try {
              if (typeof SgTelemetry !== 'undefined') SgTelemetry.emit('scheduler.chat_blocked', { reason: 'follow_round_active' });
            } catch (eDef) {}
          } else if (softRiskActive(sg, now) && !sg.softRiskChatDone) {
            canGo = true;
            Logger.info('Coor', '  chat: 软风控' + ((sg.softRiskPhase || '') === 'chat2' ? 'chat2' : ((sg.softRiskPhase || '') === 'nurture' ? '养号段误启' : 'chat1')) + '启动（按人混发）');
          } else {
            // 4.1.38/4.1.64：长冷却废除；仅显式 nextAt。满配额有债且在私信时段内才放行清债（过点不赶债）
            var leftMs = chatCooldownLeftMs(sg, now);
            canGo = leftMs <= 0;
            var inChatHours = true;
            try { inChatHours = !!readWorkChatHours().isChatTime; } catch (eH) { inChatHours = true; }
            if (!canGo && inChatHours && hasQuotaFullChatDebtCo()) {
              canGo = true;
              Logger.info('Coor', '  chat: 满配额清债，忽略冷却剩 ' + Math.ceil(leftMs / 60000) + ' 分');
              try {
                if (typeof SgTelemetry !== 'undefined') {
                  SgTelemetry.emit('scheduler.chat_debt_bypass_cooldown', {
                    left_min: Math.ceil(leftMs / 60000),
                    debt: countFanRosterChatDebtCo()
                  });
                }
              } catch (eBy) {}
            } else if (!canGo) {
              chatBlockReason = 'cooldown';
              Logger.info('Coor', '  跳过 chat (冷却中剩 ' + Math.ceil(leftMs / 60000) + ' 分)');
              try {
                if (typeof SgTelemetry !== 'undefined') SgTelemetry.emit('scheduler.chat_blocked', { reason: 'cooldown', left_min: Math.ceil(leftMs / 60000) });
              } catch (eCd) {}
            }
            if (canGo && !inChatHours) {
              canGo = false;
              chatBlockReason = 'outside_chat_hours';
              Logger.info('Coor', '  跳过 chat (非私信时段，过点不开/不赶债)');
              try {
                if (typeof SgTelemetry !== 'undefined') SgTelemetry.emit('scheduler.chat_blocked', { reason: 'outside_chat_hours' });
              } catch (eOh) {}
            }
          }
          if (canGo) {
            var chatPhase = (countChatDebtFromDB() > 0 || countActionableReplyCo() > 0) ? 'inbox' : 'outbound';
            try {
              if (typeof SgTimeBudget !== 'undefined' && !SgTimeBudget.canStartPhase(chatPhase, sg)) {
                var altPhase = chatPhase === 'inbox' ? 'outbound' : 'inbox';
                if (!SgTimeBudget.canStartPhase(altPhase, sg)) {
                  canGo = false;
                  chatBlockReason = 'budget';
                  Logger.info('Coor', '  跳过 chat (小时预算已满)');
                  try {
                    if (typeof SgTelemetry !== 'undefined') SgTelemetry.emit('scheduler.budget_blocked', { phase: chatPhase });
                  } catch (eBd) {}
                }
              }
            } catch (eTbGo) {}
          }
          // SCRM：检测通过且在线才放行（进线数字不参与）；赶工窗同样遵守
          // 4.4.1：fail-open —— 闸门未就绪不拦截
          if (canGo) {
            var scrmG = getScrmGateSync();
            if (!scrmG) {
              refreshScrmGate(); // 后台异步刷新，不阻塞
            } else if (!scrmG.allow_chat) {
              canGo = false;
              chatBlockReason = 'scrm';
              Logger.info('Coor', '  跳过 chat (' + (scrmG.reason || 'SCRM未放行') + ')');
              try {
                if (typeof SgTelemetry !== 'undefined') SgTelemetry.emit('scheduler.scrm_blocked', { reason: scrmG.reason || '' });
              } catch (eScrmEmit) {}
            } else if (scrmG.force_allow && scrmG.warn_reason) {
              Logger.info('Coor', '  chat 强制放行中 warn=' + scrmG.warn_reason);
            }
          }
          // 4.2.22/23：软风控只排 chat 却被闸门挡 → 回退养号/清窗，禁止空转
          if (!canGo && softRiskActive(sg, now)) {
            var phSoft = sg.softRiskPhase || 'chat1';
            var softChatLeg = (phSoft === 'chat1' || phSoft === 'chat2' || !phSoft);
            // scrm_pending=缓存未就绪：不烧相位，本 tick 先养号等 refresh
            if (softChatLeg && chatBlockReason === 'scrm_pending') {
              try {
                if (typeof SgTelemetry !== 'undefined') {
                  SgTelemetry.emit('scheduler.soft_risk_chat_blocked_fallback', {
                    reason: 'scrm_pending', phase: phSoft, temp_nurture: true
                  });
                }
              } catch (ePend) {}
              Logger.info('Coor', '软风控 SCRM 查询中 → 临时养号（不推进相位）');
              priority = ['nurture'];
              j = -1;
              continue;
            }
            var fbOk = softChatLeg && (
              chatBlockReason === 'scrm'
              || chatBlockReason === 'budget' || chatBlockReason === 'policy'
              || chatBlockReason === 'daily_cap' || chatBlockReason === 'cooldown'
            );
            if (fbOk) {
              var fb = softRiskChatBlockedFallback(sg, chatBlockReason || 'gate');
              sg = coLoadSg(); // markSoftRisk* 另 load，必须刷新内存对象
              now = Date.now();
              softSnap = softRiskSnapshot(sg, now);
              freezeSnap = chatFreezeSnapshot(sg);
              if (fb === 'nurture') {
                priority = ['nurture'];
                j = -1;
                continue;
              }
              if (fb === 'follow') {
                priority = moduleSwitchOn('follow') ? ['follow', 'nurture'] : ['nurture'];
                j = -1;
                continue;
              }
            }
          }
        } else if (c === 'nurture') {
          canGo = true;
          // 白天时段帽让台期内：关注未满则跳过养号（软风控养号段除外）
          try {
            if (!softRiskActive(sg, now) && (sg.nurtureYieldUntil || 0) > now) {
              var fuOk = true;
              try { fuOk = getFollowedToday() < getLimit(); } catch (eFu) {}
              if (fuOk && moduleSwitchOn('follow')) {
                canGo = false;
                Logger.info('Coor', '  nurture: 时段帽让台关注 remain=' + Math.round(((sg.nurtureYieldUntil || 0) - now) / 1000) + 's');
              }
            }
          } catch (eYld) {}
        } else if (c === 'repost') {
          // 非私信时段可跑；主路径仍是独占块，此处兜底
          canGo = false;
          try {
            if (!readWorkChatHours().isChatTime && nightRepostShouldRun()) canGo = true;
          } catch (eRpGo) {}
        }
        if (canGo) {
          var u = '';
          if (c === 'chat') {
            u = resolveChatStartUrl('') || '';
            if (!u) {
              Logger.info('Coor', '  跳过 chat (无法解析目标URL)');
              if (softRiskActive(sg, now)) {
                var fbUrl = softRiskChatBlockedFallback(sg, 'no_url');
                sg = coLoadSg();
                now = Date.now();
                softSnap = softRiskSnapshot(sg, now);
                freezeSnap = chatFreezeSnapshot(sg);
                if (fbUrl === 'nurture') {
                  priority = ['nurture'];
                  j = -1;
                  continue;
                }
                if (fbUrl === 'follow') {
                  priority = moduleSwitchOn('follow') ? ['follow', 'nurture'] : ['nurture'];
                  j = -1;
                  continue;
                }
              }
              continue;
            }
          } else {
            u = typeof PageRouter !== 'undefined' ? PageRouter.homeUrlFor(c) : '';
          }
          if (!u) {
            Logger.info('Coor', '跳过 ' + c + '：没有有效目标页');
            continue;
          }
          coStart(c, u); coSave(coPrev); return;
        }
        else { Logger.info('Coor','  跳过 '+c+' (canGo=false)'); }
      }
      Logger.info('Coor','  无模块可启动');

      coSave(coPrev);
    } finally { coTickLock = false; }
  }

  function coSave(prevState) {
    var sg2 = coLoadSg(); var modSnap = {}; for (var mk in coModules) modSnap[mk] = { state: coModules[mk]._state || 'stopped' };
    sg2.coStage = prevState.stage; sg2.coModules = modSnap; coSaveSg(sg2);
  }

  function coReportDaily() {
    try {
      var sg = coLoadSg(); var h = (localStorage.getItem(K.LK_MY_HANDLE) || 'unknown').replace('@','').replace('#guard','').toLowerCase();
      var nl = 0, nc = 0;
      try { if (typeof NurtureTracker !== 'undefined' && NurtureTracker.getStats) { var ns = NurtureTracker.getStats(); nl = (ns.daily && ns.daily.used) ? (ns.daily.used.likes || 0) : 0; nc = (ns.daily && ns.daily.used) ? (ns.daily.used.comments || 0) : 0; } } catch (e) {}
      if (sg.nurtureLikesTotal) nl = sg.nurtureLikesTotal; if (sg.nurtureCommentsTotal) nc = sg.nurtureCommentsTotal;
      var p = { worker_id: '@'+h+'#guard', follow_count: getFollowedToday() || 0, follow_duration_sec: sg.followTotalToday || 0, chat_rounds: sg.chatRoundsToday || 0, chat_duration_sec: sg.chatTotalToday || 0, nurture_likes: nl, nurture_comments: nc, nurture_duration_sec: sg.nurtureTotalToday || 0 };
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) chrome.runtime.sendMessage({ action: 'report_daily_stats', payload: p });
    } catch(e){}
  }

  /**
   * S1: 刷新后 session 旗标仍在，但 JS 循环已死。
   * 若不清理，coEngineAlive 会误判「还活着」而不再 coStart → 自动模式假死。
   *
   * 注意：startChat 跳到 /followers 常会让 content script 重注入。
   * 若每次重注入都 prepareFresh → 再 startChat → 再跳转，会「连续进入私信页」死循环。
   * 因此：仅 hard reload / 首次启动 / 用户点启动 时清理；同 tab 软导航重注入跳过。
   */
  function coNavType() {
    try {
      var nav = performance.getEntriesByType('navigation')[0];
      if (nav && nav.type) return nav.type; // navigate | reload | back_forward | prerender
    } catch (e) {}
    try {
      if (performance.navigation) {
        if (performance.navigation.type === 1) return 'reload';
        if (performance.navigation.type === 2) return 'back_forward';
        return 'navigate';
      }
    } catch (e2) {}
    return 'unknown';
  }

  function coShouldPrepareFresh(force) {
    if (force) return true;
    var t = coNavType();
    if (t === 'reload') return true;
    // 同 tab 内由调度自己 location 跳转导致的重注入
    if (t === 'navigate' && sessionStorage.getItem('sg_scheduler_booted') === '1') return false;
    return true;
  }

  function coPrepareFreshRun() {
    try {
      sessionStorage.setItem(K.SK_CHAT_AUTO_RUN, 'false');
      sessionStorage.removeItem(K.SK_CHAT_STEP);
      sessionStorage.removeItem(K.SK_NURTURE_RUNNING);
      sessionStorage.removeItem(K.SK_NURTURE_PAUSED);
      sessionStorage.removeItem(K.SK_REPOST_RUNNING || 'sg_repost_running');
      try { sessionStorage.removeItem('sg_repost_auto_slot'); } catch (eSlot) {}
      localStorage.removeItem(K.LK_FOLLOW_RUNNING);
      if (sessionStorage.getItem(K.SK_TAB_RUNNING) === 'stopped_by_user') {
        sessionStorage.removeItem(K.SK_TAB_RUNNING);
      }
      ['follow', 'chat', 'nurture', 'repost'].forEach(function (n) {
        coWrite(n, { running: false, phase: 'idle', targetUrl: '', startedAt: 0, lastActive: Date.now() });
      });
      for (var k in coModules) {
        if (coModules[k]) { coModules[k]._state = 'stopped'; coModules[k]._startedAt = 0; }
      }
      Logger.info('Coor', '已清除过期引擎旗标，准备按阶段重新拉起');
    } catch (e) {}
  }

  function coStartScheduler(opts) {
    opts = opts || {};
    var sg = coLoadSg(); coPrev.stage = sg.coStage || 'S0';
    var doPrepare = coShouldPrepareFresh(!!opts.forcePrepare);
    if (doPrepare) {
      coPrepareFreshRun();
      // 4.3.9：不再写 sg_boot_at 冷启动错峰；清掉旧页残留
      try { sessionStorage.removeItem('sg_boot_at'); } catch (eBootAt) {}
    } else {
      Logger.info('Coor', '软导航重注入，跳过 prepareFresh（防连环进私信）');
      // 旗标还在但 JS 循环已随旧文档死去：只补活，禁止再改 URL
      coRehydrateEngines();
    }
    try { sessionStorage.setItem('sg_scheduler_booted', '1'); } catch (e0) {}
    try { S.running = true; } catch (e) {}
    if (!isSchedulerModuleEnabled()) {
      coRunning = false;
      Logger.info('Coor', '后台关闭了调度模块，保持暂停');
      return;
    }
    coRunning = true; Logger.info('Coor', '调度核心启动(V3内置/resume)');
    coTick();
    installCoTimers();
    if (window._dailyStatsTimer) clearInterval(window._dailyStatsTimer);
    window._dailyStatsTimer = setInterval(coReportDaily, 5 * 60 * 1000);
    coReportDaily();
  }

  /** 软导航后重注入：按仍存活的旗标重启引擎循环，不跳页 */
  function coRehydrateEngines() {
    try {
      if (sessionStorage.getItem(K.SK_CHAT_AUTO_RUN) === 'true') {
        if (!moduleSwitchOn('chat')) {
          Logger.info('Coor', '补活跳过私信：模块已关');
          try { sessionStorage.setItem(K.SK_CHAT_AUTO_RUN, 'false'); } catch (eOff) {}
          try {
            coWrite('chat', { running: false, phase: 'idle', targetUrl: '', startedAt: 0, lastActive: Date.now() });
          } catch (eW) {}
        } else {
          Logger.info('Coor', '补活私信引擎（不跳转）');
          window.dispatchEvent(new CustomEvent('sg-chat-command', { detail: { command: 'start', targetUrl: '' } }));
          coWrite('chat', { running: true, phase: 'active', targetUrl: '', startedAt: Date.now(), lastActive: Date.now() });
          if (coModules.chat) { coModules.chat._state = 'running'; coModules.chat._startedAt = Date.now(); }
        }
      }
      if (sessionStorage.getItem(K.SK_NURTURE_RUNNING) === 'true') {
        Logger.info('Coor', '补活养号引擎（不跳转）');
        window.dispatchEvent(new CustomEvent('sg-nurture-command', { detail: { command: 'start', targetUrl: '' } }));
        coWrite('nurture', { running: true, phase: 'active', targetUrl: '', startedAt: Date.now(), lastActive: Date.now() });
        if (coModules.nurture) { coModules.nurture._state = 'running'; coModules.nurture._startedAt = Date.now(); }
      }
      if (localStorage.getItem(K.LK_FOLLOW_RUNNING) === 'true') {
        try {
          if (sessionStorage.getItem(K.SK_TAB_RUNNING) === 'stopped_by_user') {
            sessionStorage.setItem(K.SK_TAB_RUNNING, 'true');
          }
        } catch (eTabRh) {}
        Logger.info('Coor', '补活关注引擎（不跳转）');
        window.dispatchEvent(new CustomEvent('sg-follow-command', { detail: { command: 'start', targetUrl: '' } }));
        coWrite('follow', { running: true, phase: 'active', targetUrl: '', startedAt: Date.now(), lastActive: Date.now() });
        if (coModules.follow) { coModules.follow._state = 'running'; coModules.follow._startedAt = Date.now(); }
      }
      if (sessionStorage.getItem(K.SK_REPOST_RUNNING || 'sg_repost_running') === 'true') {
        var allowRp = false;
        try {
          allowRp = !!(typeof RepostTracker !== 'undefined' && RepostTracker.isAutoSlot && RepostTracker.isAutoSlot());
        } catch (eA) {}
        if (!allowRp) {
          try { allowRp = !coRunning; } catch (eB) {}
        }
        if (allowRp) {
          Logger.info('Coor', '补活转帖引擎（不跳转）');
          window.dispatchEvent(new CustomEvent('sg-repost-command', {
            detail: { command: 'start', targetUrl: '', autoSlot: !!sessionStorage.getItem('sg_repost_auto_slot') }
          }));
          coWrite('repost', { running: true, phase: 'active', targetUrl: '', startedAt: Date.now(), lastActive: Date.now() });
          if (coModules.repost) { coModules.repost._state = 'running'; coModules.repost._startedAt = Date.now(); }
        }
      }
    } catch (e) {}
  }

  function coPauseScheduler() { coRunning = false; }
  function coResumeScheduler() {
    if (!isSchedulerModuleEnabled()) {
      coRunning = false;
      Logger.info('Coor', '后台关闭调度模块，拒绝 resume');
      return;
    }
    coRunning = true;
    installCoTimers();
    coTick();
  }

  function coInit() {
    window._lastModuleAction = { follow: Date.now(), chat: Date.now(), nurture: Date.now(), repost: Date.now() };
    window.addEventListener('matrix-nurture-log', function () { if (window._lastModuleAction) window._lastModuleAction.nurture = Date.now(); });
    window.addEventListener('matrix-follow-status', function () { if (window._lastModuleAction) window._lastModuleAction.follow = Date.now(); });
    window.addEventListener('sg-soft-risk-entered', function (e) {
      try { coGentleStopFollow(); } catch (eSr) {}
      // 钉 soft_fill，防 stopBot/自恢复把旗标盖掉后关注在软窗内再起
      try { sessionStorage.setItem(K.SK_TAB_RUNNING, 'soft_fill'); } catch (eSf) {}
      try { localStorage.removeItem(K.LK_FOLLOW_RUNNING); } catch (eLf) {}
      // nurture-only / 非 chat_fill：立刻拉养号回首页，避免停在博主粉丝页空坐整窗
      try {
        var detail = (e && e.detail) || {};
        var needNurture = !detail.allowChat
          || detail.mode === 'nurture'
          || detail.softFillMode === 'nurture_only'
          || detail.softFillMode === 'off';
        if (!needNurture) return;
        setTimeout(function () {
          try {
            if (!softRiskActive(coLoadSg(), Date.now())) return;
            try { sessionStorage.setItem(K.SK_TAB_RUNNING, 'soft_fill'); } catch (eSf2) {}
            if (coEngineAlive('nurture')) return;
            var home = 'https://x.com/home';
            try {
              if (typeof PageRouter !== 'undefined' && PageRouter.homeUrlFor) {
                home = PageRouter.homeUrlFor('nurture') || home;
              }
            } catch (eHome) {}
            Logger.info('Coor', '软窗进场立刻启养号 → ' + home);
            coStart('nurture', home);
          } catch (eKick) {}
        }, 600);
      } catch (eN) {}
    });

    coModules = {};
    coRegisterFn('nurture', { canRun: function () { return moduleSwitchOn('nurture'); }, start: function (u) { startNurture(u); }, stop: function () { stopNurture(); } });
    coRegisterFn('repost', {
      canRun: function (s) {
        // 私信时段禁；非私信时段可跑（独占路径为主，此处兜底）
        try {
          if (readWorkChatHours().isChatTime) return false;
        } catch (eCt) {}
        return nightRepostShouldRun();
      },
      start: function (u) { startRepost(u, { autoSlot: true, freshRound: false }); },
      stop: function () { stopRepost('cmd'); }
    });
    coRegisterFn('follow',  { canRun: function (s) {
      if (!moduleSwitchOn('follow')) return false;
      try {
        if (isChatRushActive(coLoadSg())) return false;
        if (softRiskActive(coLoadSg(), Date.now())) return false;
        // 转帖独占时禁止关注
        if (coIsRunning('repost') || coEngineAlive('repost')) return false;
        try {
          if (!readWorkChatHours().isChatTime && nightRepostShouldRun()) return false;
        } catch (eRp) {}
      } catch (eF) {}
      return true;
    }, start: function (u) { startFollow(u); }, stop: function () { stopFollow(); } });
    coRegisterFn('chat',    { canRun: function (s) {
      if (!moduleSwitchOn('chat')) return false;
      try {
        // 软窗/赶工须先放行进 coTick 闸门，日帽在启动环里判定并走 softRiskChatBlockedFallback
        if (isChatRushActive(coLoadSg())) return true;
        var sgC = coLoadSg();
        if (softRiskActive(sgC, Date.now()) && !sgC.softRiskChatDone) {
          return !!resolveSoftFillModeCo(sgC).allowChat;
        }
        if (isChatDailyCapReachedCo()) return false;
      } catch (eC) {}
      return s === 'S3';
    }, start: function (u) { startChat(u); }, stop: function () { stopChat(); } });

    try {
      window.addEventListener('sg-config-synced', function () {
        try {
          if (!isSchedulerModuleEnabled()) {
            coPauseScheduler();
            Logger.info('Coor', '配置同步：调度模块已关闭');
            return;
          }
          installCoTimers();
        } catch (eSync) {}
      });
    } catch (eEv) {}

    var sg0 = coLoadSg();

    // 初始化时立即做一次跨日检测（不用等第一个 tick 周期）
    try { ensureFollowDailyRollover(); } catch (eInitRoll) {}
    try { ensureNurtureDailyRollover(); } catch (eInitNurtRoll) {}

    if (sg0.running) {
      S.running = true;
      coStartScheduler();
      Logger.info('调度', '调度 V3 已启动(刷新恢复自动模式)');
    } else {
      S.running = false;
      coRunning = false;
      installCoTimers();
      Logger.info('调度', '调度 V3 待命(未开自动模式)');
    }

    // 远程指令：约每 10 秒向 OPS claim 一次（白名单：start/pause/reset_*），执行后 ACK
    try {
      if (!window._sgRemoteCmdTimer) {
        var claimRemote = function () {
          try {
            if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
            chrome.runtime.sendMessage({ action: 'ops_remote_command_claim', bot_id: getWorkerId() }, function (r) {
              if (chrome.runtime.lastError) return;
              if (!r || !r.ok || !r.command) return;
              var cmd = String(r.command).toLowerCase();
              Logger.info('调度', '收到远程指令: ' + cmd);
              var ok = true;
              try {
                if (cmd === 'start') ok = schedulerStart() !== false;
                else if (cmd === 'pause') { schedulerPause(); ok = true; }
                else if (cmd === 'reset_profile_media') {
                  try {
                    if (typeof ProfileClone !== 'undefined' && ProfileClone.abort) {
                      ProfileClone.abort('ops_reset_media');
                    }
                  } catch (eAb) {}
                  try {
                    // 整份重跑：简介也可能被自动翻译污染，不能只清图
                    if (typeof ProfileClone !== 'undefined' && ProfileClone.resetAll) {
                      ProfileClone.resetAll();
                      Logger.info('调度', '远程重置资料克隆(全文+图)');
                      ok = true;
                    } else if (typeof ProfileClone !== 'undefined' && ProfileClone.resetMedia) {
                      ProfileClone.resetMedia();
                      Logger.info('调度', '远程重置资料补图状态');
                      ok = true;
                    } else {
                      Logger.warn('调度', 'ProfileClone 未注入，无法重置资料');
                      ok = false;
                    }
                  } catch (eRm) {
                    ok = false;
                  }
                }
                else if (cmd === 'reset_follow_daily_limit') {
                  ok = false;
                  try {
                    var hRf = String(getMyHandle() || '').replace(/^@/, '').replace(/#guard$/i, '').toLowerCase();
                    if (!hRf || hRf === 'unknown' || hRf === '未知账号') {
                      Logger.warn('调度', '远程重锁关注日限失败：无 handle');
                    } else {
                      var keyRf = 'matrix_stats_' + hRf;
                      var stRf = {};
                      try { stRf = JSON.parse(localStorage.getItem(keyRf) || '{}') || {}; } catch (eSt) { stRf = {}; }
                      var oldLock = parseInt(stRf.daily_limit, 10) || 0;
                      var oldUsed = parseInt(stRf.follows_today, 10) || 0;
                      try {
                        var todayRf = '';
                        try { todayRf = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }); } catch (eTd) {}
                        if (todayRf) stRf.date = todayRf;
                        // 4.3.30：清零今日已关 + 重抽上限（否则 used≥新锁仍显示满）
                        stRf.follows_today = 0;
                        stRf.follows_reset_day = todayRf || stRf.date || '';
                        delete stRf.daily_limit;
                        var dayRf = Math.max(1, parseInt(stRf.day_count, 10) || 1);
                        var pickMin = 15;
                        var pickMax = 20;
                        try {
                          if (typeof RemoteSettings !== 'undefined' && RemoteSettings.followDayRange) {
                            var rngRf = RemoteSettings.followDayRange(dayRf);
                            if (rngRf) {
                              pickMin = Math.max(1, parseInt(rngRf.min, 10) || pickMin);
                              pickMax = Math.max(pickMin, parseInt(rngRf.max, 10) || pickMax);
                            }
                          }
                        } catch (eRng) {}
                        if (pickMax < pickMin) { var tSwap = pickMin; pickMin = pickMax; pickMax = tSwap; }
                        stRf.daily_limit = pickMin + Math.floor(Math.random() * (pickMax - pickMin + 1));
                        localStorage.setItem(keyRf, JSON.stringify(stRf));
                        ok = true;
                        try {
                          var sgY = coLoadSg();
                          sgY.followNextDelayUntil = 0;
                          coSaveSg(sgY);
                        } catch (eClrD) {}
                        try {
                          var msRf = JSON.parse(sessionStorage.getItem('sg_module_follow') || '{}') || {};
                          if (msRf.phase === 'quota_exhausted' || msRf.phase === 'quota') {
                            msRf.phase = 'idle';
                            msRf.running = false;
                            sessionStorage.setItem('sg_module_follow', JSON.stringify(msRf));
                          }
                        } catch (eMsRf) {}
                        Logger.info('调度', '远程重锁关注日限: 已关' + oldUsed + '→0 旧锁' + oldLock + '→新锁' + stRf.daily_limit + ' Day' + dayRf);
                      } catch (eWrite) {
                        Logger.warn('调度', '远程重锁关注日限写失败');
                      }
                    }
                  } catch (eRf) {
                    ok = false;
                  }
                }
                else if (cmd === 'reset_chat_local') {
                  ok = false;
                  try {
                    [
                      'chat_target_db', 'dan_reject_users', 'dan_ice_task_queue',
                      'dan_session_scanned', 'sg_fan_roster_baseline', 'dan_completed_targets',
                      'dan_ops_round_map', 'sg_chat_lease', 'sg_diag_freeze'
                    ].forEach(function (k) {
                      try { localStorage.removeItem(k); } catch (eRm) {}
                    });
                    try {
                      var sgW = coLoadSg();
                      // 4.6.29：一次性清全部软风控+私信状态，避免残留
                      // 之前只清了 phase/until/chatDone + freeze，漏了 chatPass/outboundDone/
                      // chatNextAllowedAt/mode/overtimeMs 等，导致重置后仍被冷却或相位残留卡住
                      sgW.softRiskPhase = '';
                      sgW.softRiskUntil = 0;
                      sgW.softRiskMode = '';
                      sgW.softRiskChatDone = false;
                      sgW.softRiskOutboundDone = false;
                      sgW.softRiskChatPass = 0;
                      sgW.softRiskIceExtendMs = 0;
                      sgW.softRiskOvertimeMs = 0;
                      sgW.softRiskStartedAt = 0;
                      sgW.softFillMode = '';
                      sgW.chatNextAllowedAt = 0;
                      // 同步清定格快照：重置后目标库重建，firstSeen 都是新时间，
                      // 旧的 chatFreezeAt 会把所有新粉判成「定格后新粉」→ 全 freeze 跳过，
                      // 导致当天一个破冰都发不出去。
                      sgW.chatFreezeDate = '';
                      sgW.chatFreezeAt = 0;
                      sgW.chatFreezeHandles = [];
                      sgW.chatFreezeSealed = false;
                      // 4.6.30：清当日私信时长/轮次（出站帽/总帽），
                      // 不然重置了目标库但出站帽到了 chat 还是不跑，等于半拉子重置。
                      sgW.chatDate = '';
                      sgW.chatTotalToday = 0;
                      sgW.chatOutboundToday = 0;
                      sgW.chatInboxToday = 0;
                      sgW.chatRoundsToday = 0;
                      sgW.chatLastEndAt = 0;
                      // 同步清内存态 S，免得本 tab 下一次 tick 还读旧值（4.6.30 补 nurtureOnly）
                      try {
                        S.chatDate = '';
                        S.chatRoundsToday = 0;
                        S.chatLastEndAt = 0;
                        S.nurtureOnly = false;
                      } catch (eS) {}
                      coSaveSg(sgW);
                    } catch (eSgW) {}
                    try {
                      var killKeys = [];
                      for (var si = 0; si < sessionStorage.length; si++) {
                        var sk = sessionStorage.key(si);
                        if (!sk) continue;
                        // 4.6.29：补清 ops_target_rounds / sg_soft_chat2_prepared / sg_soft_risk_* 等
                        // 漏清 ops_target_rounds 会导致 getEffectiveFanRound 仍取 OPS 轮次≥1
                        // → 全员判 completed → 队列为空 → 误报「发完」转回养号
                        // 4.6.30：补 sg_debt_* 前缀（仅清债模式残留会导致 harvest 直接 return 0）
                        if (/^dan_|^sg_chat_|^sg_soft_|^sg_debt_|^ops_|current_target|dan_auto_step|dan_ice_/.test(sk)) {
                          killKeys.push(sk);
                        }
                      }
                      killKeys.forEach(function (k) {
                        try { sessionStorage.removeItem(k); } catch (eSk) {}
                      });
                    } catch (eSs) {}
                    // 4.6.30：跨 tab 广播——其他 tab 的 sessionStorage 是各自独立的，
                    // reset 命令只清了当前 tab，粉丝页/私信页的 sessionStorage 纹丝不动，
                    // 导致 ops_target_rounds / completed_targets / session_scanned 残留，
                    // 全员判 completed → pending=0 → 债=0。
                    // 写 localStorage 递增标记，所有 tab 通过 storage 事件收到后自清。
                    try {
                      var prevSeq = parseInt(localStorage.getItem('sg_reset_chat_seq') || '0', 10) || 0;
                      localStorage.setItem('sg_reset_chat_seq', String(prevSeq + 1));
                      localStorage.setItem('sg_reset_chat_at', String(Date.now()));
                    } catch (eBroadcast) {}
                    ok = true;
                    Logger.info('调度', '远程重置私信本地底账完成（已广播所有tab）');
                    try { showToast && showToast('已清本地私信底账', '#3fb950', 2500); } catch (eT) {}
                  } catch (eWipe) {
                    ok = false;
                    Logger.warn('调度', '远程重置私信本地失败');
                  }
                }
                else if (cmd === 'clear_dead_handles') {
                  ok = false;
                  try {
                    localStorage.setItem('matrix_dead_handles', '[]');
                    ok = true;
                    Logger.info('调度', '远程清空本地死号名单 matrix_dead_handles');
                    try { showToast && showToast('已清本地死号名单', '#3fb950', 2500); } catch (eT2) {}
                  } catch (eDead) {
                    ok = false;
                    Logger.warn('调度', '远程清本地死号名单失败');
                  }
                }
                else ok = false;
              } catch (eExec) { ok = false; }
              ackRemoteCommand(cmd, ok);
              try { pushRuntimeHeartbeat('full', true); } catch (eHbC) {}
            });
          } catch (eClaim) {}
        };
        claimRemote();
        window._sgRemoteCmdTimer = setInterval(claimRemote, 10000);
      }
    } catch (eRemote) {}

    // 运行态心跳：自动模式约每 30s 全量上报（监控只观测，失败不打断调度）
    try {
      if (!window._sgRuntimeHbTimer) {
        window._sgRuntimeHbTimer = setInterval(function () {
          try {
            if (S.running || coRunning) pushRuntimeHeartbeat('full', false);
          } catch (eT) {}
        }, 30000);
        if (S.running || coRunning) {
          try { pushRuntimeHeartbeat('full', true); } catch (e0) {}
        }
      }
    } catch (eHbT) {}

    // 私信边沿：content_chat 拉起/结束时立刻加急一包
    try {
      if (!window._sgRuntimePushBound) {
        window._sgRuntimePushBound = true;
        window.addEventListener('sg-runtime-push', function () {
          try { pushRuntimeHeartbeat('edge', true); } catch (eEdge) {}
        });
      }
    } catch (eBind) {}
  }

  function coRegisterFn(n, mod) {
    if (!mod || typeof mod.canRun !== 'function') return;
    coModules[n] = mod; mod._name = n; mod._state = 'stopped'; mod._startedAt = 0;
  }

  // ==================== 页面内直发命令（不走 chrome.runtime，避免消息端口关闭） ====================
  try {
    window.addEventListener('sg-chat-test-command', function () {
      try { sessionStorage.setItem('sg_chat_force_inbox', 'true'); } catch (eF) {}
      try { sessionStorage.removeItem('sg_debt_only'); } catch (eD) {}
      manualChatTest();
    });
  } catch (eEv) {}

  // 页面内直发命令：G1 主控 / E4 浮层的手动按钮统一走这里，绕过 SW（避免 SW 休眠丢消息）
  try {
    window.addEventListener('sg-page-cmd', function (ev) {
      var a = ev && ev.detail && ev.detail.action;
      if (!a) return;
      if (a === 'sg_scheduler_start') { schedulerStart(); return; }
      if (a === 'sg_scheduler_pause') { schedulerPause(); return; }
      if (a === 'sg_manual_follow') { manualFollow(); return; }
      if (a === 'sg_manual_chat') { manualChat(); return; }
      if (a === 'sg_nurture_only') { toggleNurtureOnly(); return; }
      if (a === 'sg_manual_repost') { manualRepost(); return; }
    });
  } catch (eEv2) {}

  // ==================== 消息监听 ====================
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (msg.action === 'sg_scheduler_start')  { schedulerStart(); sendResponse({ ok: true }); return true; }
      if (msg.action === 'sg_scheduler_pause')  { schedulerPause(); sendResponse({ ok: true }); return true; }
      if (msg.action === 'sg_manual_follow')    { manualFollow(); sendResponse({ ok: true }); return true; }
      if (msg.action === 'sg_manual_chat')      { manualChat(); sendResponse({ ok: true }); return true; }
      if (msg.action === 'sg_manual_chat_test') { manualChatTest(); sendResponse({ ok: true }); return true; }
      if (msg.action === 'sg_manual_nurture')   { manualNurture(); sendResponse({ ok: true }); return true; }
      if (msg.action === 'sg_manual_repost')   { manualRepost(); sendResponse({ ok: true }); return true; }
      if (msg.action === 'sg_nurture_only')     { toggleNurtureOnly(); sendResponse({ ok: true }); return true; }
      if (msg.action === 'sg_nurture_throttled') {
        Logger.info('调度', '养号报告: 今日配额用完');
        if (!S.nurtureOnly && S.engine === 'nurture_only') {
          S.engine = 'idle'; saveSG();
        }
        sendResponse({ ok: true }); return true;
      }
      if (msg.action === 'sg_test_chat_first') {
        stopFollow(); stopChat();
        S.running = true; S.engine = 'chat'; S.followRound = 2; S.followPhase = 'idle'; S.pendingChat = true; S.chatPhase = 'running';
        sessionStorage.setItem(K.SK_CHAT_AUTO_RUN, 'true');
        localStorage.setItem(K.LK_CHAT_STATUS, 'running');
        localStorage.setItem(K.LK_CHAT_RECOVERY, 'true');
        saveSG(); updatePanel();
        var myH = getMyHandle();
        if (myH !== 'unknown') window.location.href = 'https://x.com/' + myH + '/followers?_t=' + Date.now();
        sendResponse({ ok: true }); return true;
      }
      if (msg.action === 'sg_scheduler_status') {
        var rn = null;
        try { for (var rk in coModules) { if (coIsRunning(rk)) { rn = rk; break; } } } catch (eRn) {}
        var st = coPrev.stage || 'S0';
        try { if (typeof StageDetector !== 'undefined') st = StageDetector.detect().stage || st; } catch (eSt) {}
        var why = '';
        var softStat = { active: false, remainSec: 0, mode: '', chatDone: false };
        var freezeStat = { frozen: false, total: 0, pending: 0, rushing: false, rushWindow: false };
        var diagFr = null;
        try {
          if (typeof SgDiagContract !== 'undefined') diagFr = SgDiagContract.readFreeze();
        } catch (eDf2) {}
        try {
          softStat = softRiskSnapshot(coLoadSg(), Date.now());
          freezeStat = chatFreezeSnapshot(coLoadSg());
          if (diagFr && diagFr.on) why = '诊断冻结: ' + (diagFr.hint || diagFr.reason || '');
          else if (!rn) why = computeWhyIdle({ autoMode: coRunning || S.running, stage: st, runningModule: rn });
        } catch (eWhy) {}
        var rpStat = repostStatusSnap();
        var hours = { isWorkTime: true, isChatTime: true };
        try { hours = readWorkChatHours(); } catch (eH) {}
        sendResponse({
          engine: S.engine, followRound: S.followRound, followPhase: S.followPhase,
          autoMode: S.running || coRunning, pendingChat: S.pendingChat, chatPhase: S.chatPhase, chatRoundsToday: S.chatRoundsToday,
          warmupEndAt: S.warmupEndAt, followRunning: localStorage.getItem(K.LK_FOLLOW_RUNNING) === 'true',
          warmupNeeded: localStorage.getItem(K.LK_WARMUP_NEEDED) === 'true', chatRunning: sessionStorage.getItem(K.SK_CHAT_AUTO_RUN) === 'true',
          nurtureRunning: sessionStorage.getItem(K.SK_NURTURE_RUNNING) === 'true', nurtureOnly: S.nurtureOnly,
          dayCount: getDayCount(), followedToday: getFollowedToday(), followLimit: getLimit(), url: window.location.href,
          currentCreator: S.currentBlogger || localStorage.getItem(K.LK_CURRENT_CREATOR) || '', suspended: S.suspendedBlogger,
          stage: st, runningModule: rn, whyIdle: why, softRisk: softStat, chatFreeze: freezeStat, diagFreeze: diagFr,
          repostRunning: rpStat.running, repostCurrent: rpStat.current, repostDaily: rpStat.daily,
          profileClone: profileCloneSnap(),
          isWorkTime: !!hours.isWorkTime, isChatTime: !!hours.isChatTime,
          chatDiag: buildChatDiag(coLoadSg())
        }); return true;
      }
    });
  }

  window.addEventListener('beforeunload', saveSG);

  // ====== 跨 tab 私信重置广播：storage 事件监听 ======
  // sessionStorage 按 tab 隔离，reset 命令在别的 tab 执行时清不到这里。
  // 通过 localStorage 的 sg_reset_chat_seq 变化广播，每个 tab 自己清 sessionStorage。
  (function () {
    var RESET_KEY = 'sg_reset_chat_seq';
    var lastSeq = 0;
    try { lastSeq = parseInt(localStorage.getItem(RESET_KEY) || '0', 10) || 0; } catch (e) {}
    function clearChatSessionStorage(why) {
      try {
        var killKeys = [];
        for (var si = 0; si < sessionStorage.length; si++) {
          var sk = sessionStorage.key(si);
          if (!sk) continue;
          if (/^dan_|^sg_chat_|^sg_soft_|^sg_debt_|^ops_|current_target|dan_auto_step|dan_ice_/.test(sk)) {
            killKeys.push(sk);
          }
        }
        killKeys.forEach(function (k) {
          try { sessionStorage.removeItem(k); } catch (eRk) {}
        });
        console.log('[调度-重置广播] ' + (why || 'storage_event') + '：已清本 tab sessionStorage (' + killKeys.length + ' 项)');
        try { showToast && showToast('🔄 私信底账已重置（本tab）', '#3fb950', 2000); } catch (eT) {}
      } catch (e) {}
    }
    try {
      window.addEventListener('storage', function (e) {
        if (!e || e.key !== RESET_KEY) return;
        var newSeq = parseInt(e.newValue || '0', 10) || 0;
        if (newSeq > lastSeq) {
          lastSeq = newSeq;
          clearChatSessionStorage('storage_event');
        }
      });
    } catch (eL) {}
    try {
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) return;
        try {
          var cur = parseInt(localStorage.getItem(RESET_KEY) || '0', 10) || 0;
          if (cur > lastSeq) {
            lastSeq = cur;
            clearChatSessionStorage('visibility_check');
          }
        } catch (eChk) {}
      });
    } catch (eVc) {}
  })();

  setTimeout(init, 1500);

  // ==================== 诊断 API ====================
  function buildDiag() {
    try {
      var sg = {};
      try { sg = JSON.parse(localStorage.getItem(K.LK_STATE) || '{}'); } catch (_) {}
      var errLog = [];
      try { errLog = JSON.parse(localStorage.getItem('sg_error_log') || '[]'); } catch (_) {}
      var switches = null;
      try { switches = JSON.parse(localStorage.getItem('sg_module_switches') || 'null'); } catch (_) {}
      var modSnap = {};
      try {
        ['follow', 'chat', 'nurture'].forEach(function (n) {
          modSnap[n] = coRead(n);
        });
      } catch (_) {}
      var followDrift = null;
      try { followDrift = JSON.parse(sessionStorage.getItem('sg_follow_drift') || 'null'); } catch (_) {}
      var followDriftLog = [];
      try { followDriftLog = JSON.parse(localStorage.getItem('sg_follow_drift_log') || '[]'); } catch (_) {}
      var live = null;
      try {
        if (typeof StageDetector !== 'undefined' && StageDetector.detect) live = StageDetector.detect();
      } catch (_) {}
      var sh = null;
      try {
        if (typeof TimeUtil !== 'undefined' && TimeUtil.shanghaiParts) sh = TimeUtil.shanghaiParts();
      } catch (_) {}
      return {
        stage: (live && live.stage) || g_stage,
        stageCached: g_stage,
        coStage: sg.coStage || '?',
        stagePriority: (live && live.priority) || [],
        shanghaiNow: (typeof TimeUtil !== 'undefined' && TimeUtil.nowLabel) ? TimeUtil.nowLabel() : '?',
        shanghaiHM: sh,
        isWorkTime: readWorkChatHours().isWorkTime,
        isChatTime: readWorkChatHours().isChatTime,
        coPageOwner: sg.coPageOwner || '?',
        coModules: sg.coModules || {},
        moduleLive: modSnap,
        followDrift: followDrift,
        followDriftLog: followDriftLog.slice(-10),
        schedulerRunning: !!(sg.running),
        autoMode: !!(sg.running),
        diagFreeze: (function () {
          try {
            if (typeof SgDiagContract !== 'undefined') return SgDiagContract.readFreeze();
          } catch (e) {}
          return null;
        })(),
        coRunning: !!coRunning,
        engine: sg.engine || 'idle',
        followPhase: sg.followPhase || 'idle',
        chatPhase: sg.chatPhase || 'idle',
        dayCount: getDayCount(),
        followedToday: getFollowedToday(),
        followLimit: getLimit(),
        myHandle: getMyHandle(),
        currentCreator: S.currentBlogger || localStorage.getItem(K.LK_CURRENT_CREATOR) || '',
        nurtureRunning: sessionStorage.getItem(K.SK_NURTURE_RUNNING) === 'true',
        followRunning: localStorage.getItem(K.LK_FOLLOW_RUNNING) === 'true',
        chatRunning: sessionStorage.getItem(K.SK_CHAT_AUTO_RUN) === 'true',
        repostRunning: sessionStorage.getItem(K.SK_REPOST_RUNNING || 'sg_repost_running') === 'true',
        engineAlive: {
          follow: coEngineAlive('follow'),
          chat: coEngineAlive('chat'),
          nurture: coEngineAlive('nurture'),
          repost: coEngineAlive('repost')
        },
        pausedTill: parseInt(sessionStorage.getItem(K.SK_PAUSED_TILL) || '0') || 0,
        pausedRemainMs: Math.max(0, (parseInt(sessionStorage.getItem(K.SK_PAUSED_TILL) || '0') || 0) - Date.now()),
        url: window.location.href,
        urlOwner: typeof PageRouter !== 'undefined' ? PageRouter.fromUrl() : '?',
        moduleSwitches: switches,
        errors: errLog.slice(-5),
        errorCount: errLog.length,
        chatDiag: buildChatDiag(sg)
      };
    } catch (e) { return { error: e.message }; }
  }

  function attachDiagApi() {
    try {
      if (!window.__matrix_console__) window.__matrix_console__ = {};
      window.__matrix_console__.diag = buildDiag;
      window.__matrix_console__.resetCooldown = function () {
        sessionStorage.removeItem(K.SK_PAUSED_TILL);
        Logger.info('Diag', '已清除跳转冷却（sg_paused_till）');
        return true;
      };
      window.__matrix_console__.getErrors = function () {
        try { return JSON.parse(localStorage.getItem('sg_error_log') || '[]'); } catch (_) { return []; }
      };
      window.__matrix_console__.clearErrors = function () {
        localStorage.removeItem('sg_error_log');
      };
      window.__sgDiag = buildDiag;
    } catch (e) {}
  }

  // 桥到页面 JS 世界：页面控制台可执行 await __sgDiag()
  // 页面侧由 page-diag-bridge.js（world:MAIN）注入；此处只应答
  function installPageDiagBridge() {
    try {
      if (window.__sgDiagBridgeListening) return;
      window.__sgDiagBridgeListening = true;
      window.addEventListener('message', function (e) {
        if (e.source !== window || !e.data) return;
        if (e.data.type === '__sg_diag_request') {
          var payload = buildDiag();
          window.postMessage({ type: '__sg_diag_result', payload: payload, id: e.data.id || 0 }, '*');
          return;
        }
        if (e.data.type === '__sg_parse_age_request') {
          var val = null;
          var pfn = getSgParseAgeFn();
          if (pfn) {
            try { val = pfn(e.data.text); } catch (ePa) {}
          }
          window.postMessage({ type: '__sg_parse_age_result', id: e.data.id, value: val }, '*');
        }
      });
      try { document.documentElement.setAttribute('data-sg-isolated', '1'); } catch (e2) {}
      console.log('[智能调度/隔离世界] diag 应答已就绪');
    } catch (e) {}
  }

  attachDiagApi();
  installPageDiagBridge();
  setTimeout(attachDiagApi, 2000);
  setTimeout(installPageDiagBridge, 500);
})();

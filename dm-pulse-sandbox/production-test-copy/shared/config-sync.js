// =============================================================================
// 智能调度 — 配置同步模块 V2
// 从 ops-console /api/config/all 拉配置 → localStorage / chrome.storage
// 远程配置优先，供 RemoteSettings + 各引擎消费
// =============================================================================

(function () {
  'use strict';

  var SYNC_INTERVAL_MS = 1 * 60 * 1000;
  var DEFAULT_THRESHOLDS = {
    follow_daily_limit: '310',
    follow_first_day_limit: '85',
    follow_day2_limit: '145',
    follow_step_per_day: '55',
    follow_day1_min: '80', follow_day1_max: '90',
    follow_day2_min: '135', follow_day2_max: '155',
    follow_day3_min: '190', follow_day3_max: '215',
    follow_day4_min: '240', follow_day4_max: '270',
    follow_day5_min: '285', follow_day5_max: '300',
    follow_day6_min: '290', follow_day6_max: '310',
    follow_interval_min_sec: '2',
    follow_interval_max_sec: '4',
    follow_retry_delay_sec: '300',
    risk_cooldown_gradient: '[60,120,240,600]',
    nurture_daily_likes: '12',
    nurture_daily_comments: '2',
    nurture_daily_reposts_min: '1',
    nurture_daily_reposts_max: '2',
    nurture_daily_enters: '5',
    nurture_daily_trends_min: '5',
    nurture_daily_trends_max: '10',
    nurture_daily_profiles_min: '2',
    nurture_daily_profiles_max: '5',
    nurture_hourly_likes: '2',
    nurture_hourly_comments: '1',
    nurture_hourly_reposts: '1',
    nurture_hourly_enters: '2',
    nurture_hourly_trends_min: '1',
    nurture_hourly_trends_max: '2',
    nurture_hourly_profiles_min: '0',
    nurture_hourly_profiles_max: '1',
    nurture_action_gap_min_sec: '45',
    nurture_action_gap_max_sec: '90',
    nurture_like_cooldown_min: '8',
    nurture_comment_cooldown_min: '45',
    chat_rounds_per_day: '3',
    chat_cooldown_hours: '2',
    chat_cooldown_min_min: '25',
    chat_cooldown_max_min: '35',
    chat_debt_cooldown_min_min: '8',
    chat_debt_cooldown_max_min: '12',
    chat_ad_min_wait_min: '60',
    chat_two_seg_mode: 'on',
    chat_inbox_visit_cap_sec: '150',
    sg_roster_check_min: '30',
    sg_inbox_revisit_min: '8',
    sg_inbox_pulse_sec: '60',
    chat_script_pool: 'dating',
    stage_stall_cooldown_sec: '180',
    stage_tick_interval_ms: '10000',
    stage_watchdog_ms: '30000',
    nav_min_interval_ms: '45000',
    media_load_mode: 'off',
    chat_stagger_slots: '1',
    chat_stagger_slot_min: '30',
    fleet_heavy_slots: '8',
    follow_only_japanese: 'false',
    follow_antiban_enabled: 'false'
  };
  var DEFAULT_MODULES = { nurture: true, follow: true, chat: true, scheduler: true, repost: true };
  var _timer = null;
  var _retryTimer = null;
  var _retryCount = 0;
  var RETRY_BACKOFFS = [5000, 15000, 30000]; // 失败后快速重试：5s → 15s → 30s → 回归1分钟常态

  /** 导航栏个人资料链接 = 登录本号。来源主页的地址栏不能当 bot_id。 */
  function readNavLoginHandle() {
    try {
      if (typeof document === 'undefined' || !document.querySelector) return '';
      var a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
      if (!a) return '';
      var href = (a.getAttribute && (a.getAttribute('href') || a.href)) || a.href || '';
      var m = String(href).match(/(?:x\.com|twitter\.com)?\/([A-Za-z0-9_]+)(?:\?|$)/i)
        || String(href).match(/^\/([A-Za-z0-9_]+)/);
      if (m && m[1] && !/^(home|explore|search|i|settings|messages|notifications|compose|account)$/i.test(m[1])) {
        return m[1].toLowerCase();
      }
    } catch (eNav) {}
    return '';
  }

  function getBotId() {
    try {
      var nav = readNavLoginHandle();
      if (nav) return '@' + nav + '#guard';
      var bound = localStorage.getItem('sg_bound_handle');
      if (bound) {
        bound = String(bound).replace(/^@/, '').replace(/#guard$/i, '').trim();
        if (bound && bound.toLowerCase() !== 'unknown') return '@' + bound + '#guard';
      }
      var h = localStorage.getItem('matrix_my_handle');
      if (h) return h;
      h = sessionStorage.getItem('dan_worker_id');
      if (h) return h;
      h = localStorage.getItem('matrix_worker_id') || localStorage.getItem('sg_worker_id');
      if (h) return h;
      h = localStorage.getItem('matrix_extracted_handle');
      if (h) return '@' + String(h).replace(/^@/, '') + '#guard';
      h = localStorage.getItem('my_handle');
      if (h) return h;
    } catch (e) {}
    return '';
  }

  function normalizeHandleKey(botOrHandle) {
    return String(botOrHandle || '').replace(/^@/, '').replace(/#guard$/i, '').toLowerCase().trim();
  }

  /** 上海自然日 YYYY-MM-DD，避免 zh-CN / 补零不一致导致跨日清零失效 */
  function shanghaiDayKey() {
    try {
      return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    } catch (e) {
      var d = new Date(Date.now() + 8 * 3600 * 1000);
      return d.toISOString().slice(0, 10);
    }
  }

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
   * 4.6.88：本地关注配额跨日清零（ConfigSync/页面唤醒也能触发，不等 coTick）。
   * 场景：后台标签页冻结时 setInterval 暂停，零点过后 date 仍停昨天。
   */
  function ensureLocalFollowQuotaRollover(handleHint) {
    var h = normalizeHandleKey(handleHint || getBotId());
    if (!h || h === 'unknown') return false;
    try {
      var key = 'matrix_stats_' + h;
      var stats = {};
      try { stats = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (eSt) { stats = {}; }
      var today = shanghaiDayKey();
      var lastDate = toShanghaiDayKey(stats.date);
      if (!lastDate || lastDate === today) return false;
      stats.follows_today = 0;
      delete stats.daily_limit;
      // 4.6.185：打闩，挡同日 OPS runtime 昨日 followed_today 回灌
      stats.follows_reset_day = today;
      stats.date = today;
      localStorage.setItem(key, JSON.stringify(stats));
      try {
        var ms = JSON.parse(sessionStorage.getItem('sg_module_follow') || '{}') || {};
        if (ms.phase === 'quota_exhausted' || ms.phase === 'quota') {
          ms.phase = 'idle';
          ms.running = false;
          sessionStorage.setItem('sg_module_follow', JSON.stringify(ms));
        }
      } catch (eMs) {}
      console.log('[ConfigSync] 跨日清零关注配额: ' + lastDate + ' → ' + today + ' @' + h);
      return true;
    } catch (e) { return false; }
  }

  /**
   * OPS day_count → 本地 matrix_stats。
   * 跨日必须清零 follows_today（旧逻辑只改 date 不清配额，会残留昨天的 20/50）。
   * followsToday 若传入（OPS 今日真实关注数），以服务端为准纠正本地。
   */
  function applyRemoteDayCount(dayCount, handleHint, followsToday) {
    var dc = parseInt(dayCount, 10);
    if (!dc || dc < 1) return false;
    var h = normalizeHandleKey(handleHint || getBotId());
    if (!h || h === 'unknown') return false;
    try {
      var key = 'matrix_stats_' + h;
      var stats = {};
      try { stats = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (e1) { stats = {}; }
      var today = shanghaiDayKey();
      var prevDate = toShanghaiDayKey(stats.date);
      var rolled = !prevDate || prevDate !== today;
      if (rolled) {
        stats.follows_today = 0;
        delete stats.daily_limit; // 跨日重抽 DayN 随机配额
        // 4.6.185：保留/写入跨日闩（旧逻辑删闩 → 下一拍 OPS 昨日数又抬满）
        stats.follows_reset_day = today;
      } else if (stats.follows_today == null) {
        stats.follows_today = 0;
      }
      var localFollows = stats.follows_today || 0;
      var ft = null;
      if (followsToday != null && followsToday !== '') {
        var parsedFt = parseInt(followsToday, 10);
        if (!isNaN(parsedFt) && parsedFt >= 0) ft = parsedFt;
      }
      // 跨日闩 / 人工重锁：禁止 OPS today_follow_count（常为昨日 runtime）把本地又抬满
      var resetDay = toShanghaiDayKey(stats.follows_reset_day);
      var skipOpsBoost = !!(resetDay && resetDay === today);
      // 4.6.186：无闩污染态自愈（不限凌晨）——date 已是今日、已用>0、尚无 follows_reset_day
      // 视为跨日清零后被 OPS 回灌；有闩则视为当日真实关注，不误清
      if (!rolled && !skipOpsBoost && localFollows > 0 && !resetDay) {
        stats.follows_today = 0;
        stats.follows_reset_day = today;
        localFollows = 0;
        skipOpsBoost = true;
      }
      if (!rolled && ft != null && ft > localFollows && !skipOpsBoost) {
        stats.follows_today = ft;
      }
      stats.date = today;
      var prev = parseInt(stats.day_count, 10) || 0;
      stats.day_count = dc;
      // 换插件/空本地常会先误成 Day1 并锁死 15；OPS 日数对上后必须重抽配额
      // 亦：OPS 调高/调低 DayN 区间后，旧锁若已落在区间外（如锁 49 而 OPS Day2=60–70）必须重抽
      var dayMins = { 1: 15, 2: 45, 3: 90, 4: 150, 5: 200, 6: 250 };
      var dayMaxs = { 1: 20, 2: 50, 3: 100, 4: 160, 5: 210, 6: 260 };
      var slot = dc >= 6 ? 6 : dc;
      var minExpect = dayMins[slot] || 15;
      var maxExpect = dayMaxs[slot] || minExpect;
      try {
        if (typeof RemoteSettings !== 'undefined' && RemoteSettings.followDayRange) {
          var rngSync = RemoteSettings.followDayRange(dc);
          if (rngSync && rngSync.min != null) minExpect = Math.max(1, parseInt(rngSync.min, 10) || minExpect);
          if (rngSync && rngSync.max != null) maxExpect = Math.max(minExpect, parseInt(rngSync.max, 10) || maxExpect);
        }
      } catch (eRngS) {}
      var usedToday = Math.max(0, parseInt(stats.follows_today, 10) || 0);
      var locked = parseInt(stats.daily_limit, 10);
      var clearedQuotaLock = false;
      var outOfRange = !isNaN(locked) && locked > 0 && (locked < minExpect || locked > maxExpect);
      if (prev !== dc || (!isNaN(locked) && locked > 0 && locked < minExpect) || outOfRange) {
        delete stats.daily_limit;
        clearedQuotaLock = true;
      }
      // 清锁后立刻按 OPS 区间重抽，面板/getLimit 马上看到新数（不必等关注引擎再锁）
      if (clearedQuotaLock || isNaN(parseInt(stats.daily_limit, 10)) || !(parseInt(stats.daily_limit, 10) > 0)) {
        var pickMin = minExpect;
        var pickMax = maxExpect;
        if (pickMax < pickMin) { var tP = pickMin; pickMin = pickMax; pickMax = tP; }
        stats.daily_limit = Math.max(usedToday, pickMin + Math.floor(Math.random() * (pickMax - pickMin + 1)));
        clearedQuotaLock = true;
      }
      var finalLimit = parseInt(stats.daily_limit, 10);
      if (usedToday > 0 && (!(finalLimit > 0) || finalLimit < usedToday)) {
        stats.daily_limit = usedToday;
        clearedQuotaLock = true;
      }
      localStorage.setItem(key, JSON.stringify(stats));
      // 误按 Day1 锁死后会 phase=quota_exhausted + 8h 冷却；纠正 Day / 区间后必须解开
      if (clearedQuotaLock) {
        try {
          var ms = JSON.parse(sessionStorage.getItem('sg_module_follow') || '{}') || {};
          if (ms.phase === 'quota_exhausted' || ms.phase === 'quota') {
            ms.phase = 'idle';
            ms.running = false;
            sessionStorage.setItem('sg_module_follow', JSON.stringify(ms));
          }
        } catch (eMs) {}
        try {
          var sg = JSON.parse(localStorage.getItem('sg_state') || '{}') || {};
          if (sg.followNextDelayUntil && sg.followNextDelayUntil > Date.now()) {
            sg.followNextDelayUntil = 0;
            localStorage.setItem('sg_state', JSON.stringify(sg));
          }
        } catch (eSg) {}
      }
      try {
        var cs = JSON.parse(localStorage.getItem('matrix_console_settings') || '{}') || {};
        if (cs.dayOverride != null && cs.dayOverride !== '') {
          delete cs.dayOverride;
          localStorage.setItem('matrix_console_settings', JSON.stringify(cs));
        }
      } catch (e3) {}
      console.log('[ConfigSync] 同步 Day ' + prev + ' → ' + dc + (rolled ? ' (配额已跨日清零)' : '') +
        (clearedQuotaLock ? (' (已重锁日限→' + stats.daily_limit + ' 区间' + minExpect + '-' + maxExpect + ')') : '') + ' @' + h);
      return true;
    } catch (e) {
      return false;
    }
  }

  function pi(v, d) {
    var n = parseInt(v, 10);
    return isNaN(n) ? d : n;
  }

  /** 后台给单值 → 引擎要 {min,max}；矩阵精确控时 min=max */
  function budgetPair(n, d) {
    var v = pi(n, d);
    return { min: v, max: v };
  }

  /** 后台给区间 → 引擎每日随机抽一个上限 */
  function budgetRange(minV, maxV, dMin, dMax) {
    var a = pi(minV, dMin);
    var b = pi(maxV, dMax);
    if (a < 0) a = 0;
    if (b < 0) b = 0;
    if (b < a) { var t = a; a = b; b = t; }
    return { min: a, max: b };
  }

  /** 后台存秒；插件 risk_control 要毫秒 */
  function parseGradientSec(v) {
    var arr = null;
    if (Array.isArray(v)) arr = v;
    else if (typeof v === 'string') {
      try { arr = JSON.parse(v); } catch (e1) {
        arr = String(v).split(/[,，\s]+/).map(function (x) { return parseInt(x, 10); }).filter(function (n) { return !isNaN(n) && n > 0; });
      }
    }
    if (!arr || !arr.length) arr = [60, 120, 240, 600];
    return arr.map(function (n) {
      var x = parseInt(n, 10);
      if (isNaN(x) || x <= 0) return 60;
      // 已是毫秒（≥1000）则先还原成秒
      if (x >= 1000) x = Math.round(x / 1000);
      return x;
    });
  }

  function gradientMs(secArr) {
    return (secArr || [60, 120, 240, 600]).map(function (s) { return Math.max(1, parseInt(s, 10) || 60) * 1000; });
  }

  function buildNurtureRemote(thresholds) {
    return {
      dailyBudget: {
        likes: budgetPair(thresholds.nurture_daily_likes, 12),
        comments: budgetPair(thresholds.nurture_daily_comments, 2),
        reposts: { min: 0, max: 0 },
        trends: budgetRange(
          thresholds.nurture_daily_trends_min,
          thresholds.nurture_daily_trends_max,
          5,
          10
        ),
        profiles: budgetRange(
          thresholds.nurture_daily_profiles_min,
          thresholds.nurture_daily_profiles_max,
          2,
          5
        ),
        enters: budgetPair(thresholds.nurture_daily_enters, 5)
      },
      hourlyBudget: {
        likes: budgetPair(thresholds.nurture_hourly_likes, 2),
        comments: budgetPair(thresholds.nurture_hourly_comments, 1),
        reposts: { min: 0, max: 0 },
        trends: budgetRange(
          thresholds.nurture_hourly_trends_min,
          thresholds.nurture_hourly_trends_max,
          1,
          2
        ),
        profiles: budgetRange(
          thresholds.nurture_hourly_profiles_min,
          thresholds.nurture_hourly_profiles_max,
          0,
          1
        ),
        enters: budgetPair(thresholds.nurture_hourly_enters, 2)
      },
      actionGapSec: {
        min: pi(thresholds.nurture_action_gap_min_sec, 45),
        max: pi(thresholds.nurture_action_gap_max_sec, 90)
      },
      likeCooldownMin: pi(thresholds.nurture_like_cooldown_min, 8),
      commentCooldownMin: pi(thresholds.nurture_comment_cooldown_min, 45),
      actionWeights: {
        like: 0.55, comment: 0.015, repost: 0, trend: 0.04, profile: 0.02, enter: 0.10
      }
    };
  }

  /** 把远程关键字段镜像进本地面板设置，兼容旧读取路径 */
  function truthy(v, dflt) {
    if (v === undefined || v === null || v === '') return !!dflt;
    if (v === true || v === 1 || v === '1' || v === 'true') return true;
    if (v === false || v === 0 || v === '0' || v === 'false') return false;
    return !!dflt;
  }

  /** 同步转帖来源号与限额：以 OPS（含账号 override）为准覆盖本机 */
  function applyRepostRemote(thresholds, meta) {
    try {
      var raw = thresholds.repost_targets;
      var list = [];
      if (Array.isArray(raw)) {
        list = raw;
      } else if (typeof raw === 'string' && raw.trim()) {
        try {
          var parsed = JSON.parse(raw);
          list = Array.isArray(parsed) ? parsed : String(raw).split(/[\n,，\s]+/);
        } catch (e1) {
          list = String(raw).split(/[\n,，\s]+/);
        }
      }
      list = list.map(function (h) {
        return String(h || '').replace(/^@/, '').toLowerCase().trim();
      }).filter(Boolean);

      var cfg = {
        postType: String(thresholds.repost_post_type || 'text_or_image'),
        banVideo: true,
        postsPerHandle: 1,
        cooldownMin: Math.max(30, pi(thresholds.repost_cooldown_min, 40)),
        cooldownMax: pi(thresholds.repost_cooldown_max, 90),
        dailyCap: pi(thresholds.repost_daily_cap, 50),
        day14Quota: pi(thresholds.repost_day14_quota, 2),
        day5Quota: pi(thresholds.repost_day5_quota, 1),
        maxMinutes: pi(thresholds.repost_max_minutes, 60),
        followWorkEnd: thresholds.repost_follow_work_end === undefined
          ? false
          : truthy(thresholds.repost_follow_work_end, false),
        startHour: pi(thresholds.repost_start_hour, 20),
        startMin: pi(thresholds.repost_start_min, 0),
        startJitterMaxMin: Math.min(360, Math.max(0, pi(thresholds.repost_start_jitter_max_min, 240))),
        eveEndHour: pi(thresholds.repost_eve_end_hour, 23),
        eveEndMin: pi(thresholds.repost_eve_end_min, 0),
        mornStartHour: pi(thresholds.repost_morn_start_hour, 3),
        mornStartMin: pi(thresholds.repost_morn_start_min, 0),
        mornEndHour: pi(thresholds.repost_morn_end_hour, 5),
        mornEndMin: pi(thresholds.repost_morn_end_min, 0),
        // F1：内容池模式位（repost_content_pool 账号 override），随 cfg 下发给 repost-engine 分流
        contentPoolMode: truthy(thresholds.repost_content_pool, false),
        appendLink: String(thresholds.repost_append_link || '')
      };

      // 只接受「本次 bot_id 与返回账号一致」的名单。来源号不在账号表时 account 为空，
      // 全局 repost_targets 不得盖掉本机（否则面板绑定和 OPS 该号来源会分叉）。
      var asked = normalizeHandleKey(getBotId());
      var got = normalizeHandleKey(meta && meta.account && meta.account.x_handle);
      var identityOk = !!(asked && got && asked === got);
      var shouldWriteTargets = identityOk;
      if (typeof RepostTracker !== 'undefined') {
        if (shouldWriteTargets && RepostTracker.setTargets) {
          RepostTracker.setTargets(list, { skipPush: true });
        }
        if (RepostTracker.setConfig) RepostTracker.setConfig(cfg);
      } else {
        if (shouldWriteTargets) {
          localStorage.setItem('sg_repost_targets', JSON.stringify(list));
        }
        localStorage.setItem('sg_repost_config', JSON.stringify(cfg));
      }
      try {
        var payload = { matrix_repost_config: cfg };
        if (shouldWriteTargets) payload.matrix_repost_targets = list;
        chrome.storage.local.set(payload);
      } catch (e2) {}
      try {
        console.log('[ConfigSync] 转帖来源', {
          identityOk: identityOk,
          asked: asked,
          got: got,
          n: list.length,
          list: list,
          keptLocal: !shouldWriteTargets
        });
      } catch (eLog) {}
    } catch (e) {}
  }

  function mirrorConsoleSettings(thresholds, intervals) {
    try {
      var s = {};
      try { s = JSON.parse(localStorage.getItem('matrix_console_settings') || '{}') || {}; } catch (e1) {}
      s.followLimit = pi(thresholds.follow_daily_limit, s.followLimit || 260);
      s.followIntervalMin = intervals.followIntervalMinSec;
      s.followIntervalMax = intervals.followIntervalMaxSec;
      if (thresholds.follow_only_japanese !== undefined) {
        s.onlyJapanese = truthy(thresholds.follow_only_japanese, false);
      }
      if (thresholds.follow_antiban_enabled !== undefined) {
        s.antiBanMode = truthy(thresholds.follow_antiban_enabled, false);
      }
      s._fromRemote = true;
      s._remoteSyncedAt = Date.now();
      localStorage.setItem('matrix_console_settings', JSON.stringify(s));
      try {
        if (thresholds.follow_antiban_enabled !== undefined) {
          localStorage.setItem('matrix_antiban_enabled', s.antiBanMode ? 'true' : 'false');
        }
      } catch (eAb) {}
      try {
        chrome.storage.local.set({ matrix_console_settings: s });
      } catch (e2) {}
    } catch (e) {}
  }

  function applyPayload(res) {
    try {
      ensureLocalFollowQuotaRollover((res && res.account && res.account.x_handle) || getBotId());
    } catch (eRoll) {}
    var thresholds = res.thresholds || DEFAULT_THRESHOLDS;
    // 4.6.101：抬升残留 13s 默认（4.2.48 旧值），否则 Gate 读 localStorage 仍吃 13s 连环跳
    try {
      var _navN = parseInt(thresholds.nav_min_interval_ms, 10);
      if (!isFinite(_navN) || _navN === 13000) {
        thresholds = Object.assign({}, thresholds, { nav_min_interval_ms: '45000' });
      }
    } catch (eNavMig) {}
    var stagePolicy = res.stagePolicy || {};
    // 转帖过渡试验：同步时剔除白天阶段里的 repost，避免误配污染主线
    try {
      if (stagePolicy.stages) {
        ['S1', 'S2', 'S3', 'S4'].forEach(function (sk) {
          var st = stagePolicy.stages[sk];
          if (st && Array.isArray(st.priority)) {
            st.priority = st.priority.filter(function (n) { return n !== 'repost'; });
          }
        });
      }
    } catch (eSp) {}
    var modules = res.modules || DEFAULT_MODULES;
    if (modules.repost === undefined) modules.repost = true;
    var nurtureRemote = buildNurtureRemote(thresholds);

    var intervals = {
      followIntervalMinSec: pi(thresholds.follow_interval_min_sec, 2),
      followIntervalMaxSec: pi(thresholds.follow_interval_max_sec, 4),
      followRetryDelaySec: pi(thresholds.follow_retry_delay_sec, 300),
      nurtureActionGapMinSec: pi(thresholds.nurture_action_gap_min_sec, 45),
      nurtureActionGapMaxSec: pi(thresholds.nurture_action_gap_max_sec, 90),
      nurtureLikeCooldownMin: pi(thresholds.nurture_like_cooldown_min, 8),
      // 私信会话冷却（分钟）；不再用每日会话次数作闸门
      chat_cooldown_min_min: pi(thresholds.chat_cooldown_min_min, 25),
      chat_cooldown_max_min: pi(thresholds.chat_cooldown_max_min, 35),
      chat_debt_cooldown_min_min: pi(thresholds.chat_debt_cooldown_min_min, 8),
      chat_debt_cooldown_max_min: pi(thresholds.chat_debt_cooldown_max_min, 12),
      chat_ad_min_wait_min: pi(thresholds.chat_ad_min_wait_min, 60),
      chat_two_seg_mode: (function () {
        var raw = thresholds.chat_two_seg_mode;
        if (raw === undefined || raw === null || raw === '') return 'on';
        return String(raw);
      })(),
      chat_inbox_visit_cap_sec: pi(thresholds.chat_inbox_visit_cap_sec, 150),
      chat_kick_min_hours: pi(thresholds.chat_kick_min_hours, 0),
      telemetry_upload_min_level: String(thresholds.telemetry_upload_min_level || 'info'),
      telemetry_push_enabled: thresholds.telemetry_push_enabled,
      telemetry_push_dedupe_hours: pi(thresholds.telemetry_push_dedupe_hours, 2),
      telemetry_disabled_events: String(thresholds.telemetry_disabled_events || ''),
      chat_dry_run_enabled: thresholds.chat_dry_run_enabled,
      chat_round_interval_hours: pi(thresholds.chat_cooldown_hours, 2),
      chat_rounds_per_day: pi(thresholds.chat_rounds_per_day, 3)
    };

    var cfg = {
      risk: { backoff: { levels: gradientMs(parseGradientSec(thresholds.risk_cooldown_gradient)) } },
      followLimit: pi(thresholds.follow_daily_limit, 260),
      limits: {
        followDailyLimit: pi(thresholds.follow_daily_limit, 260),
        followFirstDayLimit: pi(thresholds.follow_first_day_limit, 50),
        followDay2Limit: pi(thresholds.follow_day2_limit, 100),
        followStepPerDay: pi(thresholds.follow_step_per_day, 50)
      },
      intervals: intervals,
      nurture: nurtureRemote,
      chat: {
        roundsPerDay: pi(thresholds.chat_rounds_per_day, 3),
        cooldownHours: pi(thresholds.chat_cooldown_hours, 2)
      },
      cooldown: {
        stallCooldownSec: pi(thresholds.stage_stall_cooldown_sec, 180),
        tickIntervalMs: pi(thresholds.stage_tick_interval_ms, 10000),
        watchdogMs: pi(thresholds.stage_watchdog_ms, 30000),
        navMinIntervalMs: pi(thresholds.nav_min_interval_ms, 45000)
      }
    };

    var mediaMode = String(thresholds.media_load_mode || 'off').toLowerCase();
    if (mediaMode !== 'on' && mediaMode !== 'off' && mediaMode !== 'auto') mediaMode = 'off';
    // 4.3.14：用户停禁图 — OPS 若仍写 auto，插件侧按 on 放行（避免旧配置继续拦媒体撞页）
    // 4.4.0：重启禁图 — auto 仍按 on 兼容旧配置；新默认 off
    if (mediaMode === 'auto') mediaMode = 'on';

    // OPS 号池地址优先：远程配置下发后覆盖面板本地设置，实现后台统一切换号池
    var remotePoolServer = String(thresholds.pool_server || '').trim();

    // 4.6.194 K3 页面瘦身接线：将 OPS page_slim_mode / page_slim_handles 写入 sg_page_slim
    // off → '0'；on → '1'；gray → 按逗号分隔 handle 清单匹配当前账号
    var _slimOn = '0';
    try {
      var _slimMode = String(thresholds.page_slim_mode || 'off').toLowerCase();
      if (_slimMode === 'on') {
        _slimOn = '1';
      } else if (_slimMode === 'gray') {
        var _slimHandles = String(thresholds.page_slim_handles || '').split(',')
          .map(function (h) { return h.replace(/^@/, '').trim().toLowerCase(); })
          .filter(Boolean);
        // 优先用 OPS 返回的账号 handle；bot_id 在启动早期可能还没就绪
        var _myHandle = normalizeHandleKey((res.account && res.account.x_handle) || getBotId());
        if (_myHandle && _slimHandles.indexOf(_myHandle) >= 0) _slimOn = '1';
      }
    } catch (eSlim) {}

    var storageSet = {
      matrix_config_overrides: cfg,
      sg_stage_policy: JSON.stringify(stagePolicy),
      sg_module_switches: JSON.stringify(modules),
      sg_nurture_remote_cfg: nurtureRemote,
      sg_media_load_mode: mediaMode,
      sg_page_slim: _slimOn
    };
    if (remotePoolServer) storageSet.pool_server = remotePoolServer;
    chrome.storage.local.set(storageSet);
    if (remotePoolServer) {
      try { console.log('[ConfigSync] OPS 号池地址已下发: ' + remotePoolServer); } catch (e) {}
    }

    try {
      localStorage.setItem('sg_stage_policy', JSON.stringify(stagePolicy));
      localStorage.setItem('sg_module_switches', JSON.stringify(modules));
      localStorage.setItem('sg_config_thresholds', JSON.stringify(thresholds));
      localStorage.setItem('sg_config_intervals', JSON.stringify(intervals));
      localStorage.setItem('sg_nurture_remote_cfg', JSON.stringify(nurtureRemote));
      localStorage.setItem('sg_chat_rounds_per_day', String(pi(thresholds.chat_rounds_per_day, 3)));
      // 4.9.31 私信节奏三参数必须由 OPS 下发，不能只留在面板 localStorage。
      // 旧实现只读本地键，OPS 改了也不生效，现场表现为“脉冲/复查/拉新间隔怎么调都没变”。
      try {
        if (thresholds.sg_roster_check_min != null) {
          localStorage.setItem('sg_roster_check_min', String(pi(thresholds.sg_roster_check_min, 30)));
        }
        if (thresholds.sg_inbox_revisit_min != null) {
          localStorage.setItem('sg_inbox_revisit_min', String(pi(thresholds.sg_inbox_revisit_min, 8)));
        }
        if (thresholds.sg_inbox_pulse_sec != null) {
          // 4.9.59：夹在 20–300 秒。OPS 曾下发 1860（31 分钟），
          // 结果脉冲被排到半小时后，现场表现就是“根本没有检测回复”。
          localStorage.setItem('sg_inbox_pulse_sec',
            String(Math.max(20, Math.min(300, pi(thresholds.sg_inbox_pulse_sec, 60)))));
        }
      } catch (eInboxTune) {}
      // 4.6.194 页面瘦身：同步写 localStorage（MAIN world 和 follow 引擎读此键）
      try {
        localStorage.setItem('sg_page_slim', _slimOn);
        window.dispatchEvent(new CustomEvent('sg-page-slim-changed', { detail: { on: _slimOn === '1' } }));
      } catch (eSlimLs) {}
      // 4.9.143：24h 测试开关由本地控制，配置同步不得再强制写回 false。
      try {
        var _t24 = localStorage.getItem('sg_test_24h') !== 'false';
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          var chatWin = _t24 ? { start: [0, 0], end: [24, 0] } : { start: [9, 0], end: [18, 0] };
          if (!_t24 && typeof TimeUtil !== 'undefined' && TimeUtil.readChatHours) {
            var chWin = TimeUtil.readChatHours();
            chatWin = {
              start: [chWin.startH, chWin.startM || 0],
              end: [chWin.endH, chWin.endM || 0]
            };
          }
          chrome.storage.local.set({
            sg_test_24h: _t24,
            sg_chat_window: chatWin,
            sg_chat_window_updated_at: Date.now()
          });
        }
      } catch (eT24) {}
      applyRepostRemote(thresholds, { account: res.account || null });
      if (res.account) {
        localStorage.setItem('sg_account_config', JSON.stringify(res.account));
        if (res.account.day_count != null) {
          applyRemoteDayCount(
            res.account.day_count,
            res.account.x_handle || getBotId(),
            res.account.today_follow_count
          );
        }
      }
    } catch (e) {}

    mirrorConsoleSettings(thresholds, intervals);

    try {
      if (typeof NurtureConfig !== 'undefined' && NurtureConfig.loadUserSettings) {
        NurtureConfig.loadUserSettings();
      }
    } catch (e3) {}
    try {
      if (typeof NurtureTracker !== 'undefined' && NurtureTracker.applyRemoteBudgets) {
        NurtureTracker.applyRemoteBudgets();
      }
    } catch (e3b) {}
    try {
      if (typeof MatrixConfig !== 'undefined' && MatrixConfig.loadFromStorage) {
        MatrixConfig.loadFromStorage();
      }
    } catch (eMc) {}

    try {
      window.dispatchEvent(new CustomEvent('sg-config-synced', {
        detail: { thresholds: thresholds, intervals: intervals, modules: modules }
      }));
    } catch (e4) {}

    // 同步每档 installationId → LS，供 S0 转帖抖动种子（避免全机撞 'x'）
    try {
      chrome.runtime.sendMessage({ action: 'get_installation_id' }, function (r) {
        void chrome.runtime.lastError;
        if (!r || !r.id) return;
        try {
          var prev = localStorage.getItem('sg_installation_id') || '';
          localStorage.setItem('sg_installation_id', String(r.id));
          if (!prev) {
            try {
              localStorage.removeItem('sg_repost_start_jitter_min');
              localStorage.removeItem('sg_repost_start_jitter_max_used');
            } catch (eJ) {}
          }
        } catch (eLs) {}
      });
    } catch (eId) {}

    console.log('[ConfigSync] 配置同步完成', {
      botId: getBotId() || '(global)',
      followLimit: cfg.followLimit,
      interval: intervals.followIntervalMinSec + '-' + intervals.followIntervalMaxSec,
      nurtureLikes: nurtureRemote.dailyBudget.likes.max,
      modules: modules,
      account: res.account && res.account.x_handle,
      test24h: (function () { try { return localStorage.getItem('sg_test_24h') !== 'false'; } catch (e) { return true; } })(),
      chatHours: stagePolicy && stagePolicy.chatHours,
      workHours: stagePolicy && stagePolicy.workHours,
      localTest24h: (function () { try { return localStorage.getItem('sg_test_24h'); } catch (e) { return '?'; } })(),
      repostTargets: (function () {
        try {
          if (typeof RepostTracker !== 'undefined' && RepostTracker.getTargets) {
            return RepostTracker.getTargets();
          }
        } catch (e) {}
        return thresholds.repost_targets || [];
      })()
    });
  }

  function scheduleRetry() {
    if (_retryTimer) { try { clearTimeout(_retryTimer); } catch (e) {} _retryTimer = null; }
    // _retryCount: 1=第1次失败（5s后重试）, 2=第2次失败（15s）, 3+=第3次+（30s封顶）
    var idx = Math.min(_retryCount - 1, RETRY_BACKOFFS.length - 1);
    var delay = RETRY_BACKOFFS[idx] || SYNC_INTERVAL_MS;
    _retryTimer = setTimeout(function () {
      _retryTimer = null;
      try { fetchRemote(); } catch (e) {}
    }, delay);
    console.log('[ConfigSync] 拉取失败，' + Math.round(delay / 1000) + 's 后重试 (第' + _retryCount + '次重试)');
  }

  // 4.6.160/4.6.194：隐藏页首次仍拉一次，之后 5 分钟内跳过、满 5 分钟补拉；
  // 否则 BitBrowser 后台页永远拿不到 stage_tick_interval_ms，coTick 会一直按 10s 跑。
  var HIDDEN_FETCH_WINDOW_MS = 5 * 60 * 1000;
  var _hiddenFetchAt = 0;

  function fetchRemote() {
    if (document.hidden) {
      var _nowHidden = Date.now();
      if (_hiddenFetchAt && _nowHidden - _hiddenFetchAt < HIDDEN_FETCH_WINDOW_MS) return;
      _hiddenFetchAt = _nowHidden;
    }
    // 4.6.173：深度 park 时配置同步最多 5 分钟一次
    try {
      if (sessionStorage.getItem('sg_idle_park') === '1') {
        var lastParkCfg = parseInt(sessionStorage.getItem('sg_idle_park_cfg_at') || '0', 10) || 0;
        if (Date.now() - lastParkCfg < 5 * 60 * 1000) return;
        sessionStorage.setItem('sg_idle_park_cfg_at', String(Date.now()));
      }
    } catch (eParkCfg) {}
    var botId = getBotId();
    try {
      chrome.runtime.sendMessage({ action: 'fetch_remote_config', bot_id: botId }, function (res) {
        if (chrome.runtime.lastError) { applyDefaults(); _retryCount++; scheduleRetry(); return; }
        if (!res || !res.ok) { applyDefaults(); _retryCount++; scheduleRetry(); return; }
        _retryCount = 0;
        applyPayload(res);
        fetchNurtureComments();
      });
    } catch (e) {
      applyDefaults();
      _retryCount++;
      scheduleRetry();
    }
  }

  function applyDefaults() {
    try {
      if (!chrome || !chrome.storage || !chrome.storage.local) {
        console.log('[ConfigSync] 扩展上下文失效 - 跳过默认值读取');
        return;
      }
      chrome.storage.local.get(['matrix_config_overrides', 'sg_stage_policy', 'sg_module_switches'], function (r) {
        if (chrome.runtime && chrome.runtime.lastError) return;
        if (!r || !r.matrix_config_overrides) {
          console.log('[ConfigSync] 离线 - 使用本地缓存或默认值');
        }
      });
    } catch (eDefaults) {}
  }

  function fetchNurtureComments() {
    try {
      chrome.runtime.sendMessage({ action: 'fetch_nurture_comments' }, function (res) {
        if (!res || !res.ok) return;
        try { localStorage.setItem('sg_nurture_comments', JSON.stringify(res)); } catch (e) {}
      });
    } catch (e) {}
  }

  function startSync() {
    try { ensureLocalFollowQuotaRollover(getBotId()); } catch (eRoll0) {}
    fetchRemote();
    _timer = setInterval(function () {
      try { fetchRemote(); } catch (e) { clearInterval(_timer); }
    }, SYNC_INTERVAL_MS);
    console.log('[ConfigSync] 同步模块已启动 - 每 ' + (SYNC_INTERVAL_MS / 60000) + ' 分钟');
    // ID 提取晚于首次同步时，必须立刻按账号重拉（否则会一直吃全局空来源号）
    try {
      window.addEventListener('matrix:handle-ready', function () {
        console.log('[ConfigSync] handle-ready，立即重拉账号配置');
        fetchRemote();
      });
    } catch (eHr) {}
    // 4.6.160/4.6.194：切回前台立刻拉，不受隐藏页 5 分钟窗限制
    try {
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) fetchRemote();
      });
    } catch (eVis) {}
  }

  try {
    window.ConfigSync = {
      applyRemoteDayCount: applyRemoteDayCount,
      ensureLocalFollowQuotaRollover: ensureLocalFollowQuotaRollover,
      fetchRemote: fetchRemote,
      getBotId: getBotId
    };
  } catch (eExp) {}

  startSync();
})();

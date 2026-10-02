// =============================================================================
// 智能调度 — 配置同步模块 V2
// 从 ops-console /api/config/all 拉配置 → localStorage / chrome.storage
// 远程配置优先，供 RemoteSettings + 各引擎消费
// =============================================================================

(function () {
  'use strict';

  var SYNC_INTERVAL_MS = 1 * 60 * 1000;
  var DEFAULT_THRESHOLDS = {
    follow_daily_limit: '260',
    follow_first_day_limit: '20',
    follow_day2_limit: '50',
    follow_step_per_day: '50',
    follow_day1_min: '15', follow_day1_max: '20',
    follow_day2_min: '45', follow_day2_max: '50',
    follow_day3_min: '90', follow_day3_max: '100',
    follow_day4_min: '150', follow_day4_max: '160',
    follow_day5_min: '200', follow_day5_max: '210',
    follow_day6_min: '250', follow_day6_max: '260',
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
    chat_ad_min_wait_min: '20',
    chat_inbox_visit_cap_sec: '150',
    chat_script_pool: 'dating',
    stage_stall_cooldown_sec: '180',
    stage_tick_interval_ms: '10000',
    stage_watchdog_ms: '30000',
    nav_min_interval_ms: '13000',
    media_load_mode: 'on',
    follow_only_japanese: 'true',
    follow_antiban_enabled: 'false'
  };
  var DEFAULT_MODULES = { nurture: true, follow: true, chat: true, scheduler: true, repost: true };
  var _timer = null;

  function getBotId() {
    try {
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
      } else if (stats.follows_today == null) {
        stats.follows_today = 0;
      }
      var localFollows = stats.follows_today || 0;
      var ft = null;
      if (followsToday != null && followsToday !== '') {
        var parsedFt = parseInt(followsToday, 10);
        if (!isNaN(parsedFt) && parsedFt >= 0) ft = parsedFt;
      }
      // 跨日：用 OPS 对齐；同日只允许 OPS 抬高本地（禁止把已确认关注抹成更小）
      if (ft != null && rolled) {
        stats.follows_today = ft;
      } else if (ft != null && ft > localFollows) {
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
        stats.daily_limit = pickMin + Math.floor(Math.random() * (pickMax - pickMin + 1));
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
        cooldownMin: Math.max(30, pi(thresholds.repost_cooldown_min, 30)),
        cooldownMax: pi(thresholds.repost_cooldown_max, 90),
        dailyCap: pi(thresholds.repost_daily_cap, 50),
        dailyQuota: pi(thresholds.repost_daily_quota, 2),
        maxMinutes: pi(thresholds.repost_max_minutes, 60),
        followWorkEnd: thresholds.repost_follow_work_end === undefined
          ? false
          : truthy(thresholds.repost_follow_work_end, false),
        startHour: pi(thresholds.repost_start_hour, 6),
        startMin: pi(thresholds.repost_start_min, 0),
        eveEndHour: pi(thresholds.repost_eve_end_hour, 23),
        eveEndMin: pi(thresholds.repost_eve_end_min, 0),
        mornStartHour: pi(thresholds.repost_morn_start_hour, 3),
        mornStartMin: pi(thresholds.repost_morn_start_min, 0),
        mornEndHour: pi(thresholds.repost_morn_end_hour, 5),
        mornEndMin: pi(thresholds.repost_morn_end_min, 0),
        appendLink: String(thresholds.repost_append_link || '')
      };

      // 有来源 → 写入。空列表仅当「已识别到账号」时才清空（避免 bot_id 错配吃到全局空数组刷掉本机）
      var accountBound = !!(meta && meta.account && (meta.account.x_handle || meta.account.day_count != null));
      var shouldWriteTargets = list.length > 0 || accountBound;
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
          accountBound: accountBound,
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
        s.onlyJapanese = truthy(thresholds.follow_only_japanese, true);
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
    var thresholds = res.thresholds || DEFAULT_THRESHOLDS;
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
      nurtureActionGapMinSec: pi(thresholds.nurture_action_gap_min_sec, 10),
      nurtureActionGapMaxSec: pi(thresholds.nurture_action_gap_max_sec, 20),
      nurtureLikeCooldownMin: pi(thresholds.nurture_like_cooldown_min, 3),
      // 私信会话冷却（分钟）；不再用每日会话次数作闸门
      chat_cooldown_min_min: pi(thresholds.chat_cooldown_min_min, 25),
      chat_cooldown_max_min: pi(thresholds.chat_cooldown_max_min, 35),
      chat_debt_cooldown_min_min: pi(thresholds.chat_debt_cooldown_min_min, 8),
      chat_debt_cooldown_max_min: pi(thresholds.chat_debt_cooldown_max_min, 12),
      chat_ad_min_wait_min: pi(thresholds.chat_ad_min_wait_min, 20),
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
        followFirstDayLimit: pi(thresholds.follow_first_day_limit, 20),
        followDay2Limit: pi(thresholds.follow_day2_limit, 50),
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
        navMinIntervalMs: pi(thresholds.nav_min_interval_ms, 13000)
      }
    };

    var mediaMode = String(thresholds.media_load_mode || 'on').toLowerCase();
    if (mediaMode !== 'on' && mediaMode !== 'off' && mediaMode !== 'auto') mediaMode = 'on';
    // 4.3.14：用户停禁图 — OPS 若仍写 auto，插件侧按 on 放行（避免旧阈值继续拦媒体撞页）
    if (mediaMode === 'auto') mediaMode = 'on';

    chrome.storage.local.set({
      matrix_config_overrides: cfg,
      sg_stage_policy: JSON.stringify(stagePolicy),
      sg_module_switches: JSON.stringify(modules),
      sg_nurture_remote_cfg: nurtureRemote,
      sg_media_load_mode: mediaMode
    });

    try {
      localStorage.setItem('sg_stage_policy', JSON.stringify(stagePolicy));
      localStorage.setItem('sg_module_switches', JSON.stringify(modules));
      localStorage.setItem('sg_config_thresholds', JSON.stringify(thresholds));
      localStorage.setItem('sg_config_intervals', JSON.stringify(intervals));
      localStorage.setItem('sg_nurture_remote_cfg', JSON.stringify(nurtureRemote));
      localStorage.setItem('sg_chat_rounds_per_day', String(pi(thresholds.chat_rounds_per_day, 3)));
      // OPS 阶段策略优先：远程关 test24h 时清掉面板本地 24h，避免永远吃全天窗
      try {
        if (stagePolicy && (stagePolicy.test24h === false || stagePolicy.test24h === 0 || stagePolicy.test24h === 'false')) {
          if (localStorage.getItem('sg_test_24h') === 'true') {
            localStorage.setItem('sg_test_24h', 'false');
            console.log('[ConfigSync] OPS test24h=false → 已关闭本地 sg_test_24h');
          }
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
            try { localStorage.removeItem('sg_repost_start_jitter_min'); } catch (eJ) {}
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
      test24h: !!(stagePolicy && stagePolicy.test24h),
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

  function fetchRemote() {
    var botId = getBotId();
    try {
      chrome.runtime.sendMessage({ action: 'fetch_remote_config', bot_id: botId }, function (res) {
        if (chrome.runtime.lastError) { applyDefaults(); return; }
        if (!res || !res.ok) { applyDefaults(); return; }
        applyPayload(res);
        fetchNurtureComments();
      });
    } catch (e) {
      applyDefaults();
    }
  }

  function applyDefaults() {
    chrome.storage.local.get(['matrix_config_overrides', 'sg_stage_policy', 'sg_module_switches'], function (r) {
      if (!r.matrix_config_overrides) {
        console.log('[ConfigSync] 离线 - 使用本地缓存或默认值');
      }
    });
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
  }

  try {
    window.ConfigSync = {
      applyRemoteDayCount: applyRemoteDayCount,
      fetchRemote: fetchRemote,
      getBotId: getBotId
    };
  } catch (eExp) {}

  startSync();
})();

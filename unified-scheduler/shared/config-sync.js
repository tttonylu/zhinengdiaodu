// =============================================================================
// 智能调度 — 配置同步模块 V1
// 从 ops-console /api/config/all 拉配置 → chrome.storage.matrix_config_overrides
// 5min 周期同步，失败用默认值兜底
// =============================================================================

(function () {
  'use strict';

  var SYNC_INTERVAL_MS = 1 * 60 * 1000;
  var DEFAULT_THRESHOLDS = {
    follow_daily_limit: '200',
    follow_first_day_limit: '80',
    follow_step_per_day: '40',
    follow_interval_min_sec: '12',
    follow_interval_max_sec: '19',
    risk_cooldown_gradient: '[60,120,240,600]',
    nurture_daily_likes: '30',
    nurture_daily_comments: '10',
    nurture_hourly_likes: '5',
    nurture_hourly_comments: '2',
    nurture_action_gap_min_sec: '10',
    nurture_action_gap_max_sec: '20',
    nurture_like_cooldown_min: '3',
    chat_rounds_per_day: '3',
    chat_cooldown_hours: '2',
    stage_stall_cooldown_sec: '180',
    stage_tick_interval_ms: '10000',
    stage_watchdog_ms: '30000'
  };
  var DEFAULT_MODULES = { nurture: true, follow: true, chat: true };
  var _timer = null;

  function fetchRemote() {
    try {
      chrome.runtime.sendMessage({ action: 'fetch_remote_config' }, function (res) {
        if (!res || !res.ok) { applyDefaults(); return; }
        var thresholds = res.thresholds || DEFAULT_THRESHOLDS;
        var stagePolicy = res.stagePolicy || {};
        var modules = res.modules || DEFAULT_MODULES;
        var cfg = {
          risk: { backoff: { levels: parseGradient(thresholds.risk_cooldown_gradient) } },
          followLimit: parseInt(thresholds.follow_daily_limit) || 200,
          limits: {
            followDailyLimit: parseInt(thresholds.follow_daily_limit) || 200,
            followFirstDayLimit: parseInt(thresholds.follow_first_day_limit) || 80,
            followStepPerDay: parseInt(thresholds.follow_step_per_day) || 40
          },
          intervals: {
            followIntervalMinSec: parseInt(thresholds.follow_interval_min_sec) || 12,
            followIntervalMaxSec: parseInt(thresholds.follow_interval_max_sec) || 19,
            nurtureActionGapMinSec: parseInt(thresholds.nurture_action_gap_min_sec) || 10,
            nurtureActionGapMaxSec: parseInt(thresholds.nurture_action_gap_max_sec) || 20,
            nurtureLikeCooldownMin: parseInt(thresholds.nurture_like_cooldown_min) || 3
          },
          nurture: {
            dailyBudget: { likes: parseInt(thresholds.nurture_daily_likes) || 30, comments: parseInt(thresholds.nurture_daily_comments) || 10 },
            hourlyBudget: { likes: parseInt(thresholds.nurture_hourly_likes) || 5, comments: parseInt(thresholds.nurture_hourly_comments) || 2 },
            actionGapSec: { min: parseInt(thresholds.nurture_action_gap_min_sec) || 10, max: parseInt(thresholds.nurture_action_gap_max_sec) || 20 },
            likeCooldownMin: parseInt(thresholds.nurture_like_cooldown_min) || 3
          },
          chat: { roundsPerDay: parseInt(thresholds.chat_rounds_per_day) || 3, cooldownHours: parseInt(thresholds.chat_cooldown_hours) || 2 },
          cooldown: { stallCooldownSec: parseInt(thresholds.stage_stall_cooldown_sec) || 180, tickIntervalMs: parseInt(thresholds.stage_tick_interval_ms) || 10000, watchdogMs: parseInt(thresholds.stage_watchdog_ms) || 30000 }
        };
        chrome.storage.local.set({
          matrix_config_overrides: cfg,
          sg_stage_policy: JSON.stringify(stagePolicy),
          sg_module_switches: JSON.stringify(modules)
        });
        try {
          localStorage.setItem('sg_stage_policy', JSON.stringify(stagePolicy));
          localStorage.setItem('sg_module_switches', JSON.stringify(modules));
          localStorage.setItem('sg_config_thresholds', JSON.stringify(thresholds));
          localStorage.setItem('sg_config_intervals', JSON.stringify(cfg.intervals));
        } catch (e) {}
        console.log('[ConfigSync] 配置同步完成');
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

  function parseGradient(v) {
    try { return JSON.parse(v); } catch (e) { return [60, 120, 240, 600]; }
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
    _timer = setInterval(fetchRemote, SYNC_INTERVAL_MS);
    console.log('[ConfigSync] 同步模块已启动 - 每 ' + (SYNC_INTERVAL_MS / 60000) + ' 分钟');
  }

  startSync();
})();

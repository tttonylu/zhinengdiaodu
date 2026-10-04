// =============================================================================
// 远程配置读取（OPS /api/config/all → localStorage sg_config_*）
// 优先级：远程后台 > 本地面板兜底
// =============================================================================

var RemoteSettings = (function () {
  'use strict';

  function thresholds() {
    try { return JSON.parse(localStorage.getItem('sg_config_thresholds') || '{}') || {}; }
    catch (e) { return {}; }
  }

  function intervals() {
    try { return JSON.parse(localStorage.getItem('sg_config_intervals') || '{}') || {}; }
    catch (e) { return {}; }
  }

  function int(v, d) {
    var n = parseInt(v, 10);
    return isNaN(n) ? d : n;
  }

  /** DayN 配额区间（Day6+ 用第 6 档） */
  function followDayRange(dayCount) {
    var t = thresholds() || {};
    var day = Math.max(1, int(dayCount, 1));
    var defaults = {
      1: [80, 90],
      2: [135, 155],
      3: [190, 215],
      4: [240, 270],
      5: [285, 300],
      6: [290, 310]
    };
    var slot = day >= 6 ? 6 : day;
    var dft = defaults[slot];
    var min = int(t['follow_day' + slot + '_min'], dft[0]);
    var max = int(t['follow_day' + slot + '_max'], dft[1]);
    // 兼容旧键：无新区间时用 first/day2/step 粗算中心再扩成窄区间
    if (t['follow_day' + slot + '_min'] == null && t['follow_day' + slot + '_max'] == null) {
      if (slot === 1 && t.follow_first_day_limit != null) {
        var f = int(t.follow_first_day_limit, 50);
        min = Math.max(1, f - 5); max = f;
      } else if (slot === 2 && t.follow_day2_limit != null) {
        var d2 = int(t.follow_day2_limit, 100);
        min = Math.max(1, d2 - 5); max = d2;
      }
    }
    if (max < min) { var tmp = min; min = max; max = tmp; }
    var cap = int(t.follow_daily_limit, 260);
    if (cap > 0) {
      min = Math.min(min, cap);
      max = Math.min(max, cap);
      if (max < min) max = min;
    }
    return { min: min, max: max, slot: slot };
  }

  /** 区间中点（兼容旧调用）；真实日限由插件按自然日随机锁定 */
  function followDailyLimit(dayCount) {
    var t = thresholds();
    if (!t) return null;
    var hasAny = t.follow_daily_limit != null || t.follow_first_day_limit != null ||
      t.follow_day2_limit != null || t.follow_day1_min != null || t.follow_day6_max != null;
    if (!hasAny) return null;
    var r = followDayRange(dayCount);
    return Math.round((r.min + r.max) / 2);
  }

  /** 关注间隔秒。无远程时返回 null */
  function followIntervalSec() {
    var i = intervals();
    var min = int(i.followIntervalMinSec, 0);
    var max = int(i.followIntervalMaxSec, 0);
    if (!min && !max) {
      var t = thresholds();
      min = int(t.follow_interval_min_sec, 0);
      max = int(t.follow_interval_max_sec, 0);
    }
    if (!min && !max) return null;
    // 底限 2s：允许 OPS 加速；禁止 0/负数
    min = Math.max(2, min || 3);
    max = Math.max(min, max || 5);
    return { min: min, max: max };
  }

  function nurtureRemoteCfg() {
    try {
      var raw = localStorage.getItem('sg_nurture_remote_cfg');
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return null;
  }

  function chatRoundsPerDay() {
    var n = int(thresholds().chat_rounds_per_day, 0);
    return n > 0 ? n : null;
  }

  function accountConfig() {
    try {
      var raw = localStorage.getItem('sg_account_config');
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return null;
  }

  function dmDailyLimit() {
    var n = int(thresholds().dm_daily_limit, 0);
    return n > 0 ? n : null;
  }

  function truthy(v, dflt) {
    if (v === undefined || v === null || v === '') return dflt;
    if (v === true || v === 1 || v === '1' || v === 'true') return true;
    if (v === false || v === 0 || v === '0' || v === 'false') return false;
    return dflt;
  }

  function onlyJapanese() {
    var t = thresholds();
    if (!t || t.follow_only_japanese === undefined || t.follow_only_japanese === null || t.follow_only_japanese === '') return null;
    return truthy(t.follow_only_japanese, true);
  }

  function antiBanEnabled() {
    var t = thresholds();
    if (!t || t.follow_antiban_enabled === undefined || t.follow_antiban_enabled === null || t.follow_antiban_enabled === '') return null;
    return truthy(t.follow_antiban_enabled, false);
  }

  /** 话术池：dating=交友 · job=兼职粉；非法值回落 dating */
  function chatScriptPool() {
    var v = String((thresholds() || {}).chat_script_pool || 'dating').toLowerCase().trim();
    return v === 'job' ? 'job' : 'dating';
  }

  var api = {
    thresholds: thresholds,
    intervals: intervals,
    followDayRange: followDayRange,
    followDailyLimit: followDailyLimit,
    followIntervalSec: followIntervalSec,
    nurtureRemoteCfg: nurtureRemoteCfg,
    chatRoundsPerDay: chatRoundsPerDay,
    accountConfig: accountConfig,
    dmDailyLimit: dmDailyLimit,
    onlyJapanese: onlyJapanese,
    antiBanEnabled: antiBanEnabled,
    chatScriptPool: chatScriptPool
  };

  if (typeof window !== 'undefined') window.RemoteSettings = api;
  return api;
})();

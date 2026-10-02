// =============================================================================
// SoftFillMode — 软窗「能否塞私信」单一能力闸（A4/B4 共用）
// mode: off | nurture_only | chat_fill
// SCRM 不参与 mode（只挡 startChat / coTick 启动）
// =============================================================================
(function (global) {
  'use strict';

  function chatModuleOn() {
    try {
      var raw = localStorage.getItem('sg_module_switches');
      if (!raw) return true;
      return JSON.parse(raw).chat !== false;
    } catch (e) {
      return true;
    }
  }

  function dayCount() {
    try {
      if (typeof global.__sgGetDayCount === 'function') {
        var d0 = parseInt(global.__sgGetDayCount(), 10);
        if (d0 > 0) return d0;
      }
    } catch (e0) {}
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k.indexOf('matrix_stats_') !== 0) continue;
        var st = JSON.parse(localStorage.getItem(k) || '{}');
        var dc = parseInt(st.day_count, 10);
        if (dc > 0) return dc;
      }
    } catch (e1) {}
    return 1;
  }

  function chatTimeOk() {
    try {
      if (typeof StageDetector !== 'undefined') {
        try {
          if (StageDetector.detect) StageDetector.detect();
        } catch (eD) {}
        if (typeof StageDetector.isChatTime === 'function') {
          return !!StageDetector.isChatTime();
        }
      }
    } catch (e) {}
    return true;
  }

  /**
   * @param {object} [opts]
   * @param {number} [opts.day]
   * @param {string} [opts.softRiskMode] 已写入的 sticky nurture
   * @returns {{ mode: 'off'|'nurture_only'|'chat_fill', allowChat: boolean, reason: string, day: number }}
   */
  function resolve(opts) {
    opts = opts || {};
    var day = opts.day != null ? parseInt(opts.day, 10) : dayCount();
    if (!(day > 0)) day = 1;

    if (!chatModuleOn()) {
      return { mode: 'off', allowChat: false, reason: 'chat_module_off', day: day };
    }
    if (String(opts.softRiskMode || '') === 'nurture') {
      return { mode: 'nurture_only', allowChat: false, reason: 'sticky_nurture', day: day };
    }
    if (day < 3) {
      return { mode: 'nurture_only', allowChat: false, reason: 'day_lt_3', day: day };
    }
    if (!chatTimeOk()) {
      return { mode: 'nurture_only', allowChat: false, reason: 'outside_chat_hours', day: day };
    }
    return { mode: 'chat_fill', allowChat: true, reason: '', day: day };
  }

  /** 软窗内应走只养号（含 modules.chat=off） */
  function isNurtureOnlyPath(sg) {
    var r = resolve({ softRiskMode: sg && sg.softRiskMode });
    return r.mode !== 'chat_fill';
  }

  var api = {
    resolve: resolve,
    isNurtureOnlyPath: isNurtureOnlyPath,
    chatModuleOn: chatModuleOn
  };

  if (global) global.SgSoftFillMode = api;
})(typeof window !== 'undefined' ? window : this);

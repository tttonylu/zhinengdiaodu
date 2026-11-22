// =============================================================================
// A2 · 养号日预算闸（4.9.136）
// 关注满额不再拦养号：关注优先、养号兜底；只有养号自己的日预算耗尽才停。
// 保留软风控放行（挂起/填窗 nurture_only）。
// =============================================================================
(function (root) {
  'use strict';

  /**
   * @param {{
   *   followedToday?:number,
   *   followLimit?:number,
   *   softRiskActive?:boolean,
   *   moduleOn?:boolean,
   *   nurtureDailyExhausted?:boolean
   * }} opts
   * @returns {{ allow:boolean, reason: string }}
   */
  function evaluate(opts) {
    opts = opts || {};
    if (opts.moduleOn === false) {
      return { allow: false, reason: 'module_off' };
    }
    // 软风控养号段必须放行（挂起/填窗 nurture_only）
    if (opts.softRiskActive) {
      return { allow: true, reason: 'soft_risk' };
    }
    if (opts.nurtureDailyExhausted) {
      return { allow: false, reason: 'nurture_daily_exhausted' };
    }
    var used = parseInt(opts.followedToday, 10);
    var lim = parseInt(opts.followLimit, 10);
    if (isNaN(used)) used = 0;
    if (!isNaN(lim) && lim > 0 && used >= lim) {
      return { allow: true, reason: 'follow_quota_full_nurture_ok' };
    }
    return { allow: true, reason: (isNaN(lim) || lim <= 0) ? 'no_limit' : 'under_quota' };
  }

  var api = { evaluate: evaluate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SgNurtureQuotaGate = api;
  if (typeof window !== 'undefined') window.SgNurtureQuotaGate = api;
  if (typeof self !== 'undefined') self.SgNurtureQuotaGate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

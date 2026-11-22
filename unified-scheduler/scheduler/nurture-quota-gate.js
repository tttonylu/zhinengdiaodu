// =============================================================================
// A2 · 关注满额停养号闸（4.6.164）— 降多开 /home 狂滚 CPU
// =============================================================================
(function (root) {
  'use strict';

  /**
   * @param {{ followedToday:number, followLimit:number, softRiskActive?:boolean, moduleOn?:boolean }} opts
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
    var used = parseInt(opts.followedToday, 10);
    var lim = parseInt(opts.followLimit, 10);
    if (isNaN(used)) used = 0;
    if (isNaN(lim) || lim <= 0) {
      return { allow: true, reason: 'no_limit' };
    }
    if (used >= lim) {
      return { allow: false, reason: 'follow_quota_full' };
    }
    return { allow: true, reason: 'under_quota' };
  }

  var api = { evaluate: evaluate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SgNurtureQuotaGate = api;
  if (typeof window !== 'undefined') window.SgNurtureQuotaGate = api;
  if (typeof self !== 'undefined') self.SgNurtureQuotaGate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

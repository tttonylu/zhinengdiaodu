// =============================================================================
// A2 · 深度空闲 park 闸（4.6.172 / 4.6.173 / 4.6.179）
// 满额 + 非软风控 + 无引擎真活 + 无紧急私信债 + 无转帖到期 → 可深度 park（整拍早退）
// =============================================================================
(function (root) {
  'use strict';

  /**
   * @param {{
   *   followedToday:number,
   *   followLimit:number,
   *   softRiskActive?:boolean,
   *   followRunning?:boolean,
   *   chatRunning?:boolean,
   *   nurtureRunning?:boolean,
   *   repostRunning?:boolean,
   *   chatDebtUrgent?:boolean,
   *   repostDue?:boolean
   * }} opts
   * @returns {{ park:boolean, deep:boolean, reason:string }}
   */
  function evaluate(opts) {
    opts = opts || {};
    if (opts.softRiskActive) {
      return { park: false, deep: false, reason: 'soft_risk' };
    }
    if (opts.chatRunning) return { park: false, deep: false, reason: 'chat_busy' };
    if (opts.followRunning) return { park: false, deep: false, reason: 'follow_busy' };
    if (opts.nurtureRunning) return { park: false, deep: false, reason: 'nurture_busy' };
    if (opts.repostRunning) return { park: false, deep: false, reason: 'repost_busy' };
    if (opts.chatDebtUrgent) {
      return { park: false, deep: false, reason: 'chat_debt_urgent' };
    }
    // 4.6.179：满额也要放行夜场/手动转帖；否则 coTick 早退永远开不了发帖
    if (opts.repostDue) {
      return { park: false, deep: false, reason: 'repost_due' };
    }

    var used = parseInt(opts.followedToday, 10);
    var lim = parseInt(opts.followLimit, 10);
    if (isNaN(used)) used = 0;
    if (isNaN(lim) || lim <= 0) {
      return { park: false, deep: false, reason: 'no_limit' };
    }
    if (used >= lim) {
      return { park: true, deep: true, reason: 'follow_quota_full_idle' };
    }
    return { park: false, deep: false, reason: 'under_quota' };
  }

  var api = { evaluate: evaluate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SgIdleParkGate = api;
  if (typeof window !== 'undefined') window.SgIdleParkGate = api;
  if (typeof self !== 'undefined') self.SgIdleParkGate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

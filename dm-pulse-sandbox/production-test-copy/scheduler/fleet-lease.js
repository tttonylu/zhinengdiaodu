// =============================================================================
// A2 · 舰队重活并发租约客户端（4.6.173）
// OPS fleet_heavy_slots：新开 follow/chat 前占槽；已在跑的约 60s 续约，明确满员则停。≤0 关闭
// =============================================================================
(function (root) {
  'use strict';

  function readSlots(raw) {
    try {
      var t = raw || {};
      if (typeof t === 'string') t = JSON.parse(t || '{}');
      var s = parseInt(t.fleet_heavy_slots, 10);
      if (isNaN(s)) s = 8;
      return s;
    } catch (e) {
      return 8;
    }
  }

  /**
   * @returns {{ needLease:boolean, slots:number }}
   */
  function configFromThresholds(raw) {
    var slots = readSlots(raw);
    return { needLease: slots > 0, slots: slots };
  }

  /**
   * 4.6.197：租约申请期间只进入 leasing，不写 running。
   * 回调必须带同一 token，避免停止后晚到的 granted 又拉起模块。
   */
  function markStartPending(module, url, now) {
    now = now || Date.now();
    module._state = 'starting';
    module._startedAt = 0;
    module._leasePending = true;
    module._leasePendingAt = now;
    module._leaseDeniedUntil = 0;
    module._leaseToken = (parseInt(module._leaseToken, 10) || 0) + 1;
    return {
      token: module._leaseToken,
      state: {
        running: false,
        phase: 'leasing',
        targetUrl: url || '',
        startedAt: 0,
        lastActive: now,
      },
    };
  }

  function isStartPending(module, token) {
    if (!module || !module._leasePending) return false;
    return token == null || module._leaseToken === token;
  }

  function isCurrentRun(module, token) {
    return !!(module && module._state === 'running' && module._leaseToken === token);
  }

  function beginStart(module, url, token, now) {
    if (!isStartPending(module, token)) return null;
    now = now || Date.now();
    module._leasePending = false;
    module._leasePendingAt = 0;
    module._leaseDeniedUntil = 0;
    module._state = 'running';
    module._startedAt = now;
    return {
      running: true,
      phase: 'starting',
      targetUrl: url || '',
      startedAt: now,
      lastActive: now,
    };
  }

  function cancelStart(module, token, now, backoffMs) {
    if (!isStartPending(module, token)) return null;
    now = now || Date.now();
    module._leasePending = false;
    module._leasePendingAt = 0;
    module._state = 'stopped';
    module._startedAt = 0;
    module._leaseDeniedUntil = Math.max(0, parseInt(backoffMs, 10) || 0) > 0
      ? now + parseInt(backoffMs, 10)
      : 0;
    return {
      running: false,
      phase: 'idle',
      targetUrl: '',
      startedAt: 0,
      lastActive: now,
    };
  }

  function expireStart(module, now, timeoutMs, backoffMs) {
    if (!module || !module._leasePending) return null;
    now = now || Date.now();
    if (!module._leasePendingAt || now - module._leasePendingAt < (parseInt(timeoutMs, 10) || 0)) {
      return null;
    }
    module._leaseToken = (parseInt(module._leaseToken, 10) || 0) + 1;
    module._leasePending = false;
    module._leasePendingAt = 0;
    module._state = 'stopped';
    module._startedAt = 0;
    module._leaseDeniedUntil = Math.max(0, parseInt(backoffMs, 10) || 0) > 0
      ? now + parseInt(backoffMs, 10)
      : 0;
    return {
      running: false,
      phase: 'idle',
      targetUrl: '',
      startedAt: 0,
      lastActive: now,
    };
  }

  function isStartDenied(module, now) {
    return !!(module && module._leaseDeniedUntil > (now || Date.now()));
  }

  function resetStart(module) {
    if (!module) return;
    module._leasePending = false;
    module._leasePendingAt = 0;
    module._leaseDeniedUntil = 0;
    module._leaseToken = (parseInt(module._leaseToken, 10) || 0) + 1;
    module._state = 'stopped';
    module._startedAt = 0;
  }

  var api = {
    readSlots: readSlots,
    configFromThresholds: configFromThresholds,
    markStartPending: markStartPending,
    isStartPending: isStartPending,
    isCurrentRun: isCurrentRun,
    beginStart: beginStart,
    cancelStart: cancelStart,
    expireStart: expireStart,
    isStartDenied: isStartDenied,
    resetStart: resetStart,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SgFleetLease = api;
  if (typeof window !== 'undefined') window.SgFleetLease = api;
  if (typeof self !== 'undefined') self.SgFleetLease = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

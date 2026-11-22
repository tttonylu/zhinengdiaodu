// =============================================================================
// A2 · 私信时间片错峰（4.6.163）
// 多开各壳互不共享内存 → 用上海墙钟时间片 + handle 哈希近似并发帽
// =============================================================================
(function (root) {
  'use strict';

  function cleanHandle(h) {
    return String(h || '')
      .replace(/^@/, '')
      .replace(/#guard$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '');
  }

  /** djb2 → 非负 int */
  function hashHandle(handle) {
    var s = cleanHandle(handle);
    if (!s) return 0;
    var h = 5381;
    for (var i = 0; i < s.length; i++) {
      h = ((h << 5) + h) + s.charCodeAt(i);
      h = h | 0;
    }
    return h >>> 0;
  }

  function readThresholds(raw) {
    // 4.6.172：默认关错峰（≤1）；显式 ≥2 才开
    var slots = 1;
    var slotMin = 30;
    try {
      var t = raw || {};
      if (typeof t === 'string') t = JSON.parse(t || '{}');
      var s = parseInt(t.chat_stagger_slots, 10);
      if (!isNaN(s)) slots = s;
      var m = parseInt(t.chat_stagger_slot_min, 10);
      if (!isNaN(m) && m >= 5 && m <= 180) slotMin = m;
    } catch (e) {}
    return { slots: slots, slotMin: slotMin };
  }

  function shanghaiMinutes(nowMs) {
    try {
      if (typeof TimeUtil !== 'undefined' && TimeUtil.shanghaiParts) {
        var p = TimeUtil.shanghaiParts(nowMs != null ? nowMs : Date.now());
        if (p && typeof p.minutes === 'number') return p.minutes;
      }
    } catch (e0) {}
    var d = nowMs != null ? new Date(nowMs) : new Date();
    try {
      var parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
      }).formatToParts(d);
      var h = 0, m = 0;
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === 'hour') h = parseInt(parts[i].value, 10);
        if (parts[i].type === 'minute') m = parseInt(parts[i].value, 10);
      }
      if (h === 24) h = 0;
      return h * 60 + m;
    } catch (e1) {
      return d.getUTCHours() * 60 + d.getUTCMinutes() + 8 * 60;
    }
  }

  /**
   * @returns {{ allow: boolean, reason: string, mySlot?: number, activeSlot?: number, slots?: number }}
   */
  function evaluate(opts) {
    opts = opts || {};
    if (opts.force) return { allow: true, reason: 'force' };
    if (opts.alreadyRunning) return { allow: true, reason: 'already_running' };
    if (opts.softRiskActive) return { allow: true, reason: 'soft_risk_bypass' };

    var cfg = readThresholds(opts.thresholds);
    var slots = cfg.slots | 0;
    if (slots <= 1) return { allow: true, reason: 'stagger_off', slots: slots };

    var slotMin = cfg.slotMin | 0;
    if (slotMin < 5) slotMin = 30;

    var mySlot = hashHandle(opts.handle) % slots;
    var mins = typeof opts.shanghaiMinutes === 'number'
      ? opts.shanghaiMinutes
      : shanghaiMinutes(opts.nowMs);
    var activeSlot = Math.floor(mins / slotMin) % slots;
    if (mySlot === activeSlot) {
      return {
        allow: true,
        reason: 'slot_match',
        mySlot: mySlot,
        activeSlot: activeSlot,
        slots: slots,
        slotMin: slotMin
      };
    }
    return {
      allow: false,
      reason: 'chat_stagger_wait',
      mySlot: mySlot,
      activeSlot: activeSlot,
      slots: slots,
      slotMin: slotMin
    };
  }

  var api = {
    cleanHandle: cleanHandle,
    hashHandle: hashHandle,
    readThresholds: readThresholds,
    shanghaiMinutes: shanghaiMinutes,
    evaluate: evaluate
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.SgChatStagger = api;
  if (typeof window !== 'undefined') window.SgChatStagger = api;
  if (typeof self !== 'undefined') self.SgChatStagger = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

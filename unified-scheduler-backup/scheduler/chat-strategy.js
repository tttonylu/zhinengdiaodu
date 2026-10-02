(function () {
  'use strict';

  function loadSg() {
    try { return JSON.parse(localStorage.getItem('sg_state') || '{}') || {}; } catch (e) { return {}; }
  }

  function countDebt() {
    try {
      if (typeof countChatDebtFromDB === 'function') return countChatDebtFromDB();
    } catch (e) {}
    return 0;
  }

  function scrmAllowsChat() {
    try {
      if (typeof getScrmGateSync === 'function') {
        var g = getScrmGateSync();
        return !!(g && g.allow_chat);
      }
    } catch (e) {}
    return true;
  }

  function softRiskActive(sg, now) {
    now = now || Date.now();
    sg = sg || loadSg();
    // 与 scheduler-core 对齐：until=0 不活跃；有 until+相位则活跃（含过期加班段）
    var until = sg.softRiskUntil || 0;
    if (!(until > 0)) return false;
    var phase = sg.softRiskPhase || '';
    if (phase === 'chat1' || phase === 'nurture' || phase === 'chat2') return true;
    return now < until;
  }

  function isRush() {
    try {
      if (typeof isChatRushWindowNow === 'function') return isChatRushWindowNow();
    } catch (e) {}
    return false;
  }

  function readLocalDayCount() {
    try {
      var h = '';
      try {
        if (typeof window !== 'undefined' && typeof window.__sgGetMyHandle === 'function') {
          h = String(window.__sgGetMyHandle() || '');
        }
      } catch (eH) {}
      if (!h) {
        h = localStorage.getItem('matrix_my_handle') || '';
        h = String(h).replace(/^@/, '').replace(/#guard$/i, '').toLowerCase();
      }
      if (!h || h === 'unknown') return 1;
      var dc = parseInt((JSON.parse(localStorage.getItem('matrix_stats_' + h) || '{}')).day_count, 10);
      return (dc > 0) ? dc : 1;
    } catch (e) {
      return 1;
    }
  }

  /**
   * 返回 { allowChat, preferInbox, allowFollow, cooldownMultiplier, reason }
   */
  function resolveChatPolicy(opts) {
    opts = opts || {};
    var sg = opts.sg || loadSg();
    var now = opts.now || Date.now();
    var debt = opts.debt != null ? opts.debt : countDebt();
    var replyPending = opts.replyPending != null ? opts.replyPending : 0;

    if (!scrmAllowsChat()) {
      return { allowChat: false, preferInbox: false, allowFollow: true, cooldownMultiplier: 2, reason: 'scrm_offline' };
    }
    var dayCount = readLocalDayCount();
    if (dayCount < 3) {
      return { allowChat: false, preferInbox: false, allowFollow: true, cooldownMultiplier: 1, reason: 'day_lt_3', day: dayCount };
    }
    // 4.1.64：非私信时段（默认 08:00–18:00 外）不开私信、不赶债
    try {
      var inChat = true;
      if (typeof TimeUtil !== 'undefined' && TimeUtil.isWithinChatHours) {
        inChat = !!TimeUtil.isWithinChatHours();
      } else if (typeof StageDetector !== 'undefined') {
        if (StageDetector.detect) StageDetector.detect();
        if (StageDetector.isChatTime) inChat = !!StageDetector.isChatTime();
      }
      if (!inChat) {
        return { allowChat: false, preferInbox: false, allowFollow: true, cooldownMultiplier: 1, reason: 'outside_chat_hours' };
      }
    } catch (eHours) {}
    if (softRiskActive(sg, now)) {
      var phase = sg.softRiskPhase || 'chat1';
      if (phase === 'nurture' || sg.softRiskChatDone) {
        return { allowChat: false, preferInbox: false, allowFollow: false, cooldownMultiplier: 1, reason: 'soft_risk_nurture' };
      }
      // chat1 / chat2：粉丝页队列，永不 preferInbox
      return {
        allowChat: true,
        preferInbox: false,
        allowFollow: false,
        cooldownMultiplier: 1,
        reason: phase === 'chat2' ? 'soft_risk_chat2' : 'soft_risk_chat1'
      };
    }
    // 窗外：债/回复也只走粉丝页（守箱废除）
    if (debt > 0) {
      return { allowChat: true, preferInbox: false, allowFollow: true, cooldownMultiplier: 1, reason: 'has_kick_or_debt' };
    }
    if (replyPending > 0) {
      return { allowChat: true, preferInbox: false, allowFollow: true, cooldownMultiplier: 1, reason: 'reply_pending' };
    }
    return { allowChat: true, preferInbox: false, allowFollow: true, cooldownMultiplier: 1, reason: 'normal' };
  }

  function moduleQualityScore(moduleName) {
    try {
      var raw = localStorage.getItem('sg_module_scores') || '{}';
      var scores = JSON.parse(raw);
      return Number(scores[moduleName]) || 1;
    } catch (e) {
      return 1;
    }
  }

  function recordModuleOutcome(moduleName, good) {
    try {
      var raw = localStorage.getItem('sg_module_scores') || '{}';
      var scores = JSON.parse(raw);
      var cur = Number(scores[moduleName]) || 1;
      scores[moduleName] = good ? Math.min(1.2, cur + 0.05) : Math.max(0.5, cur - 0.1);
      localStorage.setItem('sg_module_scores', JSON.stringify(scores));
    } catch (e) {}
  }

  /** 号池错峰：按 handle 哈希抖动 5–15 分钟，避免齐开 inbox */
  function fleetChatJitterMs(handle) {
    handle = String(handle || '').replace(/^@/, '').replace(/#guard$/i, '').toLowerCase().trim();
    if (!handle) return 0;
    var h = 0;
    for (var i = 0; i < handle.length; i++) {
      h = ((h << 5) - h) + handle.charCodeAt(i);
      h |= 0;
    }
    var mins = 5 + (Math.abs(h) % 11);
    return mins * 60 * 1000;
  }

  function applyModuleQualityPriority(priority) {
    priority = priority || [];
    try {
      if (typeof SgChatStrategy === 'undefined') return priority;
      var repostScore = moduleQualityScore('repost');
      var chatCap = false;
      try {
        var sg = loadSg();
        chatCap = (sg.chatTotalToday || 0) >= 240 * 60;
      } catch (eCap) {}
      var out = priority.slice();
      if (repostScore < 0.7) out = out.filter(function (n) { return n !== 'repost'; });
      if (chatCap) {
        out = out.filter(function (n) { return n !== 'chat'; });
        if (out.indexOf('follow') < 0) out.unshift('follow');
      }
      return out;
    } catch (e) {
      return priority;
    }
  }

  var SgChatStrategy = {
    resolveChatPolicy: resolveChatPolicy,
    moduleQualityScore: moduleQualityScore,
    recordModuleOutcome: recordModuleOutcome,
    fleetChatJitterMs: fleetChatJitterMs,
    applyModuleQualityPriority: applyModuleQualityPriority
  };

  if (typeof window !== 'undefined') window.SgChatStrategy = SgChatStrategy;
  if (typeof self !== 'undefined') self.SgChatStrategy = SgChatStrategy;
})();

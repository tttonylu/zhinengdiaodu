// =============================================================================
// TEST COPY ONLY · Inbox pulse state machine (pure, no DOM)
// 守箱脉冲：定时扫描 → 选一个任务 → 执行 → 排下一次。
// 不使用 softRisk 窗口，也不参与出站步进机。
// =============================================================================
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.SgInboxPulse) return;

  var MIN_INTERVAL_MS = 20000;
  var DEFAULT_INTERVAL_MS = 60000;

  function num(value, fallback) {
    var n = Number(value);
    if (isFinite(n) && n > 0) return n;
    return fallback || 0;
  }

  function normalizeState(raw, now) {
    raw = raw || {};
    var interval = num(raw.intervalMs, DEFAULT_INTERVAL_MS);
    if (interval < MIN_INTERVAL_MS) interval = MIN_INTERVAL_MS;
    var stats = raw.stats || {};
    return {
      running: !!raw.running,
      busy: !!raw.busy,
      phase: raw.phase || 'scan',
      intervalMs: interval,
      nextPulseAt: Number(raw.nextPulseAt) || 0,
      startedAt: Number(raw.startedAt) || 0,
      lastAt: Number(raw.lastAt) || 0,
      last: raw.last || null,
      stats: {
        pulses: Number(stats.pulses) || 0,
        opened: Number(stats.opened) || 0,
        sent: Number(stats.sent) || 0,
        skipped: Number(stats.skipped) || 0,
        errors: Number(stats.errors) || 0
      }
    };
  }

  function isDue(state, now) {
    if (!state || !state.running) return false;
    return (Number(now) || Date.now()) >= (Number(state.nextPulseAt) || 0);
  }

  function nextPulseIn(state, now) {
    if (!state || !state.running) return 0;
    return Math.max(0, (Number(state.nextPulseAt) || 0) - (Number(now) || Date.now()));
  }

  function finishPulse(state, result, now) {
    var t = Number(now) || Date.now();
    var s = normalizeState(state, t);
    s.busy = false;
    s.phase = 'scan';
    s.lastAt = t;
    s.last = result || null;
    s.nextPulseAt = t + s.intervalMs;
    s.stats.pulses += 1;
    if (result && result.opened) s.stats.opened += 1;
    if (result && result.sent) s.stats.sent += 1;
    if (result && (result.skipped || result.action === 'idle')) s.stats.skipped += 1;
    if (result && result.error) s.stats.errors += 1;
    return s;
  }

  /** 任务优先级：精确未读 > 视觉未读 > 广告债 > 催加 > 探测 */
  function priority(item) {
    // 唯一排序来源：inbox-decision。两套优先级会漂移（例如 revived/closed 的处理），
    // 这里只做委托，保留兜底仅为脚本加载顺序异常时可用。
    if (window.SgInboxDecision && window.SgInboxDecision.candidatePriority) {
      return window.SgInboxDecision.candidatePriority(item);
    }
    if (!item) return 99;
    if (item.unread && item.unreadPrecise) return 0;
    if (item.unread) return 1;
    // 预览最后一条不是「你:」→ 对方最后发言，即使蓝点已被打开消掉也算待办
    if (item.lastSpeaker === 'peer' || item.peerLast) return 2;
    if (item.adDebt || item.kickReady) return 3;
    if (item.probeable) return 4;
    return 5;
  }

  /** 选本次脉冲要处理的一个会话；没有任务返回 null */
  function selectTarget(list, now) {
    var kept = [];
    var items = Array.isArray(list) ? list : [];
    if (window.SgInboxDecision && window.SgInboxDecision.sortInboxCandidates) {
      var sorted = window.SgInboxDecision.sortInboxCandidates(items) || [];
      for (var s = 0; s < sorted.length; s++) {
        var cand = sorted[s];
        // 收口后对方又来消息的会话会带 revived=true；它仍然是待回复的对方来信，
        // 不能因为 closed=true 就被脉冲跳过，否则现场表现就是“有未读但永远不回”。
        if (!cand || (cand.closed && !cand.revived)) continue;
        // revived = 收口后确认有新入站，即使列表预览没变（例如预览是旧话术）
        // 也必须处理；否则它会一直停在“已排队待核对”却永远选不中。
        var hasSignal2 = !!(cand.revived || cand.unread || cand.peerLast
          || cand.adDebt || cand.kickReady || cand.probeable);
        if (!hasSignal2) continue;
        return cand;
      }
      return null;
    }
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item) continue;
      if (item.closed && !item.revived) continue;
      // 冷却只压「没有台账待办」的复查；未读、广告债、催加到点必须处理，
      // 否则催加会被 8 分钟复查冷却拖慢，永远轮不到“下一轮轮询”。
      if (item.cooldown && !item.unread && !item.adDebt && !item.kickReady) continue;
      // 没有任何待办信号（未读/对方最后发言/台账债务）→ 不开
      var hasSignal = !!(item.revived || item.unread || item.peerLast || item.hasReply
        || item.adDebt || item.kickReady || item.probeable);
      if (!hasSignal) continue;
      kept.push({ item: item, priority: priority(item), index: i });
    }
    kept.sort(function (a, b) {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.index - b.index;
    });
    return kept.length ? kept[0].item : null;
  }

  window.SgInboxPulse = {
    MIN_INTERVAL_MS: MIN_INTERVAL_MS,
    DEFAULT_INTERVAL_MS: DEFAULT_INTERVAL_MS,
    normalizeState: normalizeState,
    isDue: isDue,
    nextPulseIn: nextPulseIn,
    finishPulse: finishPulse,
    priority: priority,
    selectTarget: selectTarget
  };
})();

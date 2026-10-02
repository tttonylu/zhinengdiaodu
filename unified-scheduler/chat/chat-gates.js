// =============================================================================
// C5 + C8 · 发送闸门 / 冷却日轮配置读取
// 工作指导：等回复证据；读 remote thresholds，禁止写死与 OPS 冲突
// =============================================================================
(function () {
  'use strict';
  if (typeof window !== 'undefined' && window.__sg_chat_gates_loaded__) return;
  if (typeof window !== 'undefined') window.__sg_chat_gates_loaded__ = true;

  var CHAT_DAILY_CAP_SEC = 240 * 60;
  var CHAT_INBOX_CAP_SEC = 120 * 60;
  var CHAT_OUTBOUND_CAP_SEC = 150 * 60;

  var hooks = {
    normalizeChatHandle: null,
    loadTargetDB: null,
    saveTargetDB: null,
    loadSgState: null,
    chatShanghaiDate: null,
    isMessagesPage: null
  };

  function callHook(name) {
    var fn = hooks[name];
    if (typeof fn !== 'function') return undefined;
    try {
      return fn.apply(null, Array.prototype.slice.call(arguments, 1));
    } catch (e) {
      return undefined;
    }
  }

  function bind(next) {
    if (!next) return api;
    Object.keys(hooks).forEach(function (k) {
      if (typeof next[k] === 'function') hooks[k] = next[k];
    });
    return api;
  }

  function getChatIntervalCfg() {
    var iv = {};
    try { iv = JSON.parse(localStorage.getItem('sg_config_intervals') || '{}'); } catch (e) {}
    return {
      coolMin: parseInt(iv.chat_cooldown_min_min, 10) || 25,
      coolMax: parseInt(iv.chat_cooldown_max_min, 10) || 35,
      debtMin: parseInt(iv.chat_debt_cooldown_min_min, 10) || 8,
      debtMax: parseInt(iv.chat_debt_cooldown_max_min, 10) || 12,
      adMinWaitMin: parseInt(iv.chat_ad_min_wait_min, 10) || 20,
      kickMinHours: (function () {
        var n = parseInt(iv.chat_kick_min_hours, 10);
        // 4.1.61：默认 0=按轮次下一窗即可盾牌/催加，不再等 2h；OPS 显式 >0 仍生效
        return isNaN(n) ? 0 : Math.max(0, n);
      })(),
      inboxVisitCapSec: parseInt(iv.chat_inbox_visit_cap_sec, 10) || 150
    };
  }

  function getAdMinWaitMs() {
    return getChatIntervalCfg().adMinWaitMin * 60 * 1000;
  }

  function ensureChatDayStats(st) {
    st = st || callHook('loadSgState') || {};
    var today = callHook('chatShanghaiDate') || '';
    if (st.chatDate !== today) {
      st.chatDate = today;
      st.chatTotalToday = 0;
      st.chatInboxToday = 0;
      st.chatOutboundToday = 0;
      st.chatRoundsToday = 0;
    }
    return st;
  }

  function isChatDailyCapReached(st) {
    st = ensureChatDayStats(st);
    return (st.chatTotalToday || 0) >= CHAT_DAILY_CAP_SEC;
  }

  function isInboxCapReached(st) {
    st = ensureChatDayStats(st);
    return (st.chatInboxToday || 0) >= CHAT_INBOX_CAP_SEC;
  }

  function isOutboundCapReached(st) {
    st = ensureChatDayStats(st);
    return (st.chatOutboundToday || 0) >= CHAT_OUTBOUND_CAP_SEC;
  }

  function canSendAdNow(handle, peerTexts, entry) {
    var nh = callHook('normalizeChatHandle', handle) || String(handle || '');
    var db = callHook('loadTargetDB') || {};
    entry = entry || db[nh] || {};
    if (!peerTexts || !peerTexts.length) return { ok: false, reason: 'no_peer_texts' };
    var iceAt = entry.iceSentAt || 0;
    if (!iceAt) return { ok: false, reason: 'missing_ice_sent_at' };
    if (entry.lastInboundAt && entry.lastInboundAt > iceAt) return { ok: true, reason: 'reply_confirmed' };
    // 4.1.0：会话差集已有对方文本即回复证据（跟进开人，不依赖蓝点先写 lastInboundAt）
    return { ok: true, reason: 'peer_texts_in_session' };
  }

  /** 4.1.53：AD 后最多两步（盾牌一次 + 催加一次），满 2 次完结 */
  var KICK_MAX_COUNT = 2;

  function getKickCount(entry) {
    if (!entry) return 0;
    var n = parseInt(entry.kickCount, 10);
    if (!isNaN(n) && n >= 0) return n;
    // 旧数据：已发过跟进但无 kickCount → 视作 1（已发盾牌）
    if (entry.kickSentAt) return 1;
    if ((entry.round || 0) >= 3 && entry.done && !entry.rejectSentAt && !entry.blockedAt) return 1;
    return 0;
  }

  function canSendKickNow(handle, entry) {
    var nh = callHook('normalizeChatHandle', handle) || String(handle || '');
    var db = callHook('loadTargetDB') || {};
    entry = entry || db[nh] || {};
    if (isChatFullyClosed(entry)) return false;
    var kc = getKickCount(entry);
    if (kc >= KICK_MAX_COUNT) return false;
    // 首次盾牌需 round===2；第二次催加允许 kickCount===1
    if (kc < 1 && (entry.round || 0) !== 2) return false;
    // 4.1.61：废除小时间隔；盾牌/催加只按轮次，下一软风控窗一窗一条即可
    return true;
  }

  /** 终端完结：盾牌+催加已发完 / 显式关闭 / 婉拒 / 拉黑 */
  function isChatFullyClosed(entry) {
    if (!entry) return false;
    if (entry.chatClosedAt || entry.finalKickSentAt || entry.rejectSentAt || entry.blockedAt) return true;
    return getKickCount(entry) >= KICK_MAX_COUNT;
  }

  /** 是否已发过盾牌（第一次跟进） */
  function hasKickBeenSent(entry) {
    return getKickCount(entry) >= 1;
  }

  /**
   * 未读驱动 final_kick 已废；AD 后第二次跟进由 kickCount===1 + getRoundMessage 发 final_kick_message。
   * API 恒 false，避免旧守箱路径误开人。
   */
  function canSendFinalKickNow(/* handle, entry */) {
    return false;
  }

  function canProbeInboxTarget(handle, entry) {
    var nh = callHook('normalizeChatHandle', handle) || String(handle || '');
    var db = callHook('loadTargetDB') || {};
    entry = entry || db[nh] || {};
    if (!entry || entry.done || (entry.round || 0) !== 1) return false;
    if (!callHook('isMessagesPage')) return false;
    if (entry.iceSentAt && Date.now() - entry.iceSentAt < getAdMinWaitMs()) return false;
    return true;
  }

  function markLastInboundAt(userHandle) {
    userHandle = callHook('normalizeChatHandle', userHandle) || String(userHandle || '');
    if (!userHandle) return;
    try {
      var db = callHook('loadTargetDB') || {};
      if (!db[userHandle]) return;
      db[userHandle].lastInboundAt = Date.now();
      callHook('saveTargetDB', db);
    } catch (e) {}
  }

  function hasMinorKeyword(/* texts */) {
    return false;
  }

  var api = {
    bind: bind,
    CHAT_DAILY_CAP_SEC: CHAT_DAILY_CAP_SEC,
    CHAT_INBOX_CAP_SEC: CHAT_INBOX_CAP_SEC,
    CHAT_OUTBOUND_CAP_SEC: CHAT_OUTBOUND_CAP_SEC,
    getChatIntervalCfg: getChatIntervalCfg,
    getAdMinWaitMs: getAdMinWaitMs,
    ensureChatDayStats: ensureChatDayStats,
    isChatDailyCapReached: isChatDailyCapReached,
    isInboxCapReached: isInboxCapReached,
    isOutboundCapReached: isOutboundCapReached,
    KICK_MAX_COUNT: KICK_MAX_COUNT,
    getKickCount: getKickCount,
    canSendAdNow: canSendAdNow,
    canSendKickNow: canSendKickNow,
    isChatFullyClosed: isChatFullyClosed,
    hasKickBeenSent: hasKickBeenSent,
    canSendFinalKickNow: canSendFinalKickNow,
    canProbeInboxTarget: canProbeInboxTarget,
    markLastInboundAt: markLastInboundAt,
    hasMinorKeyword: hasMinorKeyword
  };

  if (typeof window !== 'undefined') window.SgChatGates = api;
  console.log('[C5/C8] chat-gates.js loaded');
})();

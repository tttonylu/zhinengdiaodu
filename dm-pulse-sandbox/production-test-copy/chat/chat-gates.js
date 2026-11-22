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
      adMinWaitMin: parseInt(iv.chat_ad_min_wait_min, 10) || 60,
      kickMinHours: (function () {
        var n = parseInt(iv.chat_kick_min_hours, 10);
        // 4.1.61：默认 0=按轮次下一窗即可盾牌/催加，不再等 2h；OPS 显式 >0 仍生效
        return isNaN(n) ? 0 : Math.max(0, n);
      })(),
      inboxKickMinMinutes: (function () {
        // 守箱脉冲每 60 秒一拍，没有“软风控窗”天然间隔，必须显式限速。
        // 默认 180 分钟：广告后至少 3 小时才追第一句，避免“刚发完广告 4 分钟
        // 又催一次”被对方当成机器人。OPS 显式配置可以覆盖。
        // 兼容旧参数 chat_inbox_kick_min_hours（按小时读）。
        var n = parseInt(iv.chat_inbox_kick_min_minutes, 10);
        if (isNaN(n)) {
          var h = parseInt(iv.chat_inbox_kick_min_hours, 10);
          n = isNaN(h) ? 180 : h * 60;
        }
        return Math.max(0, n);
      })(),
      inboxFinalKickMinMinutes: (function () {
        // 终催的额外时间下限；默认 12 小时，至少隔半天再发最后一句。
        // 不填时给 720 分钟，而不是跟随首次催加的 180 分钟。
        var n = parseInt(iv.chat_inbox_final_kick_min_minutes, 10);
        if (isNaN(n)) return 720;
        return Math.max(0, n);
      })(),
      inboxVisitCapSec: parseInt(iv.chat_inbox_visit_cap_sec, 10) || 150
    };
  }

  function getAdMinWaitMs() {
    return getChatIntervalCfg().adMinWaitMin * 60 * 1000;
  }

  function getInboxKickGapMs() {
    return getChatIntervalCfg().inboxKickMinMinutes * 60 * 1000;
  }

  function getInboxFinalKickGapMs() {
    var cfg = getChatIntervalCfg();
    var mins = cfg.inboxFinalKickMinMinutes || cfg.inboxKickMinMinutes;
    return mins * 60 * 1000;
  }

  /** 交友两段式模式：第1段后满 wait 或任意回复可发第2段；发 LINE 后禁止踢/追问。job 池默认关。 */
  function isTwoSegMode() {
    try {
      var t = {};
      try { t = JSON.parse(localStorage.getItem('sg_config_thresholds') || '{}') || {}; } catch (eT) {}
      var pool = String(t.chat_script_pool || 'dating').toLowerCase().trim();
      var v = t.chat_two_seg_mode;
      if (v === undefined || v === null || v === '') {
        try {
          var iv = JSON.parse(localStorage.getItem('sg_config_intervals') || '{}') || {};
          v = iv.chat_two_seg_mode;
        } catch (eI) {}
      }
      var s = (v === undefined || v === null || v === '') ? '' : String(v).toLowerCase().trim();
      if (s === '0' || s === 'off' || s === 'false' || s === 'classic' || s === 'no') return false;
      if (s === '1' || s === 'on' || s === 'true' || s === 'yes' || s === 'two_seg') return true;
      // 未显式配置：dating 默认开，job 默认关
      return pool !== 'job';
    } catch (e) {
      return true;
    }
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
    var iceAt = entry.iceSentAt || 0;
    if (!iceAt) return { ok: false, reason: 'missing_ice_sent_at' };
    var hasPeer = !!(peerTexts && peerTexts.length);
    if (entry.lastInboundAt && entry.lastInboundAt > iceAt) {
      return { ok: true, reason: 'reply_confirmed' };
    }
    if (hasPeer) {
      // 4.1.0：会话差集已有对方文本即回复证据（跟进开人，不依赖蓝点先写 lastInboundAt）
      return { ok: true, reason: 'peer_texts_in_session' };
    }
    // 4.9.132：两段式也必须先收到对方回复，等待时间不能替代回复证据。
    // 旧逻辑「满 60 分钟无回复也发广告」会把破冰直接升级成推销，
    // 现场表现为对方一句话没说却收到 LINE 广告，且隔天再催一次。
    // 没有回复就等，超过 3 天由台账过期清理。
    return { ok: false, reason: 'await_reply', wait_left_ms: 0 };
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
    // 两段式：第 2 段含 LINE 后禁止追问/盾牌/催加
    if (isTwoSegMode()) return false;
    var nh = callHook('normalizeChatHandle', handle) || String(handle || '');
    var db = callHook('loadTargetDB') || {};
    entry = entry || db[nh] || {};
    if (isChatFullyClosed(entry)) return false;
    var kc = getKickCount(entry);
    if (kc >= KICK_MAX_COUNT) return false;
    // 4.9.133：催加不是“到点自动追发”。第一次催加必须发生在广告之后
    // 对方又有入站，第二次催加必须发生在第一次催加之后又有入站。
    // 旧逻辑只卡时间，导致“广告 + 两条催加”即使对方一句话没回也会照发。
    var kickAnchor = kc >= 1
      ? (Number(entry.kickSentAt) || 0)
      : (Number(entry.adSentAt) || 0);
    var lastInbound = Math.max(
      Number(entry.lastInboundAt) || 0,
      Number(entry.replySeenAt) || 0,
      Number(entry.unreadSeenAt) || 0,
      Number(entry.lastNonTextInboundAt) || 0
    );
    if (!kickAnchor || lastInbound <= kickAnchor) return false;
    // 队列分类和守箱状态机必须用同一套时间闸；只有状态机限速、队列却
    // 把“催加到点”反复写回 pending，现场就会每轮重新入队同一个人。
    var now = Date.now();
    if (kc >= 1) {
      var lastKickAt = Number(entry.kickSentAt) || 0;
      var finalGap = getInboxFinalKickGapMs();
      if (lastKickAt && finalGap && (now - lastKickAt) < finalGap) return false;
    } else {
      var adAt = Number(entry.adSentAt) || 0;
      var firstGap = getInboxKickGapMs();
      if (adAt && firstGap && (now - adAt) < firstGap) return false;
    }
    // 首次盾牌需 round===2；第二次催加允许 kickCount===1
    if (kc < 1 && (entry.round || 0) !== 2) {
      // 兼容旧台账：round 可能还停在 1，但广告气泡证据已经存在。
      // 阶段判定以发送痕迹为准（与 inbox-state 一致），否则会出现
      // “状态机判定 kick_ready、旧闸门却永远拦住”的静默冲突。
      var adEvidence = !!(entry.adBubbleOk || Number(entry.adSentAt) > 0);
      if (!adEvidence) return false;
    }
    // 4.1.61：废除小时间隔；盾牌/催加只按轮次，下一软风控窗一窗一条即可
    return true;
  }

  /** 终端完结：盾牌+催加已发完 / 显式关闭 / 婉拒 / 拉黑 / round≥3 */
  function isChatFullyClosed(entry) {
    if (!entry) return false;
    // 目标库已标记 done 或 round≥3 → 完结（与 C1/C2 语义对齐，修旧数据 kickCount 未回填的漏网）
    if (entry.done) return true;
    if ((entry.round || 0) >= 3) return true;
    if (entry.chatClosedAt || entry.finalKickSentAt || entry.rejectSentAt || entry.blockedAt) return true;
    return getKickCount(entry) >= KICK_MAX_COUNT;
  }

  /** 是否已发过盾牌（第一次跟进） */
  function hasKickBeenSent(entry) {
    return getKickCount(entry) >= 1;
  }

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
    // 非两段式：没有回复证据时，重开只会把未读标成已读，不会产生广告。
    if (!isTwoSegMode()) {
      var iceAt = Number(entry.iceSentAt) || 0;
      var inbound = Number(entry.lastInboundAt) || 0;
      if (!entry.replySeenAt && !(inbound && inbound > iceAt)) return false;
    }
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
    isTwoSegMode: isTwoSegMode,
    ensureChatDayStats: ensureChatDayStats,
    isChatDailyCapReached: isChatDailyCapReached,
    isInboxCapReached: isInboxCapReached,
    isOutboundCapReached: isOutboundCapReached,
    KICK_MAX_COUNT: KICK_MAX_COUNT,
    getKickCount: getKickCount,
    canSendAdNow: canSendAdNow,
    getInboxKickGapMs: getInboxKickGapMs,
    getInboxFinalKickGapMs: getInboxFinalKickGapMs,
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

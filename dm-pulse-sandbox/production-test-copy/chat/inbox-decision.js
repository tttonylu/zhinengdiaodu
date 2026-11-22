// =============================================================================
// TEST COPY ONLY · Inbox watch decision rules (pure, no DOM)
// 守箱动作判定：破冰 → 广告 → 催加，以及会话候选排序（精确未读优先）。
// 仅做规则计算，不读写 DOM、不发消息；由 content_chat 调用后执行。
// =============================================================================
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.SgInboxDecision) return;

  var DEFAULT_AD_MIN_WAIT_MS = 60 * 60 * 1000;
  var KICK_MAX_COUNT = 2;
  // 与 inbox-state 保持一致：催加之间必须隔一次轮询（默认 60 秒一拍）。
  // 时间闸 = 一拍，防止积压排水（8 秒一拍）把首次催加和终催连在两分钟内发完。
  var INBOX_KICK_GAP_MS = 60 * 1000;
  // 渲染失败隔离：连续 2 次读不到会话正文就冷却 30 分钟，避免空壳反复占队首。
  var RENDER_FAIL_LIMIT = 2;
  var RENDER_FAIL_COOLDOWN_MS = 30 * 60 * 1000;
  // 单次失败后的换目标等待：90 秒内不重复同一个空壳目标。
  var RENDER_RETRY_WAIT_MS = 90 * 1000;
  // 身份未证明隔离：连续 2 次无法证明“打开的是目标本人”就冷却 30 分钟。
  // 这类目标通常列表上有蓝点，旧逻辑让未读绕过冷却，
  // 结果同一个身份错配会话每拍都排第一，后面的人永远轮不到。
  var IDENTITY_FAIL_LIMIT = 2;
  var IDENTITY_COOLDOWN_MS = 30 * 60 * 1000;
  // 「对方关闭收件箱」不是永久终态：X 允许对方随时重新打开。
  // 旧逻辑一旦记下就永远不再打开，对方后来重新开放、甚至发来新消息，
  // 台账里那个人也永远不会再被处理，后台只会一直显示“对方关闭了收件箱”。
  // 现在改为定期复查：默认 6 小时一次；列表预览一变（真来了新消息）立即复查。
  var INBOX_CLOSED_RECHECK_MS = 6 * 60 * 60 * 1000;
  var NO_REPLY_EXPIRY_MS = 3 * 24 * 60 * 60 * 1000;

  function num(value) {
    var n = Number(value);
    return isFinite(n) && n > 0 ? n : 0;
  }

  function lastInboundOf(entry) {
    var e = entry || {};
    return Math.max(
      num(e.lastInboundAt),
      num(e.replySeenAt),
      num(e.unreadSeenAt),
      num(e.lastNonTextInboundAt)
    );
  }

  function hasInboundAfter(entry, anchor, texts) {
    if (Array.isArray(texts) && texts.length > 0) return true;
    var at = num(anchor);
    return !!(at && lastInboundOf(entry) > at);
  }

  /** 与 inbox-state 完全一致：最后一条我方消息超过 3 天且之后无入站 → 过期。 */
  function isExpiredNoReply(entry, now) {
    var e = entry || {};
    now = num(now) || Date.now();
    var lastOut = Math.max(
      num(e.lastDM),
      num(e.iceSentAt),
      num(e.iceAt),
      num(e.adSentAt),
      num(e.adAt),
      num(e.kickSentAt),
      num(e.kickAt),
      num(e.finalKickSentAt),
      num(e.twoSegAdDoneAt)
    );
    if (!lastOut || (now - lastOut) <= NO_REPLY_EXPIRY_MS) return false;
    var lastIn = Math.max(
      num(e.lastInboundAt),
      num(e.replySeenAt),
      num(e.unreadSeenAt),
      num(e.lastNonTextInboundAt)
    );
    return !(lastIn && lastIn >= lastOut);
  }

  function kickCountOf(entry) {
    if (!entry) return 0;
    var raw = entry.kickCount;
    if (raw !== undefined && raw !== null && raw !== '') {
      var n = parseInt(raw, 10);
      if (!isNaN(n) && n >= 0) return n;
    }
    return entry.kickSentAt ? 1 : 0;
  }

  /** 终端完结：显式关闭 / 婉拒 / 拉黑 / 已发终催 / 催加满次数 */
  function isFullyClosed(entry) {
    if (!entry) return false;
    if (entry.done) return true;
    if (num(entry.round) >= 3) return true;
    if (entry.chatClosedAt || entry.finalKickSentAt || entry.rejectSentAt || entry.blockedAt) return true;
    if (kickCountOf(entry) >= KICK_MAX_COUNT) return true;
    return false;
  }

  function isHardClosed(entry) {
    return !!(entry && (entry.rejectSentAt || entry.blockedAt));
  }

  /**
   * 对方关闭收件箱的文案判定（纯函数）。
   * 输入是“已经穿透 shadowRoot 合并后的页面文本”。
   * 先压掉所有空白再匹配：X 会把横幅拆成多个 span，innerText 里带换行。
   */
  function inboxClosedVerdict(text) {
    var all = String(text || '');
    if (!all) return '';
    var flat = all.replace(/[\s\u3000]+/g, '');
    var lower = flat.toLowerCase();
    // 4.9.111：X 把「这个会话不能再发」也表达成只读模式，且会话里没有输入框。
    // 旧逻辑只认「收件箱已关闭」，于是这类会话每拍都被当成技术失败重开，
    // 现场表现就是某个人一直被打开、却永远不发送，把其他回复全挤到后面。
    if (/此对话当前处于只读模式|此對話目前處於唯讀模式|当前处于只读|目前處於唯讀|只读模式|唯讀模式/.test(flat)) {
      return 'peer_inbox_closed';
    }
    if (/thisconversationiscurrentlyinread-only|read-onlymode/.test(lower)) {
      return 'peer_inbox_closed';
    }
    if (/会話は現在読み取り専用|読み取り専用モード/.test(flat)) {
      return 'peer_inbox_closed';
    }
    if (/收件箱(?:已|已被)?关闭/.test(flat)) return 'peer_inbox_closed';
    if (/收件箱.{0,12}(?:关闭|安全码|安全碼)/.test(flat)) return 'peer_inbox_closed';
    if (/受信トレイ.{0,18}閉じ/.test(flat)) return 'peer_inbox_closed';
    if (/inbox.{0,18}closed/.test(lower)) return 'peer_inbox_closed';
    if (/(?:安全码|安全碼|セーフティコード|safetycode)/.test(lower)
      && /(?:私信|dm|ダイレクトメッセージ)/.test(lower)) return 'peer_inbox_closed';
    return '';
  }

  function closedAtOf(entry) {
    if (!entry) return 0;
    return Math.max(
      num(entry.chatClosedAt),
      num(entry.finalKickSentAt),
      num(entry.twoSegAdDoneAt),
      num(entry.lastDM)
    );
  }

  /**
   * 已收口会话是否出现“明确的新入站”。
   * 依据：精确未读 / 晚于收口点的入站时间 / 晚于收口点的回复时间 /
   * 列表最后一条明确是对方（我方收口必是自己发的最后一条，所以对方最后发言=之后又有来信）。
   * 草稿不算；同一批旧消息只用 reopenedAt 提醒一次。
   */
  function decideClosedReopen(entry, evidence) {
    evidence = evidence || {};
    if (!isFullyClosed(entry)) {
      return { reopen: false, reason: 'not_closed' };
    }
    if (isHardClosed(entry)) {
      return { reopen: false, reason: 'hard_closed_rejected_or_blocked' };
    }
    var closedAt = closedAtOf(entry);
    // 同一批旧消息只提醒一次：上次已读到的时点记在 reopenedAt。
    // 只有比它更新的入站证据（或新的精确未读）才再次复活，避免每拍重复打开。
    var surfacedAt = num(entry.reopenedAt);
    if (evidence.unreadPrecise) {
      return { reopen: true, reason: 'precise_unread_after_close' };
    }
    // 上次读过之后，列表预览又变了（且现在最后一条是对方）→ 确实是新来信。
    // 只比时间更可靠：时间戳来自台账，预览来自当前列表。
    // 预览基线有两个来源：正常“已读”记 reopenedPreview；
    // “等下一轮重试”记 reopenRetryPreview。两者都代表“上一次看到的那一句”。
    // 只要预览变了且最后一条是对方，就是新来信，必须立刻复活，
    // 不能被“等下一轮”的时间闸压住。
    var prevPreview = String(entry.reopenedPreview || entry.reopenRetryPreview || '');
    var nowPreview = String(evidence.preview || '');
    if (evidence.peerLast && nowPreview && prevPreview
      && nowPreview !== prevPreview) {
      return { reopen: true, reason: 'peer_last_changed' };
    }
    // 读到回复但业务判定“等下一轮才发”（催加轮次/时间下限）时，
    // 这批来信既没回过、也不能算已处理。旧逻辑直接写 reopenedAt，
    // 下一拍立刻 already_surfaced，真实回复被永久吞掉。
    // 现在改为有界重试：到点前明确报“等待重试”，到点后重新进入核对。
    // 放在“精确未读 / 预览变化”之后：真有新来信时不受重试等待压制。
    var retryAt = num(entry.reopenRetryAt);
    if (retryAt && num(evidence.now || 0) && num(evidence.now) < retryAt) {
      return { reopen: false, reason: 'reopen_retry_wait', retryAt: retryAt };
    }
    if (surfacedAt
      && num(evidence.lastInboundAt) <= surfacedAt
      && num(evidence.replySeenAt) <= surfacedAt) {
      return { reopen: false, reason: 'already_surfaced' };
    }
    if (closedAt && num(evidence.lastInboundAt) > closedAt) {
      return { reopen: true, reason: 'inbound_after_close' };
    }
    if (closedAt && num(evidence.replySeenAt) > closedAt) {
      return { reopen: true, reason: 'reply_after_close' };
    }
    // 收口动作一定是我方发消息，所以列表最后一条变成对方 = 之后确实又来消息。
    // 只在还没提醒过时使用，避免预览一直停在对方最后一句导致每拍重复打开。
    if (evidence.peerLast && !surfacedAt) {
      return { reopen: true, reason: 'peer_last_after_close' };
    }
    return { reopen: false, reason: 'closed_without_new_inbound' };
  }

  function sendResult(round, route, reason) {
    return { action: 'send', round: round, route: route, reason: reason };
  }

  /**
   * 每次真正打开会话后必须落到唯一结论。
   * 顺序很重要：读不到正文是技术失败，优先于身份/业务判断，避免把空壳当成“对方没回”。
   */
  function replyVerdict(input) {
    input = input || {};
    var leaves = Math.max(0, parseInt(input.leaves, 10) || 0);
    var articles = Math.max(0, parseInt(input.articles, 10) || 0);
    var texts = Array.isArray(input.texts) ? input.texts : [];
    var rootFound = !!input.rootFound;
    if ((!rootFound && texts.length === 0) || (leaves === 0 && articles === 0 && texts.length === 0)) {
      return 'reply_read_failed';
    }
    if (input.identityOk === false) return 'identity_unproven';
    if (leaves === 0 && texts.length === 0 && articles > 0) return 'non_text_inbound';
    if (input.hasPeerNew) return 'reply_detected';
    if (input.lastDirection === 'unknown' || (leaves > 0 && input.lastDirection === 'none')) {
      return 'direction_unproven';
    }
    return 'no_new_reply';
  }

  /**
   * 身份证明：打开会话后，判断“眼前这个会话到底是不是台账里的目标”。
   *
   * 旧逻辑只认「会话头 @handle」和「台账已有 peerId 与 URL 一致」两条正向证据。
   * 现场 rinz/れん 的情况是：台账没有 peerId（当年从粉丝列表破冰，没经过会话 URL），
   * 新版会话头又不带 @handle —— 两条都不成立，于是永远 identity_pending，
   * 对方回「40です」也永远发不出去，还会被写身份拉黑。
   *
   * 补一条本来就成立、但没被使用的证据：**导航地址**。
   * 候选行 href 里就带着「对方 id + 本号 id」，点进/直达后 URL 与它逐字一致，
   * 就说明打开的就是这一行指向的会话，身份成立；此时把 URL 里的对方 id
   * 回写台账，后续就能直接用地址打开，不用再靠会话头。
   */
  function identityProof(input) {
    input = input || {};
    var targetHandle = String(input.targetHandle || '').toLowerCase().replace(/^@/, '');
    var synthetic = /^dn_/.test(targetHandle) || /^p\d{5,}$/.test(targetHandle);
    var urlPeerId = String(input.urlPeerId || '').replace(/\D/g, '');
    var dbPeerId = String(input.dbPeerId || '').replace(/\D/g, '');
    var headerHandle = String(input.headerHandle || '').toLowerCase().replace(/^@/, '');
    var headerConfident = !!input.headerConfident;
    var navProven = !!input.navProven;
    var myId = String(input.myId || '').replace(/\D/g, '');
    // 台账 peerId 本身有过改写/冲突痕迹 = 这条 ID 不是从会话头直接读到的，
    // 不能再用「URL 与台账一致」自证身份，必须另有会话头或行内 @handle 支持。
    var ledgerPeerSuspect = !!input.ledgerPeerSuspect;
    var out = { ok: false, reason: 'identity_pending', adoptPeerId: '' };

    if (!targetHandle) {
      out.reason = 'no_target';
      return out;
    }
    // URL 两段 id 的顺序不固定；如果取到的是本号自己，那就不是对方 id，
    // 既不能拿来证明身份，更不能回写台账（一旦写进去，台账就被本号 id 污染）。
    if (urlPeerId && myId && urlPeerId === myId) {
      urlPeerId = '';
      out.reason = 'url_peer_is_self';
    }
    // 真冲突优先：可信会话头指向别人，或台账 peerId 与 URL 不一致，一律不放行。
    if (!synthetic && headerConfident && headerHandle && headerHandle !== targetHandle) {
      out.reason = 'header_handle_mismatch';
      return out;
    }
    // 低可信会话头（main_fallback 等）与目标 handle 冲突时，不能用「URL == 台账」自证。
    // 现场：台账 @rinzkumk9 的 peerId 被历史误写成另一个人的 id，打开后会话头其实是
    // @naxmhf57sh7732；因为 main_fallback 不算 confident，旧逻辑直接放行 ok_peer，
    // 结果催加消息发给了完全无关的人。会话头只要读到「另一个真人」，就必须先停手。
    var headerConflicts = !!(!synthetic && headerHandle && headerHandle !== targetHandle);
    if (urlPeerId && dbPeerId && urlPeerId !== dbPeerId) {
      out.reason = 'peer_id_mismatch';
      return out;
    }
    // 正向证据 1：会话头就是目标本人
    if (!synthetic && headerHandle && headerHandle === targetHandle) {
      out.ok = true;
      out.reason = 'ok_header';
      if (urlPeerId && !dbPeerId) out.adoptPeerId = urlPeerId;
      return out;
    }
    // 正向证据 2：台账 peerId 与 URL 一致
    if (urlPeerId && dbPeerId && urlPeerId === dbPeerId) {
      if (headerConflicts) {
        out.reason = 'header_conflict_unconfirmed';
        return out;
      }
      if (ledgerPeerSuspect) {
        out.reason = 'ledger_peer_untrusted';
        return out;
      }
      out.ok = true;
      out.reason = 'ok_peer';
      return out;
    }
    // 正向证据 3：本次导航落到的地址，正是候选行 href 指向的会话
    if (navProven && urlPeerId) {
      if (headerConflicts) {
        out.reason = 'header_conflict_unconfirmed';
        return out;
      }
      if (ledgerPeerSuspect && !dbPeerId) {
        out.reason = 'ledger_peer_untrusted';
        return out;
      }
      out.ok = true;
      out.reason = 'ok_row_href';
      if (!dbPeerId) out.adoptPeerId = urlPeerId;
      return out;
    }
    return out;
  }

  /**
   * 渲染失败冷却判定。
   * 列表预览变了 = 对方真来了新消息，必须立即解除冷却重试，不能被 30 分钟挡住。
   */
  function renderCooling(entry, preview, now) {
    var t = Number(now) || Date.now();
    var count = Math.max(0, parseInt(entry && entry.renderFailCount, 10) || 0);
    var at = num(entry && entry.renderFailAt);
    var prev = String((entry && entry.renderFailPreview) || '');
    var next = String(preview || '');
    if (next && prev && next !== prev) {
      return { cooling: false, reset: true, count: 0, reason: 'preview_changed', until: 0 };
    }
    if (count >= 1 && at && (t - at) < RENDER_RETRY_WAIT_MS) {
      return {
        cooling: true,
        reset: false,
        count: count,
        reason: 'render_retry_wait',
        until: at + RENDER_RETRY_WAIT_MS
      };
    }
    if (count >= RENDER_FAIL_LIMIT && at && (t - at) < RENDER_FAIL_COOLDOWN_MS) {
      return {
        cooling: true,
        reset: false,
        count: count,
        reason: 'render_failed_cooling',
        until: at + RENDER_FAIL_COOLDOWN_MS
      };
    }
    return { cooling: false, reset: false, count: count, reason: '', until: 0 };
  }

  /**
   * 身份失败冷却。与渲染冷却同一思路：
   * - 列表预览变了 → 说明可能真来了新消息，清零并立即重试；
   * - 连续 2 次证明不了身份 → 30 分钟内不再占队首（未读也不例外）；
   * - 读取成功会由调用方清零 identityPendingCount。
   */
  function identityCooling(entry, preview, now) {
    var t = Number(now) || Date.now();
    var count = Math.max(0, parseInt(entry && entry.identityPendingCount, 10) || 0);
    var at = num(entry && entry.identityPendingAt);
    var prev = String((entry && entry.identityPendingPreview) || '');
    var next = String(preview || '');
    if (next && prev && next !== prev) {
      return { cooling: false, reset: true, count: 0, reason: 'identity_preview_changed', until: 0 };
    }
    if (count >= IDENTITY_FAIL_LIMIT && at && (t - at) < IDENTITY_COOLDOWN_MS) {
      return {
        cooling: true,
        reset: false,
        count: count,
        reason: 'identity_unverifiable_cooling',
        until: at + IDENTITY_COOLDOWN_MS
      };
    }
    return { cooling: false, reset: false, count: count, reason: '', until: 0 };
  }

  /**
   * 「对方关闭收件箱」复查判定（纯函数）。
   * - 没有关闭记录 → 不需要复查；
   * - 列表预览与关闭时不同 → 立即复查（对方可能已经重开并来信）；
   * - 距上次确认已满复查窗口 → 复查一次；
   * - 否则继续压住，不占脉冲队列。
   * 返回值里的 dueAt 用于后台显示“下次复查时间”。
   */
  function inboxClosedRecheck(entry, preview, now) {
    var t = Number(now) || Date.now();
    var closedAt = num(entry && entry.inboxClosedAt);
    if (!closedAt) return { recheck: false, reason: 'not_closed', closedAt: 0, dueAt: 0 };
    var prev = String((entry && entry.inboxClosedPreview) || '');
    var next = String(preview || '');
    if (next && prev && next !== prev) {
      return { recheck: true, reason: 'preview_changed', closedAt: closedAt, dueAt: t };
    }
    var dueAt = closedAt + INBOX_CLOSED_RECHECK_MS;
    if (t >= dueAt) {
      return { recheck: true, reason: 'recheck_due', closedAt: closedAt, dueAt: dueAt };
    }
    return { recheck: false, reason: 'closed_recently', closedAt: closedAt, dueAt: dueAt };
  }

  function skipResult(reason) {
    return { action: 'skip', round: -1, route: 'none', reason: reason };
  }

  function waitResult(reason, extra) {
    var out = { action: 'wait', round: -1, route: 'none', reason: reason };
    if (extra) {
      if (extra.waitLeftMs != null) out.waitLeftMs = extra.waitLeftMs;
      if (extra.nextRound) out.nextRound = true;
    }
    return out;
  }

  /**
   * 守箱动作判定。
   * @param {Object} input
   * @param {Object} input.entry 目标台账条目（round/iceSentAt/adSentAt/adBubbleOk/kickCount/done…）
   * @param {Array<string>} input.peerTexts 会话中对方气泡文本
   * @param {boolean} [input.replyKnown] 之前已确认过对方回复（本拍无新文本时用于广告重试）
   * @param {boolean} [input.hasOwnBubble] 会话里是否已出现我方气泡（用于修台账，不重复破冰）
   * @param {boolean} [input.identityOk] 会话身份是否已正向证明
   * @param {number} [input.age] 解析出的年龄
   * @param {string} [input.jobIntent] job 模式意向 yes/no/unknown
   * @param {number} [input.now]
   * @param {Object} [input.opts] { twoSeg, ageRejectBelow, jobMode }
   * @returns {{action:'send'|'skip'|'wait', round:number, route:string, reason:string, waitLeftMs?:number}}
   */
  function decideInboxAction(input) {
    input = input || {};
    var opts = input.opts || {};
    // 兼容两种调用：now 放顶层或放 opts（运行时状态机放在 opts）
    var now = num(input.now) || num(opts.now) || Date.now();
    var entry = input.entry || {};
    var peerTexts = Array.isArray(input.peerTexts) ? input.peerTexts : [];
    var twoSeg = opts.twoSeg !== false;
    var kickGapMs = (opts.kickGapMs == null)
      ? INBOX_KICK_GAP_MS
      : Math.max(0, Number(opts.kickGapMs) || 0);
    var finalKickGapMs = (opts.finalKickGapMs == null)
      ? kickGapMs
      : Math.max(0, Number(opts.finalKickGapMs) || 0);
    var pulseSeq = num(opts.pulseSeq);
    var ageRejectBelow = num(opts.ageRejectBelow);
    var jobMode = !!opts.jobMode;
    var age = (input.age === undefined || input.age === null) ? null : Number(input.age);
    var jobIntent = input.jobIntent || 'n/a';
    var identityOk = input.identityOk !== false;
    var hasOwnBubble = !!input.hasOwnBubble;
    var hasReply = peerTexts.length > 0 || !!input.replyKnown;

    if (!identityOk) return skipResult('identity_pending');

    // 收口后真的又收到消息（revived）→ 按广告段重开一轮：
    // 有回复就按年龄分流后发广告，没有回复就等。
    // 与 inbox-state.planAction 的 reopened 分支保持一致。
    if (isFullyClosed(entry) && opts.reopened) {
      // 与 inbox-state.planAction 一致：最后一条仍是我方 = 没有收口后的新入站。
      if (opts.lastBubbleDirection === 'own') {
        return skipResult('reopen_no_new_peer_last');
      }
      if (hasReply) return adOrReject('reopen_inbound');
      return waitResult('reopen_await_reply');
    }
    if (isFullyClosed(entry)) return skipResult('stage_closed');
    if (isExpiredNoReply(entry, now)) return skipResult('expired_3d_no_reply');

    var iceAt = num(entry.iceSentAt);
    var adDone = !!entry.adBubbleOk || num(entry.adSentAt) > 0;
    var adAt = num(entry.adSentAt);
    var kickAt = num(entry.kickSentAt);

    // 与运行时 inbox-state.planAction 的 adOrReject 必须逐字一致：
    // 约会池只按年龄；兼职池按意向。对方先来信也不能绕过这一步。
    function adOrReject(reasonWhenAd) {
      if (jobMode) {
        if (jobIntent === 'no') return sendResult(1, 'reject', 'job_intent_no');
        return sendResult(1, 'ad', jobIntent === 'yes' ? 'job_yes' : 'job_reply');
      }
      if (age !== null && ageRejectBelow && age < ageRejectBelow) {
        return sendResult(1, 'reject', 'age_below_' + ageRejectBelow);
      }
      return sendResult(1, 'ad', reasonWhenAd);
    }

    // A. 破冰段：台账没记 iceSentAt
    // 阶段只由台账标志推导（与 inbox-state.normalizeEntry 一致），不看 round。
    if (!iceAt) {
      if (adDone) return skipResult('ad_already_sent');
      // 破冰只能从粉丝列表发起：守箱不补破冰、也不因为对方先来信就发广告。
      return skipResult('ice_via_roster_only');
    }

    // B. 广告段（破冰已发、广告未发）
    if (!adDone) {
      if (hasReply) return adOrReject(age !== null ? 'age_ok' : 'age_unknown_ad');
      // 4.9.132：两段式也不能用等待时间替代回复证据。
      // 没有对方回复就只等，超过 3 天按 expired_3d_no_reply 过期。
      return waitResult('await_reply');
    }

    // C. 催加段（广告已发、未完结）
    if (twoSeg) return skipResult('stage_closed');
    var kc = kickCountOf(entry);
    if (kc >= KICK_MAX_COUNT) return skipResult('stage_closed');
    // 与 inbox-state.planAction 逐字一致：广告后没有新回复，不发第一次催加；
    // 第一次催加后没有新回复，不发终催。
    var kickAnchor = kc >= 1 ? kickAt : adAt;
    if (!hasInboundAfter(entry, kickAnchor, peerTexts)) {
      return waitResult('await_reply');
    }
    var lastSeq = kc >= 1 ? num(entry.kickPulseSeq) : num(entry.adPulseSeq);
    if (pulseSeq && lastSeq && pulseSeq <= lastSeq) {
      return waitResult('kick_wait', { nextRound: true });
    }
    var since = kc >= 1 ? kickAt : adAt;
    var needGap = kc >= 1 ? finalKickGapMs : kickGapMs;
    if (needGap && since) {
      var left = needGap - (now - since);
      if (left > 0) return waitResult('kick_wait', { waitLeftMs: left });
    }
    return sendResult(2, 'kick', 'kick_ready');
  }

  /**
   * 会话候选优先级。
   * 第一判据是「列表最后一条是谁说的」，不是台账 replySeenAt：
   *  1. 对方最后发言 + 未读（最新、最该回）
   *  2. 对方最后发言（可能已读，但还没处理）
   *  3. 我方最后发言，但台账有到期债（广告/催加）→ 需要打开执行动作
   *  4. 我方最后发言且无债 → 视为已回复，不打开
   *  5. 列表预览缺失 → 只有未读/台账债/探测到期才打开
   */
  function candidatePriority(item) {
    if (!item) return 99;
    if (item.excluded) return 99;
    if (item.closed && !item.revived) return 99;
    if (item.revived) return 0;
    // 没有 handle、peerId 也反查不到台账的行只能做一次身份探测；
    // 它不能排在真正已登记客户的回复前面，否则一屏陌生私信会把队列占满。
    if (item.unboundProbe) return 6;
    // 历史校准是“补作业”，不能压过已登记客户的回复(2)和到期广告/催加(3)，
    // 否则十几条老粉会把刚破冰、马上该发广告的人挤到十几分钟后。
    if (item.noIceProbe) return 4;
    var debt = !!(item.adDebt || item.kickReady);
    var ownLast = item.lastSpeaker === 'own' || item.lastSpeaker === 'draft';
    // 我方最后发言 = 已经回过；没有任何到期动作时不再打开，避免反复标已读。
    if (ownLast && !debt && !item.unread) return 99;
    // 冷却只压「没有台账待办」的复查；广告债/催加到点必须放行。
    if (item.cooldown && !item.unread && !debt) return 99;
    if (item.unread && item.lastSpeaker === 'peer') {
      return item.unreadPrecise ? 0 : 1;
    }
    if (item.unread) return 1;
    if (item.lastSpeaker === 'peer') return 2;
    if (debt) return 3;
    if (item.probeable) return 5;
    return 6;
  }

  /** 排序并剔除 closed/cooldown；返回新数组，不改原数组 */
  function sortInboxCandidates(items) {
    var list = Array.isArray(items) ? items : [];
    var kept = [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item) continue;
      var p = candidatePriority(item);
      if (p >= 99) continue;
      kept.push({ item: item, priority: p, index: i });
    }
    kept.sort(function (a, b) {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.index - b.index;
    });
    var out = [];
    for (var k = 0; k < kept.length; k++) {
      kept[k].item.priority = kept[k].priority;
      out.push(kept[k].item);
    }
    return out;
  }

  window.SgInboxDecision = {
    DEFAULT_AD_MIN_WAIT_MS: DEFAULT_AD_MIN_WAIT_MS,
    KICK_MAX_COUNT: KICK_MAX_COUNT,
    INBOX_KICK_GAP_MS: INBOX_KICK_GAP_MS,
    RENDER_FAIL_LIMIT: RENDER_FAIL_LIMIT,
    RENDER_FAIL_COOLDOWN_MS: RENDER_FAIL_COOLDOWN_MS,
    RENDER_RETRY_WAIT_MS: RENDER_RETRY_WAIT_MS,
    INBOX_CLOSED_RECHECK_MS: INBOX_CLOSED_RECHECK_MS,
    kickCountOf: kickCountOf,
    isFullyClosed: isFullyClosed,
    isHardClosed: isHardClosed,
    inboxClosedVerdict: inboxClosedVerdict,
    closedAtOf: closedAtOf,
    decideClosedReopen: decideClosedReopen,
    replyVerdict: replyVerdict,
    identityProof: identityProof,
    renderCooling: renderCooling,
    identityCooling: identityCooling,
    inboxClosedRecheck: inboxClosedRecheck,
    decideInboxAction: decideInboxAction,
    candidatePriority: candidatePriority,
    sortInboxCandidates: sortInboxCandidates
  };
})();

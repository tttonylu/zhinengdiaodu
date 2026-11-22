// =============================================================================
// TEST COPY ONLY · Inbox target state machine (pure, no DOM)
// 唯一真相：由台账标志推导阶段，再由阶段决定动作。
// 不再让 round / done 这些容易写乱的字段互相干扰。
// =============================================================================
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.SgInboxState) return;

  var STAGES = {
    ICE: 'ice',
    AD: 'ad',
    KICK1: 'kick1',
    KICK2: 'kick2',
    CLOSED: 'closed'
  };

  // 催加由“轮询轮次”驱动：同一轮只对同一会话做一步，下一轮轮询到它时才发。
  // 脉冲一拍默认 60 秒；这里的时间下限 = 一拍，避免“连续两次催加只隔 8 秒”。
  // 业务口径：下一次轮询，而不是同一个积压排水窗口里连发两步。
  var DEFAULT_KICK_GAP_MS = 60 * 1000;
  var NO_REPLY_EXPIRY_MS = 3 * 24 * 60 * 60 * 1000;

  function num(v) {
    var n = Number(v);
    return isFinite(n) && n > 0 ? n : 0;
  }

  /** 台账里最后一次可证明的对方入站时间。 */
  function lastInboundOf(entry) {
    var e = entry || {};
    return Math.max(
      num(e.lastInboundAt),
      num(e.replySeenAt),
      num(e.unreadSeenAt),
      num(e.lastNonTextInboundAt)
    );
  }

  /**
   * 后续催加必须证明“上一条我方消息之后对方又说过话”。
   * 只在冰点时回过一句，不足以支撑广告后的两次追发。
   */
  function hasInboundAfter(entry, anchor, texts) {
    if (Array.isArray(texts) && texts.length > 0) return true;
    var at = num(anchor);
    return !!(at && lastInboundOf(entry) > at);
  }

  function intOr(v, fallback) {
    var n = parseInt(v, 10);
    if (!isNaN(n) && n >= 0) return n;
    return fallback || 0;
  }

  /**
   * 无回复过期：最后一次我方主动消息超过 3 天，且之后没有任何对方入站证据。
   * 只按台账时间判断，不依赖队列/轮次；这样 OPS 里很旧的 pending 也不会被反复唤起。
   */
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

  /**
   * 超过 3 天没有任何往来（我方或对方最后一条消息都算活动）→ 过期。
   * 旧口径只在我方最后一条过期且对方没回时才失效，导致「对方很久以前
   * 回过一句、之后双方都没再说话」的会话会一直留在队列里，反复被打开。
   */
  function isExpiredStale(entry, now) {
    var e = entry || {};
    now = num(now) || Date.now();
    var lastAny = Math.max(
      num(e.lastDM),
      num(e.iceSentAt),
      num(e.iceAt),
      num(e.adSentAt),
      num(e.adAt),
      num(e.kickSentAt),
      num(e.kickAt),
      num(e.finalKickSentAt),
      num(e.twoSegAdDoneAt),
      num(e.lastInboundAt),
      num(e.replySeenAt),
      num(e.unreadSeenAt),
      num(e.lastNonTextInboundAt)
    );
    if (!lastAny) return false;
    return (now - lastAny) > NO_REPLY_EXPIRY_MS;
  }

  /**
   * 从台账标志推导阶段（唯一真相）。
   * @param {Object} entry
   * @param {Object} opts { twoSeg }
   */
  function normalizeEntry(entry, opts) {
    var e = entry || {};
    var twoSeg = !(opts && opts.twoSeg === false);
    var iceAt = num(e.iceSentAt);
    var adAt = num(e.adSentAt);
    var adOk = !!e.adBubbleOk || adAt > 0;
    var kickCount = intOr(e.kickCount, e.kickSentAt ? 1 : 0);
    var rejected = !!e.rejectSentAt;
    // 两种模式对“收口”的定义不同，不能共用同一个 chatClosedAt：
    //   两段式：发完含 LINE 的广告就收口（twoSegAdDoneAt + chatClosedAt）
    //   非两段式：广告后还要催加两次，第二次终催才收口
    // 旧数据在切换模式后仍带着两段式的 chatClosedAt；如果继续把它当“已收口”，
    // 对方回了年龄也永远只得到 stage_closed —— 现场表现为“大量未回复”。
    var hardClosed = !!(e.blockedAt || e.rejectSentAt || e.finalKickSentAt);
    var chatClosed = num(e.chatClosedAt) > 0;
    var twoSegOnlyClose = !!num(e.twoSegAdDoneAt) && !hardClosed;
    var blocked = hardClosed || (twoSeg
      ? (chatClosed || twoSegOnlyClose)
      : (chatClosed && !twoSegOnlyClose));
    var stage;

    if (rejected || blocked) stage = STAGES.CLOSED;
    else if (!iceAt) stage = STAGES.ICE;
    else if (!adOk) stage = STAGES.AD;
    else if (twoSeg) stage = STAGES.CLOSED;
    else if (kickCount >= 2) stage = STAGES.CLOSED;
    else if (kickCount === 0) stage = STAGES.KICK1;
    else stage = STAGES.KICK2;

    var round = stage === STAGES.ICE ? 0
      : stage === STAGES.AD ? 1
        : stage === STAGES.CLOSED ? 3 : 2;

    return {
      stage: stage,
      round: round,
      kickCount: kickCount,
      iceAt: iceAt,
      adAt: adAt,
      kickAt: num(e.kickSentAt),
      lastDM: num(e.lastDM),
      lastInboundAt: num(e.lastInboundAt),
      replySeenAt: num(e.replySeenAt),
      unreadSeenAt: num(e.unreadSeenAt),
      lastNonTextInboundAt: num(e.lastNonTextInboundAt),
      finalKickSentAt: num(e.finalKickSentAt),
      twoSegAdDoneAt: num(e.twoSegAdDoneAt),
      adPulseSeq: intOr(e.adPulseSeq, 0),
      kickPulseSeq: intOr(e.kickPulseSeq, 0),
      // 收口后重新开了第几轮（0 = 从未复活）。OPS 轮次需要用它把
      // 第二轮对话映射到 5/6/7，不能又写 2/3/4（会被唯一键吞掉）。
      reopenCycleSeq: intOr(e.reopenCycleSeq, 0),
      adOk: adOk,
      rejected: rejected,
      blocked: blocked,
      twoSeg: twoSeg,
      closed: stage === STAGES.CLOSED
    };
  }

  /** 台账写回补丁：把推导出的阶段落回 round/done，保持字段一致 */
  function stagePatch(state) {
    var stage = state.stage;
    return {
      round: state.round,
      done: stage === STAGES.CLOSED,
      chatClosedAt: stage === STAGES.CLOSED ? Date.now() : 0,
      kickCount: state.kickCount,
      stage: stage
    };
  }

  /**
   * 决策：由阶段 + 对方发言 + 年龄决定动作。
   * @returns {{action:'send'|'wait'|'skip', stage:string, route:string, round:number, reason:string}}
   */
  function planAction(state, peerTexts, opts) {
    opts = opts || {};
    var texts = Array.isArray(peerTexts) ? peerTexts : [];
    // replyKnown：对方之前回过、但这一拍已经没有“新文本”（例如上一拍广告
    // 发送失败要重试）。没有这个证据时，绝不因为“等够 60 秒”就发广告。
    var hasReply = texts.length > 0 || !!opts.replyKnown;
    var age = (opts.age === undefined || opts.age === null) ? null : Number(opts.age);
    var rejectBelow = num(opts.ageRejectBelow);
    var jobMode = !!opts.jobMode;
    var jobIntent = opts.jobIntent || 'n/a';
    var now = num(opts.now) || Date.now();
    var kickGapMs = (opts.kickGapMs == null)
      ? DEFAULT_KICK_GAP_MS
      : Math.max(0, Number(opts.kickGapMs) || 0);
    var finalKickGapMs = (opts.finalKickGapMs == null)
      ? kickGapMs
      : Math.max(0, Number(opts.finalKickGapMs) || 0);
    var pulseSeq = num(opts.pulseSeq);

    function send(route, round, reason) {
      return { action: 'send', stage: state.stage, route: route, round: round, reason: reason };
    }
    function wait(reason, extra) {
      var out = { action: 'wait', stage: state.stage, route: 'none', round: state.round, reason: reason };
      if (extra && extra.waitLeftMs != null) out.waitLeftMs = Math.max(0, extra.waitLeftMs);
      if (extra && extra.nextRound) out.nextRound = true;
      return out;
    }
    function skip(reason) {
      return { action: 'skip', stage: state.stage, route: 'none', round: state.round, reason: reason };
    }
    // 广告段唯一的业务分流：约会池只按年龄；兼职池按意向。
    // 对方先来信时也必须走这里，不能绕过年龄判断直接发广告。
    function adOrReject(reasonWhenAd) {
      if (jobMode) {
        if (jobIntent === 'no') return send('reject', 1, 'job_intent_no');
        return send('ad', 1, jobIntent === 'yes' ? 'job_yes' : 'job_reply');
      }
      if (age !== null && rejectBelow && age < rejectBelow) {
        return send('reject', 1, 'age_below_' + rejectBelow);
      }
      return send('ad', 1, reasonWhenAd);
    }

    // 收口后又收到真回复（revived）：这不是“没关系的人”，而是新的一轮对话。
    // 旧逻辑一律 stage_closed，导致对方明明回了「40です」也永远不回，
    // 并且在读过之后写 reopenedAt，之后每拍都判 already_surfaced，彻底漏掉。
    // 新口径：收口后的新入站按“广告段”重新走一遍——有回复就按年龄分流后发广告，
    // 广告发出即重新开一轮（清掉终催/收口标记）。
    if (state.closed && opts.reopened) {
      // 复活的前提必须是“对方真的又说话了”。会话历史上有过对方气泡，
      // 不等于收口后又有新入站；若最后一条仍是我方，禁止补发广告。
      if (opts.lastBubbleDirection === 'own') {
        return skip('reopen_no_new_peer_last');
      }
      if (hasReply) return adOrReject('reopen_inbound');
      return wait('reopen_await_reply');
    }
    if (state.closed) return skip('stage_closed');
    if (isExpiredNoReply(state, now)) {
      return skip('expired_3d_no_reply');
    }
    if (isExpiredStale(state, now)) {
      return skip('expired_3d_stale');
    }

    if (state.stage === STAGES.ICE) {
      // 破冰只能从粉丝列表发起：守箱打开一个没破冰的会话时，什么都不能发。
      // 对方先来信也一样——没有破冰就不进入广告/婉拒分支。
      // 例外：台账没有 iceSentAt、但广告痕迹已经存在（旧数据/补认场景），
      // 与契约侧返回同一个结论，避免同一份台账两边给出不同原因。
      if (state.adOk) return skip('ad_already_sent');
      return skip('ice_via_roster_only');
    }

    if (state.stage === STAGES.AD) {
      // 年龄读不出来也照常发广告（业务口径），但原因要单独标出来，便于 OPS 区分。
      if (hasReply) return adOrReject(age !== null ? 'age_ok' : 'age_unknown_ad');
      // 4.9.132：两段式同样必须先有对方回复，等待时间不能替代回复证据。
      // 破冰只是打招呼，对方没接话还继续推 LINE 会被当成骚扰；
      // 这类目标等 3 天按 expired_3d_no_reply 过期清掉。
      return wait('await_reply');
    }

    if (state.stage === STAGES.KICK1 || state.stage === STAGES.KICK2) {
      // 4.9.133：没有新的对方回复，不再发广告后的催加。
      // 第一次催加必须晚于广告；第二次催加必须晚于第一次催加。
      // 只在破冰后回过一句、广告发出后一直没动静的目标，直接等过期，
      // 不能靠“到点了”连续追发两条。
      var kickAnchor = state.stage === STAGES.KICK1 ? state.adAt : state.kickAt;
      if (!hasInboundAfter(state, kickAnchor, texts)) {
        return wait('await_reply');
      }
      // 轮次闸：上一动作发生在同一轮 → 本轮不再发，等下一轮轮询到它
      var lastSeq = state.stage === STAGES.KICK1 ? state.adPulseSeq : state.kickPulseSeq;
      if (pulseSeq && lastSeq && pulseSeq <= lastSeq) {
        return wait('kick_wait', { nextRound: true });
      }
      // 可选时间下限（OPS 配了分钟数才生效；默认 0 = 不设）
      var since = state.stage === STAGES.KICK1 ? state.adAt : state.kickAt;
      var needGap = state.stage === STAGES.KICK1 ? kickGapMs : finalKickGapMs;
      if (needGap && since) {
        var left = needGap - (now - since);
        if (left > 0) return wait('kick_wait', { waitLeftMs: left });
      }
      return send('kick', 2, 'kick_ready');
    }

    return skip('unknown_stage');
  }

  /**
   * 发送成功后的台账补丁。
   * @param {Object} state 发送前的状态
   * @param {string} route ice|ad|reject|kick
   * @param {number} now
   */
  function afterSend(state, route, now, opts) {
    var t = num(now) || Date.now();
    var patch = {};
    var isReopen = !!(opts && opts.reopened);
    // 已完结的对话不允许被“补发/误发”回退到未完结：
    // 否则重复破冰会把 round 从 3 打回 1、清掉 chatClosedAt，随后可能再发一次广告。
    // 例外：对方在收口后真的又发来消息（reopened），这是新的对话轮次，
    // 必须允许本次发送把终催/收口标记清掉，否则下一拍又判 stage_closed。
    if (state && state.closed && !isReopen) return patch;
    if (isReopen) {
      // 开新一轮：保留破冰与广告历史，清掉“已收口/已终催/已拒绝”的终态。
      // 只清终催标记（finalKickSentAt / kickCount / chatClosedAt），
      // 坚决不清 rejectSentAt / blockedAt：真婉拒与拉黑永远不能复活。
      patch.finalKickSentAt = 0;
      patch.kickCount = 0;
      patch.kickSentAt = 0;
      patch.chatClosedAt = 0;
      patch.done = false;
      patch.reopenedAt = 0;
      patch.reopenedPreview = '';
      patch.reopenRetryAt = 0;
      patch.reopenRetryReason = '';
      patch.reopenCycleAt = t;
      patch.reopenCycleSeq = (Number(state && state.reopenCycleSeq) || 0) + 1;
    }
    if (route === 'ice') {
      patch.iceSentAt = t;
      patch.round = 1;
      patch.done = false;
      patch.chatClosedAt = 0;
    } else if (route === 'ad') {
      patch.adSentAt = t;
      patch.adBubbleOk = 1;
      patch.round = state.twoSeg ? 3 : 2;
      patch.done = !!state.twoSeg;
      patch.chatClosedAt = state.twoSeg ? t : 0;
      if (state.twoSeg) patch.twoSegAdDoneAt = t;
    } else if (route === 'reject') {
      patch.rejectSentAt = t;
      patch.done = true;
      patch.round = 3;
      patch.chatClosedAt = t;
    } else if (route === 'kick') {
      var kc = (state.kickCount || 0) + 1;
      patch.kickCount = kc;
      patch.kickSentAt = t;
      patch.round = 2;
      if (kc >= 2) {
        patch.done = true;
        patch.round = 3;
        patch.chatClosedAt = t;
        patch.finalKickSentAt = t;
      } else {
        patch.done = false;
        patch.chatClosedAt = 0;
      }
    }
    return patch;
  }

  /**
   * OPS dm_records 的轮次口径：
   *   1 = 破冰，2 = 广告 / 婉拒，3 = 首次催加（盾牌），4 = 终催。
   * 第二次催加必须单独占 4：OPS 对 success 轮次有
   * (bot, target, round) 唯一键，复用 3 会被当作 round_duplicate 吞掉，
   * 结果就是本地已发终催、OPS 台账里却永远没有这一条。
   *
   * @param {string} route ice|ad|reject|kick
   * @param {number} kickCountAfter 本条发完后的本地 kickCount（1=首次，2=终催）
   */
  function opsRoundForSend(route, kickCountAfter) {
    if (route === 'ice') return 1;
    if (route === 'kick') return num(kickCountAfter) >= 2 ? 4 : 3;
    return 2;
  }

  /**
   * 从本地台账推导“它应该已经在 OPS 里到第几轮”。
   *   4 = 终催已发（kickCount>=2 / finalKickSentAt）
   *   3 = 首次催加已发（kickSentAt / kickCount>=1）
   *   2 = 广告或婉拒已发
   *   1 = 破冰已发
   *   0 = 本地没有任何发送证据，不能凭 OPS 反向造账
   */
  function localOpsRound(entry) {
    if (!entry) return 0;
    if (entry.finalKickSentAt || num(entry.kickCount) >= 2) return 4;
    if (entry.kickSentAt || num(entry.kickCount) >= 1) return 3;
    if (entry.adSentAt || entry.adBubbleOk) return 2;
    if (entry.iceSentAt) return 1;
    return 0;
  }

  /**
   * 本地已推进、OPS 缺账的补记目标（只读选择，不发请求）。
   * 规则：
   *  - 本地必须有发送证据（localOpsRound>0）；
   *  - 本地轮次必须高于 OPS 已知轮次；
   *  - 已经补记成功过（opsReconciledRound）的不再重复。
   * 排序：轮次高的先补（终催 > 首次催加 > 广告 > 破冰），同轮次按最近发送时间。
   */
  function pendingOpsReconcile(db, opsMap, opts) {
    opts = opts || {};
    var limit = Math.max(1, Math.min(20, opt_int(opts.limit, 5)));
    var out = [];
    if (!db || typeof db !== 'object') return out;
    opsMap = opsMap && typeof opsMap === 'object' ? opsMap : {};
    for (var h in db) {
      if (!Object.prototype.hasOwnProperty.call(db, h)) continue;
      var e = db[h];
      if (!e || typeof e !== 'object') continue;
      var want = localOpsRound(e);
      if (want <= 0) continue;
      var key = String(h || '').replace(/^@/, '').replace(/#guard$/i, '').toLowerCase().trim();
      var have = num(opsMap[key] || opsMap[h]) || 0;
      var acked = num(e.opsReconciledRound) || 0;
      if (want <= have || want <= acked) continue;
      // 补记连续失败到上限后隔离：OPS 侧缺前轮且补不进去（例如早期轮次
      // 在 OPS 已不可重建）时，否则会每 4 分钟重试同一条，永远刷失败事件。
      if (num(e.opsReconcileGiveUpAt)) continue;
      out.push({
        handle: key || h,
        round: want,
        ops_round: have,
        attempts: num(e.opsReconcileAttempts) || 0,
        last_at: num(e.finalKickSentAt) || num(e.kickSentAt) || num(e.adSentAt) || num(e.iceSentAt)
      });
    }
    out.sort(function (a, b) {
      if (a.round !== b.round) return b.round - a.round;
      return b.last_at - a.last_at;
    });
    return out.slice(0, limit);
  }

  function opt_int(v, fallback) {
    var n = parseInt(v, 10);
    return !isNaN(n) && n > 0 ? n : fallback;
  }

  window.SgInboxState = {
    STAGES: STAGES,
    DEFAULT_KICK_GAP_MS: DEFAULT_KICK_GAP_MS,
    NO_REPLY_EXPIRY_MS: NO_REPLY_EXPIRY_MS,
    isExpiredNoReply: isExpiredNoReply,
    isExpiredStale: isExpiredStale,
    normalizeEntry: normalizeEntry,
    stagePatch: stagePatch,
    planAction: planAction,
    afterSend: afterSend,
    opsRoundForSend: opsRoundForSend,
    localOpsRound: localOpsRound,
    pendingOpsReconcile: pendingOpsReconcile
  };
})();

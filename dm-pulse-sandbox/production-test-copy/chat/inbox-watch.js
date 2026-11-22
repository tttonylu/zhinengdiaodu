// =============================================================================
// C3 · 回复扫描 / 收件箱守箱
// 工作指导：预览差集、未读、会话检测；禁止关注点击 / 调度 priority
//
// 本文件已拥有：差集硬门 + 列表行分析/pickActionableInboxRows
// runInboxWatchTick 编排仍由 content_chat register（依赖 completeChatRound/chatGo 等）
// =============================================================================
(function () {
  'use strict';
  if (typeof window !== 'undefined' && window.__sg_inbox_watch_loaded__) return;
  if (typeof window !== 'undefined') window.__sg_inbox_watch_loaded__ = true;

  var hooks = {
    normalizeChatHandle: null,
    getDefaultLinks: null,
    getOwnScriptCorpus: null,
    rebuildOwnScriptCorpus: null,
    getHandleSentScriptTexts: null,
    getDnaCore: null,
    collectPeerDmMessages: null,
    fallbackCollectPeerDmTexts: null,
    getDmConversationRoot: null,
    isSystemDmLine: null,
    isProfileUiLine: null,
    isDmChromeNoise: null,
    findBottomAwakeningTarget: null,
    findDmSendButton: null,
    loadTargetDB: null,
    saveTargetDB: null,
    ensureChatFreeze: null,
    getDB: null,
    getInboxDoneList: null,
    isChatTargetAllowed: null,
    canProbeInboxTarget: null,
    canSendKickNow: null,
    normalizeDisplayName: null,
    getOpsMaxRound: null,
    reportChatMetric: null,
    getUrlDmPeerId: null,
    getConversationHeaderHandle: null,
    assertDmConversationMatchesTarget: null
  };

  var registered = {};

  function callHook(name) {
    var fn = hooks[name];
    if (typeof fn !== 'function') return undefined;
    var args = Array.prototype.slice.call(arguments, 1);
    try {
      return fn.apply(null, args);
    } catch (e) {
      return undefined;
    }
  }

  function bind(nextHooks) {
    if (!nextHooks) return api;
    Object.keys(hooks).forEach(function (k) {
      if (typeof nextHooks[k] === 'function') hooks[k] = nextHooks[k];
    });
    return api;
  }

  function register(apiMap) {
    if (!apiMap || typeof apiMap !== 'object') return api;
    Object.keys(apiMap).forEach(function (k) {
      if (typeof apiMap[k] === 'function') registered[k] = apiMap[k];
    });
    return api;
  }

  function callRegistered(name) {
    var fn = registered[name];
    if (typeof fn !== 'function') return undefined;
    var args = Array.prototype.slice.call(arguments, 1);
    try {
      return fn.apply(null, args);
    } catch (e) {
      console.warn('[C3] SgInboxWatch.' + name + ' error', e);
      return undefined;
    }
  }

  function inboxV2() {
    return (typeof window !== 'undefined' && window.SgInboxV2Adapter) || null;
  }

  function inboxRows() {
    var adapter = inboxV2();
    if (adapter && adapter.listRows) {
      try {
        var rows = adapter.listRows();
        if (rows && rows.length) return rows;
      } catch (eV2) {}
    }
    return document.querySelectorAll('[data-testid^="dm-conversation-item-"]');
  }

  function inboxRowIdentity(row) {
    var adapter = inboxV2();
    if (adapter) {
      try {
        if (adapter.resolvePeerId) return adapter.resolvePeerId(row, '');
        if (adapter.parseIds) return adapter.parseIds(row);
      } catch (eId) {}
    }
    var tid = row && row.getAttribute ? (row.getAttribute('data-testid') || '') : '';
    var m = tid.match(/dm-conversation-item-(\d+):(\d+)/);
    return { valid: !!m, peerId: m ? m[1] : '', myId: m ? m[2] : '' };
  }

  function inboxRowDisplayName(row, fallback) {
    var adapter = inboxV2();
    if (adapter && adapter.isV2Row && adapter.isV2Row(row) && adapter.rowDisplayName) {
      try { return adapter.rowDisplayName(row) || fallback; } catch (eDn) {}
    }
    return fallback;
  }

  /** 规范化后再比话术：去空白、去 URL、去 {LINK} */
  function normalizeForScriptMatch(text) {
    var s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    s = s.replace(/https?:\/\/\S+/gi, ' ');
    s = s.replace(/\{LINK\}/gi, ' ');
    s = s.replace(/\bline\.me\/\S+/gi, ' ');
    return s.replace(/\s+/g, ' ').trim();
  }

  /** 链接壳 / 推广预览碎片 → 本方衍生，不算对方额外回复 */
  function isLinkShellText(text) {
    var s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s) return true;
    if (/^https?:\/\/\S+$/i.test(s)) return true;
    if (/^(www\.)\S+$/i.test(s) && !/\s/.test(s)) return true;
    if (/^line\.me\b/i.test(s) && s.length < 96) return true;
    if (/line\.me\/R\/ti\/p\//i.test(s) && s.length < 160) return true;
    try {
      var links = callHook('getDefaultLinks') || [];
      for (var i = 0; i < links.length; i++) {
        var u = String(links[i] || '').trim();
        if (!u) continue;
        if (s === u || s.indexOf(u) >= 0) return true;
        try {
          var host = (u.match(/^https?:\/\/([^\/\s]+)/i) || [])[1];
          if (host && s.indexOf(host) >= 0 && s.length < 160) return true;
        } catch (eH) {}
      }
    } catch (eL) {}
    if (!normalizeForScriptMatch(s) && /https?:\/\/|line\.me/i.test(s)) return true;
    return false;
  }

  /**
   * 本方话术差集：是否可解释为「自己发过的内容」
   * 短话术(<8)仅整句全等；长话术允许包含/前缀；链接壳算本方；DNA≥3 兜底
   */
  function isOwnScriptText(text, handle) {
    var s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s) return true;
    if (isLinkShellText(s)) return true;
    var norm = normalizeForScriptMatch(s);
    if (!norm) return true;

    var corpus = callHook('getOwnScriptCorpus') || [];
    if (!corpus.length) {
      try {
        callHook('rebuildOwnScriptCorpus');
        corpus = callHook('getOwnScriptCorpus') || [];
      } catch (eR) {}
    }
    var extra = callHook('getHandleSentScriptTexts', handle) || [];
    var i;
    for (i = 0; i < extra.length; i++) {
      var en = normalizeForScriptMatch(extra[i]);
      if (!en) continue;
      if (en.length < 8) {
        if (norm === en) return true;
      } else {
        if (norm === en || norm.indexOf(en) >= 0 || en.indexOf(norm) >= 0) return true;
        var ep = en.slice(0, Math.min(12, en.length));
        if (ep.length >= 4 && norm.indexOf(ep) === 0) return true;
      }
    }
    for (i = 0; i < corpus.length; i++) {
      var ent = corpus[i];
      if (!ent || !ent.norm) continue;
      if (ent.short) {
        if (norm === ent.norm) return true;
        continue;
      }
      if (norm === ent.norm || norm.indexOf(ent.norm) >= 0) return true;
      if (ent.norm.length >= 12 && ent.norm.indexOf(norm) >= 0 && norm.length >= 12) return true;
      var n = ent.needle || '';
      if (n && n.length >= 4) {
        if (norm.indexOf(n) >= 0) return true;
        var prefix = n.slice(0, Math.min(12, n.length));
        if (prefix.length >= 4 && norm.indexOf(prefix) === 0) return true;
      }
    }
    var dna = callHook('getDnaCore') || [];
    var hit = 0;
    for (var j = 0; j < dna.length; j++) {
      if (dna[j] && s.indexOf(dna[j]) >= 0) hit++;
    }
    if (hit >= 3) return true;
    if (/line\.me\/R\/ti\/p\//i.test(s)) return true;
    return false;
  }

  function isLikelyOwnDmText(text, handle) {
    return isOwnScriptText(text, handle);
  }

  /** 面板差集：非本方、非系统壳、非链接壳的额外文本 = 有效回复候选
   *  4.1.17：默认不用 fallback 宽扫（防时间戳/句柄片段误跳破冰）；诊断可 opts.allowFallback=true
   */
  function collectExtraPeerTexts(handle, opts) {
    opts = opts || {};
    var allowFallback = opts.allowFallback === true;
    var normHandle = callHook('normalizeChatHandle', handle || sessionStorage.getItem('current_target') || '') || '';
    var msgs = [];
    try {
      msgs = callHook('collectPeerDmMessages') || [];
    } catch (eM) {
      msgs = [];
    }
    // 4.1.17：发送路径禁止 fallback；仅显式 allowFallback 时启用（诊断）
    var fromFallback = false;
    if (!msgs.length && allowFallback) {
      try {
        var root = callHook('getDmConversationRoot');
        var fb = callHook('fallbackCollectPeerDmTexts', root);
        if (fb && fb.length) { msgs = fb; fromFallback = true; }
      } catch (eF) {}
    }
    var out = [];
    var seen = {};
    for (var i = 0; i < msgs.length; i++) {
      var t = String((msgs[i] && msgs[i].text) || '').replace(/\s+/g, ' ').trim();
      if (!t || seen[t]) continue;
      if (typeof hooks.isDmChromeNoise === 'function') {
        if (callHook('isDmChromeNoise', t, normHandle)) continue;
      } else if (callHook('isSystemDmLine', t) || callHook('isProfileUiLine', t)) {
        continue;
      }
      // 4.6.33：主路径 collectPeerDmMessages 已做几何+DNA 混合分类（几何左=对方，即使文本像话术），
      // 此处再按文本二次过滤会把"对方引用/撞车前缀"的真回复误杀——文本兜底过滤只用于 fallback 宽扫
      if (fromFallback && (isLinkShellText(t) || isOwnScriptText(t, normHandle))) continue;
      // 极短噪声（非年龄数字等有效短回复仍可能 2 字；≤1 已在 chrome 拦）
      if (t.length < 2) continue;
      seen[t] = 1;
      out.push(t);
    }
    return out;
  }

  function detectDmReplyState(targetHandle) {
    var handle = callHook('normalizeChatHandle', targetHandle || sessionStorage.getItem('current_target') || '') || '';
    var texts = [];
    try {
      texts = collectExtraPeerTexts(handle);
    } catch (eEx) {
      texts = [];
    }
    var latest = texts.length ? texts[texts.length - 1] : '';
    var unreadSeen = false;
    var root = callHook('getDmConversationRoot');
    try {
      unreadSeen = !!(root && root.querySelector && (
        root.querySelector('[data-testid="unreadIndicator"]') ||
        root.querySelector('[aria-label*="未读" i]') ||
        root.querySelector('[aria-label*="未読" i]') ||
        root.querySelector('[aria-label*="Unread" i]') ||
        root.querySelector('[aria-label*="新消息" i]') ||
        root.querySelector('[data-testid*="unread" i]')
      ));
    } catch (eUnread) {}
    var sessionTarget = callHook('normalizeChatHandle', sessionStorage.getItem('current_target') || '') || '';
    var composerReady = false;
    try {
      var input = callHook('findBottomAwakeningTarget');
      // 与 step2 一致：有可用输入框即 ready；新版 X 空框时常无启用发送键
      composerReady = !!(input && !input.disabled);
    } catch (eComposer) {}
    var hasReply = texts.length > 0;
    var canSend = hasReply;
    var reason = 'none';
    // 会话身份：仅走 assertDmConversationMatchesTarget（正向证明；禁止 sessionTarget 双轨）
    var idOk = true;
    var idPending = false;
    try {
      var assertFn = hooks.assertDmConversationMatchesTarget;
      if (typeof assertFn === 'function') {
        var idr = assertFn(handle || sessionTarget);
        if (idr && idr.ok === false) {
          if (idr.reason === 'identity_pending' || idr.reason === 'no_target') idPending = true;
          else idOk = false;
        }
      } else {
        var headerH = callHook('normalizeChatHandle', callHook('getConversationHeaderHandle') || '') || '';
        var urlPid = String(callHook('getUrlDmPeerId') || '').replace(/\D/g, '');
        var db = callHook('loadTargetDB') || {};
        var dbPid = String(((db[handle] || {}).peerId) || '').replace(/\D/g, '');
        if (headerH && handle && headerH !== handle) idOk = false;
        else if (urlPid && dbPid && urlPid !== dbPid) idOk = false;
        else if (!(headerH && handle && headerH === handle) && !(urlPid && dbPid && urlPid === dbPid)) idPending = true;
      }
    } catch (eId) {}
    if (!idOk) reason = 'target_mismatch';
    else if (idPending) reason = 'identity_pending';
    else if (!texts.length) reason = unreadSeen ? 'unread_only' : 'no_reply';
    else if (!composerReady) reason = 'composer_not_ready';
    else reason = 'reply_detected';
    return {
      target: targetHandle || '',
      texts: texts,
      latest: latest,
      hasReply: hasReply,
      unreadSeen: unreadSeen,
      source: texts.length ? 'extra_diff' : (unreadSeen ? 'unread_indicator' : 'none'),
      composerReady: composerReady,
      canSend: canSend,
      decision: reason,
      extraCount: texts.length
    };
  }

  // ========== 列表行分析 / pickActionableInboxRows ==========
  // 4.9.15：X 中文界面用「你:」标记我方消息，之前漏了这一条，
  // 只能靠话术池兜底，自动翻译一介入就会把「我方消息」误判成「对方回复」。
  var INBOX_PREVIEW_SELF_PREFIX_RE = /^(You:|You sent|Me:|我[:：]?|你[:：]|あなた:|送信済|已发送|Sent|草稿[:：]|Draft[:：]|下書き[:：])/i;
  var INBOX_PREVIEW_DRAFT_PREFIX_RE = /^(草稿|Draft|下書き)[:：]\s*/i;
  var DM_UNREAD_LABEL_RE = /未读|未読|Unread|新消息|new message|message unread/i;
  var INBOX_ARIA_TIME_RE = /^(\d+\s*[smhdwy]|刚刚|刚才|今[天日]|昨[天日]|星期[一二三四五六日天]|Today|Yesterday|Just now|now)$/i;
  var INBOX_ARIA_UNREAD_TOKEN_RE = /^(Unread|未读|未読)$/i;
  var DM_TIMESTAMP_RE_LIST = /^(\d{1,2}:\d{2}(\s?(AM|PM|上午|下午))?|(上午|下午)\d{1,2}:\d{2}|昨[日天]|昨天|今天|今日|刚刚|稍后|saved)$/i;
  var SG_DM_UNREAD_SELECTORS_KEY = (typeof SKeys !== 'undefined' && SKeys.LK_DM_UNREAD_SELECTORS) ? SKeys.LK_DM_UNREAD_SELECTORS : 'sg_dm_unread_selectors';

  function loadInboxUnreadSelectors() {
    try {
      var raw = localStorage.getItem(SG_DM_UNREAD_SELECTORS_KEY);
      if (!raw) return { testids: [], ariaLabels: [] };
      var parsed = JSON.parse(raw);
      return {
        testids: Array.isArray(parsed.testids) ? parsed.testids : [],
        ariaLabels: Array.isArray(parsed.ariaLabels) ? parsed.ariaLabels : []
      };
    } catch (e) { return { testids: [], ariaLabels: [] }; }
  }

  function labelMatchesUnread(label) {
    return DM_UNREAD_LABEL_RE.test(String(label || ''));
  }

  function parseInboxAriaDescription(desc) {
    var out = { displayName: '', handle: '', preview: '', unread: false };
    var raw = String(desc || '').replace(/\s+/g, ' ').trim();
    if (!raw) return out;
    if (/\bUnread\b|未读|未読/i.test(raw)) out.unread = true;
    var parts = raw.split(',').map(function (p) { return String(p || '').trim(); }).filter(Boolean);
    while (parts.length) {
      var last = parts[parts.length - 1];
      if (INBOX_ARIA_UNREAD_TOKEN_RE.test(last) || /^Unread$/i.test(last)) {
        out.unread = true;
        parts.pop();
        continue;
      }
      if (INBOX_ARIA_TIME_RE.test(last) || DM_TIMESTAMP_RE_LIST.test(last)) {
        parts.pop();
        continue;
      }
      break;
    }
    if (parts.length >= 2 && /^@\S+/i.test(parts[1])) {
      out.displayName = parts[0];
      out.handle = callHook('normalizeChatHandle', parts[1]) || '';
      out.preview = parts.slice(2).join(', ').replace(/^[\s:：\-—]+/, '').trim();
    } else if (parts.length >= 3) {
      out.displayName = parts[0];
      out.preview = parts.slice(2).join(', ').replace(/^[\s:：\-—]+/, '').trim();
    } else if (parts.length) {
      out.preview = parts.join(', ');
    }
    return out;
  }

  function inboxRowHasVisibleSelfPrefix(row) {
    if (!row) return false;
    try {
      var lines = String(row.innerText || '').split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = String(lines[i] || '').replace(/\s+/g, ' ').trim();
        if (INBOX_PREVIEW_SELF_PREFIX_RE.test(line)) return true;
      }
    } catch (e) {}
    return false;
  }

  function isInboxPreviewFromSelf(preview) {
    var s = String(preview || '').replace(/\s+/g, ' ').trim();
    if (!s) return false;
    if (INBOX_PREVIEW_SELF_PREFIX_RE.test(s)) return true;
    try {
      if (isLikelyOwnDmText(s)) return true;
    } catch (eOwn) {}
    return false;
  }

  function scoreInboxPreview(text) {
    var s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s || callHook('isSystemDmLine', s)) {
      return { own: false, peer: false, unknown: true, confidence: 'unknown', dnaHits: 0 };
    }
    if (isLinkShellText(s) || isInboxPreviewFromSelf(s) || isOwnScriptText(s)) {
      return { own: true, peer: false, unknown: false, confidence: 'own', dnaHits: 0 };
    }
    var dna = callHook('getDnaCore') || [];
    var hit = 0;
    for (var j = 0; j < dna.length; j++) {
      if (dna[j] && s.indexOf(dna[j]) >= 0) hit++;
    }
    if (hit >= 3) {
      return { own: true, peer: false, unknown: false, confidence: 'own', dnaHits: hit };
    }
    if (hit >= 1) {
      return { own: false, peer: false, unknown: true, confidence: 'weak_peer', dnaHits: hit };
    }
    return { own: false, peer: true, unknown: false, confidence: 'strong_peer', dnaHits: hit };
  }

  function inboxPreviewIndicatesPeerReply(preview, previewData, previewScore) {
    if (!preview) return false;
    if (typeof hooks.isDmChromeNoise === 'function') {
      if (callHook('isDmChromeNoise', preview, '')) return false;
    } else if (callHook('isSystemDmLine', preview)) {
      return false;
    }
    if (isLinkShellText(preview) || isOwnScriptText(preview)) return false;
    if (previewData && previewData.fromSelf) return false;
    previewScore = previewScore || scoreInboxPreview(preview);
    return previewScore.confidence === 'strong_peer';
  }

  function getInboxRowUnread(row) {
    if (!row) return { unread: false, source: '', precise: false };
    // 深度扫描快照：DOM 行已被虚拟列表回收，未读状态必须在首次看到时冻结。
    if (row.__sgSnapshot) {
      return row.unreadInfo || { unread: false, source: '', precise: false };
    }
    var adapter = inboxV2();
    if (adapter && adapter.isV2Row && adapter.isV2Row(row) && adapter.rowUnread) {
      try {
        var v2u = adapter.rowUnread(row);
        // V2 适配器只认 icon-circle-fill；新版常见右侧纯视觉蓝点，
        // 未命中时必须继续往下走视觉兜底，不能直接 return false
        if (v2u && v2u.unread) return v2u;
      } catch (eV2Unread) {}
    }
    try {
      if (row.querySelector('[data-testid="unreadIndicator"]')) {
        return { unread: true, source: 'unreadIndicator', precise: true };
      }
      var unreadNodes = row.querySelectorAll('[data-testid*="unread" i]');
      for (var ui = 0; ui < unreadNodes.length; ui++) {
        var utid = unreadNodes[ui].getAttribute('data-testid') || '';
        if (utid) return { unread: true, source: 'testid:' + utid, precise: utid === 'unreadIndicator' };
      }
      try {
        var ariaDesc = (row.getAttribute && row.getAttribute('aria-description')) || '';
        if (/\bUnread\b|未读|未読/i.test(ariaDesc)) {
          return { unread: true, source: 'aria-description:Unread', precise: true };
        }
      } catch (eAria) {}
      var labeled = row.querySelectorAll('[aria-label]');
      for (var li = 0; li < labeled.length; li++) {
        var al = labeled[li].getAttribute('aria-label') || '';
        if (labelMatchesUnread(al)) {
          return { unread: true, source: 'aria-label:' + al.slice(0, 48), precise: true };
        }
      }
      var statuses = row.querySelectorAll('[role="status"]');
      for (var si = 0; si < statuses.length; si++) {
        var sal = statuses[si].getAttribute('aria-label') || '';
        if (labelMatchesUnread(sal)) {
          return { unread: true, source: 'status:' + sal.slice(0, 48), precise: true };
        }
      }
      var cached = loadInboxUnreadSelectors();
      for (var ct = 0; ct < cached.testids.length; ct++) {
        var cSel = cached.testids[ct];
        if (cSel && row.querySelector('[data-testid="' + cSel + '"]')) {
          return { unread: true, source: 'cached-testid:' + cSel, precise: true };
        }
      }
      for (var ca = 0; ca < cached.ariaLabels.length; ca++) {
        var cLabel = cached.ariaLabels[ca];
        if (!cLabel) continue;
        for (var lj = 0; lj < labeled.length; lj++) {
          var rowAl = labeled[lj].getAttribute('aria-label') || '';
          if (rowAl.indexOf(cLabel) >= 0) {
            return { unread: true, source: 'cached-aria:' + cLabel.slice(0, 48), precise: true };
          }
        }
      }
      // 行本身 aria-label 带未读
      try {
        var rowAl = (row.getAttribute && (row.getAttribute('aria-label') || '')) || '';
        if (labelMatchesUnread(rowAl)) {
          return { unread: true, source: 'row-aria-label', precise: true };
        }
      } catch (eRowAl) {}
      // class 名带 unread 的角标（部分 A/B 版本）
      try {
        if (row.querySelector('[class*="unread" i]')) {
          return { unread: true, source: 'class-unread', precise: false };
        }
      } catch (eCls) {}
      // 新版 /i/chat：右侧常只有视觉蓝点，无 unreadIndicator / 未読 aria
      if (hasVisualUnreadDot(row)) {
        return { unread: true, source: 'visual_dot', precise: false };
      }
      if (hasPseudoUnreadDot(row)) {
        return { unread: true, source: 'visual_dot_pseudo', precise: false };
      }
    } catch (e) {}
    return { unread: false, source: '', precise: false };
  }

  /**
   * 4.9.111 诊断：行右侧所有小圆点候选的真实结构。
   * 现场“明明有蓝点却 unread=0”必须能直接看到是尺寸、位置还是颜色不符，
   * 而不是再靠猜。
   */
  function probeUnreadDots(row, limit) {
    var out = [];
    if (!row || !row.getBoundingClientRect) return out;
    var cap = Math.max(1, Math.min(20, Number(limit) || 10));
    try {
      var rr = row.getBoundingClientRect();
      var nodes = row.querySelectorAll('div, span, i, button, svg, circle, ellipse, use, path, rect');
      for (var i = 0; i < nodes.length && out.length < cap; i++) {
        var el = nodes[i];
        if (!el || !el.getBoundingClientRect) continue;
        var r = el.getBoundingClientRect();
        if (r.width < 2 || r.width > 30 || r.height < 2 || r.height > 30) continue;
        if (Math.abs(r.width - r.height) > 10) continue;
        if (r.left < rr.right - 90) continue;
        if (r.top + r.height < rr.top - 8 || r.top > rr.bottom + 8) continue;
        var st = null;
        try { st = window.getComputedStyle(el); } catch (eSt) { st = null; }
        out.push({
          tag: String(el.tagName || '').toLowerCase(),
          icon: String((el.getAttribute && el.getAttribute('data-icon')) || '').slice(0, 24),
          testid: String((el.getAttribute && el.getAttribute('data-testid')) || '').slice(0, 32),
          fill: String((el.getAttribute && el.getAttribute('fill')) || '').slice(0, 24),
          bg: st ? String(st.backgroundColor || '').slice(0, 24) : '',
          color: st ? String(st.color || '').slice(0, 24) : '',
          stFill: st ? String(st.fill || '').slice(0, 24) : '',
          w: Math.round(r.width),
          h: Math.round(r.height),
          dx: Math.round(rr.right - r.right),
          blueish: (function () {
            var cands = [st && st.backgroundColor, st && st.color, st && st.fill,
              el.getAttribute && el.getAttribute('fill')];
            for (var ci = 0; ci < cands.length; ci++) {
              if (parseBlueishRgb(cands[ci])) return true;
            }
            return false;
          })()
        });
      }
    } catch (eProbeDots) {}
    return out;
  }

  /** 解析蓝系 RGB（含 X 品牌蓝 #1d9bf0） */
  function parseBlueishRgb(colorStr) {
    var bg = String(colorStr || '');
    var m = bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (!m) {
      var hex = bg.match(/#([0-9a-f]{3,8})\b/i);
      if (!hex) return null;
      var h = hex[1];
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      if (h.length < 6) return null;
      m = [null, parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    var R = +m[1], G = +m[2], B = +m[3];
    var aMatch = bg.match(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)/i);
    if (aMatch && Number(aMatch[1]) < 0.35) return null;
    if (B >= 150 && B > R + 30 && B >= G - 10 && R <= 160) return { R: R, G: G, B: B };
    if (R <= 60 && G >= 120 && B >= 190) return { R: R, G: G, B: B };
    return null;
  }

  /** 在指定容器里找「右侧小圆蓝点」；rowRect 用于把范围限制到目标行 */
  function findVisualDotIn(scope, rowRect) {
    if (!scope || !scope.querySelectorAll) return false;
    var nodes = scope.querySelectorAll('div, span, i, button, svg, circle, ellipse, use, path, rect');
    var limit = Math.min(nodes.length, 500);
    for (var i = 0; i < limit; i++) {
      var el = nodes[i];
      if (!el || !el.getBoundingClientRect) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 3 || r.width > 14 || r.height < 3 || r.height > 14) continue;
      if (Math.abs(r.width - r.height) > 8) continue;
      if (rowRect) {
        // 必须与目标行垂直重叠（容差 6px），且靠近该行右边缘
        if (r.top + r.height < rowRect.top - 6) continue;
        if (r.top > rowRect.bottom + 6) continue;
        if (r.left < rowRect.right - 48) continue;
      }
      var rawTxt = String(el.innerText || el.textContent || '').replace(/\s+/g, '');
      // 允许空、圆点符号、或 1–2 位未读数字
      if (rawTxt.length > 0 && !/^[●•·◦○\d]{1,2}$/.test(rawTxt)) continue;
      var st = window.getComputedStyle(el);
      if (!st || st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) continue;
      var tag = String(el.tagName || '').toLowerCase();
      var br = String(st.borderRadius || '');
      var brOk = tag === 'circle' || tag === 'ellipse' || tag === 'svg'
        || /%|999|50|100/.test(br)
        || parseFloat(br) >= Math.min(r.width, r.height) * 0.25
        || (r.width <= 12 && r.height <= 12);
      if (!brOk && rawTxt.length === 0) continue;
      var colorCandidates = [
        st.backgroundColor,
        st.color,
        st.fill,
        el.getAttribute && el.getAttribute('fill'),
        el.getAttribute && el.getAttribute('stroke')
      ];
      if (st.backgroundColor === 'rgba(0, 0, 0, 0)' || st.backgroundColor === 'transparent') {
        colorCandidates.push(st.borderColor, st.outlineColor);
      }
      for (var ci = 0; ci < colorCandidates.length; ci++) {
        if (parseBlueishRgb(colorCandidates[ci])) return true;
      }
    }
    return false;
  }

  /** 行右侧小圆蓝点启发；蓝点可能渲染在行外层容器，需向上找 3 层 */
  function hasVisualUnreadDot(row) {
    if (!row || !row.getBoundingClientRect) return false;
    try {
      var rr = row.getBoundingClientRect();
      if (rr.width < 40 || rr.height < 20) return false;
      // 1) 行内
      // 4.9.111：把 path / rect 也算进来。新版 X 的未读点是 <svg><path fill="#1d9bf0">，
      // 旧清单只查 svg/circle/ellipse/use，path 尺寸算在 svg 上又超过 12px，
      // 结果蓝点明明在、却一直报 unread=0。
      var inner = row.querySelectorAll('div, span, i, button, svg, circle, ellipse, use, path, rect');
      var limit = Math.min(inner.length, 260);
      for (var i = 0; i < limit; i++) {
        var el = inner[i];
        if (!el || !el.getBoundingClientRect) continue;
        var r = el.getBoundingClientRect();
        // 未读点是小圆点（约 6–10px），且一定贴在行最右侧（时间戳之后）。
        // 旧范围 3–28px / 行宽 35% 起会把蓝色认证徽章当成未读点，
        // 现场表现为「一堆认证账号每拍都是 latest_unread，但预览是我方最后一句」。
        // 4.9.111：放宽到 14px / 右缘 48px —— 现场蓝点距行右缘约 40px，
        // 旧的 36px 门槛刚好把它排除；认证徽章约 18px，仍被 14px 上限挡住。
        if (r.width < 3 || r.width > 14 || r.height < 3 || r.height > 14) continue;
        if (Math.abs(r.width - r.height) > 8) continue;
        if (r.left < rr.right - 48) continue;
        if (r.right > rr.right + 10) continue;
        var rawTxt = String(el.innerText || el.textContent || '').replace(/\s+/g, '');
        if (rawTxt.length > 0 && !/^[●•·◦○\d]{1,2}$/.test(rawTxt)) continue;
        var st = window.getComputedStyle(el);
        if (!st || st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) continue;
        var tag = String(el.tagName || '').toLowerCase();
        var br = String(st.borderRadius || '');
        var brOk = tag === 'circle' || tag === 'ellipse' || tag === 'svg'
          || /%|999|50|100/.test(br)
          || parseFloat(br) >= Math.min(r.width, r.height) * 0.25
          || (r.width <= 12 && r.height <= 12);
        if (!brOk && rawTxt.length === 0) continue;
        var colorCandidates = [
          st.backgroundColor, st.color, st.fill,
          el.getAttribute && el.getAttribute('fill'),
          el.getAttribute && el.getAttribute('stroke')
        ];
        if (st.backgroundColor === 'rgba(0, 0, 0, 0)' || st.backgroundColor === 'transparent') {
          colorCandidates.push(st.borderColor, st.outlineColor);
        }
        for (var ci = 0; ci < colorCandidates.length; ci++) {
          if (parseBlueishRgb(colorCandidates[ci])) return true;
        }
      }
      // 2) 蓝点在行外层容器（与行同级/父级）
      var p = row.parentElement;
      for (var depth = 0; depth < 3 && p; depth++) {
        if (findVisualDotIn(p, rr)) return true;
        p = p.parentElement;
      }
    } catch (eV) {}
    return false;
  }

  /**
   * 某些 X 版本把未读蓝点画在 ::after / ::before 伪元素上。
   * 伪元素拿不到 getBoundingClientRect，只能读计算样式；
   * 用父节点位置限制在行右缘，避免把认证徽章/按钮误判成未读。
   */
  function hasPseudoUnreadDot(row) {
    if (!row || !row.getBoundingClientRect) return false;
    try {
      var rr = row.getBoundingClientRect();
      if (rr.width < 40 || rr.height < 20) return false;
      var nodes = row.querySelectorAll('div, span, i, button, a');
      var limit = Math.min(nodes.length, 180);
      for (var i = 0; i < limit; i++) {
        var el = nodes[i];
        if (!el || !el.getBoundingClientRect) continue;
        var er = el.getBoundingClientRect();
        if (er.width < 1 || er.height < 1) continue;
        // 只检查靠近行右缘的容器；认证徽章在名字旁边，不会落在这里。
        if (er.right < rr.right - 56 || er.left > rr.right) continue;
        for (var which = 0; which < 2; which++) {
          var pseudo = which === 0 ? '::after' : '::before';
          var ps = window.getComputedStyle(el, pseudo);
          if (!ps) continue;
          var content = String(ps.content || '').trim();
          // content: "" 是常见装饰伪元素，不能当成“没有伪元素”跳过；
          // 只排除 none / normal，后面再用宽高和颜色确认是不是蓝点。
          if (content === 'none' || content === 'normal') continue;
          var w = parseFloat(ps.width);
          var h = parseFloat(ps.height);
          if (!(w >= 3 && w <= 28 && h >= 3 && h <= 28)) continue;
          if (Math.abs(w - h) > 8) continue;
          if (ps.display === 'none' || ps.visibility === 'hidden' || Number(ps.opacity) === 0) continue;
          var colors = [ps.backgroundColor, ps.color, ps.borderColor, ps.outlineColor];
          for (var ci = 0; ci < colors.length; ci++) {
            if (parseBlueishRgb(colors[ci])) return true;
          }
        }
      }
    } catch (ePseudo) {}
    return false;
  }

  /** 可视列表信号：含宇宙外蓝点计数（供 OPS 证明识别到了） */
  function summarizeInboxListSignals(actionable) {
    var rows = inboxRows();
    var visible = rows.length;
    var unreadDom = 0;
    var unreadVisual = 0;
    for (var i = 0; i < rows.length; i++) {
      var info = getInboxRowUnread(rows[i]);
      if (!info.unread) continue;
      if (info.source === 'visual_dot') unreadVisual++;
      else unreadDom++;
    }
    var debtMatched = Array.isArray(actionable) ? actionable.length : 0;
    var urgent = 0;
    if (Array.isArray(actionable)) {
      for (var u = 0; u < actionable.length; u++) {
        if (actionable[u] && (actionable[u].replied || actionable[u].unread)) urgent++;
      }
    }
    return {
      visible_rows: visible,
      unread_dom: unreadDom,
      unread_visual: unreadVisual,
      debt_matched: debtMatched,
      urgent: urgent
    };
  }

  function conversationHasUnread(row) {
    return getInboxRowUnread(row).unread;
  }

  /** 打开优先级：未读 > 强回复 > kick > 探测（短扫强制） */
  function inboxRowOpenPriority(item) {
    if (!item) return 99;
    if (item.lastSpeaker === 'own' || item.lastSpeaker === 'draft') {
      if (!item.adDebt && !item.kickReady && !item.unread) return 99;
    }
    if (item.unread && item.unreadPrecise) return 0;
    if (item.unread) return 1;
    if (item.lastSpeaker === 'peer' || item.peerLast) return 2;
    if (item.replied || item.confidence === 'strong_peer') return 2;
    if (item.confidence === 'weak_peer') return 3;
    if (item.kickReady) return 4;
    if (item.probeable) return 5;
    return 6;
  }

  function extractInboxRowPreviewData(row) {
    var result = { preview: '', fromSelf: false, source: 'none', handle: '', unreadFromAria: false };
    if (!row) return result;
    var adapter = inboxV2();
    if (row.__sgSnapshot) {
      try {
        var snapPreview = adapter && adapter.rowPreview ? adapter.rowPreview(row) : null;
        if (snapPreview) {
          result.preview = snapPreview.preview || '';
          result.fromSelf = snapPreview.fromSelf === true;
          result.isDraft = snapPreview.isDraft === true;
          result.source = 'snapshot';
          return result;
        }
      } catch (eSnapPreview) {}
    }
    if (adapter && adapter.isV2Row && adapter.isV2Row(row) && adapter.rowPreview) {
      try {
        var v2Preview = adapter.rowPreview(row);
        result.preview = v2Preview.preview || '';
        result.fromSelf = v2Preview.fromSelf === true;
        result.isDraft = v2Preview.isDraft === true;
        result.source = 'inbox-v2-adapter';
        return result;
      } catch (eV2Preview) {}
    }
    try {
      var desc = String((row.getAttribute && row.getAttribute('aria-description')) || '').trim();
      if (desc) {
        var parsed = parseInboxAriaDescription(desc);
        result.unreadFromAria = !!parsed.unread;
        result.handle = parsed.handle || '';
        if (parsed.preview) {
          result.preview = parsed.preview.slice(0, 120);
          result.fromSelf = isInboxPreviewFromSelf(parsed.preview) || inboxRowHasVisibleSelfPrefix(row);
          result.source = 'aria-description';
          return result;
        }
      }
    } catch (e) {}
    try {
      var lines = String(row.innerText || '').split('\n').map(function (l) { return String(l).replace(/\s+/g, ' ').trim(); }).filter(Boolean);
      // 多行消息：X 只在第一行加「你:」，后面几行是正文换行。
      // 旧逻辑只看最后两行，会把「你: まだかな… / … / test」误判成对方发言。
      for (var sl = 1; sl < lines.length; sl++) {
        var sline = lines[sl];
        if (DM_TIMESTAMP_RE_LIST.test(sline) || INBOX_ARIA_TIME_RE.test(sline)) continue;
        if (isInboxPreviewFromSelf(sline) || INBOX_PREVIEW_SELF_PREFIX_RE.test(sline)) {
          result.preview = sline.replace(INBOX_PREVIEW_SELF_PREFIX_RE, '').trim().slice(0, 120) || sline.slice(0, 120);
          result.fromSelf = true;
          result.isDraft = INBOX_PREVIEW_DRAFT_PREFIX_RE.test(sline);
          result.source = result.isDraft ? 'innerText-draft-line' : 'innerText-self-line';
          return result;
        }
        // 第一行正文就是对方的话 → 停止，避免把后面的引用行误判成我方
        break;
      }
      var picks = [];
      for (var i = lines.length - 1; i >= 0 && picks.length < 2; i--) {
        var line = lines[i];
        if (DM_TIMESTAMP_RE_LIST.test(line) || INBOX_ARIA_TIME_RE.test(line)) continue;
        if (/^@\S+$/i.test(line)) continue;
        if (INBOX_ARIA_UNREAD_TOKEN_RE.test(line)) continue;
        if (/^(今天|昨天|星期[一二三四五六日天]|Today|Yesterday)$/i.test(line)) continue;
        picks.push(line);
      }
      // X 会自动在原文下面追加一行译文。译文行没有「你:」前缀，
      // 只看最后一行会把「我方消息的译文」误判成「对方最后发言」。
      // 两行成对出现时，如果上一行是我方前缀，最后一行视为译文，仍按我方处理。
      var lastLine = picks[0] || '';
      var prevLine = picks[1] || '';
      if (prevLine && !isInboxPreviewFromSelf(lastLine)
          && (isInboxPreviewFromSelf(prevLine) || INBOX_PREVIEW_SELF_PREFIX_RE.test(prevLine))) {
        result.preview = prevLine.replace(INBOX_PREVIEW_SELF_PREFIX_RE, '').trim().slice(0, 120) || prevLine.slice(0, 120);
        result.fromSelf = true;
        result.source = 'innerText-self-translated';
        return result;
      }
      for (var p = 0; p < picks.length; p++) {
        var line2 = picks[p];
        if (isInboxPreviewFromSelf(line2) || INBOX_PREVIEW_SELF_PREFIX_RE.test(line2)) {
          result.preview = line2.replace(INBOX_PREVIEW_SELF_PREFIX_RE, '').trim().slice(0, 120) || line2.slice(0, 120);
          result.fromSelf = true;
          result.source = 'innerText-self';
          return result;
        }
        result.preview = line2.slice(0, 120);
        // 没有「你:」前缀＝对方最后一发言。旧实现再用“文案像我们的话术池”兜底，
        // 会把对方回的「何歳？」「おいくつですか？」这类同款短句误判成我方，
        // 导致真回复在列表层就被丢掉。误判成对方最多多开一次会话确认。
        result.fromSelf = false;
        result.source = 'innerText';
        return result;
      }
    } catch (e2) {}
    return result;
  }

  function extractInboxRowPreview(row) {
    return extractInboxRowPreviewData(row).preview;
  }

  function pickActionableInboxRows() {
    var db = callHook('loadTargetDB') || {};
    var sg = callHook('ensureChatFreeze') || {};
    var rejectDB = callHook('getDB', 'dan_reject_users');
    var inboxDone = callHook('getInboxDoneList') || [];
    var opening = callHook('normalizeChatHandle', sessionStorage.getItem('dan_inbox_opening') || '') || '';
    var targetMeta = {};
    var pid2h = {};
    var dn2h = {};
    var anyDebt = false;
    function doneHas(handle) {
      if (!inboxDone) return false;
      if (typeof inboxDone.includes === 'function') return inboxDone.includes(handle);
      return inboxDone.indexOf(handle) >= 0;
    }
    function emitMatchRepair(handle, by, extra) {
      try {
        var meta = { handle: handle, by: by };
        if (extra) {
          if (extra.ops_max != null) meta.ops_max = extra.ops_max;
          if (extra.peer_id != null) meta.peer_id = extra.peer_id;
          if (extra.repaired_peer != null) meta.repaired_peer = !!extra.repaired_peer;
          if (extra.repaired_name != null) meta.repaired_name = !!extra.repaired_name;
        }
        callHook('reportChatMetric', 'inbox.match_repair', meta);
      } catch (eR) {}
    }
    // 全库未 done 建索引（行→handle）；可行动作仍限 round1/2（含 round0 已破冰提升）
    for (var h in db) {
      var entry = db[h];
      var handle = callHook('normalizeChatHandle', h) || '';
      if (!entry || !handle || entry.done) continue;
      if (entry.blockedAt || entry.rejectSentAt) continue;
      if (rejectDB && rejectDB.has && rejectDB.has(handle)) continue;
      if (opening && opening === handle) continue;
      if (!callHook('isChatTargetAllowed', handle, sg)) continue;
      if (entry.peerId) pid2h[String(entry.peerId).replace(/\D/g, '') || String(entry.peerId)] = handle;
      var dn = callHook('normalizeDisplayName', entry.displayName || '');
      if (dn) dn2h[dn] = handle;

      var round = entry.round || 0;
      var opsMax = 0;
      try { opsMax = Number(callHook('getOpsMaxRound', handle) || 0) || 0; } catch (eOps) { opsMax = 0; }
      if (round === 0 && (entry.iceSentAt || opsMax >= 1)) {
        var promoted = Math.max(1, opsMax || 1);
        try {
          if ((entry.round || 0) < 1) {
            entry.round = promoted;
            if (!entry.iceSentAt) entry.iceSentAt = entry.lastDM || entry.firstSeen || Date.now();
            db[handle] = entry;
            callHook('saveTargetDB', db);
            emitMatchRepair(handle, 'round0_promote', { ops_max: opsMax });
          }
        } catch (ePromo) {}
        round = entry.round || promoted;
      }
      if (round !== 1 && round !== 2) continue;
      var probeable = !!callHook('canProbeInboxTarget', handle, entry);
      var kickReady = round === 2 && !!callHook('canSendKickNow', handle, entry);
      var needsAdRepair = round === 2 && !entry.adBubbleOk;
      targetMeta[handle] = {
        handle: handle,
        round: round,
        probeable: probeable,
        kickReady: kickReady,
        needsAdRepair: needsAdRepair,
        confirmed: !!(entry.replySeenAt),
        inboxDone: doneHas(handle)
      };
      anyDebt = true;
    }
    if (!anyDebt) return [];
    var rows = inboxRows();
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var identity = inboxRowIdentity(row);
      var peerId = identity && identity.valid ? identity.peerId : '';
      var desc = String(row.getAttribute('aria-description') || '');
      var descM = desc.match(/@(\S+)/i);
      var rowHandle = descM ? String(descM[1]).replace(/[,\s].*$/, '').toLowerCase() : '';
      var firstLine = ((row.innerText || '').split('\n')[0] || '');
      var rowDisplayName = inboxRowDisplayName(row, firstLine);
      var handle2 = '';
      var matchBy = '';
      if (peerId && pid2h[peerId]) {
        var hByPid = pid2h[peerId];
        if (rowHandle && rowHandle !== hByPid.toLowerCase()) {
          console.warn('[inbox_scan] peerId 命中但行 handle 不一致，拒绝错配 @' + hByPid + ' (row=@' + rowHandle + ') peerId=' + peerId);
        } else {
          handle2 = hByPid;
          matchBy = 'peerId';
        }
      }
      if (!handle2 && rowHandle) {
        var nh = callHook('normalizeChatHandle', rowHandle) || rowHandle;
        if (targetMeta[nh] || db[nh]) {
          handle2 = nh;
          matchBy = 'handle';
        }
      }
      if (!handle2) {
        var nfl = callHook('normalizeDisplayName', rowDisplayName);
        if (nfl && dn2h[nfl]) {
          handle2 = dn2h[nfl];
          matchBy = 'displayName';
        }
      }
      if (!handle2 || !targetMeta[handle2]) continue;
      try {
        var dirty = false;
        var repairedPeer = false;
        var repairedName = false;
        if (peerId && String(db[handle2].peerId || '') !== peerId) {
          db[handle2].peerId = peerId;
          dirty = true;
          repairedPeer = true;
        }
        if (firstLine && String(db[handle2].displayName || '') !== firstLine) {
          db[handle2].displayName = firstLine;
          dirty = true;
          repairedName = true;
        }
        // 只有真的回写了才上报；旧逻辑每次扫描都为每个 peerId/显示名命中的行
        // 无条件发一条 match_repair，10 行会话每 30 秒就是 10 条噪音。
        if (dirty) {
          callHook('saveTargetDB', db);
          emitMatchRepair(handle2, repairedPeer ? 'peerId' : 'displayName', {
            peer_id: peerId || '',
            repaired_peer: repairedPeer,
            repaired_name: repairedName
          });
          console.log('[inbox_scan] 命中 @' + handle2 + '，回写 peerId=' + peerId + ' displayName=' + firstLine);
        }
      } catch (eFix) {}
      var meta = targetMeta[handle2];
      var unreadInfo = getInboxRowUnread(row);
      var unread = unreadInfo.unread;
      var previewData = extractInboxRowPreviewData(row);
      var preview = previewData.preview;
      var previewScore = scoreInboxPreview(preview);
      var confidence = previewData.fromSelf ? 'own' : previewScore.confidence;
      var replied = inboxPreviewIndicatesPeerReply(preview, previewData, previewScore);
      if (meta.inboxDone && !replied && !unread) continue;
      if (replied && handle2 && meta.round === 1) {
        try {
          if (!db[handle2].replySeenAt) {
            db[handle2].replySeenAt = Date.now();
            callHook('saveTargetDB', db);
            console.log('[inbox_scan] @' + handle2 + ' 行预览确认回复，标记 replySeenAt confidence=' + confidence);
          }
        } catch (eRS) {}
      }
      // round2：催加就绪，或会话缺广告需补发；禁止仅因蓝点空转 kick_not_ready
      var actionable = (meta.round === 1 && (replied || unread || meta.probeable))
        || (meta.round === 2 && (meta.kickReady || meta.needsAdRepair));
      if (!actionable) continue;
      out.push({
        row: row,
        handle: handle2,
        peerId: peerId,
        round: meta.round,
        unread: unread,
        unreadSource: unreadInfo.source,
        unreadPrecise: unreadInfo.precise,
        replied: replied,
        confidence: confidence,
        previewFromSelf: previewData.fromSelf,
        previewSource: previewData.source,
        confirmed: meta.confirmed,
        preview: preview.slice(0, 60),
        probeable: meta.probeable,
        kickReady: meta.kickReady
      });
    }
    var seenPid = {};
    var uniq = [];
    for (var u = 0; u < out.length; u++) {
      var it = out[u];
      if (!it.peerId) { uniq.push(it); continue; }
      if (seenPid[it.peerId]) continue;
      seenPid[it.peerId] = true;
      uniq.push(it);
    }
    out = uniq;
    out.sort(function (a, b) {
      var pa = inboxRowOpenPriority(a);
      var pb = inboxRowOpenPriority(b);
      if (pa !== pb) return pa - pb;
      if (a.unreadPrecise !== b.unreadPrecise) return a.unreadPrecise ? -1 : 1;
      if (a.unread !== b.unread) return a.unread ? -1 : 1;
      if (a.replied !== b.replied) return a.replied ? -1 : 1;
      if (!!a.kickReady !== !!b.kickReady) return a.kickReady ? -1 : 1;
      if (!!a.probeable !== !!b.probeable) return a.probeable ? 1 : -1;
      if (a.round !== b.round) return a.round - b.round;
      if ((a.confirmed || 0) !== (b.confirmed || 0)) return a.confirmed ? -1 : 1;
      return 0;
    });
    return out;
  }

  /** 可视未读且当前不在 urgent 打开集中的行（宇宙外 / 匹配失败 / round2 未读漏网）
   *  @param {Object} [urgentHandles] handle → true，已由 pick 判为 replied|unread 的债务目标
   */
  function listOrphanUnreadRows(urgentHandles) {
    urgentHandles = urgentHandles || {};
    var db = callHook('loadTargetDB') || {};
    var sg = callHook('ensureChatFreeze') || {};
    var rejectDB = callHook('getDB', 'dan_reject_users');
    var pid2h = {};
    var dn2h = {};
    for (var h in db) {
      var entry = db[h];
      var handle = callHook('normalizeChatHandle', h) || '';
      if (!entry || !handle) continue;
      // done/墓碑仍建索引，便于未读行 peerId/显示名匹配后 revive
      if (entry.blockedAt || entry.rejectSentAt) continue;
      if (rejectDB && rejectDB.has && rejectDB.has(handle)) continue;
      if (!entry.done && !callHook('isChatTargetAllowed', handle, sg)) continue;
      if (entry.peerId) pid2h[String(entry.peerId).replace(/\D/g, '') || String(entry.peerId)] = handle;
      var dn = callHook('normalizeDisplayName', entry.displayName || '');
      if (dn) dn2h[dn] = handle;
    }
    var rows = inboxRows();
    var orphans = [];
    var seen = {};
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var unreadInfo = getInboxRowUnread(row);
      if (!unreadInfo.unread) continue;
      var identity = inboxRowIdentity(row);
      var peerId = identity && identity.valid ? identity.peerId : '';
      var desc = String(row.getAttribute('aria-description') || '');
      var descM = desc.match(/@(\S+)/i);
      var rowHandle = descM ? callHook('normalizeChatHandle', String(descM[1]).replace(/[,\s].*$/, '')) || '' : '';
      var firstLine = ((row.innerText || '').split('\n')[0] || '');
      var rowDisplayName = inboxRowDisplayName(row, firstLine);
      var handle2 = '';
      // 与 pick 一致：peerId 命中须通过 rowHandle 交叉验证，否则不当作已绑定债务
      if (peerId && pid2h[peerId]) {
        var hByPid = pid2h[peerId];
        if (!(rowHandle && rowHandle !== hByPid.toLowerCase())) {
          handle2 = hByPid;
        }
      }
      if (!handle2 && rowHandle) handle2 = rowHandle;
      if (!handle2) {
        var nfl = callHook('normalizeDisplayName', rowDisplayName);
        if (nfl && dn2h[nfl]) handle2 = dn2h[nfl];
      }
      // 仅当该 handle 已在本轮 urgent 打开集中才跳过
      if (handle2 && urgentHandles[handle2]) continue;
      // 已婉拒 / 终端完结：不因蓝点反复开。done/墓碑仍允许 orphan（催加后未最终催加的也要能开）
      if (handle2 && db[handle2] && (db[handle2].rejectSentAt || db[handle2].chatClosedAt || db[handle2].finalKickSentAt)) continue;
      var key = peerId || handle2 || callHook('normalizeDisplayName', rowDisplayName) || rowDisplayName;
      if (!key || seen[key]) continue;
      seen[key] = 1;
      orphans.push({
        row: row,
        peerId: peerId,
        handle: handle2 || '',
        rowHandle: rowHandle || '',
        displayName: rowDisplayName,
        unreadSource: unreadInfo.source || '',
        unreadPrecise: !!unreadInfo.precise
      });
    }
    return orphans;
  }


  var api = {
    bind: bind,
    register: register,
    ready: function () {
      return typeof hooks.collectPeerDmMessages === 'function';
    },
    listRegistered: function () {
      return Object.keys(registered).concat([
        'normalizeForScriptMatch', 'isLinkShellText', 'isOwnScriptText',
        'collectExtraPeerTexts', 'detectDmReplyState'
      ]);
    },
    normalizeForScriptMatch: normalizeForScriptMatch,
    isLinkShellText: isLinkShellText,
    isOwnScriptText: isOwnScriptText,
    isLikelyOwnDmText: isLikelyOwnDmText,
    collectExtraPeerTexts: collectExtraPeerTexts,
    detectDmReplyState: detectDmReplyState,
    parseInboxAriaDescription: parseInboxAriaDescription,
    scoreInboxPreview: scoreInboxPreview,
    inboxPreviewIndicatesPeerReply: inboxPreviewIndicatesPeerReply,
    getInboxRowUnread: getInboxRowUnread,
    probeUnreadDots: probeUnreadDots,
    conversationHasUnread: conversationHasUnread,
    inboxRowOpenPriority: inboxRowOpenPriority,
    summarizeInboxListSignals: summarizeInboxListSignals,
    extractInboxRowPreviewData: extractInboxRowPreviewData,
    extractInboxRowPreview: extractInboxRowPreview,
    pickActionableInboxRows: pickActionableInboxRows,
    listOrphanUnreadRows: listOrphanUnreadRows,
    runInboxWatchTick: function () { return callRegistered('runInboxWatchTick'); }
  };

  if (typeof window !== 'undefined') {
    window.SgInboxWatch = api;
  }

  console.log('[C3] inbox-watch.js loaded (diff-gate + list-pick owned)');
})();

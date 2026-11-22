// =============================================================================
// TEST COPY ONLY · Inbox V2 read-only adapter
// 新版 X 会话栏：shadow DOM + a[role="option"][id^="dm-conversation-option-"]
// 本文件只读，不点击、不发送、不写存储。
// =============================================================================
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.SgInboxV2Adapter) return;

  var ROW_SELECTOR = 'a[role="option"][id^="dm-conversation-option-"]';
  var OLD_ROW_SELECTOR = '[data-testid^="dm-conversation-item-"]';
  var UNREAD_ICON = '[data-icon="icon-circle-fill"]';
  var LISTBOX = '[role="listbox"]';

  var TIME_RE = /^(?:\d+\s*(?:秒|分钟|分|小时|天|周|个月|年)|今天|昨天|星期[一二三四五六日天]|Today|Yesterday|.*\d{1,2}:\d{2})$/i;
  var SKIP_RE = /^(?:未读|新|Unread|New|已发送|送信済み|送信しました|Sent|●|•|·|◦|○)$/i;
  var SELF_PREFIX_RE = /^(你|You|あなた|草稿|Draft|下書き)[:：]\s*/i;
  var DRAFT_PREFIX_RE = /^(草稿|Draft|下書き)[:：]\s*/i;
  var HANDLE_LINE_RE = /^@\S+$/i;

  function deepQueryAll(root, selector, out) {
    out = out || [];
    if (!root) return out;
    try {
      var direct = root.querySelectorAll(selector);
      for (var i = 0; i < direct.length; i++) out.push(direct[i]);
    } catch (eDirect) {}
    try {
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      var node;
      while ((node = walker.nextNode())) {
        if (!node.shadowRoot) continue;
        deepQueryAll(node.shadowRoot, selector, out);
      }
    } catch (eWalker) {}
    return out;
  }

  function deepQuery(root, selector) {
    if (!root) return null;
    try {
      var direct = root.querySelector(selector);
      if (direct) return direct;
    } catch (eDirect) {}
    try {
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      var node;
      while ((node = walker.nextNode())) {
        if (!node.shadowRoot) continue;
        var hit = deepQuery(node.shadowRoot, selector);
        if (hit) return hit;
      }
    } catch (eWalker) {}
    return null;
  }

  function findListbox() {
    return deepQuery(document, LISTBOX);
  }

  /**
   * 统一读取会话行字段。
   * 深度扫描后 DOM 行会被虚拟列表回收复用，必须在首次看到时冻结快照；
   * 快照对象（__sgSnapshot）与真实 DOM 行走同一套解析入口。
   */
  function rowField(row, key) {
    if (!row) return '';
    if (row.__sgSnapshot) {
      if (key === 'id') return String(row.id || '');
      if (key === 'text') return String(row.text || '');
      if (key === 'testid') return String(row.testid || '');
      if (key === 'href') return String(row.href || '');
      if (key === 'aria-label') return String(row.ariaLabel || '');
      if (key === 'aria-description') return String(row.ariaDescription || '');
      return '';
    }
    if (key === 'id') return String(row.id || '');
    if (key === 'text') return String(row.innerText || '');
    if (key === 'testid') key = 'data-testid';
    try {
      return String((row.getAttribute && row.getAttribute(key)) || '');
    } catch (eField) {
      return '';
    }
  }

  function dedupe(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (out.indexOf(list[i]) < 0) out.push(list[i]);
    }
    return out;
  }

  function listRows() {
    var listbox = findListbox();
    if (listbox) {
      var scoped = [];
      try {
        var newRows = listbox.querySelectorAll(ROW_SELECTOR);
        for (var i = 0; i < newRows.length; i++) scoped.push(newRows[i]);
      } catch (eNew) {}
      if (scoped.length) return dedupe(scoped);
    }
    var rows = dedupe(deepQueryAll(document, ROW_SELECTOR));
    if (rows.length) return rows;
    return dedupe(deepQueryAll(document, OLD_ROW_SELECTOR));
  }

  function pathOf(href) {
    var value = String(href || '');
    return value.replace(/^https?:\/\/[^/]+/i, '');
  }

  function parseConversationIds(id, testid, href) {
    var peerId = '';
    var myId = '';
    var source = '';
    var rawId = String(id || '');
    var rawTestid = String(testid || '');
    var path = pathOf(href);

    var byId = rawId.match(/^dm-conversation-option-(\d+):(\d+)$/);
    if (byId) {
      peerId = byId[1];
      myId = byId[2];
      source = 'row.id';
    }
    if (!peerId) {
      var byTestid = rawTestid.match(/^dm-conversation-item-(\d+):(\d+)$/);
      if (byTestid) {
        peerId = byTestid[1];
        myId = byTestid[2];
        source = 'row.testid';
      }
    }

    var byHref = path.match(/^\/i\/chat\/(\d+)-(\d+)\/?$/);
    if (byHref) {
      // href 也可能是「本号-对方」，不能按位置直接认定 peer。
      // 把两段 id 一并保留，交给 detectMyId/resolvePeerId 用本号 id 反推。
      if (!peerId) {
        peerId = byHref[1];
        myId = byHref[2];
        source = 'row.href';
      } else if (peerId !== byHref[1] || myId !== byHref[2]) {
        return {
          valid: false,
          peerId: '',
          myId: '',
          href: path,
          source: 'mismatch'
        };
      }
    }

    return {
      valid: !!peerId,
      peerId: peerId,
      myId: myId,
      // row.id 有时只有一段（搜索结果行），此时 href 的两段仍是有效证据。
      firstId: byId ? byId[1] : (byHref ? byHref[1] : ''),
      secondId: byId ? byId[2] : (byHref ? byHref[2] : ''),
      href: path,
      source: source
    };
  }

  /**
   * 本号 ID 探测：行 ID 的某一段在所有行中出现频率最高（且出现于多数行）即本号。
   * X 的 ID 顺序不固定（有时 peer:me，有时 me:peer），不能按位置取对方。
   */
  function detectMyId(rows) {
    var list = Array.isArray(rows) ? rows : listRows();
    var counts = {};
    var total = 0;
    for (var i = 0; i < list.length; i++) {
      var ids = parseIds(list[i]);
      if (!ids.valid || !ids.firstId || !ids.secondId) continue;
      total++;
      counts[ids.firstId] = (counts[ids.firstId] || 0) + 1;
      counts[ids.secondId] = (counts[ids.secondId] || 0) + 1;
    }
    var best = '';
    var bestCount = 0;
    Object.keys(counts).forEach(function (key) {
      if (counts[key] > bestCount) {
        bestCount = counts[key];
        best = key;
      }
    });
    if (!best || bestCount < 2 || bestCount < total * 0.6) return '';
    return best;
  }

  /**
   * 用本号 ID 解析对方：若 first 是本号则 peer=second，反之 peer=first。
   * myIdHint 可由调用方传入（更可靠，例如 DB 或 URL）。
   */
  function resolvePeerId(row, myIdHint) {
    var ids = parseIds(row);
    if (!ids.valid) return ids;
    var my = String(myIdHint || '').replace(/\D/g, '') || detectMyId();
    if (!my) return ids;
    if (ids.firstId === my && ids.secondId) {
      return Object.assign({}, ids, {
        peerId: ids.secondId,
        myId: ids.firstId,
        order: 'me-first',
        source: ids.source + '+myId'
      });
    }
    if (ids.secondId === my && ids.firstId) {
      return Object.assign({}, ids, {
        peerId: ids.firstId,
        myId: ids.secondId,
        order: 'peer-first',
        source: ids.source + '+myId'
      });
    }
    // 已知本号 id，但两段都不等于本号：这份地址没有“我方”这一侧，
    // 无法证明哪一段是对方。旧实现会直接取 row.id 的第一段，现场就会串号。
    return Object.assign({}, ids, {
      valid: false,
      peerId: '',
      order: 'unresolved',
      reason: 'my_id_not_in_pair'
    });
  }

  function parseIds(row) {
    if (!row) return { valid: false, peerId: '', myId: '', href: '', source: '' };
    return parseConversationIds(
      rowField(row, 'id'),
      rowField(row, 'testid'),
      rowField(row, 'href')
    );
  }

  function isV2Row(row) {
    return !!(row && /^dm-conversation-option-/.test(rowField(row, 'id')));
  }

  function rowUnread(row) {
    if (!row) return { unread: false, precise: false, source: '' };
    if (row.__sgSnapshot) {
      return row.unreadInfo || { unread: false, precise: false, source: '' };
    }
    try {
      if (row.querySelector(UNREAD_ICON)) {
        return { unread: true, precise: true, source: 'icon-circle-fill' };
      }
      var icons = row.querySelectorAll('[data-icon]');
      for (var i = 0; i < icons.length; i++) {
        var name = String(icons[i].getAttribute('data-icon') || '');
        if (name.indexOf('circle-fill') >= 0) {
          return { unread: true, precise: true, source: 'data-icon:' + name };
        }
      }
    } catch (eIcon) {}
    return { unread: false, precise: false, source: '' };
  }

  function textLines(row) {
    try {
      var raw = rowField(row, 'text');
      if (!raw && row && row.__sgText != null) raw = row.__sgText;
      return String(raw || '')
        .split('\n')
        .map(function (line) { return String(line).replace(/\s+/g, ' ').trim(); })
        .filter(Boolean);
    } catch (eLines) {
      return [];
    }
  }

  function parsePreviewLines(lines) {
    var source = Array.isArray(lines) ? lines : [];
    var displayName = source.length ? String(source[0] || '').trim() : '';
    var preview = '';
    // 「你:」前缀只出现在消息的第一行。多行消息（含 \n 的广告/催加）在列表里
    // 会被拆成多行，旧实现只取“最后一行”，于是把
    //   你: まだかなー🥺 / こっちの方が… / test
    // 误判成对方最后发言（preview 只剩 “test”），进而每拍把已回复的人重新打开、
    // 甚至把收口会话复活。这里先整行找前缀，再决定归属。
    var selfIdx = -1;
    for (var si = 1; si < source.length; si++) {
      var sline = String(source[si] || '').trim();
      if (!sline) continue;
      if (TIME_RE.test(sline) || SKIP_RE.test(sline) || HANDLE_LINE_RE.test(sline)) continue;
      if (SELF_PREFIX_RE.test(sline)) { selfIdx = si; break; }
      // 第一行就是对方的话，说明这条预览不是多行我方消息
      break;
    }
    if (selfIdx >= 0) {
      var selfRaw = String(source[selfIdx] || '');
      var selfIsDraft = DRAFT_PREFIX_RE.test(selfRaw);
      preview = selfRaw.replace(SELF_PREFIX_RE, '').trim();
      if (!preview) preview = selfRaw.trim();
      return {
        displayName: displayName,
        preview: preview.slice(0, 120),
        // 草稿也是“我方这一侧”的内容，fromSelf 保持 true，
        // 由 isDraft 单独表达“还没发出去”，下游用 isDraft 排除已发送判定。
        fromSelf: true,
        isDraft: selfIsDraft,
        source: selfIsDraft ? 'innerText-draft-line' : 'innerText-self-line'
      };
    }
    for (var i = source.length - 1; i >= 1; i--) {
      var line = String(source[i] || '').trim();
      if (!line) continue;
      if (TIME_RE.test(line)) continue;
      if (SKIP_RE.test(line)) continue;
      if (HANDLE_LINE_RE.test(line)) continue;
      preview = line;
      break;
    }
    var fromSelf = SELF_PREFIX_RE.test(preview);
    var isDraft = DRAFT_PREFIX_RE.test(preview);
    if (fromSelf) preview = preview.replace(SELF_PREFIX_RE, '').trim();
    return {
      displayName: displayName,
      preview: preview.slice(0, 120),
      fromSelf: fromSelf,
      isDraft: isDraft,
      source: 'innerText'
    };
  }

  function rowPreview(row) {
    return parsePreviewLines(textLines(row));
  }

  function rowDisplayName(row) {
    return rowPreview(row).displayName;
  }

  function findRowByPeerId(peerId) {
    var wanted = String(peerId || '').replace(/\D/g, '');
    if (!wanted) return null;
    var rows = listRows();
    var my = detectMyId(rows);
    for (var i = 0; i < rows.length; i++) {
      var ids = resolvePeerId(rows[i], my);
      if (ids.valid && String(ids.peerId).replace(/\D/g, '') === wanted) return rows[i];
    }
    return null;
  }

  function findRowByDisplayName(displayName, normalizer) {
    var wanted = String(displayName || '').trim();
    if (!wanted) return null;
    if (typeof normalizer === 'function') wanted = String(normalizer(wanted) || '');
    else wanted = wanted.toLowerCase();
    var rows = listRows();
    for (var i = 0; i < rows.length; i++) {
      var name = rowDisplayName(rows[i]);
      if (!name) continue;
      var normalized = typeof normalizer === 'function'
        ? String(normalizer(name) || '')
        : name.toLowerCase();
      if (normalized === wanted) return rows[i];
    }
    return null;
  }

  /**
   * 生成会话直开地址。X 的会话路由需要「对方 id + 本号 id」两段；
   * 缺任一段都不猜，交给调用方回退到点击列表行。
   */
  function buildConversationUrl(peerId, myId) {
    var peer = String(peerId || '').replace(/\D/g, '');
    var mine = String(myId || '').replace(/\D/g, '');
    if (!peer || !mine) return '';
    if (peer === mine) return '';
    return '/i/chat/' + peer + '-' + mine;
  }

  function findScroller(listbox) {
    if (!listbox) return null;
    var node = listbox;
    var fallback = null;
    while (node) {
      try {
        if (node.scrollHeight - node.clientHeight > 24) {
          var overflow = window.getComputedStyle(node).overflowY;
          if (/^(auto|scroll|overlay)$/i.test(String(overflow || ''))) return node;
          if (node === listbox) return node;
          if (!fallback) fallback = node;
        }
      } catch (eScroll) {}
      var parent = node.parentElement;
      if (!parent) {
        var root = node.getRootNode ? node.getRootNode() : null;
        parent = root && root.host ? root.host : null;
      }
      node = parent;
    }
    return fallback;
  }

  function scrollListBy(delta) {
    var listbox = findListbox();
    var scroller = findScroller(listbox);
    if (!scroller) return false;
    try {
      scroller.scrollTop = Math.max(0, scroller.scrollTop + Number(delta || 0));
      return true;
    } catch (eScroll) {
      return false;
    }
  }

  function summarize() {
    var rows = listRows();
    var my = detectMyId(rows);
    var unreadCount = 0;
    var preciseUnreadCount = 0;
    var peerIdCount = 0;
    var displayNameCount = 0;
    var orderStats = { meFirst: 0, peerFirst: 0, unknown: 0 };
    for (var i = 0; i < rows.length; i++) {
      var unread = rowUnread(rows[i]);
      if (unread.unread) {
        unreadCount++;
        if (unread.precise) preciseUnreadCount++;
      }
      var ids = resolvePeerId(rows[i], my);
      if (ids.valid) peerIdCount++;
      if (ids.order === 'me-first') orderStats.meFirst++;
      else if (ids.order === 'peer-first') orderStats.peerFirst++;
      else orderStats.unknown++;
      if (rowDisplayName(rows[i])) displayNameCount++;
    }
    return {
      schema: 'xchat-v2',
      listReady: !!findListbox(),
      rowCount: rows.length,
      unreadCount: unreadCount,
      preciseUnreadCount: preciseUnreadCount,
      peerIdCount: peerIdCount,
      displayNameCount: displayNameCount,
      myIdDetected: !!my,
      orderStats: orderStats,
      handleAvailable: false
    };
  }

  function diagnostics() {
    var rows = listRows();
    var my = detectMyId(rows);
    var samples = [];
    for (var i = 0; i < rows.length && i < 5; i++) {
      var ids = resolvePeerId(rows[i], my);
      var preview = rowPreview(rows[i]);
      var unread = rowUnread(rows[i]);
      samples.push({
        schema: isV2Row(rows[i]) ? 'xchat-v2' : 'legacy',
        hasPeerId: ids.valid,
        idSource: ids.source,
        order: ids.order || '',
        unread: unread.unread,
        precise: unread.precise,
        displayNameLength: preview.displayName.length,
        previewLength: preview.preview.length,
        fromSelf: preview.fromSelf,
        lineCount: textLines(rows[i]).length
      });
    }
    var summary = summarize();
    summary.samples = samples;
    return summary;
  }

  window.SgInboxV2Adapter = {
    ROW_SELECTOR: ROW_SELECTOR,
    OLD_ROW_SELECTOR: OLD_ROW_SELECTOR,
    UNREAD_ICON: UNREAD_ICON,
    listRows: listRows,
    findListbox: findListbox,
    parseIds: parseIds,
    detectMyId: detectMyId,
    resolvePeerId: resolvePeerId,
    isV2Row: isV2Row,
    rowUnread: rowUnread,
    rowPreview: rowPreview,
    rowDisplayName: rowDisplayName,
    findRowByPeerId: findRowByPeerId,
    findRowByDisplayName: findRowByDisplayName,
    scrollListBy: scrollListBy,
    summarize: summarize,
    diagnostics: diagnostics,
    parseConversationIds: parseConversationIds,
    parsePreviewLines: parsePreviewLines,
    buildConversationUrl: buildConversationUrl
  };
})();

// DM Pulse Sandbox · MAIN world injected via chrome.scripting
// 只读：不点击、不发送、不写存储、不导航。
window.__dmPulseRun = function (options) {
    var opts = options || {};
    var budgetMs = typeof opts.budgetMs === 'number' && opts.budgetMs > 0 ? opts.budgetMs : 15000;
    var intervalMs = typeof opts.intervalMs === 'number' && opts.intervalMs > 0 ? opts.intervalMs : 500;
    var deep = opts.deep !== false;
    var maxScrolls = clampNumber(opts.maxScrolls, 3, 0, 12);
    var scrollStepPx = clampNumber(opts.scrollStepPx, 600, 120, 2400);
    var settleMs = clampNumber(opts.settleMs, 700, 250, 3000);
    var emptyGraceMs = 5000;

    function clampNumber(value, fallback, min, max) {
      var parsed = Number(value);
      if (!isFinite(parsed)) return fallback;
      return Math.max(min, Math.min(max, Math.floor(parsed)));
    }

    function classifySurface(pathname) {
      var path = String(pathname || '').replace(/\/+$/, '') || '/';
      if (path === '/i/chat') return 'list';
      if (/^\/i\/chat\/\d+(?:-\d+)?$/.test(path)) return 'conversation';
      return 'other';
    }

    function findListboxDeep(root) {
      if (!root) return null;
      var direct = null;
      try { direct = root.querySelector('[role="listbox"]'); } catch (eDirect) {}
      if (direct) return direct;
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      var node;
      while ((node = walker.nextNode())) {
        if (!node.shadowRoot) continue;
        try {
          var hit = node.shadowRoot.querySelector('[role="listbox"]');
          if (hit) return hit;
        } catch (eHit) {}
        var nested = findListboxDeep(node.shadowRoot);
        if (nested) return nested;
      }
      return null;
    }

    function findDeepIn(root, selector) {
      if (!root) return null;
      try {
        var direct = root.querySelector(selector);
        if (direct) return direct;
      } catch (eDirect) {}
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      var node;
      while ((node = walker.nextNode())) {
        if (!node.shadowRoot) continue;
        var hit = findDeepIn(node.shadowRoot, selector);
        if (hit) return hit;
      }
      return null;
    }

    function findDeep(selector) {
      return findDeepIn(document, selector);
    }

    function collectDeepIn(root, selector, results) {
      if (!root) return;
      try {
        Array.prototype.push.apply(results, root.querySelectorAll(selector));
      } catch (eDirect) {}
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      var node;
      while ((node = walker.nextNode())) {
        if (!node.shadowRoot) continue;
        collectDeepIn(node.shadowRoot, selector, results);
      }
    }

    function findAllDeep(selector) {
      var results = [];
      collectDeepIn(document, selector, results);
      return results;
    }

    function readPageState() {
      var out = {};
      try {
        out.testInboxWatch = sessionStorage.getItem('sg_test_inbox_watch') === 'true';
        out.dryRun = sessionStorage.getItem('sg_chat_dry_run') === 'true';
        out.phase = sessionStorage.getItem('dan_chat_phase') || '';
        out.autoStep = sessionStorage.getItem('dan_auto_step') || '';
        out.targetUser = sessionStorage.getItem('dan_target_username') || '';
        var cfg = JSON.parse(localStorage.getItem('sg_config_thresholds') || '{}') || {};
        out.config = {
          scriptPool: cfg.chat_script_pool || '',
          dryRunEnabled: cfg.chat_dry_run_enabled === true || cfg.chat_dry_run_enabled === 'true',
          inboxWatchEnabled: cfg.chat_inbox_watch_enabled === true || cfg.chat_inbox_watch_enabled === 'true'
        };
        var st = JSON.parse(localStorage.getItem('sg_state') || '{}') || {};
        out.state = {
          running: !!st.running,
          softRiskPhase: st.softRiskPhase || '',
          softRiskChatDone: !!st.softRiskChatDone,
          softRiskOutboundDone: !!st.softRiskOutboundDone,
          softRiskUntil: Number(st.softRiskUntil) || 0
        };
        var db = JSON.parse(localStorage.getItem('chat_target_db') || '{}') || {};
        out.chatTick = {
          step: sessionStorage.getItem('dan_auto_step') || '',
          autoRun: sessionStorage.getItem('dan_auto_run') === 'true',
          inflight: sessionStorage.getItem('dan_dm_inflight') || '',
          currentTarget: sessionStorage.getItem('current_target') || '',
          scrollFail: sessionStorage.getItem('dan_scroll_fail_count') || '',
          bottomHits: sessionStorage.getItem('dan_bottom_hit_count') || '',
          fReady: sessionStorage.getItem('dan_own_profile_f_ready') === '1',
          navPhase: sessionStorage.getItem('sg_roster_nav_phase') || '',
          userCells: document.querySelectorAll('[data-testid="UserCell"]').length,
          progressbar: document.querySelectorAll('[role="progressbar"]').length
        };
        try {
          var iq = JSON.parse(sessionStorage.getItem('dan_ice_task_queue') || 'null');
          if (iq && Array.isArray(iq.items)) {
            var pending = 0;
            var doing = 0;
            var nextHandle = '';
            for (var qi = 0; qi < iq.items.length; qi++) {
              var it = iq.items[qi] || {};
              if (it.status === 'pending' && !nextHandle) nextHandle = it.handle || '';
              if (it.status === 'pending') pending++;
              if (it.status === 'doing') doing++;
            }
            out.chatTick.queue = { total: iq.items.length, pending: pending, doing: doing, nextHandle: nextHandle, sealed: !!iq.sealed };
          } else {
            out.chatTick.queue = null;
          }
        } catch (eQueue) {
          out.chatTick.queue = { error: 'parse_failed' };
        }
        var entries = Object.keys(db).map(function (handle) {
          var entry = db[handle] || {};
          return {
            targetUser: handle,
            round: Number(entry.round) || 0,
            done: !!entry.done,
            blocked: !!(entry.blockedAt || entry.rejectSentAt),
            hasIce: !!entry.iceSentAt,
            iceSentAt: Number(entry.iceSentAt) || 0,
            hasPeerId: !!entry.peerId,
            hasDisplayName: !!entry.displayName,
            nameLength: String(entry.displayName || '').length,
            replySeenAt: Number(entry.replySeenAt) || 0,
            lastInboundAt: Number(entry.lastInboundAt) || 0
          };
        });
        out.targetDb = {
          total: entries.length,
          round1: entries.filter(function (e) { return e.round === 1; }).length,
          round2: entries.filter(function (e) { return e.round === 2; }).length,
          done: entries.filter(function (e) { return e.done; }).length,
          withIce: entries.filter(function (e) { return e.hasIce; }).length,
          candidates: entries.filter(function (e) {
            return !e.done && !e.blocked && e.round >= 1 && e.round <= 2 && e.hasIce;
          }).slice(0, 8)
        };
      } catch (eState) {
        out.error = String((eState && eState.message) || eState);
      }
      return out;
    }

    function runReadUnread(options) {
      var opts = options || {};
      var startedAt = Date.now();
      var maxWaitMs = clampNumber(opts.maxWaitMs, 10000, 1000, 30000);
      var errors = [];

      function finish(extra) {
        var payload = extra || {};
        payload.durationMs = Date.now() - startedAt;
        payload.errors = errors;
        return DmPulseConversation.buildConversationReport(payload);
      }

      function sampleConversation(opened) {
        var log = findDeep('[role="log"]');
        var container = log || findDeep('main') || document.body;
        var containerRect = container.getBoundingClientRect();
        var articleEls = log
          ? log.querySelectorAll('[role="article"], article')
          : findAllDeep('[role="article"], article');
        var bubbles = [];
        for (var i = 0; i < articleEls.length; i++) {
          var article = articleEls[i];
          var rect = article.getBoundingClientRect();
          var centerX = rect.left + rect.width / 2;
          var direction = DmPulseConversation.directionOf(centerX, containerRect.left, containerRect.right);
          var text = String(article.innerText || article.textContent || '').trim();
          var links = article.querySelectorAll('a[href]');
          var groups = article.querySelectorAll('[role="group"]');
          bubbles.push({
            direction: direction,
            textLength: text.length,
            linkCount: links.length,
            hasAttachment: groups.length > 0
          });
        }
        var summary = DmPulseConversation.summarizeBubbles(bubbles, {
          attachmentGroups: log ? log.querySelectorAll('[role="group"]').length : 0
        });
        var composer = findDeep('[role="textbox"][aria-label="私信"]') ||
          findDeep('[contenteditable="true"]') ||
          findDeep('textarea');
        var composerText = '';
        if (composer) {
          composerText = String(composer.value != null
            ? composer.value
            : (composer.innerText || composer.textContent || ''));
        }
        return finish({
          verdict: bubbles.length > 0 ? 'conversation_probed' : 'conversation_empty',
          opened: opened === true,
          surface: 'conversation',
          bubbleCount: summary.bubbleCount,
          peerBubbles: summary.peerBubbles,
          ownBubbles: summary.ownBubbles,
          unknownBubbles: summary.unknownBubbles,
          textBubbles: summary.textBubbles,
          linkBubbles: summary.linkBubbles,
          attachmentGroups: summary.attachmentGroups,
          lastDirection: summary.lastDirection,
          maxTextLength: summary.maxTextLength,
          hasComposer: !!composer,
          composerHasText: composerText.trim().length > 0
        });
      }

      return new Promise(function (resolve) {
        if (opts.allowOpen !== true) {
          errors.push({ atMs: 0, reason: 'allow_open_required' });
          resolve(finish({ verdict: 'open_not_allowed', opened: false }));
          return;
        }

        var surface = classifySurface(location.pathname);
        if (surface === 'conversation') {
          setTimeout(function () { resolve(sampleConversation(false)); }, 300);
          return;
        }
        if (surface !== 'list') {
          resolve(finish({ verdict: 'wrong_surface', opened: false }));
          return;
        }

        var listbox = findListboxDeep(document);
        if (!listbox) {
          resolve(finish({ verdict: 'list_not_ready', opened: false }));
          return;
        }

        var rows = listbox.querySelectorAll('a[role="option"][id^="dm-conversation-option-"]');
        var target = null;
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].querySelector('[data-icon="icon-circle-fill"]')) {
            target = rows[i];
            break;
          }
        }
        if (!target) {
          resolve(finish({ verdict: 'no_unread', opened: false }));
          return;
        }

        try {
          target.click();
        } catch (eClick) {
          errors.push({ atMs: Date.now() - startedAt, reason: 'click_failed' });
          resolve(finish({ verdict: 'open_failed', opened: false }));
          return;
        }

        var deadline = Date.now() + maxWaitMs;
        (function waitForConversation() {
          if (classifySurface(location.pathname) === 'conversation') {
            setTimeout(function () { resolve(sampleConversation(true)); }, 900);
            return;
          }
          if (Date.now() > deadline) {
            errors.push({ atMs: Date.now() - startedAt, reason: 'open_timeout' });
            resolve(finish({ verdict: 'open_timeout', opened: false }));
            return;
          }
          setTimeout(waitForConversation, 250);
        })();
      });
    }

    if (opts.action === 'read_unread') return runReadUnread(opts);

    return new Promise(function (resolve) {
      var samples = [];
      var times = [];
      var start = Date.now();
      var scroller = null;
      var originalScrollTop = null;
      var scrollSteps = 0;
      var bottomReached = false;
      var scrollAvailable = deep;
      var scanComplete = false;
      var seenRowIds = {};
      var noGrowthSteps = 0;
      var lastListbox = null;

      function pickScroller(listbox) {
        if (!listbox) return null;
        var node = listbox;
        var fallback = null;
        while (node) {
          try {
            if (node.scrollHeight - node.clientHeight > 24) {
              var style = window.getComputedStyle(node);
              var overflowY = style && style.overflowY;
              if (/^(auto|scroll|overlay)$/i.test(String(overflowY || ''))) return node;
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
        if (fallback) return fallback;
        return findNearbyScroller(listbox);
      }

      function findNearbyScroller(listbox) {
        try {
          var root = listbox.getRootNode ? listbox.getRootNode() : document;
          var box = listbox.getBoundingClientRect();
          var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
          var best = null;
          var bestHeight = 0;
          var node;
          while ((node = walker.nextNode())) {
            if (node === document.body || node === document.documentElement) continue;
            try {
              var overflow = window.getComputedStyle(node).overflowY;
              if (!/^(auto|scroll|overlay)$/i.test(String(overflow || ''))) continue;
              if (node.scrollHeight - node.clientHeight <= 24) continue;
              var rect = node.getBoundingClientRect();
              var overlaps = rect.bottom > box.top && rect.top < box.bottom &&
                rect.right > box.left && rect.left < box.right;
              if (!overlaps) continue;
              if (node.scrollHeight > bestHeight) {
                best = node;
                bestHeight = node.scrollHeight;
              }
            } catch (eNode) {}
          }
          return best;
        } catch (eNearby) {
          return null;
        }
      }

      function seenCount() {
        return Object.keys(seenRowIds).length;
      }

      function sampleVisibleInbox() {
        var surface = classifySurface(location.pathname);
        if (surface !== 'list') {
          return { surface: surface, listReady: false, loading: false, emptyState: false, rows: [] };
        }
        // 新版 X 会话栏在 closed shadow DOM 中，需遍历所有 shadow roots
        var listbox = findListboxDeep(document);
        lastListbox = listbox;
        var listReady = !!listbox;
        var statusEl = listbox.querySelector('[role="status"]') || document.querySelector('[role="status"]');
        var loadingMore = !!statusEl;
        if (!listReady) {
          return { surface: surface, listReady: false, loading: true, loadingMore: loadingMore, emptyState: false, rows: [] };
        }
        var options = listbox.querySelectorAll('a[role="option"][id^="dm-conversation-option-"]');
        var candidateRows = listbox.querySelectorAll('[data-inbox-row]');
        var rows = [];
        for (var i = 0; i < options.length; i++) {
          var el = options[i];
          var icons = [];
          var iconEls = el.querySelectorAll('[data-icon]');
          for (var j = 0; j < iconEls.length; j++) icons.push(iconEls[j].getAttribute('data-icon'));
          rows.push({
            id: el.id,
            href: el.getAttribute('href') || '',
            inboxRow: !!el.querySelector('[data-inbox-row]'),
            icons: icons,
            selfPreview: /^(你|You)[:：]/.test((el.textContent || '').trim())
          });
        }
        var knownEmptyText = /^(暂无对话|没有对话|No conversations|No messages|メッセージはありません|会話はありません)$/i.test((listbox.textContent || '').trim());
        var emptyState = rows.length === 0 && knownEmptyText;
        var loading = loadingMore && rows.length === 0 && !emptyState;
        var currentScroller = pickScroller(listbox);
        var scrollTop = currentScroller ? currentScroller.scrollTop : null;
        var scrollHeight = currentScroller ? currentScroller.scrollHeight : null;
        var clientHeight = currentScroller ? currentScroller.clientHeight : null;
        var atBottom = currentScroller
          ? currentScroller.scrollTop + currentScroller.clientHeight >= currentScroller.scrollHeight - 4
          : false;
        return {
          surface: surface,
          listReady: listReady,
          loading: loading,
          loadingMore: loadingMore,
          emptyState: emptyState,
          selectorMismatch: candidateRows.length > 0 && rows.length === 0,
          rows: rows,
          candidateCount: candidateRows.length,
          optionCount: options.length,
          scrollTop: scrollTop,
          scrollHeight: scrollHeight,
          clientHeight: clientHeight,
          bottomReached: atBottom,
          scrollerTag: currentScroller ? String(currentScroller.tagName || '').toLowerCase() : null,
          scrollerRole: currentScroller ? currentScroller.getAttribute('role') : null,
          scrollerMatchesListbox: currentScroller === listbox,
          scrollerInShadow: currentScroller ? currentScroller.getRootNode() !== document : false
        };
      }

      function finishDeep() {
        if (scroller && originalScrollTop !== null) {
          try { scroller.scrollTop = originalScrollTop; } catch (eRestore) {}
        }
        var result = DmPulsePulse.runReadonlyPulse({
          samples: samples,
          now: times,
          budgetMs: budgetMs,
          intervalMs: intervalMs,
          mode: 'deep',
          probeRev: '0.5.5',
          pageState: readPageState(),
          scrollMeta: {
            scrollSteps: scrollSteps,
            bottomReached: bottomReached,
            restoredScroll: !!(scroller && originalScrollTop !== null),
            scrollAvailable: scrollAvailable,
            scanComplete: scanComplete || bottomReached || noGrowthSteps >= 2
          }
        });
        resolve(DmPulseReport.buildPublicReport(result));
      }

      function tick() {
        var elapsed = Date.now() - start;
        var sample = sampleVisibleInbox();
        sample.scrollStep = scrollSteps;
        sample.bottomReached = bottomReached;
        samples.push(sample);
        times.push(elapsed);

        if (deep) {
          if (!scroller && lastListbox) {
            scroller = pickScroller(lastListbox);
            if (scroller) originalScrollTop = scroller.scrollTop;
            else scrollAvailable = false;
          }
          var before = seenCount();
          var rows = sample.rows || [];
          for (var r = 0; r < rows.length; r++) seenRowIds[rows[r].id] = 1;
          var grew = seenCount() > before;

          if (elapsed >= budgetMs - settleMs || scrollSteps >= maxScrolls || bottomReached) {
            finishDeep();
            return;
          }

          if (!scroller) {
            var canFinishEmpty = rows.length === 0 && sample.emptyState === true && elapsed >= emptyGraceMs;
            if ((rows.length > 0 && samples.length >= 2) || canFinishEmpty) {
              scanComplete = true;
              finishDeep();
              return;
            }
            setTimeout(tick, settleMs);
            return;
          }

          if (scrollSteps > 0) {
            if (!grew) {
              noGrowthSteps++;
              if (noGrowthSteps >= 2) {
                finishDeep();
                return;
              }
            } else {
              noGrowthSteps = 0;
            }
          }

          try {
            var beforeTop = scroller.scrollTop;
            scroller.scrollTop = Math.min(scroller.scrollTop + scrollStepPx, scroller.scrollHeight);
            scrollSteps++;
            bottomReached = scroller.scrollTop === beforeTop ||
              scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
          } catch (eScrollStep) {
            scrollAvailable = false;
            finishDeep();
            return;
          }
          setTimeout(tick, settleMs);
          return;
        }

        var result = DmPulsePulse.runReadonlyPulse({
          samples: samples,
          now: times,
          budgetMs: budgetMs,
          intervalMs: intervalMs,
          mode: 'snapshot',
          probeRev: '0.5.5',
          pageState: readPageState()
        });
        var terminal = result.verdict !== 'samples_exhausted' && result.verdict !== 'loading_timeout';
        if (elapsed >= budgetMs || terminal) {
          resolve(DmPulseReport.buildPublicReport(result));
          return;
        }
        setTimeout(tick, intervalMs);
      }
      tick();
    });
};

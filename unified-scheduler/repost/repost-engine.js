// =============================================================================
// 转帖引擎：两阶段原创发（非原生转推）
// 1) 来源主页：抓取文案+图 → strip @ → savePending → 跳发帖页
// 2) 发帖页：系统剪贴板复制一次 → 粘贴/注图发送（禁来源页就地发、禁 Retweet/Quote）
//    「复制」文案仅在真写剪贴板时出现；抓取阶段禁止再说复制（防「复制两边」观感）
// 硬规则：禁视频；正文禁止 @；失败进 skip 不循环
// =============================================================================
(function () {
  'use strict';
  if (window.RepostEngine) return;

  var NAME = 'repost';
  var MAX_CONSECUTIVE_FAILS = 5;
  var FUSE_COOLDOWN_MS = 20 * 60 * 1000;   // 熔断后冷却 20 分钟再继续
  var ZERO_POST_COOLDOWN_MS = 30 * 60 * 1000; // 本轮 0 条成功后冷却 30 分钟再扫一轮
  var isProcessing = false;
  var pendingStopReason = null; // repostTweet 执行中收到的 stop 请求，延迟到安全点执行
  var consecutiveFails = 0;
  var fuseCoolingUntil = 0; // 熔断冷却结束时间戳
  var processedThisRun = {};
  var tickTimer = null;
  var wdTimer = null;
  var sleepTimers = [];

  // 方案：先抓取内容到本地，再导航到首页发帖（避免在来源号主页发帖被检测为转帖）
  var PENDING_CONTENT_KEY = 'sg_repost_pending_content';

  function blobToBase64(blob) {
    return new Promise(function (resolve) {
      try {
        var reader = new FileReader();
        reader.onloadend = function () { resolve(reader.result || ''); };
        reader.onerror = function () { resolve(''); };
        reader.readAsDataURL(blob);
      } catch (e) { resolve(''); }
    });
  }

  function base64ToBlob(base64) {
    try {
      var parts = base64.split(',');
      var mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/jpeg';
      var bytes = atob(parts[1] || '');
      var arr = new Uint8Array(bytes.length);
      for (var i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
      return new Blob([arr], { type: mime });
    } catch (e) { return null; }
  }

  // ── 4.6.111：X GraphQL 直发（经 MAIN world page-diag-bridge RPC）──────────
  // 实测（2026-10-13）：CreateTweet 不强制 x-client-transaction-id，
  // 复用 X 自身请求的 qid+features+Bearer 即可直发，绕开合成事件指纹。
  // 模板由 MAIN 观察器在 X 前端真实发帖成功后自动播种（localStorage）；
  // 无模板/qid 失效（403/404）/网络异常 → 回退现有 UI 拟人路径，UI 成功即重新播种。
  var XAPI_SEED_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  function isApiDirectEnabled() {
    try { return localStorage.getItem('sg_repost_api_direct') === '1'; } catch (e) { return false; }
  }
  function xapiCall(action, payload, timeoutMs) {
    return new Promise(function (resolve) {
      var id = 'xapi_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      var done = false;
      function onMsg(e) {
        if (e.source !== window || !e.data || e.data.type !== '__sg_xapi_response' || e.data.id !== id) return;
        done = true;
        window.removeEventListener('message', onMsg);
        resolve(e.data.value);
      }
      window.addEventListener('message', onMsg);
      try {
        window.postMessage({ type: '__sg_xapi_request', id: id, action: action, payload: payload || {} }, '*');
      } catch (e) {
        done = true;
        window.removeEventListener('message', onMsg);
        resolve({ ok: false, reason: 'rpc_post_failed', error: String(e && e.message || e) });
        return;
      }
      setTimeout(function () {
        if (done) return;
        done = true;
        window.removeEventListener('message', onMsg);
        resolve({ ok: false, reason: 'rpc_timeout' });
      }, timeoutMs || 15000);
    });
  }
  // 反垃圾/日限命中时填满当日配额（与 UI 路径同口径）
  function fillDailyQuotaForApiStop() {
    try {
      var lim = T().getEffectiveDailyLimit ? T().getEffectiveDailyLimit() : 10;
      if (T().setDailyCount) T().setDailyCount(lim);
      else for (var k = 0; k < lim; k++) T().bumpDaily();
    } catch (eFill) {}
  }

  function savePendingContent(text, mediaFiles, sourceHandle, tweetId) {
    return new Promise(function (resolve) {
      try {
        var pending = {
          text: text,
          sourceHandle: sourceHandle,
          tweetId: tweetId,
          id: tweetId,
          requireMedia: !!(mediaFiles && mediaFiles.length),
          timestamp: Date.now()
        };
        if (mediaFiles && mediaFiles.length) {
          pending.mediaCount = mediaFiles.length;
          pending.mediaBase64 = 'PENDING'; // 标记异步填充中
        }
        // 先存文字，图片异步转 base64 后补充
        sessionStorage.setItem(PENDING_CONTENT_KEY, JSON.stringify(pending));
        if (mediaFiles && mediaFiles.length) {
          var converted = [];
          var idx = 0;
          function convertNext() {
            if (idx >= mediaFiles.length) {
              pending.mediaBase64 = converted;
              try {
                sessionStorage.setItem(PENDING_CONTENT_KEY, JSON.stringify(pending));
                resolve(true);
              } catch (eStorage) {
                // sessionStorage 空间不足（图片太大）：丢弃图片，只存文字
                pending.mediaBase64 = null;
                pending.mediaCount = 0;
                pending.mediaNote = 'storage_full_images_dropped';
                sessionStorage.setItem(PENDING_CONTENT_KEY, JSON.stringify(pending));
                resolve(true);
              }
              return;
            }
            blobToBase64(mediaFiles[idx].blob).then(function (b64) {
              converted.push({ base64: b64, ext: mediaFiles[idx].ext, type: mediaFiles[idx].type });
              idx++;
              convertNext();
            });
          }
          convertNext();
        } else {
          resolve(true);
        }
      } catch (e) { resolve(false); }
    });
  }

  function loadPendingContent() {
    try {
      var raw = sessionStorage.getItem(PENDING_CONTENT_KEY);
      if (!raw) return null;
      var pending = JSON.parse(raw);
      // 超时检查（5分钟）
      if (Date.now() - (pending.timestamp || 0) > 5 * 60 * 1000) {
        sessionStorage.removeItem(PENDING_CONTENT_KEY);
        return null;
      }
      // mediaBase64 还在异步转换中
      if (pending.mediaBase64 === 'PENDING') return null;
      return pending;
    } catch (e) { return null; }
  }

  function clearPendingContent() {
    try { sessionStorage.removeItem(PENDING_CONTENT_KEY); } catch (e) {}
  }

  function T() { return window.RepostTracker; }
  function log() {
    try {
      if (typeof Logger !== 'undefined') Logger.info.apply(Logger, ['转帖'].concat([].slice.call(arguments)));
      else console.log.apply(console, ['[转帖]'].concat([].slice.call(arguments)));
    } catch (e) {}
  }

  /** 比特等无控制台环境：面板读此键显示当前步骤；空串=清除。
   *  「复制」仅表示已写入系统剪贴板；抓取/存待发禁止用复制字样。 */
  function setRepostLastMsg(msg) {
    var s = String(msg || '').trim();
    try {
      if (!s) localStorage.removeItem('sg_repost_last_msg');
      else localStorage.setItem('sg_repost_last_msg', s);
    } catch (eLs) {}
    try {
      window.dispatchEvent(new CustomEvent('sg-repost-status', { detail: { message: s } }));
    } catch (eEv) {}
  }

  async function copyPlainToSystemClipboard(text) {
    var want = String(text || '');
    if (!want) return false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(want);
        return true;
      }
    } catch (eNc) {}
    try {
      var ta = document.createElement('textarea');
      ta.value = want;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (eTa) {}
    return false;
  }

  function cancelSleeps() {
    sleepTimers.forEach(function (id) { clearTimeout(id); });
    sleepTimers.length = 0;
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      if (!EngineUtils.isActive(NAME)) return resolve();
      var id = setTimeout(function () {
        var i = sleepTimers.indexOf(id);
        if (i >= 0) sleepTimers.splice(i, 1);
        resolve();
      }, ms);
      sleepTimers.push(id);
    });
  }

  function mediaGateOpen(reason) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ action: 'media_gate_open', reason: reason || 'repost' }, function (r) {
          void chrome.runtime.lastError;
          resolve(r || { ok: false });
        });
      } catch (e) { resolve({ ok: false }); }
    });
  }

  function mediaGateClose(reason) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ action: 'media_gate_close', reason: reason || 'repost' }, function (r) {
          void chrome.runtime.lastError;
          resolve(r || { ok: false });
        });
      } catch (e) { resolve({ ok: false }); }
    });
  }

  function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function writeModuleState(s) {
    try { sessionStorage.setItem('sg_module_repost', JSON.stringify(s)); } catch (e) {}
  }

  function ping(phase) {
    EngineUtils.ping(NAME);
    try {
      var ms = JSON.parse(sessionStorage.getItem('sg_module_repost') || '{}');
      ms.lastActive = Date.now();
      if (phase) ms.phase = phase;
      sessionStorage.setItem('sg_module_repost', JSON.stringify(ms));
    } catch (e) {}
  }

  /** 仅 modal/确认层/compose 路由；首页内联 What's happening 不算「发帖窗仍开」 */
  function composeStillOpen() {
    if (document.querySelector('[role="dialog"] [data-testid="tweetTextarea_0"]') ||
        document.querySelector('[data-testid="modal"] [data-testid="tweetTextarea_0"]')) {
      return true;
    }
    return !!(
      document.querySelector('[data-testid="confirmationSheetDialog"]') ||
      document.querySelector('[data-testid="confirmationSheetConfirm"]') ||
      document.querySelector('[role="alertdialog"]') ||
      document.querySelector('a[href="/compose/post"][aria-current]') ||
      (location.pathname || '').indexOf('/compose/') === 0
    );
  }

  function findLeaveConfirmSheet() {
    return (
      document.querySelector('[data-testid="confirmationSheetDialog"]') ||
      document.querySelector('[role="alertdialog"]') ||
      document.querySelector('[data-testid="sheetDialog"]') ||
      null
    );
  }

  /** 点「放弃/离开/Discard」确认；旧正则缺 Leave/离开，会卡在「是否离开」层导致长时间不工作 */
  function clickDiscardConfirm() {
    var sheet = findLeaveConfirmSheet();
    // 无 sheet 时仍扫全页确认钮（部分语言/布局 testid 不同）
    var scope = sheet || document;
    var btn =
      (sheet && (sheet.querySelector('[data-testid="confirmationSheetConfirm"]') ||
        sheet.querySelector('button[data-testid="confirmationSheetConfirm"]'))) ||
      document.querySelector('[data-testid="confirmationSheetConfirm"]');
    if (!btn) {
      var buttons = scope.querySelectorAll('button, [role="button"]');
      for (var i = 0; i < buttons.length; i++) {
        var el = buttons[i];
        var t = ((el.innerText || el.textContent || '') + '').replace(/\s+/g, ' ').trim();
        var aria = ((el.getAttribute('aria-label') || '') + '').trim();
        var label = t || aria;
        if (!label) continue;
        // 明确排除取消/留下
        if (/^(Cancel|取消|キャンセル|Stay|留下|保存|Save|編集を続ける)/i.test(label)) continue;
        if (/Cancel|取消|Stay|留下|続ける/i.test(label) && !/Discard|Leave|放弃|离开|破棄|削除/i.test(label)) continue;
        if (
          /^(Discard|Delete|Leave|放弃|丢弃|删除|舍弃|离开|破棄|削除)/i.test(label) ||
          /Discard|Delete|Leave|放弃草稿|放弃|离开|破棄|このまま閉じる|Discard post|Leave page/i.test(label)
        ) {
          btn = el;
          break;
        }
      }
    }
    if (btn) {
      try {
        if (typeof EngineUtils !== 'undefined' && EngineUtils.humanClick) {
          EngineUtils.humanClick(btn);
        } else {
          btn.click();
        }
        return true;
      } catch (e) {
        try { btn.click(); return true; } catch (e2) {}
      }
    }
    return false;
  }

  function clickComposeClose() {
    var btn =
      document.querySelector('[data-testid="app-bar-close"]') ||
      document.querySelector('[aria-label="Close"]') ||
      document.querySelector('[aria-label="关闭"]') ||
      document.querySelector('[aria-label="閉じる"]') ||
      document.querySelector('[aria-label="Close" i]') ||
      document.querySelector('[aria-label="关闭" i]');
    if (btn) {
      try { btn.click(); return true; } catch (e) {}
    }
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
      return true;
    } catch (e2) {}
    return false;
  }

  function sleepRaw(ms) {
    return new Promise(function (resolve) {
      var id = setTimeout(function () {
        var i = sleepTimers.indexOf(id);
        if (i >= 0) sleepTimers.splice(i, 1);
        resolve();
      }, ms);
      sleepTimers.push(id);
    });
  }

  /** 强关发帖层：关按钮 +「是否离开」确认；必须点到 Discard/离开，否则会卡死整轮 */
  async function closeCompose(opts) {
    opts = opts || {};
    var force = !!opts.force;
    var wait = force ? sleepRaw : sleep;
    try {
      if (typeof SchedulerGate !== 'undefined' && SchedulerGate.prepareLeave) SchedulerGate.prepareLeave();
    } catch (ePl0) {}

    var rounds = 0;
    while (rounds < 10 && composeStillOpen() && (force || EngineUtils.isActive(NAME))) {
      rounds++;
      // 已在「是否离开」层：优先点确认，别再 Escape（可能反复弹）
      if (findLeaveConfirmSheet() || document.querySelector('[data-testid="confirmationSheetConfirm"]')) {
        if (clickDiscardConfirm()) {
          await wait(400);
          continue;
        }
        log('离开确认框未点到按钮，重试 round=' + rounds);
        await wait(350);
        clickDiscardConfirm();
        await wait(400);
        continue;
      }
      clickComposeClose();
      await wait(450);
      if (clickDiscardConfirm()) {
        await wait(400);
      }
    }
    // 仍开着：最后再清一次
    if (composeStillOpen()) {
      try {
        if (typeof SchedulerGate !== 'undefined' && SchedulerGate.prepareLeave) SchedulerGate.prepareLeave();
      } catch (e) {}
      clickComposeClose();
      await wait(450);
      clickDiscardConfirm();
      await wait(450);
      clickDiscardConfirm();
      await wait(400);
    }
    if (composeStillOpen()) {
      var stuckLeave = !!(findLeaveConfirmSheet() || document.querySelector('[data-testid="confirmationSheetConfirm"]'));
      log(stuckLeave ? '卡在「是否离开」确认框，未能关闭' : '发帖窗未能完全关闭');
      return false;
    }
    return true;
  }

  function extractTweetId(article) {
    var link = article.querySelector('a[href*="/status/"]');
    if (!link) return '';
    var m = (link.getAttribute('href') || link.href || '').match(/\/status\/(\d+)/);
    return m ? m[1] : '';
  }

  function hasVideo(article) {
    if (!article) return false;
    if (article.querySelector('video')) return true;
    if (article.querySelector('[data-testid="videoPlayer"], [data-testid="videoComponent"]')) return true;
    // 播放按钮常见于视频卡
    if (article.querySelector('[data-testid="playButton"]')) return true;
    return false;
  }

  function hasPhoto(article) {
    return !!(article && article.querySelector('[data-testid="tweetPhoto"] img'));
  }

  function hasKana(s) {
    return /[\u3040-\u309f\u30a0-\u30ff\uff66-\uff9f]/.test(String(s || ''));
  }

  /** 取帖文全文（不优先假 ja 子节点，避免翻译层掩盖原文） */
  function extractTweetText(article) {
    if (!article) return '';
    var textEl = article.querySelector('[data-testid="tweetText"]');
    if (!textEl) return '';
    return (textEl.innerText || textEl.textContent || '').trim();
  }

  function hasForeignScript(s) {
    return /[\u0900-\u097F\u0600-\u06FF\u0400-\u04FF\u0E00-\u0E7F\uAC00-\uD7AF\u0370-\u03FF]/.test(String(s || ''));
  }

  /** 只要日语：须有假名；外国文/纯中文/英文/纯图一律不转 */
  function isJapaneseTweet(article) {
    if (!article) return false;
    var textEl = article.querySelector('[data-testid="tweetText"]');
    if (!textEl) return false;
    var raw = extractTweetText(article);
    if (!raw) return false;
    if (hasForeignScript(raw)) return false;
    if (hasKana(raw)) return true;
    return false;
  }

  async function revealOriginalOnArticle(article) {
    if (!article) return false;
    var nodes = article.querySelectorAll('button, [role="button"], span[role="button"], a');
    for (var i = 0; i < nodes.length; i++) {
      var lab = ((nodes[i].innerText || nodes[i].getAttribute('aria-label') || '') + '').replace(/\s+/g, ' ').trim();
      if (!lab || lab.length > 60) continue;
      if (/Translate|翻译|翻訳/i.test(lab) && !/original|原文/i.test(lab)) continue;
      if (/Show original|See original|查看原文|顯示原文|原文を表示|원문 보기/i.test(lab)) {
        try { nodes[i].click(); } catch (eC) {}
        await sleep(450);
        return true;
      }
    }
    return false;
  }

  function tweetMatchesType(article, postType, banVideo) {
    if (banVideo !== false && hasVideo(article)) return false;
    var photo = hasPhoto(article);
    if (postType === 'text') return !photo && !hasVideo(article);
    if (postType === 'image') return photo && !hasVideo(article);
    // text_or_image / all（仍禁视频）
    return !hasVideo(article);
  }

  /** 置顶帖多为广告，一律不转。X 标签在 socialContext，整卡 innerText 往往从显示名开始。 */
  function isPinnedTweet(article) {
    if (!article) return false;
    var PIN_RE = /Pinned|置顶|固定された|固定済み|ピン留め|ピン付き/;
    var ctx = article.querySelector('[data-testid="socialContext"]');
    if (ctx) {
      var ctxText = ((ctx.innerText || ctx.textContent || '') + ' ' + (ctx.getAttribute('aria-label') || '')).replace(/\s+/g, ' ');
      if (PIN_RE.test(ctxText)) return true;
      try {
        var paths = ctx.querySelectorAll('svg path');
        for (var p = 0; p < paths.length; p++) {
          var d = paths[p].getAttribute('d') || '';
          // X 置顶图钉 path 特征（避免误伤转发/回复图标）
          if (d.indexOf('M7 4.5') === 0 || d.indexOf('M16 3v4.5') === 0) return true;
        }
      } catch (eSvg) {}
    }
    try {
      var nodes = article.querySelectorAll('[aria-label]');
      for (var i = 0; i < nodes.length; i++) {
        var al = nodes[i].getAttribute('aria-label') || '';
        if (PIN_RE.test(al)) return true;
      }
    } catch (eAl) {}
    var head = (article.innerText || '').slice(0, 120);
    if (/^\s*(Pinned|置顶|固定された|固定済み|ピン留め)/m.test(head)) return true;
    if (/\n\s*(Pinned|置顶|固定された|ピン留め)\s*\n/.test(head)) return true;
    return false;
  }

  function stripMentions(text, sourceHandle) {
    var t = String(text || '');
    t = t.replace(/Replying to\s*@?\w*/ig, '');
    t = t.replace(/@\w+/g, '');
    if (sourceHandle) {
      var re = new RegExp('@?' + sourceHandle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
      t = t.replace(re, '');
    }
    return t.replace(/\n{3,}/g, '\n\n').replace(/  +/g, ' ').trim();
  }

  /** 发帖前：编辑器内不得残留 @来源博主。
   *  4.6.36：只读检测，禁止重写粘贴（正文整次 compose 只复制一次）。
   *  写入前已 stripMentions；若粘贴后仍见 @，调用方 mention_blocked 放弃。 */
  async function scrubEditorMentions(editor, sourceHandle) {
    if (!editor) return '';
    return ((editor.innerText || editor.textContent || '') + '').trim();
  }

  /** 4.6.36：验证归一化——Lexical 常改空白，禁止因此二次粘贴 */
  function normalizeComposeText(s) {
    return String(s || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function verifyComposeText(got, want) {
    var g = normalizeComposeText(got);
    var w = normalizeComposeText(want);
    if (!w) return { ok: true, reason: 'empty_want' };
    if (g === w) return { ok: true, reason: 'exact' };
    if (g.replace(/\s+/g, '') === w.replace(/\s+/g, '')) return { ok: true, reason: 'ws_collapsed' };
    var prefixLen = Math.min(40, w.length, g.length);
    if (prefixLen >= 8 && g.slice(0, prefixLen) === w.slice(0, prefixLen) && g.length >= w.length * 0.85) {
      return { ok: true, reason: 'near' };
    }
    return { ok: false, reason: 'mismatch', gotLen: g.length, wantLen: w.length };
  }

  function editorHasSourceMention(editor, sourceHandle) {
    var text = (editor && (editor.innerText || editor.textContent) || '');
    if (/@\w+/.test(text)) return true;
    if (sourceHandle && new RegExp('@?' + sourceHandle + '\\b', 'i').test(text)) return true;
    return false;
  }

  function waitFor(sel, timeout) {
    return new Promise(function (resolve) {
      var start = Date.now();
      (function check() {
        if (!EngineUtils.isActive(NAME)) return resolve(null);
        var el = document.querySelector(sel);
        if (el) return resolve(el);
        if (Date.now() - start > (timeout || 10000)) return resolve(null);
        var id = setTimeout(check, 250);
        sleepTimers.push(id);
      })();
    });
  }

  function waitForEnabled(sel, timeout) {
    return new Promise(function (resolve) {
      var start = Date.now();
      (function check() {
        if (!EngineUtils.isActive(NAME)) return resolve(null);
        var el = document.querySelector(sel);
        if (el && !el.disabled && el.getAttribute('aria-disabled') !== 'true') return resolve(el);
        if (Date.now() - start > (timeout || 60000)) return resolve(null);
        var id = setTimeout(check, 400);
        sleepTimers.push(id);
      })();
    });
  }

  function waitForGone(sel, timeout) {
    return new Promise(function (resolve) {
      var start = Date.now();
      (function check() {
        if (!EngineUtils.isActive(NAME)) return resolve(false);
        if (!document.querySelector(sel)) return resolve(true);
        if (Date.now() - start > (timeout || 20000)) return resolve(false);
        var id = setTimeout(check, 300);
        sleepTimers.push(id);
      })();
    });
  }

  async function fetchBlob(url) {
    try {
      var r = await fetch(url);
      if (!r.ok) throw new Error('fetch_' + r.status);
      return await r.blob();
    } catch (e1) {
      var r2 = await fetch(url, { credentials: 'omit', mode: 'cors', cache: 'no-cache' });
      if (!r2.ok) throw new Error('fetch_' + r2.status);
      return await r2.blob();
    }
  }

  /** X compose：系统剪贴板复制一次 + 粘贴一次。禁止 selectAll+delete；有残留仅全选后 paste 覆盖。
   *  合成 paste 无效时兜底 insertText 一次（不算第二次「复制」）。 */
  async function insertEditorText(editor, text) {
    if (!editor) return false;
    var want = String(text || '');
    if (!want) return true;

    function read() {
      return ((editor.innerText || editor.textContent || '') + '').trim();
    }

    // 真写剪贴板才说「复制」——与抓取阶段「抓取文案」区分，避免复制两边观感
    setRepostLastMsg('复制到剪贴板 ' + want.length + ' 字…');
    var clipOk = await copyPlainToSystemClipboard(want);
    log('系统剪贴板写入 ' + want.length + ' 字' + (clipOk ? '' : '（失败，将合成粘贴）'));
    setRepostLastMsg('粘贴正文 ' + want.length + ' 字…');

    editor.focus();
    await sleep(rand(300, 700));

    var before = read();
    if (before) {
      try { document.execCommand('selectAll', false); } catch (eSel) {}
      await sleep(rand(80, 180));
      log('编辑器有残留 ' + before.length + ' 字，全选后粘贴覆盖（不 delete）');
    }

    var pasted = false;
    if (clipOk) {
      try { pasted = document.execCommand('paste'); } catch (ePasteCmd) { pasted = false; }
    }
    if (!pasted) {
      try {
        var dt = new DataTransfer();
        dt.setData('text/plain', want);
        editor.dispatchEvent(new ClipboardEvent('paste', {
          clipboardData: dt,
          bubbles: true,
          cancelable: true
        }));
        pasted = true;
      } catch (ePaste) {
        try {
          document.execCommand('insertText', false, want);
          pasted = true;
        } catch (eExec) {}
      }
    }
    await sleep(rand(600, 1200));

    var got = read();
    var v = verifyComposeText(got, want);
    if (!v.ok && got.length < Math.min(8, want.length)) {
      log('粘贴未进编辑器，insertText 兜底一次');
      try { document.execCommand('insertText', false, want); } catch (eIns) {}
      await sleep(rand(500, 900));
      got = read();
      v = verifyComposeText(got, want);
    }
    log('粘贴核对 want=' + want.length + ' got=' + got.length + ' verify=' + v.reason);
    if (v.ok) setRepostLastMsg('正文已粘贴 ' + got.length + ' 字');
    return !!v.ok;
  }

  function looksLikePostSuccessToast(txt) {
    return /Your post was sent|Post sent|已发送|已发帖|已发布|发布成功|posted|tweeted|送信済|送信しました/i.test(String(txt || ''));
  }

  /** 发帖成功信号：优先 toast；编辑器消失须排除「是否离开」放弃路径 */
  function detectComposePostSuccess(initialUrl, opts) {
    opts = opts || {};
    try {
      var toastTxt = '';
      var toasts = document.querySelectorAll('[data-testid="toast"], [role="status"], [role="alert"]');
      for (var ti = 0; ti < toasts.length; ti++) {
        toastTxt += ' ' + (toasts[ti].innerText || '');
      }
      if (looksLikePostSuccessToast(toastTxt)) return { ok: true, reason: 'toast' };
    } catch (eT) {}
    // 放弃/离开确认层：不算发帖成功（否则关窗会被误记）
    try {
      if (findLeaveConfirmSheet() || document.querySelector('[data-testid="confirmationSheetConfirm"]')) {
        return { ok: false, reason: 'leave_confirm' };
      }
    } catch (eL) {}
    // 全页 /compose/post：发成功后常仍停在此页，编辑器被清空、发送钮禁用
    try {
      if (isComposePage()) {
        var edC = document.querySelector('[data-testid="tweetTextarea_0"]');
        var lenC = edC ? ((edC.innerText || edC.textContent || '') + '').trim().length : 0;
        var btnLive = document.querySelector('[data-testid="tweetButton"]:not([disabled]), [data-testid="tweetButtonInline"]:not([disabled])');
        var beforeLen = opts.beforeTextLen || 0;
        if (beforeLen >= 8 && lenC <= 2) {
          return { ok: true, reason: 'compose_cleared' };
        }
        if (edC && lenC <= 2 && !btnLive) {
          return { ok: true, reason: 'compose_empty_no_btn' };
        }
        try {
          if (initialUrl && location.href !== initialUrl && !/\/compose\//.test(location.pathname || '')) {
            return { ok: true, reason: 'left_compose' };
          }
        } catch (eLc) {}
      }
    } catch (eCp) {}
    if (!document.querySelector('[data-testid="tweetTextarea_0"]')) {
      // 编辑器没了且 compose 层也关了 → 通常已发出
      if (!composeStillOpen()) return { ok: true, reason: 'editor_gone' };
      // 编辑器没了但弹层还在且无发送钮 → 也可认
      if (!document.querySelector('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]')) {
        return { ok: true, reason: 'editor_gone_no_btn' };
      }
    }
    try {
      if (initialUrl && location.href !== initialUrl && !/compose/.test(location.pathname || '')) {
        return { ok: true, reason: 'url_changed' };
      }
    } catch (eU) {}
    return { ok: false, reason: '' };
  }

  /** 发送真兜底：合成 humanClick 常被 X 忽略；仍开着则再原生 click 一次（防双发：成功/按钮禁用则不补点） */
  async function clickPostButtonWithFallback(postBtn) {
    if (!postBtn) return false;
    log('发送 click try=1 humanClick');
    try { await EngineUtils.humanClick(postBtn); } catch (eH) {
      try { postBtn.click(); } catch (eC0) {}
    }
    await sleep(rand(1500, 2500));
    if (detectComposePostSuccess(location.href).ok) {
      log('发送 try=1 已见成功信号，跳过 native');
      return true;
    }
    var stillOpen = !!document.querySelector('[data-testid="tweetTextarea_0"]');
    if (!stillOpen) return true;
    var btnStill =
      document.querySelector('[data-testid="tweetButton"]:not([disabled]), [data-testid="tweetButtonInline"]:not([disabled])') ||
      null;
    if (!btnStill) {
      log('发送按钮已消失/禁用，跳过 native');
      return true;
    }
    var btnEnabled = !btnStill.disabled && btnStill.getAttribute('aria-disabled') !== 'true';
    if (!btnEnabled) return true;
    log('发送 click try=2 native（合成点击未生效）');
    try { btnStill.click(); } catch (eC) {
      try { postBtn.click(); } catch (eC2) {}
    }
    await sleep(rand(600, 1200));
    return true;
  }

  function creditRepostSuccess(id, why) {
    if (id) {
      try { T().markPosted(id); } catch (eM) {}
    } else {
      try { if (T().markOwnPosted) T().markOwnPosted(); } catch (eOwn) {}
    }
    try { if (T().markLastOkAt) T().markLastOkAt(Date.now()); } catch (eOk) {}
    try { T().bumpDaily(); } catch (eB) {}
    var used = 0;
    var cap = 1;
    try { used = (T().getDaily() || {}).count || 0; } catch (eU) {}
    try { cap = T().getEffectiveDailyLimit ? T().getEffectiveDailyLimit() : (T().getDailyQuota ? T().getDailyQuota() : 1); } catch (eC) {}
    var ownHs = [];
    try { if (T().ownHandleCandidates) ownHs = T().ownHandleCandidates(); } catch (eHs) {}
    setRepostLastMsg('✓发帖成功 ' + used + '/' + cap);
    log('✓ 发帖成功，已记账（@' + (ownHs.join(' @') || 'unknown') + '）id=' + (id || '-') + ' via=' + (why || '') + ' daily=' + used + '/' + cap);
  }

  // H9 来源号被动检测：进来源主页检出冻结/不存在 → 上报 OPS 标 banned，本来源跳过
  function detectSourceDeadPage() {
    var txt = '';
    try {
      var empty = document.querySelector('[data-testid="emptyState"]');
      txt = (empty ? empty.innerText : '') || '';
      if (!txt) {
        var col = document.querySelector('[data-testid="primaryColumn"]');
        txt = (col ? col.innerText : '').slice(0, 2000);
      }
    } catch (e) { return ''; }
    if (/account suspended|アカウントは凍結|账号已被冻结|此账号已被冻结|帳號已被凍結/i.test(txt)) return 'suspended';
    if (/this account doesn.t exist|アカウントは存在しません|此账号不存在|此帳號不存在|account doesn.t exist/i.test(txt)) return 'not_exist';
    return '';
  }

  function reportSourceStatus(handle, status, note) {
    try {
      var h = String(handle || '').replace(/^@/, '').toLowerCase().trim();
      if (!h) return;
      var key = 'sg_rp_src_reported_' + status + '_' + h;
      // 同状态每号每天只报一次，防抖
      var day = new Date().toISOString().slice(0, 10);
      if (sessionStorage.getItem(key) === day) return;
      sessionStorage.setItem(key, day);
      chrome.runtime.sendMessage({ action: 'ops_repost_source_status', source: h, status: status, note: note || '' }, function () {
        void chrome.runtime.lastError;
      });
      log('已上报来源号状态 @' + h + ' → ' + status);
    } catch (e) {}
  }

  async function findLatestTweets(count, postType, banVideo) {
    var seen = {};
    var result = [];
    var scrolls = 0;
    var noNew = 0;
    var lastVisibleIds = [];
    var isManual = !(T().isAutoSlot && T().isAutoSlot());
    var minScrolls = isManual ? 3 : 0; // 手动场至少往下滚 3 屏，避免只扫顶帖

    async function scan() {
      var articles = document.querySelectorAll('article[data-testid="tweet"]');
      var visibleIds = [];
      for (var i = 0; i < articles.length; i++) {
        var article = articles[i];
        var id = extractTweetId(article);
        if (!id) continue;
        visibleIds.push(id);
        if (seen[id]) continue;
        seen[id] = true;
        if (isPinnedTweet(article)) {
          try { log('跳过置顶帖 ' + id); } catch (ePin) {}
          continue;
        }
        if (T().isPosted(id) || T().isSkipped(id)) continue;
        if (!tweetMatchesType(article, postType, banVideo)) continue;
        await revealOriginalOnArticle(article);
        if (!isJapaneseTweet(article)) {
          T().markSkipped(id, 'not_ja');
          try { log('跳过非日语帖 ' + id); } catch (eJa) {}
          continue;
        }
        result.push(article);
        if (result.length >= count) return { enough: true, hasNew: true };
      }
      // 虚拟列表：用「本次可见 ID 集合」变化判断是否有新内容，避免旧节点回收导致 seen 计数不涨
      var hasNew = visibleIds.some(function (vid) { return lastVisibleIds.indexOf(vid) < 0; }) ||
                   lastVisibleIds.some(function (vid) { return visibleIds.indexOf(vid) < 0; });
      lastVisibleIds = visibleIds;
      return { enough: false, hasNew: hasNew };
    }

    var first = await scan();
    if (first.enough) return result;
    while (scrolls < 40 && result.length < count && EngineUtils.isActive(NAME)) {
      window.scrollBy(0, Math.floor(window.innerHeight * rand(70, 95) / 100));
      await sleep(rand(1200, 2400));
      var s = await scan();
      scrolls++;
      if (!s.hasNew) {
        noNew++;
        if (noNew >= 6 && scrolls >= minScrolls) break;
      } else {
        noNew = 0;
      }
      if (s.enough) break;
    }
    try { log('扫描结束', 'manual=' + isManual, 'count=' + count, 'got=' + result.length, 'scrolls=' + scrolls, 'noNew=' + noNew); } catch (eL) {}
    return result;
  }

  async function repostTweet(article, sourceHandle) {
    var id = extractTweetId(article);
    if (!id) return { skipped: true, reason: 'no_id' };
    if (isPinnedTweet(article)) return { skipped: true, reason: 'pinned' };
    if (T().isPosted(id) || T().isSkipped(id)) return { skipped: true, reason: 'dedupe' };
    if (hasVideo(article)) {
      T().markSkipped(id, 'video');
      return { skipped: true, reason: 'video' };
    }
    await revealOriginalOnArticle(article);
    if (!isJapaneseTweet(article)) {
      T().markSkipped(id, 'not_ja');
      return { skipped: true, reason: 'not_ja' };
    }

    var cfg = T().getConfig();
    var cleanTxt = stripMentions(extractTweetText(article), sourceHandle);
    var finalText = cleanTxt + (cfg.appendLink ? ('\n\n' + cfg.appendLink) : '');
    // 硬规则：最终正文不得含 @
    finalText = finalText.replace(/@\w+/g, '').trim();

    var mediaFiles = [];
    var needMedia = (cfg.postType || 'text_or_image') !== 'text';
    var gateHeld = false;
    if (needMedia) {
      try {
        var go = await mediaGateOpen('repost');
        if (go && go.ok !== false) gateHeld = true;
        else log('媒体开闸失败，跳过下图', go && go.error);
        if (gateHeld) {
          if (typeof window.__sgWaitMediaAllow === 'function') {
            try { await window.__sgWaitMediaAllow(rand(3000, 5000)); } catch (eWa) {}
          }
          await sleep(rand(300, 700));
        }
      } catch (eGo) {
        log('媒体开闸异常', eGo && eGo.message);
      }
    }
    try {
      var imgs = (needMedia && !gateHeld)
        ? []
        : article.querySelectorAll('[data-testid="tweetPhoto"] img');
      var seenSrcs = {}; // 按 src 去重，避免虚拟列表 DOM 回收导致同一图片被收集两次
      for (var i = 0; i < imgs.length; i++) {
        try {
          var img = imgs[i];
          var nw = img.naturalWidth || 0;
          var nh = img.naturalHeight || 0;
          if (nw && nh && (nw < 80 || nh < 80)) continue;
          var src = img.currentSrc || img.src || '';
          if (!src) continue;
          // 去重：同一 src 只收集一次
          var srcKey = src.replace(/\?[^]*/, '');
          if (seenSrcs[srcKey]) {
            log('图片去重：跳过重复 src=' + srcKey.slice(-30));
            continue;
          }
          seenSrcs[srcKey] = true;
          var u = new URL(src, location.href);
          try { u.searchParams.set('name', 'orig'); } catch (eN) {}
          var blob = await fetchBlob(u.href);
          // 二次去重：按 blob size 去重（同一图片不同 src 可能 size 相同）
          var sizeKey = String(blob && blob.size || 0);
          if (mediaFiles.some(function (m) { return m.blob && m.blob.size === blob.size; })) {
            log('图片去重：跳过重复 size=' + sizeKey);
            continue;
          }
          if (blob && blob.size > 1000) {
            var mime = blob.type || 'image/jpeg';
            var ext = /png/i.test(mime) ? 'png' : 'jpg';
            mediaFiles.push({ blob: blob, ext: ext, type: mime.indexOf('image/') === 0 ? mime : 'image/jpeg' });
          }
        } catch (e) {
          log('图片下载失败', e && e.message);
        }
      }
    } finally {
      if (gateHeld) {
        try { await mediaGateClose('repost'); } catch (eGc) {}
      }
    }

    // 产品定稿 A（图优先）：来源有图且本任务需要图，却下不到 → 整条放弃，禁止降级纯文
    if (needMedia && hasPhoto(article) && !mediaFiles.length) {
      log('来源有图但下载 0 张，图优先放弃本条（不发纯文）');
      setRepostLastMsg('跳过：图下载失败（图优先）');
      T().markSkipped(id, 'media_download_fail');
      return { skipped: true, reason: 'media_download_fail' };
    }
    if ((cfg.postType || '') === 'image' && !mediaFiles.length) {
      log('postType=image 无图，放弃');
      T().markSkipped(id, 'image_required');
      return { skipped: true, reason: 'image_required' };
    }

    if (!cleanTxt && !mediaFiles.length) {
      T().markSkipped(id, 'empty');
      return { skipped: true, reason: 'empty' };
    }

    // 抓取结束：存 pending（不是系统剪贴板；勿写「复制」）
    ping('scraping');
    var preview = finalText ? finalText.slice(0, 24).replace(/\s+/g, ' ') : '';
    setRepostLastMsg('抓取文案 ' + (finalText ? finalText.length : 0) + ' 字' +
      (mediaFiles.length ? (' · 图' + mediaFiles.length + '张') : '') +
      (preview ? (' ·「' + preview + '…」') : ''));
    log('抓取文案 ' + (finalText ? finalText.length : 0) + ' 字、图 ' + mediaFiles.length + ' 张，存待发后去发帖页');
    var saved = false;
    try {
      saved = await savePendingContent(finalText, mediaFiles, sourceHandle, id);
    } catch (eSave) {
      log('待发保存异常 ' + (eSave && eSave.message));
      saved = false;
    }
    var pendingCheck = loadPendingContent();
    if (!saved || !pendingCheck) {
      log('待发内容未就绪，放弃本条');
      clearPendingContent();
      T().markSkipped(id, 'pending_save_fail');
      return false;
    }
    // 图优先：存盘时若因空间丢图，禁止带着「只要字」去首页
    if (pendingCheck.mediaNote === 'storage_full_images_dropped' ||
        (pendingCheck.requireMedia && !(pendingCheck.mediaBase64 && pendingCheck.mediaBase64.length))) {
      log('待发丢图（storage/requireMedia），图优先放弃');
      clearPendingContent();
      T().markSkipped(id, 'media_storage_drop');
      return { skipped: true, reason: 'media_storage_drop' };
    }
    ping('navigating_home');
    setRepostLastMsg('抓取完成，跳转发帖页…');
    log('导航到发帖页发布（/compose/post 原创，非转发/@）');
    var navOk = true;
    var publishUrl = 'https://x.com/compose/post';
    if (typeof SchedulerGate !== 'undefined') {
      navOk = SchedulerGate.go('repost', publishUrl, { force: true });
    } else {
      try {
        if (typeof SchedulerGate !== 'undefined' && SchedulerGate.goRaw) navOk = !!SchedulerGate.goRaw(publishUrl, { force: true });
        else { location.href = publishUrl; navOk = true; }
      } catch (eNav) { navOk = false; }
    }
    if (!navOk) {
      log('跳转发帖页被节流/拦截，待发已保留，稍后重试');
      return { pendingDeferred: true };
    }
    return { pendingNav: true };
  }

  function isProfilePage(handle) {
    var path = (location.pathname || '').replace(/\/$/, '').toLowerCase();
    return path === '/' + handle || path.indexOf('/' + handle + '/') === 0;
  }

  function isHomePage() {
    var path = (location.pathname || '').replace(/\/$/, '') || '/';
    return path === '/home' || path === '/' || path === '/i/home';
  }

  /** 全页发帖路由（侧栏点发帖常跳到这里，比首页 modal 更稳） */
  function isComposePage() {
    var path = (location.pathname || '').toLowerCase();
    return path.indexOf('/compose/') === 0;
  }

  function isPublishReadyPage() {
    return isHomePage() || isComposePage();
  }

  // 发布待发内容：从来源号主页抓取后导航到首页，在首页打开 compose 发布
  // 返回：'sent' 已发成 | 'stop' 当日停转（反垃圾/日限） | 'skip' 跳过本条（业务错） | 其他=回退原因，继续走 UI
  async function tryApiDirectPublish(text, pid) {
    setRepostLastMsg('API 直发中…');
    var r = null;
    try {
      r = await xapiCall('createTweet', { text: text, maxAgeMs: XAPI_SEED_MAX_AGE_MS });
    } catch (e) {
      return 'rpc_exception';
    }
    if (!r) return 'empty_response';

    if (r.ok) {
      log('GraphQL 直发成功 restId=' + (r.restId || '?') + ' ' + (r.ms || '?') + 'ms');
      creditRepostSuccess(pid, 'api_direct');
      try { sessionStorage.removeItem('sg_repost_manual_slot'); } catch (eMs) {}
      return 'sent';
    }

    // 反垃圾（code 326 / 自动化措辞）：冷却 60–120 分钟 + 填满当日配额，与 UI 路径同口径
    if (r.antispam) {
      log('API 直发命中反垃圾 code=' + (r.code || '?') + ' msg=' + (r.message || ''));
      try { EngineUtils.markAntiSpamCooldown(60, 120); } catch (eCd) {}
      fillDailyQuotaForApiStop();
      if (pid) try { T().markSkipped(pid, 'antispam_detected'); } catch (eSk) {}
      return 'stop';
    }
    if (r.reason === 'daily_limit') {
      log('API 直发返回日限 code=344，填满当日配额');
      fillDailyQuotaForApiStop();
      if (pid) try { T().markSkipped(pid, 'api_daily_limit'); } catch (eSk) {}
      return 'stop';
    }
    if (r.reason === 'business') {
      // 重复推文/内容类业务错：同内容再走 UI 必再撞，跳过本条不回退
      log('API 直发业务错误 code=' + (r.code || '?') + ' msg=' + (r.message || ''));
      if (pid) try { T().markSkipped(pid, 'api_business_' + (r.code || 0)); } catch (eSk) {}
      return 'skip';
    }
    // need_seed / seed_invalid / seed_expired / seed_corrupt / no_ct0 /
    // network / rpc_timeout / rate_limited / auth_401 / unexpected → 回退 UI（多数同时完成重新播种）
    return String(r.reason || 'unknown');
  }

  async function publishPendingContent(pending) {
    var finalText = String(pending.text || '').replace(/@\w+/g, '').trim();
    var sourceHandle = pending.sourceHandle || '';
    var pid = pending.tweetId || pending.id || '';
    var mediaFiles = [];
    if (pending.mediaBase64 && pending.mediaBase64.length) {
      for (var mi = 0; mi < pending.mediaBase64.length; mi++) {
        var m = pending.mediaBase64[mi];
        var blob = base64ToBlob(m.base64);
        if (blob && blob.size > 1000) {
          mediaFiles.push({ blob: blob, ext: m.ext, type: m.type });
        }
      }
      log('恢复图片 ' + mediaFiles.length + '/' + pending.mediaBase64.length + ' 张');
    }
    if (!finalText && !mediaFiles.length) {
      return { skipped: true, reason: 'empty_pending' };
    }
    // 产品定稿 A：待发要求有图但恢复 0 张 → 放弃，不降级纯文
    if (pending.requireMedia && !mediaFiles.length) {
      log('待发要求有图但恢复 0 张，图优先放弃');
      return { skipped: true, reason: 'media_restore_fail' };
    }

    // 4.6.111：纯文本优先 GraphQL 直发（带图仍走 UI，媒体上传链路后续再收编）
    // 无种子/种子失效/网络错 → 自动回退下面的 UI 拟人路径，UI 成功即完成播种
    if (!mediaFiles.length && finalText && isApiDirectEnabled()) {
      var apiVerdict = await tryApiDirectPublish(finalText, pid);
      if (apiVerdict === 'sent') return true;
      if (apiVerdict === 'stop') return false;
      if (apiVerdict === 'skip') return { skipped: true, reason: 'api_business' };
      log('API 直发未就绪（' + apiVerdict + '），回退 UI 路径（成功后自动播种）');
    }

    ping('composing_pending');
    setRepostLastMsg('打开发帖框，准备粘贴…');

    var editor = null;
    if (isComposePage()) {
      // 已在 /compose/post：直接用本页编辑器（勿再点侧栏，会连环跳）
      log('已在发帖页，直接粘贴');
      editor = await waitFor('[data-testid="tweetTextarea_0"]', 12000);
      if (!editor) {
        // 4.6.110：编辑器未渲染 → 自愈重载一次，仍失败才放弃
        var _edRetry = parseInt(sessionStorage.getItem('sg_repost_editor_retry') || '0') + 1;
        sessionStorage.setItem('sg_repost_editor_retry', String(_edRetry));
        if (_edRetry <= 1) {
          log('发帖页编辑器未出现，软愈重载 compose (' + _edRetry + '/1)');
          setRepostLastMsg('编辑器未加载，重载发帖页…');
          try {
            if (typeof SgTelemetry !== 'undefined') SgTelemetry.emit('repost.step_mismatch', { step: 'compose_editor', page: location.pathname, action: 'heal', mismatch_count: _edRetry });
          } catch (eT) {}
          if (typeof SchedulerGate !== 'undefined' && SchedulerGate.go) SchedulerGate.go('repost', 'https://x.com/compose/post', { force: true });
          else if (typeof SchedulerGate !== 'undefined' && SchedulerGate.goRaw) SchedulerGate.goRaw('https://x.com/compose/post', { force: true });
          else location.href = 'https://x.com/compose/post';
          return { pendingNav: true };
        }
        sessionStorage.removeItem('sg_repost_editor_retry');
        log('发帖页编辑器重载后仍未出现，放弃');
        setRepostLastMsg('跳过：发帖页无编辑器');
        return false;
      }
      sessionStorage.removeItem('sg_repost_editor_retry');
    } else {
      // 首页：只点侧栏球开 modal；禁止点 a[href=/compose/post]（会整页跳走打断粘贴）
      if (composeStillOpen()) {
        log('发现残留发帖窗（modal），先关闭');
        setRepostLastMsg('关闭残留发帖窗…');
        await closeCompose({ force: true });
        await sleep(500);
        if (composeStillOpen()) {
          log('残留发帖窗关不掉，跳过');
          setRepostLastMsg('跳过：残留发帖窗关不掉');
          return false;
        }
      }
      var composeBtn = document.querySelector('[data-testid="SideNav_NewTweet_Button"]');
      if (!composeBtn) {
        // 侧栏没有 → 直接导航到全页 compose（比点链接更可控）
        log('无侧栏发帖钮，改走 /compose/post');
        setRepostLastMsg('改走发帖页…');
        if (typeof SchedulerGate !== 'undefined' && SchedulerGate.go) SchedulerGate.go('repost', 'https://x.com/compose/post', { force: true });
        else if (typeof SchedulerGate !== 'undefined' && SchedulerGate.goRaw) SchedulerGate.goRaw('https://x.com/compose/post', { force: true });
        else location.href = 'https://x.com/compose/post';
        return { pendingNav: true };
      }
      var beforeHref = location.href;
      await EngineUtils.humanClick(composeBtn);
      await sleep(rand(1400, 2600));
      // 侧栏点击若整页跳到 /compose/post：保留 pending，交给重载后续跑
      if (isComposePage() || (location.href !== beforeHref && /\/compose\//.test(location.pathname || ''))) {
        log('侧栏发帖触发整页跳转，待重载后粘贴');
        setRepostLastMsg('已进发帖页，待粘贴…');
        return { pendingNav: true };
      }
      editor = await waitFor('[role="dialog"] [data-testid="tweetTextarea_0"], [data-testid="modal"] [data-testid="tweetTextarea_0"]', 12000);
      if (!editor) {
        log('发帖框未弹出（modal 未出现），改走 /compose/post');
        setRepostLastMsg('改走发帖页…');
        if (typeof SchedulerGate !== 'undefined' && SchedulerGate.go) SchedulerGate.go('repost', 'https://x.com/compose/post', { force: true });
        else if (typeof SchedulerGate !== 'undefined' && SchedulerGate.goRaw) SchedulerGate.goRaw('https://x.com/compose/post', { force: true });
        else location.href = 'https://x.com/compose/post';
        return { pendingNav: true };
      }
    }

    if (finalText) {
      // 4.6.36：与抓取后发布一致——只粘贴一次 + 验证，不重写
      var wrote = await insertEditorText(editor, finalText);
      var isLongOrHashtag = finalText.length > 280 || /[#＃][\w\u3040-\u309f\u30a0-\u30ff]/.test(finalText);
      if (isLongOrHashtag) {
        log('长文案/含#话题（' + finalText.length + '字），等待 reconciliation 后验证');
        await sleep(rand(1500, 3000));
      } else {
        await sleep(rand(800, 1600));
      }
      var finalCheck = ((editor.innerText || editor.textContent || '') + '').trim();
      var textVerify = verifyComposeText(finalCheck, finalText);
      log('验证环节·正文：' + textVerify.reason + ' want=' + finalText.length + ' got=' + finalCheck.length);
      if (!textVerify.ok && !mediaFiles.length) {
        log('正文验证未通过且无图，放弃（不二次粘贴）');
        if (pid) try { T().markSkipped(pid, 'editor_write_fail'); } catch (eSk) {}
        await closeCompose({ force: true });
        return false;
      }
      if (!wrote && textVerify.ok) {
        log('写入即时核对偏严，验证环节已通过，继续');
      }
    }

    if (mediaFiles.length) {
      setRepostLastMsg('粘贴图片 ' + mediaFiles.length + ' 张…');
      log('准备注入图片 ' + mediaFiles.length + ' 张');
      var gateHeld2 = false;
      try {
        var go2 = await mediaGateOpen('repost');
        if (go2 && go2.ok !== false) gateHeld2 = true;
        if (gateHeld2) {
          if (typeof window.__sgWaitMediaAllow === 'function') {
            try { await window.__sgWaitMediaAllow(rand(3000, 5000)); } catch (eWa2) {}
          }
          await sleep(rand(300, 700));
        }
      } catch (eGo2) {}
      try {
        // 在 modal 内优先找 fileInput，兜底全文档
        var dialogEl = document.querySelector('[role="dialog"], [data-testid="modal"]');
        var fileInput = null;
        if (dialogEl) {
          fileInput = dialogEl.querySelector('input[type="file"]');
        }
        if (!fileInput) {
          var allInputs = document.querySelectorAll('input[type="file"]');
          for (var ai = 0; ai < allInputs.length; ai++) {
            var acc = allInputs[ai].getAttribute('accept') || '';
            if (acc.indexOf('image') >= 0 || acc.indexOf('media') >= 0) {
              fileInput = allInputs[ai];
              break;
            }
          }
          if (!fileInput && allInputs.length) fileInput = allInputs[0];
        }
        if (!fileInput) {
          log('未找到图片上传 input，干净关窗回退');
          if (pid) try { T().markSkipped(pid, 'no_file_input'); } catch (eSk2) {}
          await closeCompose({ force: true });
          return false;
        }
        log('找到 fileInput accept=' + (fileInput.getAttribute('accept') || '') + ' name=' + (fileInput.getAttribute('name') || ''));
        var dt = new DataTransfer();
        for (var fi = 0; fi < mediaFiles.length; fi++) {
          var f = new File([mediaFiles[fi].blob], 'img_' + fi + '.' + mediaFiles[fi].ext, { type: mediaFiles[fi].type });
          dt.items.add(f);
        }
        try {
          fileInput.files = dt.files;
        } catch (eSet) {
          try {
            Object.defineProperty(fileInput, 'files', { value: dt.files, configurable: true });
          } catch (eDef) {
            log('无法注入图片 file input');
            if (pid) try { T().markSkipped(pid, 'file_assign_fail'); } catch (eSk3) {}
            await closeCompose({ force: true });
            return false;
          }
        }
        try { fileInput.dispatchEvent(new Event('change', { bubbles: true })); } catch (eCh) {}
        log('图片注入（仅一次）' + mediaFiles.length + ' 张，files.length=' + (fileInput.files && fileInput.files.length));
        await sleep(500);
        // 验证环节：等预览；失败干净关窗，禁止重注
        var previewOk = false;
        var thumbCount = 0;
        for (var pi = 0; pi < 16; pi++) {
          var previewNodes = document.querySelectorAll(
            '[data-testid="attachments"] img, [data-testid="media-preview"] img, [role="dialog"] [data-testid="tweetPhoto"] img, div[aria-label*="Image"] img, div[aria-label*="图片"] img'
          );
          thumbCount = previewNodes ? previewNodes.length : 0;
          if (thumbCount > 0) { previewOk = true; break; }
          await sleep(300);
        }
        log('验证环节·图片：预览 ' + thumbCount + '/' + mediaFiles.length + (previewOk ? ' 通过' : ' 未出现'));
        if (!previewOk) {
          log('图片预览失败，干净关窗回退（不重注、不重贴）');
          if (pid) try { T().markSkipped(pid, 'media_preview_fail'); } catch (eSk4) {}
          await closeCompose({ force: true });
          return false;
        }
        await sleep(rand(800, 1500));
      } finally {
        if (gateHeld2) {
          try { await mediaGateClose('repost'); } catch (eGc2) {}
        }
      }
    }

    // 发送前只检测 @，不重写
    await scrubEditorMentions(editor, sourceHandle);
    await sleep(rand(200, 600));
    if (editorHasSourceMention(editor, sourceHandle)) {
      log('正文仍含@，放弃发送以免变成转帖（不二次粘贴清@）');
      if (pid) try { T().markSkipped(pid, 'mention_blocked'); } catch (eSk5) {}
      await closeCompose({ force: true });
      return { skipped: true, reason: 'mention_blocked' };
    }

    // 点发帖按钮（只认 Post/发帖，不认 回复/reply）
    var sendBtn = await waitForEnabled(
      '[role="dialog"] [data-testid="tweetButton"]:not([disabled]), [data-testid="modal"] [data-testid="tweetButton"]:not([disabled]), [data-testid="tweetButton"]:not([disabled])',
      60000
    );
    if (!sendBtn) {
      var btns = document.querySelectorAll('[role="dialog"] button[role="button"], [data-testid="modal"] button[role="button"]');
      for (var bi = 0; bi < btns.length; bi++) {
        var bt = btns[bi];
        var txt = (bt.innerText || '').trim().toLowerCase();
        if ((txt === 'post' || txt === '发帖') && !bt.disabled && bt.getAttribute('aria-disabled') !== 'true') {
          sendBtn = bt;
          break;
        }
      }
    }
    if (!sendBtn || sendBtn.getAttribute('aria-disabled') === 'true') {
      log('发帖按钮未就绪');
      if (pid) try { T().markSkipped(pid, 'btn_timeout'); } catch (eSk6) {}
      await closeCompose({ force: true });
      return false;
    }
    if (editorHasSourceMention(editor, sourceHandle)) {
      if (pid) try { T().markSkipped(pid, 'mention_blocked'); } catch (eSk7) {}
      await closeCompose({ force: true });
      return { skipped: true, reason: 'mention_blocked' };
    }
    await clickPostButtonWithFallback(sendBtn);
    log('已点击发帖按钮（待发，含 native 兜底）');
    ping('sending');
    setRepostLastMsg('已点发送，等待确认…');

    // 等待确认（手点发出同样算成功）
    var confirmed = false;
    var confirmWhy = '';
    var waitStart = Date.now();
    var initialUrl2 = location.href;
    var beforeTextLen = 0;
    try { beforeTextLen = ((editor.innerText || editor.textContent || '') + '').trim().length; } catch (eBt) {}
    if (finalText && beforeTextLen < finalText.length / 2) beforeTextLen = finalText.length;
    while (Date.now() - waitStart < 45000 && EngineUtils.isActive(NAME)) {
      await sleep(1000);
      var det2 = detectComposePostSuccess(initialUrl2, { beforeTextLen: beforeTextLen });
      if (det2.ok) {
        confirmed = true;
        confirmWhy = det2.reason;
        break;
      }
      // 首页 modal：关窗=成功；全页 compose 不能靠 composeStillOpen（路径一直算开）
      if (!isComposePage() && !composeStillOpen()) {
        confirmed = true;
        confirmWhy = 'compose_closed';
        break;
      }
      if (isComposePage() && !/\/compose\//.test(location.pathname || '')) {
        confirmed = true;
        confirmWhy = 'left_compose_path';
        break;
      }
      // 反垃圾文案可能在错误弹窗，也可能在 toast（4.6.110：官方「看上去可能是自动产生」句常以 toast 呈现）
      // 不扫 role=dialog——compose 弹层正文含「自动/垃圾」等词会自伤误判
      var errBoxes = document.querySelectorAll(
        '[role="alertdialog"], [role="alert"], [data-testid="toast"], [role="status"]'
      );
      var errT = '';
      for (var ebi = 0; ebi < errBoxes.length; ebi++) {
        errT += ' ' + ((errBoxes[ebi].innerText || '') + '').trim();
      }
      errT = errT.trim();
      if (errT && EngineUtils.looksLikeAntiSpam && EngineUtils.looksLikeAntiSpam(errT)) {
        if (looksLikePostSuccessToast(errT)) {
          confirmed = true;
          confirmWhy = 'toast_in_dialog';
          break;
        }
        log('发帖命中反垃圾检测，当日停止转帖并进入 60–120 分钟冷却：' + errT.slice(0, 60));
        try { EngineUtils.markAntiSpamCooldown(60, 120); } catch (eCd2) {}
        try {
          var limit2 = T().getEffectiveDailyLimit ? T().getEffectiveDailyLimit() : 10;
          if (T().setDailyCount) T().setDailyCount(limit2);
          else for (var fi2 = 0; fi2 < limit2; fi2++) T().bumpDaily();
        } catch (eFill2) {}
        if (pid) try { T().markSkipped(pid, 'antispam_detected'); } catch (eSk8) {}
        await closeCompose({ force: true });
        return false;
      }
    }

    if (!confirmed) {
      var late2 = detectComposePostSuccess(initialUrl2, { beforeTextLen: beforeTextLen });
      if (late2.ok) {
        confirmed = true;
        confirmWhy = late2.reason + '_late';
      }
    }

    if (confirmed) {
      creditRepostSuccess(pid, confirmWhy || 'pending_publish');
      try { sessionStorage.removeItem('sg_repost_manual_slot'); } catch (eMs) {}
      if (composeStillOpen() && !isComposePage()) await closeCompose({ force: true });
      return true;
    }
    log('发帖未确认（待发内容），尝试强关');
    if (pid) try { T().markSkipped(pid, 'post_unconfirmed'); } catch (eSk9) {}
    if (!isComposePage()) await closeCompose({ force: true });
    return false;
  }

  async function runOnce() {
    if (!EngineUtils.isActive(NAME) || isProcessing) return;
    if (EngineUtils.isAntiSpamCooldown && EngineUtils.isAntiSpamCooldown()) {
      var left = Math.ceil(EngineUtils.msUntilAntiSpamCooldownEnd() / 60000);
      log('反垃圾冷却中，' + left + ' 分钟后再试');
      isProcessing = false;
      scheduleNext(Math.min(600000, Math.max(60000, left * 60000)));
      return;
    }
    if (T().dailyExhausted()) {
      log('今日转帖条数已满');
      stop('quota');
      return;
    }

    isProcessing = true;
    ping('scanning');
    var cfg = T().getConfig();
    var rem = 1;
    try { rem = Math.max(0, T().remainingDaily ? T().remainingDaily() : (T().getEffectiveDailyLimit() - T().getDaily().count)); } catch (eRem) { rem = 1; }
    if (rem <= 0) {
      log('今日转帖条数已满');
      isProcessing = false;
      stop('quota');
      return;
    }
    // 自动场：按剩余配额取帖（Day1–4 可 2 条，Day≥5 为 1；单来源也能填满）
    // 手动场：postsPerHandle 与剩余取更严
    var perHandle = rem;
    try {
      if (!(T().isAutoSlot && T().isAutoSlot())) {
        perHandle = Math.min(rem, Math.max(1, Number(cfg.postsPerHandle) || rem));
      }
    } catch (ePh) { perHandle = rem; }
    try {
      log('今日配额 Day' + (T().getAccountDayCount ? T().getAccountDayCount() : '?') +
        ' = ' + (T().getDailyQuota ? T().getDailyQuota() : '?') +
        '，已发 ' + (T().getDaily().count || 0) + '，本轮取 ' + perHandle);
    } catch (eLog) {}

    try {
      // 熔断冷却中：跳过本次扫描，等冷却结束再继续
      if (fuseCoolingUntil && Date.now() < fuseCoolingUntil) {
        var remainMin = Math.ceil((fuseCoolingUntil - Date.now()) / 60000);
        log('熔断冷却中，' + remainMin + ' 分钟后继续');
        isProcessing = false;
        scheduleNext(60000); // 每分钟检查一次
        return;
      }
      if (fuseCoolingUntil && Date.now() >= fuseCoolingUntil) {
        // 冷却结束，重置连续失败计数
        consecutiveFails = 0;
        fuseCoolingUntil = 0;
        log('熔断冷却结束，继续尝试');
      }
      if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
        // 自动场：熔断后冷却，不直接 stop（当天必须发到配额）
        if (T().isAutoSlot && T().isAutoSlot()) {
          fuseCoolingUntil = Date.now() + FUSE_COOLDOWN_MS;
          log('连续失败熔断，冷却 ' + (FUSE_COOLDOWN_MS / 60000) + ' 分钟后继续');
          isProcessing = false;
          scheduleNext(FUSE_COOLDOWN_MS);
          return;
        }
        log('连续失败熔断');
        stop('fuse');
        return;
      }

      // 两阶段：有待发则优先在首页或 /compose/post 发布
      var pendingEarly = loadPendingContent();
      if (pendingEarly) {
        if (!isPublishReadyPage()) {
          ping('navigating_home');
          log('有待发内容，导航发帖页发布');
          var navEarlyOk = true;
          var pubUrl = 'https://x.com/compose/post';
          if (typeof SchedulerGate !== 'undefined') {
            navEarlyOk = SchedulerGate.go('repost', pubUrl, { force: true });
          } else {
            try {
            if (typeof SchedulerGate !== 'undefined' && SchedulerGate.goRaw) navEarlyOk = !!SchedulerGate.goRaw(pubUrl, { force: true });
            else { location.href = pubUrl; navEarlyOk = true; }
          } catch (eNe) { navEarlyOk = false; }
          }
          if (!navEarlyOk) {
            log('跳转发帖页被节流，待发已保留，稍后重试');
            setTimeout(function () { isProcessing = false; scheduleNext(8000); }, 200);
            return;
          }
          return; // 保持 isProcessing，重载后 recover
        }
        ping('publishing_pending');
        log('发布待发内容 id=' + (pendingEarly.tweetId || pendingEarly.id || '-') +
          (isComposePage() ? ' @compose' : ' @home'));
        var pubOk = false;
        try {
          pubOk = await publishPendingContent(pendingEarly);
        } catch (ePub) {
          log('发布异常 ' + (ePub && ePub.message));
          pubOk = false;
        }
        if (pubOk && pubOk.pendingNav) {
          log('发帖页跳转中，待重载后粘贴');
          return;
        }
        var pubId = pendingEarly.tweetId || pendingEarly.id || '';
        if (pubOk === true) {
          reportPoolOutcome(pendingEarly, pubOk, consecutiveFails);
          clearPendingContent();
          consecutiveFails = 0;
          log('发布成功');
          if (T().dailyExhausted()) {
            log('今日转帖条数已满，收工');
            isProcessing = false;
            stop('quota');
            return;
          }
          if (pendingStopReason) {
            var psrP = pendingStopReason;
            pendingStopReason = null;
            isProcessing = false;
            stop(psrP);
            return;
          }
          var waitNext = 0;
          try { waitNext = T().msUntilNextPostAllowed ? T().msUntilNextPostAllowed() : 0; } catch (eWn) { waitNext = 0; }
          if (waitNext < 30 * 60000) waitNext = Math.max(waitNext, 30 * 60000);
          setTimeout(function () { isProcessing = false; scheduleNext(waitNext || 1500); }, 200);
          return;
        }
        if (pubOk && pubOk.skipped) {
          clearPendingContent();
          reportPoolOutcome(pendingEarly, pubOk, consecutiveFails);
          log('待发跳过 ' + pubOk.reason);
          if (pubId) try { T().markSkipped(pubId, pubOk.reason || 'pending_skip'); } catch (eSkP) {}
        } else {
          consecutiveFails++;
          log('发布失败 consecutive=' + consecutiveFails + '（待发已保留，可重试）');
          setRepostLastMsg('发布失败，待发已保留');
          reportPoolOutcome(pendingEarly, pubOk, consecutiveFails);
        }
        if (pendingStopReason) {
          var psrP2 = pendingStopReason;
          pendingStopReason = null;
          isProcessing = false;
          stop(psrP2);
          return;
        }
        setTimeout(function () { isProcessing = false; scheduleNext(4000); }, 200);
        return;
      }

      // E5：内容池模式 —— 不扫来源号，claim 到就走既有两阶段发布
      // Task 9 前 cfg.contentPoolMode 未下发 → 判定 false，维持来源号模式
      var cpCfgPool = null;
      try { cpCfgPool = T().getConfig ? T().getConfig() : null; } catch (eCp) { cpCfgPool = null; }
      if (isContentPoolMode(cpCfgPool)) {
        await runContentPoolTick();
        return;
      }

      var current = T().getCurrent();
      if (!current) {
        var targets = T().getTargets();
        var next = targets.filter(function (h) { return !processedThisRun[h]; });
        if (!next.length) {
          // 所有来源都扫完了
          var postedThisRound = 0;
          try { postedThisRound = (T().getDaily && T().getDaily() || {}).count || 0; } catch (e) {}
          // 自动场且今日还没发到配额：冷却后重新扫（可能来源号后来更了新帖）
          if (T().isAutoSlot && T().isAutoSlot() && !T().dailyExhausted()) {
            log('本轮来源号已扫完，今日已发 ' + postedThisRound + ' 条，未到配额，冷却 ' + (ZERO_POST_COOLDOWN_MS / 60000) + ' 分钟后重扫');
            processedThisRun = {};
            isProcessing = false;
            scheduleNext(ZERO_POST_COOLDOWN_MS);
            return;
          }
          log('本轮来源号已扫完');
          stop('done');
          return;
        }
        current = next[0];
        T().setCurrent(current);
      }

      if (!isProfilePage(current)) {
        ping('navigating');
        log('导航到 @' + current + '（lang=ja，保持 isProcessing，待重载 recover）');
        try { console.warn('[转帖] navigate keep-processing @' + current); } catch (eNav) {}
        var url = 'https://x.com/' + current + '?lang=ja';
        if (typeof SchedulerGate !== 'undefined' && SchedulerGate.go) SchedulerGate.go('repost', url, { force: true });
        else if (typeof SchedulerGate !== 'undefined' && SchedulerGate.goRaw) SchedulerGate.goRaw(url, { force: true });
        else location.href = url;
        return;
      }

      await sleep(rand(2000, 4000));
      // H9：死号检测 → 上报 banned 并跳过本来源
      var deadKind = detectSourceDeadPage();
      if (deadKind) {
        log('来源号 @' + current + ' ' + (deadKind === 'suspended' ? '已冻结' : '不存在') + '，上报并跳过');
        reportSourceStatus(current, 'banned', deadKind);
        T().markCompletedRound(current);
        processedThisRun[current] = 1;
        T().setCurrent('');
        setTimeout(function () { isProcessing = false; scheduleNext(1200); }, 200);
        return;
      }
      var tweets = await findLatestTweets(perHandle, cfg.postType || 'text_or_image', cfg.banVideo !== false);
      if (!tweets.length) {
        log('@' + current + ' 无可用日语帖，跳过');
        T().markCompletedRound(current);
        processedThisRun[current] = 1;
        T().setCurrent('');
        consecutiveFails = 0;
        setTimeout(function () { isProcessing = false; scheduleNext(1200); }, 200);
        return;
      }
      // H9：抓到帖即存活 — 若此前报过 banned 则回标 alive（自动解封）
      try {
        if (sessionStorage.getItem('sg_rp_src_reported_banned_' + current)) {
          reportSourceStatus(current, 'alive', 'recovered');
          sessionStorage.removeItem('sg_rp_src_reported_banned_' + current);
        }
      } catch (eRec) {}

      for (var i = 0; i < tweets.length; i++) {
        if (!EngineUtils.isActive(NAME)) break;
        var waitMs = 0;
        try { waitMs = T().msUntilNextPostAllowed ? T().msUntilNextPostAllowed() : 0; } catch (eWait) { waitMs = 0; }
        if (i > 0) {
          var gap = rand((cfg.cooldownMin || 30) * 60000, (cfg.cooldownMax || 90) * 60000);
          if (gap < 30 * 60000) gap = 30 * 60000;
          waitMs = Math.max(waitMs, gap);
        }
        if (waitMs > 0) {
          log('冷却 ' + Math.round(waitMs / 60000) + ' 分（至少 30）');
          await sleep(waitMs);
          if (!EngineUtils.isActive(NAME)) break;
        }
        ping('posting');
        var result = await repostTweet(tweets[i], current);
        if (result && result.pendingDeferred) {
          log('待发已存，跳首页稍后重试');
          setTimeout(function () { isProcessing = false; scheduleNext(8000); }, 200);
          return;
        }
        if (result && result.pendingNav) {
          log('已存待发，等待首页重载后发布');
          return; // 保持 isProcessing，页面跳 /home 后 recover → runOnce 发 pending
        }
        if (composeStillOpen()) await closeCompose({ force: true });
        if (result && result.skipped) {
          log('跳过 ' + result.reason);
          continue;
        }
        if (result) {
          consecutiveFails = 0;
          log('成功抓取/发布链路 @' + current);
          if (T().dailyExhausted()) {
            log('今日转帖条数已满，收工');
            T().markCompletedRound(current);
            processedThisRun[current] = 1;
            T().setCurrent('');
            isProcessing = false;
            stop('quota');
            return;
          }
        } else {
          consecutiveFails++;
          log('失败 consecutive=' + consecutiveFails);
        }
      }

      T().markCompletedRound(current);
      processedThisRun[current] = 1;
      T().setCurrent('');
      // 如果 repostTweet 执行中收到过延迟 stop 请求，在此安全点执行
      if (pendingStopReason) {
        var psr = pendingStopReason;
        pendingStopReason = null;
        isProcessing = false;
        log('执行延迟停止请求 reason=' + (psr || ''));
        stop(psr);
        return;
      }
      setTimeout(function () { isProcessing = false; scheduleNext(1500); }, 200);
    } catch (e) {
      consecutiveFails++;
      log('异常 ' + (e && e.message));
      try { await closeCompose({ force: true }); } catch (eClose) {}
      // 异常退出也要执行延迟 stop
      if (pendingStopReason) {
        var psr2 = pendingStopReason;
        pendingStopReason = null;
        isProcessing = false;
        log('异常后执行延迟停止 reason=' + (psr2 || ''));
        stop(psr2);
        return;
      }
      isProcessing = false;
      scheduleNext(4000);
    } finally {
      if (isProcessing) {
        // 导航中途 return 时保持 processing，页面重载后 recover
      }
    }
  }

  // ── E5 原创内容池（4.6.126）：模式判定 / 回报分类 / claim 一轮 ───────────
  /** 内容池模式判定：注入了 ContentPoolClient 且 cfg.contentPoolMode 为真值
   *  （对齐计划临时判定：cfg 缺失时视为开启；Task 9 前 cfg 无该字段 → 维持来源号模式） */
  function isContentPoolMode(cfg) {
    if (!window.ContentPoolClient) return false;
    if (!cfg) return true;
    return cfg.contentPoolMode === true || cfg.contentPoolMode === 'true' || cfg.contentPoolMode === 1;
  }

  /** 待发跳过原因 → 内容池回报分类：可恢复（等图/媒体临时问题）→ retry 回池重发；
   *  内容红线放弃（mention_blocked/mismatch/api_business 等）→ failed 转人工 */
  var CP_RETRYABLE_SKIP_REASONS = { media_restore_fail: 1, media_download_fail: 1, api_business: 0 };
  function classifyPoolSkipResult(reason) {
    return CP_RETRYABLE_SKIP_REASONS[String(reason || '')] === 1 ? 'retry' : 'failed';
  }

  /** pending 发布结果 → 内容池回报（client 自兜错，回报失败不影响主流程）：
   *  成功 → posted；跳过 → 按 reason retry/failed；连发失败达熔断阈值 → failed 防 claimed 卡死 */
  function reportPoolOutcome(pending, pubOk, fails) {
    if (!pending || !pending.contentPoolId || !window.ContentPoolClient) return;
    if (pubOk === true) {
      window.ContentPoolClient.report(pending.contentPoolId, 'posted', {
        externalPostId: pending.tweetId || '',
      }).then(function (r) {
        try { log('内容池回报 posted id=' + pending.contentPoolId + (r && r.ok ? '' : ' 失败')); } catch (e) {}
      }).catch(function () {});
      return;
    }
    if (pubOk && pubOk.skipped) {
      var cpResult = classifyPoolSkipResult(pubOk.reason);
      window.ContentPoolClient.report(pending.contentPoolId, cpResult, { failReason: pubOk.reason || 'skipped' });
      log('内容池回报 ' + cpResult + ' id=' + pending.contentPoolId + ' reason=' + (pubOk.reason || ''));
      return;
    }
    if (fails >= MAX_CONSECUTIVE_FAILS) {
      window.ContentPoolClient.report(pending.contentPoolId, 'failed', { failReason: 'publish_failed_x5' });
    }
  }

  /** E5：内容池模式一轮 —— claim→下图→存 pending→跳发帖页；空池/异常定时再查，绝不发空文本 */
  async function runContentPoolTick() {
    var myHandle = '';
    try {
      if (T().getMyHandle) myHandle = T().getMyHandle() || '';
      if (!myHandle && T().ownHandleCandidates) myHandle = (T().ownHandleCandidates()[0]) || '';
    } catch (eH) { myHandle = ''; }
    if (!myHandle) {
      try { myHandle = String(localStorage.getItem('matrix_my_handle') || '').replace(/^@/, '').replace(/#guard$/i, '').toLowerCase().trim(); } catch (eH2) { myHandle = ''; }
    }
    if (!myHandle) {
      log('内容池：认不到本号 handle，60 秒后再查');
      isProcessing = false;
      scheduleNext(60000);
      return;
    }

    var item;
    try {
      item = await window.ContentPoolClient.claim(myHandle);
    } catch (e) { item = { error: String(e && e.message || e) }; }
    if (item && item.error) {
      log('内容池 claim 异常：' + item.error + '，60 秒后再查');
      isProcessing = false;
      scheduleNext(60000);
      return;
    }
    if (!item) {
      log('内容池无到期内容，5 分钟后再查');
      isProcessing = false;
      scheduleNext(5 * 60000);
      return;
    }

    var urls = item.media_urls || [];
    var blobs = [];
    if (urls.length) {
      try {
        blobs = await window.ContentPoolClient.fetchMedia(urls);
      } catch (eImg) {
        log('内容池配图下载失败 id=' + item.id + '：' + (eImg && eImg.message) + '，报 retry 延后重发');
        await window.ContentPoolClient.report(item.id, 'retry', { failReason: 'media_download_fail' });
        isProcessing = false;
        scheduleNext(60000);
        return;
      }
    }
    // fetchMedia 返回裸 Blob[]；对齐来源号抓图路径补 ext/type（savePendingContent 按 .blob/.ext/.type 消费）
    var mediaFiles = [];
    for (var bi = 0; bi < blobs.length; bi++) {
      var mime = (blobs[bi] && blobs[bi].type) || 'image/jpeg';
      mediaFiles.push({ blob: blobs[bi], ext: /png/i.test(mime) ? 'png' : 'jpg', type: mime.indexOf('image/') === 0 ? mime : 'image/jpeg' });
    }

    try {
      var saved = await savePendingContent(item.text, mediaFiles, '', String(item.id));
      if (!saved) throw new Error('save_pending_returned_false');
      var pend = JSON.parse(sessionStorage.getItem(PENDING_CONTENT_KEY) || 'null');
      if (pend) {
        pend.contentPoolId = item.id;
        sessionStorage.setItem(PENDING_CONTENT_KEY, JSON.stringify(pend));
      }
      log('内容池已存待发 id=' + item.id + '（图 ' + mediaFiles.length + '），导航发帖页');
    } catch (eSave) {
      log('内容池存待发失败：' + (eSave && eSave.message));
      await window.ContentPoolClient.report(item.id, 'retry', { failReason: 'save_pending_fail' });
      isProcessing = false;
      scheduleNext(30000);
      return;
    }

    // 与既有 pending 路径一致：跳 /compose/post，保持 isProcessing，重载后 runOnce 走 pendingEarly 发布
    var navOk = true;
    var pubUrl = 'https://x.com/compose/post';
    try {
      if (typeof SchedulerGate !== 'undefined' && SchedulerGate.go) navOk = !!SchedulerGate.go('repost', pubUrl, { force: true });
      else { location.href = pubUrl; }
    } catch (eNav) { navOk = false; }
    if (!navOk) {
      log('跳转发帖页被节流，待发已保留，稍后重试');
      setTimeout(function () { isProcessing = false; scheduleNext(8000); }, 200);
    }
  }

  function scheduleNext(ms) {
    if (tickTimer && tickTimer.cancel) tickTimer.cancel();
    if (!EngineUtils.isActive(NAME)) return;
    tickTimer = EngineUtils.createTimeout(function () {
      isProcessing = false;
      runOnce();
    }, ms || 2000);
  }

  function startWithTarget(targetUrl) {
    if (EngineUtils.isRunning(NAME)) {
      EngineUtils.resume(NAME);
      writeModuleState({ running: true, phase: 'active', targetUrl: targetUrl || '', startedAt: Date.now(), lastActive: Date.now() });
      scheduleNext(500);
      return;
    }
    EngineUtils.start(NAME);
    sessionStorage.setItem('sg_repost_running', 'true');
    writeModuleState({ running: true, phase: 'active', targetUrl: targetUrl || '', startedAt: Date.now(), lastActive: Date.now() });
    consecutiveFails = 0;
    fuseCoolingUntil = 0;
    isProcessing = false;
    if (!Object.keys(processedThisRun).length) {
      // 新会话不清 round completed，允许跨页恢复；仅新 start 清空
    }
    log('引擎启动');
    scheduleNext(800);
  }

  function stop(reason) {
    cancelSleeps();
    // repostTweet 执行中：外部 stop 请求延迟到安全点执行，避免打断发文流程
    // 'challenge'（软风控）和 'force'（强制）仍立即执行
    if (isProcessing && reason !== 'challenge' && reason !== 'force' && reason !== 'fuse') {
      pendingStopReason = reason;
      log('转帖执行中，延迟停止请求 reason=' + (reason || ''));
      return;
    }
    EngineUtils.stop(NAME);
    sessionStorage.removeItem('sg_repost_running');
    if (tickTimer && tickTimer.cancel) tickTimer.cancel();
    tickTimer = null;
    isProcessing = false;
    pendingStopReason = null;
    writeModuleState({ running: false, phase: reason || 'idle', targetUrl: '', startedAt: 0, lastActive: Date.now() });
    try { closeCompose({ force: true }); } catch (eClose) {}
    try {
      if (reason === 'done' || reason === 'quota') {
        setRepostLastMsg(reason === 'quota' ? '今日转帖已满' : '转帖轮次完成');
        if (T().isAutoSlot && T().isAutoSlot()) {
          T().markAutoDone();
          log(reason === 'quota' ? '定时自动：今日条数已满' : '定时自动轮完成');
        } else {
          try {
            if (sessionStorage.getItem('sg_repost_manual_slot') === '1') {
              T().markAutoDone();
              log('手动转帖完成，本日自动跳过');
            }
          } catch (eMan) {}
        }
      } else if ((reason === 'timeout' || reason === 'fuse') && T().isAutoSlot && T().isAutoSlot()) {
        T().markAutoTimeout();
        setRepostLastMsg('转帖超时/熔断');
      } else if (reason === 'cmd' || reason === 'api') {
        T().clearAutoSlotFlag && T().clearAutoSlotFlag();
        setRepostLastMsg('');
      } else {
        setRepostLastMsg('');
      }
      try { sessionStorage.removeItem('sg_repost_manual_slot'); } catch (eMs) {}
    } catch (eAuto) {}
    log('引擎停止 ' + (reason || ''));
  }

  function recover() {
    var was = sessionStorage.getItem('sg_repost_running') === 'true';
    if (!was) return;
    var allowAutoRecover = false;
    try { allowAutoRecover = !!(T() && T().isAutoSlot && T().isAutoSlot()); } catch (eA) {}
    if (typeof SchedulerGate !== 'undefined' && !SchedulerGate.canSelfStart('repost') && !allowAutoRecover) {
      log('自动模式：跳过自恢复');
      return;
    }
    EngineUtils.start(NAME);
    writeModuleState({ running: true, phase: 'recover', targetUrl: '', startedAt: Date.now(), lastActive: Date.now() });
    scheduleNext(1500);
    log('断点恢复');
  }

  window.addEventListener('sg-repost-command', function (e) {
    var d = e.detail || {};
    if (d.command === 'start') {
      if (d.autoSlot) {
        try {
          if (T().markAutoRunning) T().markAutoRunning();
        } catch (eM) {}
      }
      var dest = (d.targetUrl || '').split('?')[0];
      if (dest && location.href.indexOf(dest) === -1) {
        EngineUtils.start(NAME);
        sessionStorage.setItem('sg_repost_running', 'true');
        writeModuleState({ running: true, phase: 'starting', targetUrl: dest, startedAt: Date.now(), lastActive: Date.now() });
        if (typeof SchedulerGate !== 'undefined' && SchedulerGate.go) SchedulerGate.go('repost', dest, { force: true });
        else if (typeof SchedulerGate !== 'undefined' && SchedulerGate.goRaw) SchedulerGate.goRaw(dest, { force: true });
        else location.href = dest;
        return;
      }
      // 仅「新一轮」清空；补活/断点恢复必须保留 processedThisRun
      if (d.freshRound) {
        processedThisRun = {};
        T().clearCompletedRound();
      } else {
        // 从 tracker 已完成列表回填，避免跳页后内存丢失导致重跑
        try {
          var done = T().getCompletedRound() || [];
          for (var di = 0; di < done.length; di++) processedThisRun[done[di]] = 1;
        } catch (eFill) {}
      }
      startWithTarget(dest || '');
    } else if (d.command === 'stop') {
      stop(d.reason || 'cmd');
    }
  });

  wdTimer = EngineUtils.createWatchdog(NAME, 120000, function () {
    log('看门狗重启');
    isProcessing = false;
    scheduleNext(500);
  });

  window.RepostEngine = {
    start: function () { startWithTarget(''); },
    stop: function () { stop('api'); },
    startWithTarget: startWithTarget,
    getStatus: function () { return EngineUtils.isActive(NAME) ? 'running' : 'idle'; },
    isActive: function () { return EngineUtils.isActive(NAME); },
    _test: {
      isContentPoolMode: isContentPoolMode,
      classifyPoolSkipResult: classifyPoolSkipResult,
      reportPoolOutcome: reportPoolOutcome,
      runContentPoolTick: runContentPoolTick,
      runOnce: runOnce,
    }
  };

  recover();
  log('模块已加载');
})();

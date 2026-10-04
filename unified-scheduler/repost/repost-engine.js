// =============================================================================
// 转帖引擎：复制文案+图片到 compose（非原生转推）
// 硬规则：禁视频；正文禁止 @来源博主；失败进 skip 不循环
// 4.1.72：仅转日语帖；?lang=ja+显示原文；compose 写入改 paste/InputEvent 兜底
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

  function savePendingContent(text, mediaFiles, sourceHandle, tweetId) {
    return new Promise(function (resolve) {
      try {
        var pending = {
          text: text,
          sourceHandle: sourceHandle,
          tweetId: tweetId,
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

  function composeStillOpen() {
    return !!(
      document.querySelector('[data-testid="tweetTextarea_0"]') ||
      document.querySelector('[data-testid="confirmationSheetDialog"]') ||
      document.querySelector('a[href="/compose/post"][aria-current]') ||
      (location.pathname || '').indexOf('/compose/') === 0
    );
  }

  function clickDiscardConfirm() {
    var sheet = document.querySelector('[data-testid="confirmationSheetDialog"]');
    if (!sheet) return false;
    var btn =
      sheet.querySelector('[data-testid="confirmationSheetConfirm"]') ||
      sheet.querySelector('button[data-testid="confirmationSheetConfirm"]');
    if (!btn) {
      var buttons = sheet.querySelectorAll('button, [role="button"]');
      for (var i = 0; i < buttons.length; i++) {
        var t = (buttons[i].innerText || buttons[i].textContent || '').trim();
        if (/^(Discard|Delete|放弃|丢弃|删除|舍弃)/i.test(t) || /Discard|放弃草稿/i.test(t)) {
          btn = buttons[i];
          break;
        }
      }
    }
    if (btn) {
      try { btn.click(); return true; } catch (e) {}
    }
    return false;
  }

  function clickComposeClose() {
    var btn =
      document.querySelector('[data-testid="app-bar-close"]') ||
      document.querySelector('[aria-label="Close"]') ||
      document.querySelector('[aria-label="关闭"]') ||
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

  /** 强关发帖层：关按钮 + 放弃草稿确认；旧版只点一次 Close 会卡在 Discard 层导致下一轮重复弹窗 */
  async function closeCompose(opts) {
    opts = opts || {};
    var force = !!opts.force;
    var wait = force ? sleepRaw : sleep;
    var rounds = 0;
    while (rounds < 6 && composeStillOpen() && (force || EngineUtils.isActive(NAME))) {
      rounds++;
      if (clickDiscardConfirm()) {
        await wait(350);
        continue;
      }
      clickComposeClose();
      await wait(400);
      clickDiscardConfirm();
      await wait(350);
    }
    // 仍开着：最后再清一次（勿在首轮清空，避免空草稿也弹确认却无人点）
    if (composeStillOpen()) {
      try {
        if (typeof SchedulerGate !== 'undefined' && SchedulerGate.prepareLeave) SchedulerGate.prepareLeave();
      } catch (e) {}
      clickComposeClose();
      await wait(400);
      clickDiscardConfirm();
      await wait(400);
    }
    if (composeStillOpen()) {
      log('发帖窗未能完全关闭');
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

  /** X compose：正文只粘贴一次（4.6.36）；禁止内层删贴重试 */
  async function insertEditorText(editor, text) {
    if (!editor) return false;
    var want = String(text || '');
    if (!want) return true;

    function read() {
      return ((editor.innerText || editor.textContent || '') + '').trim();
    }

    editor.focus();
    await sleep(rand(300, 700));

    var before = read();
    if (before) {
      try {
        document.execCommand('selectAll', false);
        document.execCommand('delete', false);
      } catch (eClr) {}
      await sleep(rand(150, 350));
    }

    try {
      var dt = new DataTransfer();
      dt.setData('text/plain', want);
      editor.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true
      }));
    } catch (ePaste) {
      try {
        document.execCommand('insertText', false, want);
      } catch (eExec) {}
    }
    await sleep(rand(600, 1200));

    var got = read();
    var v = verifyComposeText(got, want);
    log('写入（仅一次）want=' + want.length + '字 got=' + got.length + '字 verify=' + v.reason);
    return !!v.ok;
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

    if (!cleanTxt && !mediaFiles.length) {
      T().markSkipped(id, 'empty');
      return { skipped: true, reason: 'empty' };
    }

    ping('composing');

    // 在当前页直接打开 compose modal 发帖（不导航到首页，减少跳转/握手数）
    // compose modal 是独立弹窗，不带转帖元数据，X 看不出是转帖
    // 上一轮残留的 compose / Discard 必须先清掉，否则会叠层「重复弹出」
    if (composeStillOpen()) {
      log('发现残留发帖窗，先关闭');
      await closeCompose();
      await sleep(500);
      if (composeStillOpen()) {
        log('残留发帖窗关不掉，跳过本条');
        return false;
      }
    }
    var composeBtn =
      document.querySelector('a[href="/compose/post"]') ||
      document.querySelector('a[href="/compose/tweet"]') ||
      document.querySelector('[data-testid="SideNav_NewTweet_Button"]');
    if (!composeBtn) {
      log('找不到发帖入口');
      return false;
    }
    await EngineUtils.humanClick(composeBtn);
    await sleep(rand(1400, 2600));

    // 优先找 modal 内的 editor（首页内联框也会匹配 tweetTextarea_0 导致误选）
    var editor = await waitFor('[role="dialog"] [data-testid="tweetTextarea_0"], [data-testid="modal"] [data-testid="tweetTextarea_0"]', 12000);
    if (!editor) {
      editor = await waitFor('[data-testid="tweetTextarea_0"]', 5000);
    }
    if (!editor) {
      log('发帖框未弹出');
      await closeCompose({ force: true });
      return false;
    }
    if (finalText) {
      // 4.6.36：正文只粘贴一次，然后验证；失败不重写
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
        T().markSkipped(id, 'editor_write_fail');
        await closeCompose({ force: true });
        return false;
      }
      if (!wrote && textVerify.ok) {
        log('写入即时核对偏严，验证环节已通过，继续');
      }
    }

    // 上传图片（只注入一次）+ 验证预览
    if (mediaFiles.length) {
      ping('uploading');
      var fileInput =
        document.querySelector('[role="dialog"] input[type="file"]') ||
        document.querySelector('[data-testid="fileInput"]') ||
        document.querySelector('input[type="file"][accept*="image"]') ||
        document.querySelector('input[type="file"]');
      if (fileInput) {
        var uploadFiles = mediaFiles.map(function (m, idx) {
          return new File([m.blob], 'media' + idx + '.' + m.ext, { type: m.type });
        });
        var dt = new DataTransfer();
        uploadFiles.forEach(function (f) { dt.items.add(f); });
        try {
          fileInput.focus();
          await sleep(rand(100, 300));
          fileInput.files = dt.files;
        } catch (eSet) {
          try {
            Object.defineProperty(fileInput, 'files', { value: dt.files, configurable: true });
          } catch (eDef) {
            log('无法注入图片 file input');
          }
        }
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        fileInput.dispatchEvent(new Event('input', { bubbles: true }));
        try { fileInput.dispatchEvent(new Event('blur', { bubbles: true })); } catch (_) {}
        log('图片注入（仅一次）' + mediaFiles.length + ' 张，files.length=' + (fileInput.files && fileInput.files.length));

        // 验证环节：等缩略图出现（不重注）
        var upStart = Date.now();
        var thumbCount = 0;
        while (Date.now() - upStart < 12000 && EngineUtils.isActive(NAME)) {
          var thumbs = document.querySelectorAll(
            '[data-testid="attachments"] img, [data-testid="media-preview"] img, [role="dialog"] [data-testid="tweetPhoto"] img, div[aria-label*="Image"] img, div[aria-label*="图片"] img'
          );
          thumbCount = thumbs ? thumbs.length : 0;
          var readyBtn = document.querySelector('[data-testid="tweetButton"]:not([disabled]), [data-testid="tweetButtonInline"]:not([disabled])');
          if (thumbCount >= mediaFiles.length || (thumbCount > 0 && readyBtn)) break;
          await sleep(rand(400, 900));
        }
        await sleep(rand(800, 1800));
        log('验证环节·图片：预览 ' + thumbCount + '/' + mediaFiles.length + (thumbCount > 0 ? ' 通过' : ' 未出现（有正文则继续）'));
        if (thumbCount <= 0 && !finalText) {
          log('无图预览且无正文，放弃');
          T().markSkipped(id, 'media_preview_fail');
          await closeCompose({ force: true });
          return false;
        }
      } else {
        log('无 file input，跳过配图');
      }
    }

    // 发送前只检测 @，不重写（4.6.36）
    await scrubEditorMentions(editor, sourceHandle);
    await sleep(rand(200, 600));
    if (editorHasSourceMention(editor, sourceHandle)) {
      log('正文仍含@，放弃发送以免变成转帖（不二次粘贴清@）');
      T().markSkipped(id, 'mention_blocked');
      await closeCompose({ force: true });
      await sleep(800);
      return { skipped: true, reason: 'mention_blocked' };
    }

    var postBtn = await waitForEnabled(
      '[data-testid="tweetButton"]:not([disabled]), [data-testid="tweetButtonInline"]:not([disabled]), button[data-testid="tweetButton"]:not([disabled]), button:has(> span > span:only-child)',
      60000
    );
    if (!postBtn) {
      // 兜底：通过文本找 Post/发帖 按钮
      var btns = document.querySelectorAll('button[role="button"]');
      for (var bi = 0; bi < btns.length; bi++) {
        var bt = btns[bi];
        var txt = (bt.innerText || '').trim().toLowerCase();
        if ((txt === 'post' || txt === '发帖' || txt === '回复' || txt === 'reply') && !bt.disabled && bt.getAttribute('aria-disabled') !== 'true') {
          // 排除侧边栏的发帖大按钮（不在 compose 弹窗里）
          if (bt.closest('[data-testid="tweetTextarea_0"], [role="dialog"], [data-testid="app-bar"], [data-testid="tweetButtonContainer"]')) {
            postBtn = bt;
            break;
          }
        }
      }
    }
    if (!postBtn) {
      log('发送按钮未就绪');
      T().markSkipped(id, 'btn_timeout');
      await closeCompose({ force: true });
      return false;
    }

    await sleep(rand(800, 2500));
    // 最后一刻再扫一次 @（只检测，不重贴）
    if (editorHasSourceMention(editor, sourceHandle)) {
      T().markSkipped(id, 'mention_blocked');
      await closeCompose({ force: true });
      return { skipped: true, reason: 'mention_blocked' };
    }
    if (!EngineUtils.isActive(NAME)) {
      await closeCompose({ force: true });
      return false;
    }

    await EngineUtils.humanClick(postBtn);
    ping('sending');
    // 点击后立即标记 pending，防止重复发送（即使后面确认失败，也由重试逻辑处理，不重新开 compose）
    var postedPendingKey = '__rp_pending_' + id;
    if (!window[postedPendingKey]) {
      window[postedPendingKey] = true;
    }

    // 成功信号：编辑器消失 / toast 提示 / URL 变化 / 成功推文出现
    var ok = false;
    var waitStart = Date.now();
    var initialUrl = location.href;
    var swgRetries = 0;
    var MAX_SWG_RETRIES = 3;

    while (Date.now() - waitStart < 45000 && EngineUtils.isActive(NAME)) {
      // 编辑器消失 = 发送完成
      if (!document.querySelector('[data-testid="tweetTextarea_0"]')) {
        ok = true;
        break;
      }
      // 成功 toast
      try {
        var toastTxt = '';
        var toasts = document.querySelectorAll('[data-testid="toast"], [role="status"], [data-testid="toast"]');
        for (var ti = 0; ti < toasts.length; ti++) {
          toastTxt += ' ' + (toasts[ti].innerText || '');
        }
        if (/Your post was sent|Post sent|已发送|已发帖|已发布|发布成功/i.test(toastTxt)) {
          ok = true;
          break;
        }
      } catch (eToast) {}
      // URL 变了（跳转到帖子详情）也算成功
      if (location.href !== initialUrl && !/compose/.test(location.pathname)) {
        ok = true;
        break;
      }
      // Something went wrong / 反垃圾 弹窗：点 Try again 重试（反垃圾命中则直接冷却）
      if (swgRetries < MAX_SWG_RETRIES) {
        try {
          var swgBtns = document.querySelectorAll('button[role="button"]');
          for (var si = 0; si < swgBtns.length; si++) {
            var sbt = swgBtns[si];
            var stxt = (sbt.innerText || '').trim().toLowerCase();
            if ((stxt === 'try again' || /再試行|重试|retry/i.test(stxt)) && !sbt.disabled) {
              // 确认是 "Something went wrong" 弹窗里的重试
              var sParent = sbt.closest('[role="dialog"], [data-testid="confirmationSheetDialog"], div[role="alertdialog"]');
              var sParentTxt = (sParent && sParent.innerText) || '';
              var bodyPrefix = document.body.innerText.slice(0, 800);
              if (sParent || /something went wrong|しばらく経ってから|お時間をいただい/i.test(sParentTxt || bodyPrefix)) {
                // 反垃圾检测：立即退让，不计入普通重试
                var dialogTxt = sParentTxt || bodyPrefix;
                if (EngineUtils.looksLikeAntiSpam(dialogTxt)) {
                  log('发送命中反垃圾检测，进入冷却');
                  EngineUtils.markAntiSpamCooldown(60, 120);
                  T().markSkipped(id, 'antispam_detected:' + (dialogTxt.slice(0, 20) || 'unknown'));
                  try { delete window[postedPendingKey]; } catch (_) {}
                  await closeCompose({ force: true });
                  return false;
                }
                swgRetries++;
                log('发送遇到 Something went wrong，第 ' + swgRetries + ' 次重试');
                await EngineUtils.humanClick(sbt);
                waitStart = Date.now(); // 重置等待时间
                await sleep(rand(1800, 3200));
                // 重新找发送按钮再点一次
                var retryBtn = await waitForEnabled(
                  '[data-testid="tweetButton"]:not([disabled]), [data-testid="tweetButtonInline"]:not([disabled])',
                  15000
                );
                if (retryBtn) {
                  await EngineUtils.humanClick(retryBtn);
                }
                break;
              }
            }
          }
        } catch (eSwg) {}
      }
      await sleep(rand(400, 900));
    }
    if (ok) {
      T().markPosted(id);
      try { delete window[postedPendingKey]; } catch (ePend) {}
      try { if (T().markLastOkAt) T().markLastOkAt(Date.now()); } catch (eOkAt) {}
      T().bumpDaily();
      // 确认标记已写入面板：手动转帖和按钮转帖都走此路径
      var ownHs = [];
      try { if (T().ownHandleCandidates) ownHs = T().ownHandleCandidates(); } catch (eHs) {}
      log('✓ 发帖成功，已标记到面板（@' + (ownHs.join(' @') || 'unknown') + '）id=' + id);
      // 有的版本发送成功后仍留空编辑器/遮罩，必须强关，否则下一轮又弹
      if (composeStillOpen()) await closeCompose({ force: true });
      return true;
    }
    // 失败时抓取页面上的错误信息
    var errMsg = '';
    try {
      var allToasts = document.querySelectorAll('[role="status"], [role="alert"], [data-testid="toast"]');
      for (var eti = 0; eti < allToasts.length; eti++) {
        var t = (allToasts[eti].innerText || '').trim();
        if (t) { errMsg = t.slice(0, 100); break; }
      }
    } catch (eEt) {}
    // 同时扫一下弹窗里的错误
    try {
      var dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
      for (var di = 0; di < dialogs.length; di++) {
        var dt = (dialogs[di].innerText || '').trim().replace(/\n+/g, ' ');
        if (dt && /something went wrong|error|失敗|错误|疑似|自动|automated|spam|suspicious/i.test(dt)) {
          errMsg = dt.slice(0, 100);
          break;
        }
      }
    } catch (eDi) {}

    // 反垃圾检测兜底
    if (EngineUtils.looksLikeAntiSpam(errMsg)) {
      log('发帖命中反垃圾检测，当日停止转帖：' + errMsg.slice(0, 40));
      // 直接把当日配额填满，让 dailyExhausted() 为 true，当日不再尝试
      try {
        var limit = T().getEffectiveDailyLimit ? T().getEffectiveDailyLimit() : 10;
        // 4.6.30：一次写满到日限，不用 +5 循环 bump（虚高计数会污染面板/遥测的当日已发数）
        if (T().setDailyCount) T().setDailyCount(limit);
        else for (var fi = 0; fi < limit; fi++) T().bumpDaily();
      } catch (eFill) {}
      T().markSkipped(id, 'antispam_detected:' + errMsg.slice(0, 20));
      try { delete window[postedPendingKey]; } catch (_) {}
      await closeCompose({ force: true });
      return false;
    }

    log('发帖未确认关闭，尝试强关' + (errMsg ? '，错误: ' + errMsg : ''));
    // 只有确认失败且非 pending 状态才 markSkipped；pending 说明已点过发送，避免重复发
    var isSwgFail = swgRetries >= MAX_SWG_RETRIES;
    T().markSkipped(id, isSwgFail ? ('swg_fail:' + swgRetries + '次') : (errMsg ? ('post_fail:' + errMsg.slice(0, 30)) : 'post_unconfirmed'));
    try { delete window[postedPendingKey]; } catch (ePend2) {}
    await closeCompose({ force: true });
    return false;
  }

  function isProfilePage(handle) {
    var path = (location.pathname || '').replace(/\/$/, '').toLowerCase();
    return path === '/' + handle || path.indexOf('/' + handle + '/') === 0;
  }

  // 发布待发内容：从来源号主页抓取后导航到首页，在首页打开 compose 发布
  async function publishPendingContent(pending) {
    var finalText = pending.text || '';
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

    ping('composing_pending');
    // 上一轮残留的 compose / Discard 必须先清掉
    if (composeStillOpen()) {
      log('发现残留发帖窗，先关闭');
      await closeCompose();
      await sleep(500);
      if (composeStillOpen()) {
        log('残留发帖窗关不掉，跳过');
        return false;
      }
    }
    var composeBtn =
      document.querySelector('a[href="/compose/post"]') ||
      document.querySelector('a[href="/compose/tweet"]') ||
      document.querySelector('[data-testid="SideNav_NewTweet_Button"]');
    if (!composeBtn) {
      log('首页找不到发帖入口');
      return false;
    }
    await EngineUtils.humanClick(composeBtn);
    await sleep(rand(1400, 2600));

    // 必须等 modal dialog 弹出，不能直接找 [data-testid="tweetTextarea_0"]
    // 因为首页顶部有内联 "What's happening?" 发帖框（也是 tweetTextarea_0），会误匹配
    var dialog = await waitFor('[role="dialog"] [data-testid="tweetTextarea_0"], [data-testid="modal"] [data-testid="tweetTextarea_0"]', 12000);
    var editor = dialog;
    if (!editor) {
      // 兜底：dialog 选择器没匹配到，退而求其次直接找（profile 页无内联框时可接受）
      editor = await waitFor('[data-testid="tweetTextarea_0"]', 5000);
    }
    if (!editor) {
      log('发帖框未弹出（modal 未出现）');
      await closeCompose({ force: true });
      return false;
    }

    if (finalText) {
      // 4.6.36：与 live 路径一致——只粘贴一次 + 验证，不重写
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
        await closeCompose({ force: true });
        return false;
      }
      if (!wrote && textVerify.ok) {
        log('写入即时核对偏严，验证环节已通过，继续');
      }
    }

    if (mediaFiles.length) {
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
        var dialog = document.querySelector('[role="dialog"], [data-testid="modal"]');
        var fileInput = null;
        if (dialog) {
          fileInput = dialog.querySelector('input[type="file"]');
        }
        if (!fileInput) {
          // 兜底：全文档找所有 file input，优先 accept 含 image 的
          var allInputs = document.querySelectorAll('input[type="file"]');
          for (var ai = 0; ai < allInputs.length; ai++) {
            var acc = allInputs[ai].getAttribute('accept') || '';
            if (acc.indexOf('image') >= 0 || acc.indexOf('media') >= 0) {
              fileInput = allInputs[ai];
              break;
            }
          }
          // 再兜底：任意 file input
          if (!fileInput && allInputs.length) fileInput = allInputs[0];
        }
        if (!fileInput) {
          log('未找到图片上传 input（modal 内和全文档都没有）');
        } else {
          log('找到 fileInput accept=' + (fileInput.getAttribute('accept') || '') + ' name=' + (fileInput.getAttribute('name') || ''));
          var dt = new DataTransfer();
          for (var fi = 0; fi < mediaFiles.length; fi++) {
            var f = new File([mediaFiles[fi].blob], 'img_' + fi + '.' + mediaFiles[fi].ext, { type: mediaFiles[fi].type });
            dt.items.add(f);
          }
          fileInput.files = dt.files;
          log('图片注入（仅一次）' + mediaFiles.length + ' 张，files.length=' + fileInput.files.length);
          await sleep(500);
          if (fileInput.files.length !== mediaFiles.length) {
            log('⚠ fileInput.files 赋值后数量不对：' + fileInput.files.length + ' != ' + mediaFiles.length);
          }
          // 验证环节：等预览（不重注）
          var previewOk = false;
          var thumbCount = 0;
          for (var pi = 0; pi < 20; pi++) {
            var previewNodes = document.querySelectorAll(
              '[data-testid="tweetPhoto"], [role="dialog"] img[src*="twimg"], [data-testid="attachments"] img'
            );
            thumbCount = previewNodes ? previewNodes.length : 0;
            if (thumbCount > 0) { previewOk = true; break; }
            await sleep(300);
          }
          log('验证环节·图片：预览 ' + thumbCount + '/' + mediaFiles.length + (previewOk ? ' 通过' : ' 未出现（继续尝试发送）'));
          if (previewOk) await sleep(rand(800, 1500));
        }
      } finally {
        if (gateHeld2) {
          try { await mediaGateClose('repost'); } catch (eGc2) {}
        }
      }
    }

    // 点发帖按钮
    var sendBtn = null;
    for (var si = 0; si < 20; si++) {
      sendBtn = document.querySelector('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]') ||
                document.querySelector('[data-testid="toolBar"] [role="button"]');
      if (sendBtn) {
        var en = sendBtn.getAttribute('aria-disabled') || sendBtn.getAttribute('disabled');
        if (en !== 'true' && !sendBtn.getAttribute('aria-disabled')) break;
      }
      await sleep(300);
    }
    if (!sendBtn || sendBtn.getAttribute('aria-disabled') === 'true') {
      log('发帖按钮未就绪');
      await closeCompose({ force: true });
      return false;
    }
    await EngineUtils.humanClick(sendBtn);
    log('已点击发帖按钮（待发内容）');

    // 等待确认
    var confirmed = false;
    var waitStart = Date.now();
    while (Date.now() - waitStart < 45000 && EngineUtils.isActive(NAME)) {
      await sleep(1000);
      if (!composeStillOpen()) { confirmed = true; break; }
      var closeBtn2 = document.querySelector('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]');
      if (!closeBtn2 && !document.querySelector('[data-testid="tweetTextarea_0"]')) { confirmed = true; break; }
      var toast = document.querySelector('[data-testid="toast"]');
      if (toast && /posted|tweeted|已发|送信済|送信しました/i.test(toast.innerText || '')) { confirmed = true; break; }
      var errDlg = document.querySelector('[role="alertdialog"], [role="dialog"]');
      if (errDlg) {
        var errT = (errDlg.innerText || '').trim();
        if (errT && /something went wrong|automated|spam|suspicious|自动|垃圾|疑似/i.test(errT)) {
          log('发帖命中反垃圾检测，当日停止转帖：' + errT.slice(0, 60));
          // 直接把当日配额填满，当日不再尝试
          try {
            var limit2 = T().getEffectiveDailyLimit ? T().getEffectiveDailyLimit() : 10;
            for (var fi2 = 0; fi2 < limit2 + 5; fi2++) T().bumpDaily();
          } catch (eFill2) {}
          await closeCompose({ force: true });
          return false;
        }
      }
    }

    if (confirmed) {
      log('✓ 发帖成功，已标记到面板（待发内容发布）');
      T().bumpDaily();
      // 清除 manual_slot：待发内容发布完成，不再需要跳过时段判定
      try { sessionStorage.removeItem('sg_repost_manual_slot'); } catch (eMs) {}
      if (composeStillOpen()) await closeCompose({ force: true });
      return true;
    }
    log('发帖未确认（待发内容），尝试强关');
    await closeCompose({ force: true });
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
        if (typeof SchedulerGate !== 'undefined') SchedulerGate.go('repost', url);
        else location.href = url;
        return;
      }

      await sleep(rand(2000, 4000));
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
        if (composeStillOpen()) await closeCompose({ force: true });
        if (result && result.skipped) {
          log('跳过 ' + result.reason);
          continue;
        }
        if (result) {
          consecutiveFails = 0;
          log('成功 @' + current);
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
      } else if (reason === 'cmd' || reason === 'api') {
        T().clearAutoSlotFlag && T().clearAutoSlotFlag();
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
        if (typeof SchedulerGate !== 'undefined') SchedulerGate.go('repost', dest);
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
    isActive: function () { return EngineUtils.isActive(NAME); }
  };

  recover();
  log('模块已加载');
})();

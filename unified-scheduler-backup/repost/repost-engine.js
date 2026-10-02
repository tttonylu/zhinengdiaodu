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
  var isProcessing = false;
  var consecutiveFails = 0;
  var processedThisRun = {};
  var tickTimer = null;
  var wdTimer = null;
  var sleepTimers = [];

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

  /** 发帖前：编辑器内不得残留 @来源博主 */
  function scrubEditorMentions(editor, sourceHandle) {
    if (!editor) return '';
    var text = (editor.innerText || editor.textContent || '');
    var cleaned = stripMentions(text, sourceHandle);
    // 再保险：去掉任意 @handle
    cleaned = cleaned.replace(/@\w+/g, '').trim();
    if (cleaned !== text.trim()) {
      editor.focus();
      try {
        document.execCommand('selectAll', false);
        if (cleaned) document.execCommand('insertText', false, cleaned);
        else document.execCommand('delete', false);
      } catch (e) {
        try { editor.textContent = cleaned; } catch (e2) {}
      }
    }
    return cleaned;
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

  /** X compose 多为 React/Lexical：execCommand 常空写，paste + beforeinput 兜底 */
  async function insertEditorText(editor, text) {
    if (!editor) return false;
    var want = String(text || '');
    if (!want) return true;
    editor.focus();
    await sleep(120);

    function read() {
      return ((editor.innerText || editor.textContent || '') + '').trim();
    }

    try {
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, want);
    } catch (e0) {}
    await sleep(200);
    if (read().indexOf(want.slice(0, Math.min(12, want.length))) >= 0 || read() === want) return true;

    try {
      var dt = new DataTransfer();
      dt.setData('text/plain', want);
      editor.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true
      }));
    } catch (e1) {}
    await sleep(250);
    if (read().indexOf(want.slice(0, Math.min(12, want.length))) >= 0 || read() === want) return true;

    try {
      editor.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'insertText',
        data: want,
        bubbles: true,
        cancelable: true
      }));
      editor.dispatchEvent(new InputEvent('input', {
        inputType: 'insertText',
        data: want,
        bubbles: true,
        cancelable: true
      }));
    } catch (e2) {
      try {
        editor.textContent = want;
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (e3) {}
    }
    await sleep(200);
    var got = read();
    return !!(got && (got === want || got.indexOf(want.slice(0, Math.min(8, want.length))) >= 0));
  }

  async function findLatestTweets(count, postType, banVideo) {
    var seen = {};
    var result = [];
    var scrolls = 0;
    var noNew = 0;

    async function scan() {
      var articles = document.querySelectorAll('article[data-testid="tweet"]');
      for (var i = 0; i < articles.length; i++) {
        var article = articles[i];
        var id = extractTweetId(article);
        if (!id || seen[id]) continue;
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
        if (result.length >= count) return true;
      }
      return false;
    }

    if (await scan()) return result;
    while (scrolls < 28 && result.length < count && EngineUtils.isActive(NAME)) {
      var before = Object.keys(seen).length;
      window.scrollBy(0, Math.floor(window.innerHeight * 0.85));
      await sleep(1200);
      await scan();
      scrolls++;
      if (Object.keys(seen).length === before) {
        noNew++;
        if (noNew >= 5) break;
      } else noNew = 0;
    }
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
            try { await window.__sgWaitMediaAllow(4000); } catch (eWa) {}
          }
          await sleep(400);
        }
      } catch (eGo) {
        log('媒体开闸异常', eGo && eGo.message);
      }
    }
    try {
      var imgs = (needMedia && !gateHeld)
        ? []
        : article.querySelectorAll('[data-testid="tweetPhoto"] img');
      for (var i = 0; i < imgs.length; i++) {
        try {
          var img = imgs[i];
          var nw = img.naturalWidth || 0;
          var nh = img.naturalHeight || 0;
          if (nw && nh && (nw < 80 || nh < 80)) continue;
          var src = img.currentSrc || img.src || '';
          if (!src) continue;
          var u = new URL(src, location.href);
          try { u.searchParams.set('name', 'orig'); } catch (eN) {}
          var blob = await fetchBlob(u.href);
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
    composeBtn.click();
    await sleep(1600);

    var editor = await waitFor('[data-testid="tweetTextarea_0"]', 12000);
    if (!editor) {
      log('发帖框未弹出');
      await closeCompose({ force: true });
      return false;
    }

    if (finalText) {
      var wrote = await insertEditorText(editor, finalText);
      if (!wrote) {
        log('正文写入失败，重试一次');
        wrote = await insertEditorText(editor, finalText);
      }
      if (!wrote && !mediaFiles.length) {
        log('正文写入失败且无图，放弃');
        T().markSkipped(id, 'editor_write_fail');
        await closeCompose({ force: true });
        return false;
      }
      await sleep(400);
    }

    // 上传图片
    if (mediaFiles.length) {
      ping('uploading');
      var fileInput =
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
        // 等缩略图出现或发送钮可用
        var upStart = Date.now();
        while (Date.now() - upStart < 12000 && EngineUtils.isActive(NAME)) {
          var thumb = document.querySelector('[data-testid="attachments"] img, [data-testid="media-preview"] img, div[aria-label*="Image"], div[aria-label*="图片"]');
          var readyBtn = document.querySelector('[data-testid="tweetButton"]:not([disabled]), [data-testid="tweetButtonInline"]:not([disabled])');
          if (thumb || readyBtn) break;
          await sleep(400);
        }
        await sleep(800);
      } else {
        log('无 file input，跳过配图');
      }
    }

    // 发送前二次清 @
    scrubEditorMentions(editor, sourceHandle);
    await sleep(300);
    if (editorHasSourceMention(editor, sourceHandle)) {
      scrubEditorMentions(editor, sourceHandle);
      await sleep(200);
    }
    if (editorHasSourceMention(editor, sourceHandle)) {
      log('正文仍含@，放弃发送以免变成转帖');
      T().markSkipped(id, 'mention_blocked');
      await closeCompose({ force: true });
      await sleep(800);
      return { skipped: true, reason: 'mention_blocked' };
    }

    var postBtn = await waitForEnabled(
      '[data-testid="tweetButton"]:not([disabled]), [data-testid="tweetButtonInline"]:not([disabled])',
      60000
    );
    if (!postBtn) {
      log('发送按钮未就绪');
      T().markSkipped(id, 'btn_timeout');
      await closeCompose({ force: true });
      return false;
    }

    await sleep(400);
    // 最后一刻再扫一次
    scrubEditorMentions(editor, sourceHandle);
    if (editorHasSourceMention(editor, sourceHandle)) {
      T().markSkipped(id, 'mention_blocked');
      await closeCompose({ force: true });
      return { skipped: true, reason: 'mention_blocked' };
    }
    if (!EngineUtils.isActive(NAME)) {
      await closeCompose({ force: true });
      return false;
    }

    postBtn.click();
    ping('sending');
    // 成功信号：编辑器消失，或 toast/状态提示「已发送」
    var ok = false;
    var waitStart = Date.now();
    while (Date.now() - waitStart < 25000 && EngineUtils.isActive(NAME)) {
      if (!document.querySelector('[data-testid="tweetTextarea_0"]')) {
        ok = true;
        break;
      }
      try {
        var toastTxt = '';
        var toasts = document.querySelectorAll('[data-testid="toast"], [role="status"], [data-testid="toast"]');
        for (var ti = 0; ti < toasts.length; ti++) {
          toastTxt += ' ' + (toasts[ti].innerText || '');
        }
        if (/Your post was sent|Post sent|已发送|已发帖|已发布/i.test(toastTxt)) {
          ok = true;
          break;
        }
      } catch (eToast) {}
      await sleep(300);
    }
    if (ok) {
      T().markPosted(id);
      try { if (T().markLastOkAt) T().markLastOkAt(Date.now()); } catch (eOkAt) {}
      T().bumpDaily();
      // 有的版本发送成功后仍留空编辑器/遮罩，必须强关，否则下一轮又弹
      if (composeStillOpen()) await closeCompose({ force: true });
      return true;
    }
    log('发帖未确认关闭，尝试强关');
    T().markSkipped(id, 'post_unconfirmed');
    await closeCompose({ force: true });
    return false;
  }

  function isProfilePage(handle) {
    var path = (location.pathname || '').replace(/\/$/, '').toLowerCase();
    return path === '/' + handle || path.indexOf('/' + handle + '/') === 0;
  }

  async function runOnce() {
    if (!EngineUtils.isActive(NAME) || isProcessing) return;
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
      if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
        log('连续失败熔断');
        stop('fuse');
        return;
      }

      var current = T().getCurrent();
      if (!current) {
        var targets = T().getTargets();
        var next = targets.filter(function (h) { return !processedThisRun[h]; });
        if (!next.length) {
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

      await sleep(2500);
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
      setTimeout(function () { isProcessing = false; scheduleNext(1500); }, 200);
    } catch (e) {
      consecutiveFails++;
      log('异常 ' + (e && e.message));
      try { await closeCompose({ force: true }); } catch (eClose) {}
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
    isProcessing = false;
    if (!Object.keys(processedThisRun).length) {
      // 新会话不清 round completed，允许跨页恢复；仅新 start 清空
    }
    log('引擎启动');
    scheduleNext(800);
  }

  function stop(reason) {
    cancelSleeps();
    EngineUtils.stop(NAME);
    sessionStorage.removeItem('sg_repost_running');
    if (tickTimer && tickTimer.cancel) tickTimer.cancel();
    tickTimer = null;
    isProcessing = false;
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

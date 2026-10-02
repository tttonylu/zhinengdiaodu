// =============================================================================
// 智能调度 — 养号引擎（独立模块）
// 每小时预算制：点赞/评论/转发/看趋势/进主页/进帖刷回复
// 动作间隔10~20秒，避开广告内容，匹配推文内容选评论
// 受调度器命令控制：sg_nurture_start / sg_nurture_stop / sg_nurture_pause
// =============================================================================

(function () {
  'use strict';

  if (window.NurtureEngine) return;

  var NAME = 'nurture';
  var tickTimer = null;
  var wdTimer = null;
  var _nurtureActionBusy = false;
  var NAV_BUSY_KEY = 'sg_nurture_nav_busy';

  /** 进帖/进主页等短暂离 home：tick 勿强拽回首页 */
  function markNavBusy(ms) {
    try {
      sessionStorage.setItem(NAV_BUSY_KEY, String(Date.now() + Math.max(3000, ms || 18000)));
    } catch (e) {}
  }
  function isNavBusy() {
    try {
      var until = parseInt(sessionStorage.getItem(NAV_BUSY_KEY) || '0', 10) || 0;
      return until > Date.now();
    } catch (e) { return false; }
  }
  /** 养号允许短暂停留的路径（勿与进帖/主页打架） */
  function isNurtureOkPath(pathname) {
    var p = String(pathname || '');
    if (p === '/home' || p.indexOf('/home/') === 0) return true;
    if (p.indexOf('/explore') === 0) return true;
    if (p.indexOf('/i/') === 0) return true;
    if (p.indexOf('/status/') >= 0) return true;
    if (p.indexOf('/followers') >= 0 || p.indexOf('/following') >= 0) return true;
    var parts = p.split('/').filter(Boolean);
    if (parts.length === 1 &&
        !/^(home|explore|search|settings|messages|notifications|compose|login|logout|i|intent|share)$/i.test(parts[0])) {
      return true;
    }
    return false;
  }

  function pageLooksNurtureShell() {
    try {
      if (document.querySelector('[data-testid="primaryColumn"]')) {
        if (document.querySelector('[data-testid="tweet"], [data-testid="UserCell"], article')) return false;
        var pc = document.querySelector('[data-testid="primaryColumn"]');
        var t = String((pc && pc.textContent) || '').trim();
        if (t.length > 120) return false;
      }
      var path = String(window.location.pathname || '');
      if (path.indexOf('/followers') >= 0 || path === '/home' || path.indexOf('/home/') === 0) {
        if (!document.querySelector('[data-testid="primaryColumn"]')) return true;
        if (!document.querySelector('[data-testid="tweet"], [data-testid="UserCell"], article')) return true;
      }
      return false;
    } catch (e) { return false; }
  }

  function isChallengeLikePath(pathname) {
    var p = String(pathname || '').toLowerCase();
    return /challenge|account\/access|login|logout|captcha/.test(p);
  }

  function requestSharedSoftHealNurture(reason) {
    var CD = 60000;
    try {
      var last = parseInt(sessionStorage.getItem('sg_shared_soft_heal_at') || '0', 10) || 0;
      if (last > 0 && Date.now() - last < CD) {
        Logger.info('养号', '共用软愈冷却中 (' + (reason || '') + ')');
        return false;
      }
    } catch (eCd) {}
    try {
      var main = document.querySelector('main') || document.body;
      if (main) {
        var btns = main.querySelectorAll('[role="button"]');
        for (var i = 0; i < btns.length; i++) {
          var tx = String(btns[i].textContent || '');
          if (/重试|重新加载|Retry|Reload|Try again/i.test(tx)) {
            try { btns[i].click(); } catch (eClk) {}
            try { sessionStorage.setItem('sg_shared_soft_heal_at', String(Date.now())); } catch (eS1) {}
            Logger.info('养号', '未灌水·点重试 (' + (reason || '') + ')');
            return true;
          }
        }
      }
    } catch (eBtn) {}
    try { sessionStorage.setItem('sg_shared_soft_heal_at', String(Date.now())); } catch (eS2) {}
    try {
      var pausedTill = 0;
      try { pausedTill = parseInt(sessionStorage.getItem('sg_paused_till') || '0', 10) || 0; } catch (eP) {}
      chrome.runtime.sendMessage({
        action: 'sg_request_heal',
        reason: reason || 'nurture_shell',
        mode: 'soft_reload',
        pausedTill: pausedTill,
        challenge: false
      }, function () {});
      Logger.info('养号', '未灌水·soft_reload (' + (reason || '') + ')');
    } catch (eHeal) {}
    return true;
  }

  // ==================== 操作上报 ====================
  function nurtureLog(action, detail) {
    try {
      var h = localStorage.getItem('matrix_my_handle');
      var bot = h ? '@' + h.replace('@', '').replace('#guard', '').toLowerCase() + '#guard' : 'unknown';
      console.log('[nurtureLog] sending', action, 'bot:', bot, 'target:', (detail||'').slice(0,30), 'chrome.runtime:', typeof chrome !== 'undefined' && !!chrome.runtime);
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          action: 'log_action',
          bot_id: bot,
          target: detail || 'nurture-action',
          type: 'AUTO',
          action_type: action
        }).catch(function (e) { console.warn('[nurtureLog] FAIL:', e.message); });
      } else {
        console.warn('[nurtureLog] chrome.runtime.sendMessage not available');
      }
    } catch (e) { console.warn('[nurtureLog] error:', e.message); }
  }

  // ==================== 工具 ====================
  function gapMs() {
    var cfg = NurtureConfig ? NurtureConfig.getCfg() : {};
    var g = cfg.actionGapSec || { min: 10, max: 20 };
    return (g.min + Math.random() * (g.max - g.min)) * 1000;
  }

  function emitStatus() {
    try {
      var st = NurtureTracker ? NurtureTracker.getStats() : {};
      window.dispatchEvent(new CustomEvent('matrix-nurture-log', { detail: {
        running: EngineUtils.isActive(NAME),
        stats: st,
      }}));
    } catch (e) {}
  }

  function activeHoursCfg() {
    var cfg = NurtureConfig ? NurtureConfig.getCfg() : {};
    return cfg.activeHours || { start: { hour: 7, minute: 0 }, end: { hour: 21, minute: 0 } };
  }

  function isInActiveHours() {
    var ah = activeHoursCfg();
    var nowMin = -1;
    try {
      if (typeof TimeUtil !== 'undefined' && TimeUtil.shanghaiParts) {
        var sp = TimeUtil.shanghaiParts();
        if (sp) nowMin = sp.minutes;
      }
    } catch (e0) {}
    if (nowMin < 0) {
      try {
        var parts = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        }).formatToParts(new Date());
        var hh = 0, mm = 0;
        for (var i = 0; i < parts.length; i++) {
          if (parts[i].type === 'hour') hh = parseInt(parts[i].value, 10);
          if (parts[i].type === 'minute') mm = parseInt(parts[i].value, 10);
        }
        if (hh === 24) hh = 0;
        nowMin = hh * 60 + mm;
      } catch (e1) {
        return true;
      }
    }
    var start = ah.start.hour * 60 + ah.start.minute;
    var end = ah.end.hour * 60 + ah.end.minute;
    if (end <= start) return nowMin >= start || nowMin < end;
    return nowMin >= start && nowMin < end;
  }

  // ==================== 广告检测 ====================
  function isAdTweet(el) {
    if (!el) return true;
    var txt = (el.innerText || '').toLowerCase();
    if (txt.includes('promoted')) return true;
    if (txt.includes('プロモーション')) return true;
    if (txt.includes('広告')) return true;
    var badges = el.querySelectorAll('[data-testid="badge"]');
    for (var i = 0; i < badges.length; i++) {
      if ((badges[i].innerText || '').toLowerCase().includes('ad')) return true;
    }
    return false;
  }

  /** 平假名/片假名（含半角）——确认日语的硬证据；单靠汉字会误收中文 */
  function hasKana(s) {
    return /[\u3040-\u309f\u30a0-\u30ff\uff66-\uff9f]/.test(String(s || ''));
  }

  /** 印地/阿语/西里/泰/韩等：出现即非「只要日语」 */
  function hasForeignScript(s) {
    return /[\u0900-\u097F\u0600-\u06FF\u0400-\u04FF\u0E00-\u0E7F\uAC00-\uD7AF\u0370-\u03FF]/.test(String(s || ''));
  }

  function extractTweetText(article) {
    if (!article) return '';
    var textEl = article.querySelector('[data-testid="tweetText"]');
    if (!textEl) return '';
    // 不要优先抽 lang=ja 子节点：翻译层可能挂假 ja，掩盖印地/英文正文
    return (textEl.innerText || textEl.textContent || '').trim();
  }

  /**
   * 养号只互动日语帖。只要日语：
   * - 有印地/阿语/韩文等外国文 → 否
   * - 必须有假名（ひらがな/カタカナ）；纯中文汉字/英文/纯图 → 否
   * - 禁止仅凭 lang=ja 放行
   */
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

  /** 点「显示原文」，避免自动翻译成日语后假放行印地/英文原帖 */
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

  /** 详情/回复页：主帖必须是日语，否则放弃互动 */
  function primaryStatusIsJapanese() {
    try {
      if (!/\/status\//.test(window.location.pathname || '')) return true;
      var articles = document.querySelectorAll('article[data-testid="tweet"]');
      if (!articles || !articles.length) return false;
      return isJapaneseTweet(articles[0]);
    } catch (e) { return false; }
  }

  function listVisibleTweetArticles() {
    var articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    return articles.filter(function (a) {
      if (isAdTweet(a)) return false;
      var rect = a.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.top > -80 && rect.top < window.innerHeight + 80;
    });
  }

  /** 先揭原文再判日语；无合格帖返回 null */
  async function pickJapaneseTweet() {
    var list = listVisibleTweetArticles();
    if (!list.length) return null;
    // 打乱，避免总点第一条
    for (var i = list.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = list[i]; list[i] = list[j]; list[j] = tmp;
    }
    for (var k = 0; k < list.length; k++) {
      await revealOriginalOnArticle(list[k]);
      if (isJapaneseTweet(list[k])) return list[k];
    }
    return null;
  }

  function getVisibleTweet() {
    // 同步路径：仅用当前可见文案（调用方应优先 pickJapaneseTweet）
    var articles = listVisibleTweetArticles().filter(isJapaneseTweet);
    if (articles.length === 0) return null;
    return articles[Math.floor(Math.random() * articles.length)];
  }

  // ==================== DOM 操作函数 ====================
  async function clickLike() {
    if (!NurtureTracker.canLikeNow()) return false;
    var tweet = await pickJapaneseTweet();
    if (!tweet) return false;
    if (!isJapaneseTweet(tweet)) return false;
    var btn = tweet.querySelector('[data-testid="like"]');
    if (!btn) return false;
    var label = btn.getAttribute('aria-label') || '';
    if (label.includes('Liked') || label.includes('いいねを取り消す')) return false;
    try {
      btn.click();
      NurtureTracker.didOne('likes');
      EngineUtils.ping(NAME);
      var likeStats = NurtureTracker.getStats();
      Logger.info('养号', '点赞 (' + (likeStats.daily.used.likes || 0) + '/' + (likeStats.daily.budget.likes || 0) + ')');
      nurtureLog('NURTURE_LIKE', (tweet.innerText || '').slice(0, 50));
      emitStatus();
      return true;
    } catch (e) { return false; }
  }

  function _nr_findReplyBtn(tweet) {
    if (!tweet) return null;
    return tweet.querySelector('[data-testid="reply"]')
      || tweet.querySelector('button[data-testid="reply"]')
      || tweet.querySelector('[role="button"][data-testid="reply"]');
  }

  function _nr_hasReplyDialog() {
    var sheet = document.querySelector('[data-testid="sheetDialog"], [data-testid="mask"]');
    if (sheet) return true;
    var modal = document.querySelector('[aria-modal="true"]');
    if (modal && modal.querySelector('[contenteditable="true"], [data-testid^="tweetTextarea_"]')) return true;
    var dialogs = document.querySelectorAll('[role="dialog"]');
    for (var i = 0; i < dialogs.length; i++) {
      if (dialogs[i].querySelector('[contenteditable="true"], [data-testid^="tweetTextarea_"]')) return true;
    }
    return false;
  }

  function _nr_composerReady(origUrl) {
    // 弹层优先；仅 URL 变不够，必须已有可写框（防空提交打回）
    if (_nr_hasReplyDialog() && _nr_findCommentBox(false)) return true;
    if (window.location.href !== origUrl && _nr_findCommentBox(true)) return true;
    return false;
  }

  /** X 回复失败条（插件点发送后平台打回，非白屏） */
  function _nr_detectCommentRejectBanner() {
    try {
      var t = String((document.body && document.body.innerText) || '').slice(0, 6000);
      return /再试一次|别担心|发生了错误|出了点问题|Something went wrong|Try again|错了[，,]/i.test(t);
    } catch (e) {
      return false;
    }
  }

  /** 对齐转帖 Lexical 写入：execCommand → paste → InputEvent，读回校验 */
  async function _nr_insertCommentText(editor, text) {
    if (!editor) return false;
    var want = String(text || '');
    if (!want) return false;
    try { editor.focus(); } catch (_) {}
    await sleep(120);

    function read() {
      return ((editor.innerText || editor.textContent || '') + '').trim();
    }
    function looksOk(got) {
      if (!got) return false;
      if (got === want) return true;
      var n = Math.min(12, want.length);
      return n > 0 && got.indexOf(want.slice(0, n)) >= 0;
    }

    try {
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, want);
    } catch (e0) {}
    await sleep(200);
    if (looksOk(read())) return true;

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
    if (looksOk(read())) return true;

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
    return looksOk(read());
  }

  async function _nr_leaveCommentComposer(navigatedAway) {
    try { if (typeof SchedulerGate !== 'undefined' && SchedulerGate.prepareLeave) SchedulerGate.prepareLeave(); } catch (_) {}
    try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (_) {}
    await sleep(400);
    if (navigatedAway || /\/status\//.test(window.location.pathname || '')) {
      try { window.history.back(); } catch (_) {}
    }
  }

  function _nr_findCommentBox(preferNavigated) {
    // 1) 弹层内
    var scopes = [];
    document.querySelectorAll('[data-testid="sheetDialog"], [aria-modal="true"], [role="dialog"]').forEach(function (el) {
      scopes.push(el);
    });
    for (var s = 0; s < scopes.length; s++) {
      var box = scopes[s].querySelector('[data-testid^="tweetTextarea_"][contenteditable="true"]')
        || scopes[s].querySelector('[contenteditable="true"]');
      if (box && box.offsetParent !== null) return box;
    }

    // 2) 已跳转详情页：取页面上的回复框（避免首页顶栏 compose）
    if (preferNavigated) {
      var byTid = document.querySelector('[data-testid^="tweetTextarea_"][contenteditable="true"]')
        || document.querySelector('.public-DraftEditor-content[contenteditable="true"]');
      if (byTid && byTid.offsetParent !== null) return byTid;
      var nodes = Array.from(document.querySelectorAll('[contenteditable="true"]')).filter(function (e) {
        return e.offsetParent !== null;
      });
      if (nodes.length) return nodes[nodes.length - 1];
    }
    return null;
  }

  function _nr_findSendBtn(textarea) {
    var panel = textarea
      ? textarea.closest('[role="dialog"], [data-testid="sheetDialog"], [aria-modal="true"]')
      : null;
    var scope = panel || document;
    return scope.querySelector('button[data-testid="tweetButtonInline"]:not([disabled])')
      || scope.querySelector('button[data-testid="tweetButton"]:not([disabled])')
      || document.querySelector('button[data-testid="tweetButtonInline"]:not([disabled])')
      || document.querySelector('button[data-testid="tweetButton"]:not([disabled])');
  }

  async function postComment() {
    if (!NurtureTracker.canCommentNow()) return false;
    var tweet = await pickJapaneseTweet();
    if (!tweet) return false;
    if (!isJapaneseTweet(tweet)) {
      Logger.info('养号', '评论-跳过非日语帖');
      return false;
    }
    var replyBtn = _nr_findReplyBtn(tweet);
    if (!replyBtn) {
      Logger.warn('养号', '评论-找不到回复按钮');
      return false;
    }

    markNavBusy(25000);
    var navigatedAway = false;
    try {
      var origUrl = window.location.href;
      await _nr_humanClick(replyBtn);

      // 对齐号池：等弹层或 URL 变化，不把「必须 sheetDialog」写成硬失败
      var composerReady = false;
      for (var di = 0; di < 15; di++) {
        await sleep(1000);
        if (window.location.href !== origUrl) navigatedAway = true;
        if (_nr_composerReady(origUrl)) { composerReady = true; break; }
      }
      if (!composerReady) {
        Logger.warn('养号', '评论-对话框未出现');
        return false;
      }
      // 详情页或弹层：主帖必须仍是日语
      var okJa = primaryStatusIsJapanese();
      if (okJa && _nr_hasReplyDialog()) {
        try {
          var sheet = document.querySelector('[data-testid="sheetDialog"], [aria-modal="true"], [role="dialog"]');
          var sheetTweet = sheet && sheet.querySelector('article[data-testid="tweet"]');
          if (sheetTweet && !isJapaneseTweet(sheetTweet)) okJa = false;
          if (!sheetTweet && tweet && !isJapaneseTweet(tweet)) okJa = false;
        } catch (eSh) {}
      } else if (!/\/status\//.test(window.location.pathname || '') && tweet && !isJapaneseTweet(tweet)) {
        okJa = false;
      }
      if (!okJa) {
        Logger.info('养号', '评论-详情/主帖非日语，放弃');
        await _nr_leaveCommentComposer(navigatedAway);
        return false;
      }

      var textarea = null;
      for (var ti = 0; ti < 15; ti++) {
        textarea = _nr_findCommentBox(navigatedAway);
        if (textarea) break;
        await sleep(1000);
      }
      if (!textarea) {
        Logger.warn('养号', '评论-找不到输入框');
        await _nr_leaveCommentComposer(navigatedAway);
        return false;
      }

      var comment = NurtureComments.pick(tweet);
      if (!comment) { Logger.warn('养号', '评论-无可用文字'); return false; }

      await _nr_humanClick(textarea);
      await sleep(300);
      var wrote = await _nr_insertCommentText(textarea, comment);
      if (!wrote) {
        Logger.warn('养号', '评论-写入失败');
        await _nr_leaveCommentComposer(navigatedAway);
        return false;
      }
      await sleep(400);

      var sendBtn = _nr_findSendBtn(textarea);
      if (!sendBtn || sendBtn.disabled) {
        Logger.warn('养号', '评论-找不到发送按钮');
        await _nr_leaveCommentComposer(navigatedAway);
        return false;
      }
      await _nr_humanClick(sendBtn);

      var rejected = false;
      var leftComposer = false;
      for (var vi = 0; vi < 12; vi++) {
        await sleep(1000);
        if (_nr_detectCommentRejectBanner()) {
          rejected = true;
          break;
        }
        if (window.location.href === origUrl || window.location.href.indexOf('/home') >= 0) {
          leftComposer = true;
          break;
        }
        if (!_nr_hasReplyDialog() && !/\/status\//.test(window.location.pathname || '')) {
          leftComposer = true;
          break;
        }
      }

      if (rejected) {
        Logger.warn('养号', '评论-平台打回');
        await _nr_leaveCommentComposer(true);
        await sleep(_nr_rand(2500, 4500));
        return false;
      }
      if (!leftComposer && _nr_hasReplyDialog()) {
        Logger.warn('养号', '评论-发送未确认');
        await _nr_leaveCommentComposer(navigatedAway);
        return false;
      }

      NurtureTracker.didOne('comments');
      EngineUtils.ping(NAME);
      var cmtStats = NurtureTracker.getStats();
      Logger.info('养号', '评论(' + (cmtStats.daily.used.comments || 0) + '/' + (cmtStats.daily.budget.comments || 0) + '): ' + comment);
      nurtureLog('NURTURE_COMMENT', comment.slice(0, 80));
      emitStatus();
      return true;
    } catch (e) {
      Logger.warn('养号', '评论失败: ' + (e.message || String(e)));
      try { await _nr_leaveCommentComposer(navigatedAway); } catch (_) {}
      return false;
    }
  }

  function _nr_rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

  async function _nr_humanClick(el) {
    if (!el) return;
    el.focus();
    await sleep(_nr_rand(73, 211));
    el.click();
    await sleep(_nr_rand(121, 322));
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function repostTweet() {
    // 4.2.36：养号不再转帖（转帖只走 E 专场，且间隔≥30 分钟、已发 ID 不重复）
    return false;
    if (!NurtureTracker.canDo('reposts')) return false;
    var tweet = getVisibleTweet();
    if (!tweet) return false;
    var btn = tweet.querySelector('[data-testid="retweet"]');
    if (!btn) return false;
    try {
      // 点击 retweet 打开菜单
      btn.click();
      NurtureTracker.didOne('reposts');
      EngineUtils.ping(NAME);
      var rpStats = NurtureTracker.getStats();
      Logger.info('养号', '转发 (' + (rpStats.daily.used.reposts || 0) + '/' + (rpStats.daily.budget.reposts || 0) + ')');
      nurtureLog('NURTURE_REPOST');
      emitStatus();
      // Twitter 弹出下拉菜单，等待后点击"转推"确认
      setTimeout(function () {
        var confirm = document.querySelector('[data-testid="Dropdown"] [role="menuitem"]:first-child');
        if (!confirm) confirm = document.querySelector('[data-testid="retweetConfirm"]');
        if (confirm) confirm.click();
        // 如果出现"引用"弹窗，点 X 关闭
        setTimeout(function () {
          var close = document.querySelector('[aria-label="关闭" i]') || document.querySelector('[data-testid="app-bar-close"]');
          if (close) close.click();
        }, 300);
      }, 500);
      return true;
    } catch (e) { return false; }
  }

  function viewTrends() {
    if (!NurtureTracker.canDo('trends')) return false;
    var trendEl = document.querySelector('[data-testid="trend"]') ||
                  document.querySelector('a[href*="/i/trends"]');
    if (!trendEl) return false;
    try {
      markNavBusy(20000);
      trendEl.click();
      NurtureTracker.didOne('trends');
      EngineUtils.ping(NAME);
      var trStats = NurtureTracker.getStats();
      Logger.info('养号', '看趋势 (' + (trStats.daily.used.trends || 0) + '/' + (trStats.daily.budget.trends || 0) + ')');
      nurtureLog('NURTURE_TREND');
      emitStatus();
      setTimeout(function () { window.scrollBy(0, 300); }, 2000);
      setTimeout(function () { window.history.back(); }, 8000);
      return true;
    } catch (e) { return false; }
  }

  function visitProfile() {
    if (!NurtureTracker.canDo('profiles')) return false;
    var tweet = getVisibleTweet();
    if (!tweet) return false;
    var links = tweet.querySelectorAll('a[role="link"][href^="/"]');
    var profileLink = null;
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href');
      if (!href) continue;
      if (href.includes('/status/') || href.includes('/hashtag/') || href.includes('/i/')) continue;
      if (href.split('/').filter(Boolean).length === 1) { profileLink = links[i]; break; }
    }
    if (!profileLink) return false;
    try {
      markNavBusy(20000);
      profileLink.click();
      NurtureTracker.didOne('profiles');
      EngineUtils.ping(NAME);
      var pfStats = NurtureTracker.getStats();
      Logger.info('养号', '进主页 (' + (pfStats.daily.used.profiles || 0) + '/' + (pfStats.daily.budget.profiles || 0) + ')');
      nurtureLog('NURTURE_PROFILE');
      emitStatus();
      setTimeout(function () { window.history.back(); }, 5000);
      return true;
    } catch (e) { return false; }
  }

  /** 从回复按钮解析评论数，优先进高评论帖 */
  function getReplyScore(tweet) {
    var btn = _nr_findReplyBtn(tweet);
    if (!btn) return -1;
    var sources = [btn.getAttribute('aria-label') || '', btn.textContent || ''];
    var group = btn.closest('[role="group"]');
    if (group) sources.push(group.textContent || '');
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      if (!s) continue;
      var m = s.match(/(\d[\d,.]*)\s*(K|k|万|千)?/);
      if (!m) continue;
      var n = parseFloat(String(m[1]).replace(/,/g, ''));
      if (isNaN(n)) continue;
      if (m[2] === 'K' || m[2] === 'k') n *= 1000;
      if (m[2] === '万') n *= 10000;
      if (m[2] === '千') n *= 1000;
      return n;
    }
    return 0;
  }

  async function pickHighReplyTweet() {
    var articles = listVisibleTweetArticles();
    var scored = [];
    for (var i = 0; i < articles.length; i++) {
      var a = articles[i];
      await revealOriginalOnArticle(a);
      if (!isJapaneseTweet(a)) continue;
      var score = getReplyScore(a);
      if (score < 0) continue;
      scored.push({ el: a, score: score });
    }
    if (!scored.length) return null;
    scored.sort(function (x, y) { return y.score - x.score; });
    var preferred = scored.filter(function (x) { return x.score >= 3; });
    var pool = preferred.length ? preferred.slice(0, Math.min(3, preferred.length)) : scored.slice(0, 1);
    return pool[Math.floor(Math.random() * pool.length)].el;
  }

  function _nr_isStatusPage() {
    return /\/status\//.test(window.location.pathname || '');
  }

  async function _nr_closeTweetDetail(origUrl) {
    for (var i = 0; i < 3; i++) {
      if (!_nr_isStatusPage() && window.location.href === origUrl) return;
      var closeBtn = document.querySelector('[data-testid="app-bar-back"], [aria-label="Back"], [aria-label="戻る"]');
      if (closeBtn) {
        await _nr_humanClick(closeBtn);
        await sleep(_nr_rand(800, 1500));
        continue;
      }
      try {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      } catch (eEsc) {}
      await sleep(_nr_rand(400, 800));
      if (_nr_isStatusPage() || window.location.href !== origUrl) {
        try { window.history.back(); } catch (eBack) {}
        await sleep(_nr_rand(1000, 1800));
      }
    }
  }

  async function _nr_browseDetailReplies() {
    var scrolls = _nr_rand(3, 6);
    for (var i = 0; i < scrolls; i++) {
      window.scrollBy({ top: _nr_rand(300, 700), behavior: 'smooth' });
      EngineUtils.ping(NAME);
      await sleep(_nr_rand(1500, 3500));
    }
  }

  /** 进评论多的帖子，浏览回复区后退出（不发评论） */
  async function enterTweetBrowseReplies() {
    if (!NurtureTracker.canDo('enters')) return false;
    if (_nurtureActionBusy) return false;
    var tweet = (await pickHighReplyTweet()) || (await pickJapaneseTweet());
    if (!tweet) return false;
    await revealOriginalOnArticle(tweet);
    if (!isJapaneseTweet(tweet)) return false;

    _nurtureActionBusy = true;
    markNavBusy(22000);
    var origUrl = window.location.href;
    var replyScore = getReplyScore(tweet);
    try {
      var clickTarget = tweet.querySelector('[data-testid="tweetText"]')
        || tweet.querySelector('a[href*="/status/"] time')
        || tweet.querySelector('a[href*="/status/"]');
      if (!clickTarget) return false;

      await _nr_humanClick(clickTarget);
      await sleep(_nr_rand(2000, 3500));

      if (!_nr_isStatusPage() && window.location.href === origUrl) {
        var timeLink = tweet.querySelector('a[href*="/status/"]');
        if (timeLink) {
          await _nr_humanClick(timeLink);
          await sleep(_nr_rand(2000, 3500));
        }
      }
      if (!_nr_isStatusPage() && window.location.href === origUrl) {
        Logger.warn('养号', '进帖-未能进入详情');
        return false;
      }

      await sleep(_nr_rand(1500, 2500));
      await _nr_browseDetailReplies();
      await _nr_closeTweetDetail(origUrl);
      await sleep(_nr_rand(800, 1500));

      NurtureTracker.didOne('enters');
      EngineUtils.ping(NAME);
      var enStats = NurtureTracker.getStats();
      Logger.info('养号', '进帖刷回复 replies≈' + replyScore + ' (' +
        (enStats.daily.used.enters || 0) + '/' + (enStats.daily.budget.enters || 0) + ')');
      nurtureLog('NURTURE_ENTER', 'replies≈' + replyScore);
      emitStatus();
      return true;
    } catch (e) {
      Logger.warn('养号', '进帖失败: ' + (e.message || String(e)));
      try { await _nr_closeTweetDetail(origUrl); } catch (e2) {}
      return false;
    } finally {
      _nurtureActionBusy = false;
    }
  }

  function scrollRandomly() {
    var dir = Math.random() > 0.3 ? 1 : -0.5;
    var amount = Math.floor(150 + Math.random() * 400) * dir;
    window.scrollBy({ top: amount, behavior: 'smooth' });
    EngineUtils.ping(NAME);
  }

  // ==================== 行为权重 ====================
  function getWeights() {
    var cfg = NurtureConfig ? NurtureConfig.getCfg() : {};
    return cfg.actionWeights || {
      like: 0.55, comment: 0.015, repost: 0, trend: 0.04, profile: 0.02, enter: 0.10
    };
  }

  function doRandomAction() {
    var w = getWeights();
    // 非活跃时段降低互动频率
    if (!isInActiveHours()) {
      w = { like: 0.22, comment: 0.005, repost: 0, trend: 0.01, profile: 0.01, enter: 0.04 };
    }

    var roll = Math.random();
    var cum = 0;

    cum += w.like || 0;
    if (roll < cum && NurtureTracker.canLikeNow()) { void clickLike(); return; }

    cum += w.comment || 0;
    if (roll < cum && NurtureTracker.canCommentNow()) { void postComment(); return; }

    // 养号不做转帖（权重留 0，避免抽到转发）

    cum += w.trend || 0;
    if (roll < cum && NurtureTracker.canDo('trends')) { viewTrends(); return; }

    cum += w.profile || 0;
    if (roll < cum && NurtureTracker.canDo('profiles')) { visitProfile(); return; }

    cum += w.enter || 0;
    if (roll < cum && NurtureTracker.canDo('enters')) { void enterTweetBrowseReplies(); return; }
  }

  // ==================== 主循环 ====================
  function tick() {
    if (!EngineUtils.isActive(NAME)) return;

    // 进帖/进主页/评论导航进行中：只续 tick，禁止强拽 /home（否则来回调转）
    if (_nurtureActionBusy || isNavBusy()) {
      try { EngineUtils.ping(NAME); } catch (ePing) {}
      tickTimer = EngineUtils.createTimeout(tick, 1500);
      return;
    }

    // 回关主动扫占用通知页：暂不拽回，避免打断扫描
    try {
      if (sessionStorage.getItem('sg_fb_scan_hold') === '1') {
        tickTimer = EngineUtils.createTimeout(tick, 3000);
        return;
      }
    } catch (eHold) {}

    // 转帖占用页面时勿拽回首页
    try {
      if (sessionStorage.getItem('sg_repost_running') === 'true' ||
          (typeof EngineUtils !== 'undefined' && EngineUtils.isActive && EngineUtils.isActive('repost'))) {
        tickTimer = EngineUtils.createTimeout(tick, 5000);
        return;
      }
    } catch (eRep) {}

    // 资料克隆占用：源号页 /settings/profile 绝不可拽回 /home（否则 apply 永不到达）
    try {
      var pcBusyTick = false;
      if (typeof ProfileClone !== 'undefined' && ProfileClone.isRunning) {
        pcBusyTick = !!ProfileClone.isRunning();
      } else if (sessionStorage.getItem('sg_profile_clone_running') === 'true') {
        pcBusyTick = true;
      }
      if (pcBusyTick) {
        tickTimer = EngineUtils.createTimeout(tick, 5000);
        return;
      }
    } catch (ePc) {}

    // 仅卡死在非养号业务页时拉回；/status、/@handle、followers 等允许停留
    var p = window.location.pathname || '';
    // 可养路径但白壳：共用软愈；软风控窗若仍停在粉丝列表 → 拉回首页（否则只会空转待机）
    if (isNurtureOkPath(p) && pageLooksNurtureShell()) {
      var softFill = false;
      try {
        var sgSf = JSON.parse(localStorage.getItem('sg_state') || '{}');
        softFill = !!(sgSf.softRiskUntil && Date.now() < sgSf.softRiskUntil);
      } catch (eSf) {}
      if (softFill && (p.indexOf('/followers') >= 0 || p.indexOf('/following') >= 0)) {
        Logger.info('养号', '软窗停在粉丝列表白壳 → 跳首页');
        if (typeof SchedulerGate !== 'undefined') SchedulerGate.go('nurture', 'https://x.com/home');
        else window.location.href = 'https://x.com/home';
        tickTimer = EngineUtils.createTimeout(tick, 5000);
        return;
      }
      Logger.info('养号', '可养路径白壳，软愈不盲跳 home path=' + p);
      requestSharedSoftHealNurture('nurture_ok_shell');
      markNavBusy(20000);
      tickTimer = EngineUtils.createTimeout(tick, 5000);
      return;
    }
    // 软风控养号段：必须在时间线互动；粉丝列表 / 私信·加密页一律拉回 /home
    try {
      var sgHome = JSON.parse(localStorage.getItem('sg_state') || '{}');
      var softNurture = !!(sgHome.softRiskUntil && Date.now() < sgHome.softRiskUntil
        && (sgHome.softRiskPhase === 'nurture' || sgHome.softRiskMode === 'nurture'
          || sgHome.softFillMode === 'nurture_only'));
      var onHome = (p === '/home' || p.indexOf('/home/') === 0);
      var softOffHome = softNurture && !onHome && (
        p.indexOf('/followers') >= 0 || p.indexOf('/following') >= 0
        || /\/i\/(chat|flow|premium)/i.test(p)
        || /\/messages/i.test(p)
      );
      if (softOffHome) {
        var lastHomeNav = parseInt(sessionStorage.getItem('sg_nurture_soft_home_nav_at') || '0', 10) || 0;
        if (Date.now() - lastHomeNav > 20000) {
          sessionStorage.setItem('sg_nurture_soft_home_nav_at', String(Date.now()));
          Logger.info('养号', '软窗养号段偏离首页 path=' + p + ' → 跳首页');
          if (typeof SchedulerGate !== 'undefined') SchedulerGate.go('nurture', 'https://x.com/home');
          else window.location.href = 'https://x.com/home';
          tickTimer = EngineUtils.createTimeout(tick, 5000);
          return;
        }
      }
    } catch (eHn) {}
    if (!isNurtureOkPath(p)) {
      if (isChallengeLikePath(p)) {
        Logger.info('养号', '验证/登录页，不 back 不硬跳 path=' + p);
        tickTimer = EngineUtils.createTimeout(tick, 8000);
        return;
      }
      var backTried = false;
      try { backTried = sessionStorage.getItem('sg_nurture_back_once') === '1'; } catch (eBk) {}
      if (!backTried) {
        try { sessionStorage.setItem('sg_nurture_back_once', '1'); } catch (eBk2) {}
        Logger.info('养号', '非养号页先 history.back path=' + p);
        markNavBusy(12000);
        try { window.history.back(); } catch (eBack) {}
        tickTimer = EngineUtils.createTimeout(tick, 3500);
        return;
      }
      try { sessionStorage.removeItem('sg_nurture_back_once'); } catch (eBk3) {}
      Logger.info('养号', '检测到非养号页面(' + p + ')，跳回首页');
      if (typeof SchedulerGate !== 'undefined') SchedulerGate.go('nurture', 'https://x.com/home');
      else window.location.href = 'https://x.com/home';
      return;
    }
    try { sessionStorage.removeItem('sg_nurture_back_once'); } catch (eBkOk) {}

    // 心跳：更新模块状态 lastActive
    try {
      var ms = JSON.parse(sessionStorage.getItem('sg_module_nurture') || '{}');
      ms.lastActive = Date.now();
      sessionStorage.setItem('sg_module_nurture', JSON.stringify(ms));
    } catch (e) {}

    NurtureTracker.maybeReset();

    if (NurtureTracker.isDailyExhausted()) {
      Logger.info('养号', '今日配额用完，上报调度器');
      if (tickTimer && tickTimer.cancel) tickTimer.cancel();
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime) {
          chrome.runtime.sendMessage({ action: 'sg_nurture_throttled' });
        }
      } catch (e) {}
      // 汇总今日养号数据到 sg_state（供 coordinator 上报）
      try {
        var ns = NurtureTracker.getStats();
        var sgSt = JSON.parse(localStorage.getItem('sg_state') || '{}');
        sgSt.nurtureLikesTotal = (ns.daily && ns.daily.used) ? (ns.daily.used.likes || 0) : 0;
        sgSt.nurtureCommentsTotal = (ns.daily && ns.daily.used) ? (ns.daily.used.comments || 0) : 0;
        sgSt.nurtureRepostsTotal = (ns.daily && ns.daily.used) ? (ns.daily.used.reposts || 0) : 0;
        sgSt.nurtureTrendsTotal = (ns.daily && ns.daily.used) ? (ns.daily.used.trends || 0) : 0;
        sgSt.nurtureProfilesTotal = (ns.daily && ns.daily.used) ? (ns.daily.used.profiles || 0) : 0;
        localStorage.setItem('sg_state', JSON.stringify(sgSt));
      } catch (e) {}
      try {
        var ms = JSON.parse(sessionStorage.getItem('sg_module_nurture') || '{}');
        ms.running = false;
        ms.phase = 'quota_exhausted';
        ms.lastActive = Date.now();
        sessionStorage.setItem('sg_module_nurture', JSON.stringify(ms));
      } catch (e) {}
      EngineUtils.stop(NAME);
      return;
    }

    scrollRandomly();
    EngineUtils.ping(NAME);

    setTimeout(function () {
      if (!EngineUtils.isActive(NAME)) return;
      doRandomAction();

      if (!EngineUtils.isActive(NAME)) return;
      // 非活跃时段延长间隔
      var ms = gapMs();
      if (!isInActiveHours()) ms = ms * 2;
      tickTimer = EngineUtils.createTimeout(tick, ms);
    }, 800);
  }

  function restartTick() {
    if (tickTimer && tickTimer.cancel) tickTimer.cancel();
    tick();
  }

  // ==================== 对外接口 ====================
  function start() {
    startWithTarget('');
  }

  function startWithTarget(targetUrl) {
    var dest = targetUrl || 'https://x.com/home';
    // 资料克隆进行中：禁止启动/补活养号（否则会把 settings 拽回 /home）
    try {
      var pcBusyStart = false;
      if (typeof ProfileClone !== 'undefined' && ProfileClone.isRunning) {
        pcBusyStart = !!ProfileClone.isRunning(); // 内部会清幽灵旗
      } else if (sessionStorage.getItem('sg_profile_clone_running') === 'true') {
        pcBusyStart = true;
      }
      if (pcBusyStart) {
        Logger.info('养号', '资料克隆进行中，拒绝启动 → ' + dest);
        return;
      }
    } catch (ePcStart) {}
    // 调度若已先写了 running 旗标，仍必须拉起 tick，否则「旗标在跑、行为没有」
    if (EngineUtils.isRunning(NAME)) {
      EngineUtils.resume(NAME);
      writeModuleState({ running: true, phase: 'active', targetUrl: dest, startedAt: Date.now(), lastActive: Date.now() });
      Logger.info('养号', '已授权但无循环，补启 tick → ' + dest);
      restartTick();
      return;
    }
    EngineUtils.start(NAME);
    writeModuleState({ running: true, phase: 'active', targetUrl: dest, startedAt: Date.now(), lastActive: Date.now() });
    Logger.info('养号', '引擎启动 → ' + dest);
    restartTick();
  }

  function stop() {
    EngineUtils.stop(NAME);
    if (tickTimer && tickTimer.cancel) tickTimer.cancel();
    tickTimer = null;
    EngineUtils.clearWatchdog(wdTimer);
    wdTimer = null;
    writeModuleState({ running: false, phase: 'idle', targetUrl: '', startedAt: 0, lastActive: Date.now() });
    Logger.info('养号', '引擎停止');
  }

  function pause() {
    EngineUtils.pause(NAME);
    if (tickTimer && tickTimer.cancel) tickTimer.cancel();
    EngineUtils.clearWatchdog(wdTimer);
    writeModuleState({ running: false, phase: 'idle', targetUrl: '', startedAt: 0, lastActive: Date.now() });
    Logger.info('养号', '引擎暂停');
  }

  function recover() {
    // 硬规则：自动模式禁止自恢复
    if (typeof SchedulerGate !== 'undefined' && !SchedulerGate.canSelfStart('nurture')) {
      var msAuto = {};
      try { msAuto = JSON.parse(sessionStorage.getItem('sg_module_nurture') || '{}'); } catch (e1) {}
      if (!msAuto.running && !SchedulerGate.isModuleOn('nurture')) {
        sessionStorage.removeItem('sg_' + NAME + '_running');
        sessionStorage.removeItem('sg_' + NAME + '_paused');
        writeModuleState({ running: false, phase: 'idle', targetUrl: '', startedAt: 0, lastActive: Date.now() });
      }
      Logger.info('养号', '自动模式：跳过自恢复，等待调度');
      return;
    }

    var wasRunning = sessionStorage.getItem('sg_' + NAME + '_running') === 'true';
    var wasPaused = sessionStorage.getItem('sg_' + NAME + '_paused') === 'true';
    if (!wasRunning || wasPaused) {
      sessionStorage.removeItem('sg_' + NAME + '_running');
      sessionStorage.removeItem('sg_' + NAME + '_paused');
      writeModuleState({ running: false, phase: 'idle', targetUrl: '', startedAt: 0, lastActive: Date.now() });
      return;
    }
    EngineUtils.start(NAME);
    writeModuleState({ running: true, phase: 'active', targetUrl: 'https://x.com/home', startedAt: Date.now(), lastActive: Date.now() });
    restartTick();
    Logger.info('养号', '从断点恢复');
  }

  // 看门狗
  wdTimer = EngineUtils.createWatchdog(NAME, 90000, restartTick);

  // ==================== 命令监听（通过 window 事件，同页通信） ====================
  window.addEventListener('sg-nurture-command', function (e) {
    var d = e.detail || {};
    var cmd = d.command;
    if (cmd === 'start') {
      var dest = (d.targetUrl || '').split('?')[0] || 'https://x.com/home';
      var curPath = window.location.pathname || '';
      var destPath = '/home';
      try {
        destPath = (new URL(dest, window.location.origin).pathname || '/home');
      } catch (eDp) {}
      function onDestPath() {
        if (destPath === '/home' || destPath.indexOf('/home/') === 0) {
          return curPath === '/home' || curPath.indexOf('/home/') === 0;
        }
        try {
          return curPath === destPath || window.location.href.indexOf(dest) !== -1;
        } catch (eM) { return false; }
      }
      // 已在目标页：壳→软愈；非壳→直接开工（勿把 /followers 当成已到 /home）
      if (onDestPath()) {
        if (pageLooksNurtureShell()) {
          requestSharedSoftHealNurture('nurture_start_shell');
          EngineUtils.start(NAME);
          writeModuleState({ running: true, phase: 'starting', targetUrl: dest, startedAt: Date.now(), lastActive: Date.now() });
          restartTick();
          return;
        }
        startWithTarget(dest);
        return;
      }
      // 软风控常见：停在博主 /followers，dest=/home → 必须跳首页再养
      EngineUtils.start(NAME);
      writeModuleState({ running: true, phase: 'starting', targetUrl: dest, startedAt: Date.now(), lastActive: Date.now() });
      Logger.info('养号', '启动跳转 ' + curPath + ' → ' + dest);
      if (typeof SchedulerGate !== 'undefined') SchedulerGate.go('nurture', dest);
      else window.location.href = dest;
    }
    else if (cmd === 'stop') { stop(); }
    else if (cmd === 'pause') { pause(); }
    else if (cmd === 'resume') { EngineUtils.resume(NAME); restartTick(); }
  });

  // ==================== 模块状态管理 ====================
  function writeModuleState(s) {
    try { sessionStorage.setItem('sg_module_nurture', JSON.stringify(s)); } catch (e) {}
  }

  // ==================== 模块导出 + 初始化 ====================
  window.NurtureEngine = {
    start: start, stop: stop, pause: pause,
    startWithTarget: startWithTarget,
    isJapaneseTweet: isJapaneseTweet,
    getStatus: function () { return EngineUtils.isActive(NAME) ? 'running' : 'idle'; },
    isActive: function () { return EngineUtils.isActive(NAME); },
    writeModuleState: writeModuleState
  };

  recover();
  Logger.info('养号', '模块已加载 V3.0.0');
})();

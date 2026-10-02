// =============================================================================
// C6 · DM Passcode 自动解锁
// 工作指导：只改填码/重试/检测门；禁止守箱排序与调度
// 宿主依赖（findBottomAwakeningTarget 等）经 SgDmPin.bind(hooks) 注入
// =============================================================================
(function () {
  'use strict';
  if (typeof window !== 'undefined' && window.__sg_dm_pin_loaded__) return;
  if (typeof window !== 'undefined') window.__sg_dm_pin_loaded__ = true;

  var hooks = {
    findBottomAwakeningTarget: null,
    isMessagesPage: null,
    isDmPath: null,
    getWorkerId: null,
    getChatPhase: null,
    showToast: null,
    debugChatLog: null
  };

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

  function getChatDmPin() {
    try {
      var cfg = JSON.parse(localStorage.getItem('sg_config_thresholds') || '{}');
      if (cfg.chat_dm_pin) return String(cfg.chat_dm_pin);
    } catch (e) {}
    return '2546';
  }

  // 真解锁门文案；禁止单独匹配裸 "PIN"（粉丝简介极常见，会误卡整引擎）
  var DM_PIN_GATE_RE = /Enter Passcode|Confirm Passcode|パスコードを入力|暗証番号|暗証コード|コードを入力|recover your encryption|Enter your\s*(DM\s*)?(passcode|PIN)|输入.*[密密]码|输入.*PIN|(^|\s)passcode(\s|$)/i;
  // 「创建密码」引导 ≠ 解锁验码；误当解锁会空填 2546 → max_attempts 假死
  var DM_PIN_SETUP_RE = /欢迎使用新的\s*X\s*聊天|Welcome to (the )?new X (Chat|Messaging)|创建密码|Create (a )?(Passcode|Password)|设置密码|Set (a )?(passcode|password)|为保障私信安全|you need to (create|set) (a )?pass/i;
  var DM_PIN_RATE_LIMIT_RE = /Rate limit exceeded|请稍后再试|稍后再试|Too many (requests|attempts|tries)|try again later/i;

  function collectHiddenDmPinText(root, maxLen) {
    maxLen = maxLen || 4000;
    var out = '';
    try {
      if (!root) root = document;
      if (root.nodeType === 3) {
        var t = (root.nodeValue || '').replace(/\s+/g, ' ').trim();
        return t.slice(0, maxLen);
      }
      if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return '';
      if (root.nodeType === 1) {
        var tag = String(root.tagName || '').toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'noscript') return '';
        if (root.childNodes && !root.shadowRoot) {
          var direct = '';
          for (var i = 0; i < root.childNodes.length; i++) {
            var c = root.childNodes[i];
            if (c.nodeType === 3) direct += (c.nodeValue || '');
          }
          if (direct && out.length < maxLen) out += ' ' + direct;
        }
      }
      var nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (var j = 0; j < nodes.length && out.length < maxLen; j++) {
        var n = nodes[j];
        if (n.shadowRoot) out += ' ' + collectHiddenDmPinText(n.shadowRoot, maxLen - out.length);
        if (n.tagName === 'IFRAME') {
          try {
            var idoc = n.contentDocument;
            if (idoc) out += ' ' + collectHiddenDmPinText(idoc.body || idoc, maxLen - out.length);
          } catch (eF) {}
        }
      }
    } catch (eC) {}
    return out.replace(/\s+/g, ' ').trim().slice(0, maxLen);
  }

  function isOnFollowersListPath() {
    try {
      var p = String(window.location.pathname || '').toLowerCase();
      return p.indexOf('/followers') >= 0 || p.indexOf('/following') >= 0 || p.indexOf('/verified_followers') >= 0;
    } catch (e) {
      return false;
    }
  }

  function sampleDmPinPageText() {
    var bodyText = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 5000) : '';
    var deep = '';
    try { deep = collectHiddenDmPinText(document, 3000); } catch (e) {}
    return (bodyText + ' ' + deep).replace(/\s+/g, ' ').trim();
  }

  function hasCreatePasscodeButton() {
    try {
      var buttons = document.querySelectorAll('button, div[role="button"], [role="link"]');
      for (var i = 0; i < buttons.length; i++) {
        var txt = (buttons[i].innerText || buttons[i].textContent || '').replace(/\s+/g, ' ').trim();
        if (/^(创建密码|Create (a )?(Passcode|Password)|设置密码|Set (a )?(Passcode|Password))$/i.test(txt)) {
          return true;
        }
      }
    } catch (e) {}
    return false;
  }

  /** 新 X Chat 首次「创建密码」引导（不可自动填 2546） */
  function isDmPinSetupRequired() {
    try {
      if (isOnFollowersListPath()) return false;
      try {
        if (callHook('findBottomAwakeningTarget')) return false;
      } catch (e0) {}
      var t = sampleDmPinPageText();
      if (DM_PIN_SETUP_RE.test(t)) return true;
      if (hasCreatePasscodeButton()) return true;
    } catch (e) {}
    return false;
  }

  function isDmPinRateLimited() {
    try {
      return DM_PIN_RATE_LIMIT_RE.test(sampleDmPinPageText());
    } catch (e) {
      return false;
    }
  }

  /** X 报「无法加载加密模块」：模块未起来，自动填码无效，应交回软窗养号 */
  function isDmEncryptionModuleBroken() {
    try {
      var t = sampleDmPinPageText();
      if (/无法加载加密模块|加密模块.*刷新|Unable to load (the )?encryption module|encryption module.*refresh/i.test(t)) {
        return true;
      }
    } catch (e) {}
    return false;
  }

  function isDmPinGateVisible() {
    // 创建引导优先：不当成可自动解锁的验码门
    if (isDmPinSetupRequired()) return false;

    var pathname = (window.location.pathname || '').toLowerCase();
    var href = (window.location.href || '').toLowerCase();
    if (pathname.indexOf('/i/chat/pin/') >= 0 || href.indexOf('/i/chat/pin/') >= 0) return true;

    // 粉丝/关注列表：绝不做 body 全文 PIN 匹配（简介含 PIN/暗証 会误报，主循环直接 return 破冰全停）
    if (isOnFollowersListPath()) return false;

    try {
      if (callHook('findBottomAwakeningTarget')) return false;
    } catch (e0) {}

    var onDm = false;
    try {
      onDm = !!callHook('isMessagesPage') || !!callHook('isDmPath', window.location.pathname || '');
    } catch (eP) {}

    var pinCells = document.querySelectorAll(
      'input[maxlength="1"], input[inputmode="numeric"][type="text"], input[inputmode="numeric"][type="tel"]'
    );
    // 非 DM 页：只有明确多格 PIN 输入才认门，不扫全文
    if (!onDm) {
      return pinCells.length >= 4;
    }

    if (pinCells.length >= 4) return true;
    var pageText = sampleDmPinPageText();
    if (DM_PIN_GATE_RE.test(pageText)) return true;
    var pwd = document.querySelector('input[type="password"]');
    if (pwd && onDm) return true;
    return false;
  }

  function isDmPinBlockedForSend() {
    try {
      if (isDmEncryptionModuleBroken()) return true;
      if (isDmPinSetupRequired()) return true;
      try {
        if (sessionStorage.getItem('dm_pin_setup_inflight') === '1') return true;
      } catch (eInf) {}
      return isDmPinGateVisible();
    } catch (e) {
      // 异常时勿 fail-closed：否则粉丝页偶发异常会整引擎停转
      return false;
    }
  }

  function reportDmPinGate(detail) {
    detail = detail || {};
    try {
      if (typeof SgTelemetry !== 'undefined' && SgTelemetry.emit) {
        SgTelemetry.emit('chat.dm_pin_gate', Object.assign({
          phase: callHook('getChatPhase'),
          pin_from_config: !!getChatDmPin()
        }, detail));
      }
    } catch (eT) {}
    try {
      callHook('debugChatLog', 'DM PIN 门禁拦截', Object.assign({ step: 'pin_gate' }, detail));
    } catch (eD) {}
    try {
      var hbBotId = callHook('getWorkerId');
      if (hbBotId && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          action: 'ops_account_heartbeat',
          bot_id: hbBotId,
          payload: { bot_id: hbBotId, dm_pin_blocked: true }
        }, function () {});
      }
    } catch (eH) {}
  }

  function clearDmPinBlocked() {
    try {
      var hbBotId = callHook('getWorkerId');
      if (hbBotId && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          action: 'ops_account_heartbeat',
          bot_id: hbBotId,
          payload: { bot_id: hbBotId, dm_pin_blocked: false }
        }, function () {});
      }
    } catch (eH) {}
  }

  function clickCreatePasscodeButton() {
    var buttons = document.querySelectorAll('button, div[role="button"], [role="link"]');
    for (var i = 0; i < buttons.length; i++) {
      var txt = (buttons[i].innerText || buttons[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (/^(创建密码|Create (a )?(Passcode|Password)|设置密码|Set (a )?(Passcode|Password)|开始|Get started|Continue to create)$/i.test(txt)) {
        try { buttons[i].click(); return true; } catch (eC) {}
      }
    }
    return false;
  }

  function clickPinConfirmButton() {
    var buttons = document.querySelectorAll('button, div[role="button"], [role="link"]');
    for (var i = 0; i < buttons.length; i++) {
      var txt = (buttons[i].innerText || buttons[i].textContent || '').trim();
      if (/^(Confirm|Next|Continue|Submit|Done|确认|次へ|続ける|OK|送信|下一步|继续|完成)$/i.test(txt) ||
          /确认|继续|下一步|完了|完成/.test(txt)) {
        if (/forgot|忘れ|忘记|创建密码|Create (a )?(Passcode|Password)|设置密码/i.test(txt)) continue;
        try { buttons[i].click(); return true; } catch (eC) {}
      }
    }
    return false;
  }

  function setNativeInputValue(el, value) {
    if (!el) return false;
    try {
      var proto = window.HTMLInputElement && window.HTMLInputElement.prototype;
      var desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
      try {
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: String(value), inputType: 'insertText' }));
      } catch (eIe) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) {
      return false;
    }
  }

  function dispatchDigitKeys(target, digit) {
    if (!target) return;
    var code = 'Digit' + digit;
    var keyCode = 48 + (parseInt(digit, 10) || 0);
    var opts = { key: String(digit), code: code, keyCode: keyCode, which: keyCode, bubbles: true, cancelable: true };
    try { target.dispatchEvent(new KeyboardEvent('keydown', opts)); } catch (e1) {}
    try { target.dispatchEvent(new KeyboardEvent('keypress', opts)); } catch (e2) {}
    try { target.dispatchEvent(new KeyboardEvent('keyup', opts)); } catch (e3) {}
  }

  function collectPinInputCandidates() {
    var sels = [
      'input[maxlength="1"]',
      'input[maxlength="4"]',
      'input[inputmode="numeric"]',
      'input[autocomplete="one-time-code"]',
      'input[type="tel"]',
      'input[type="password"]',
      'input[type="text"]',
      'input[name*="pin" i]',
      'input[aria-label*="passcode" i]',
      'input[aria-label*="PIN" i]',
      'input[aria-label*="暗証" i]',
      'input[data-testid*="pin" i]'
    ];
    var seen = [];
    var out = [];
    for (var s = 0; s < sels.length; s++) {
      var list;
      try { list = document.querySelectorAll(sels[s]); } catch (eQ) { continue; }
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        if (!el || seen.indexOf(el) >= 0) continue;
        var visible = !!(el.offsetParent !== null || (el.getClientRects && el.getClientRects().length));
        var onPinPath = /\/i\/chat\/pin\//i.test(window.location.pathname || '');
        if (!visible && !onPinPath) continue;
        seen.push(el);
        out.push(el);
      }
    }
    return out;
  }

  function fillPinDigits(pin) {
    pin = String(pin || '').replace(/\D/g, '');
    if (pin.length < 4) return false;
    pin = pin.slice(0, 4);
    var cells = collectPinInputCandidates();
    var singleCells = cells.filter(function (el) {
      var ml = parseInt(el.getAttribute('maxlength') || '0', 10) || 0;
      return ml === 1 || (el.inputMode === 'numeric' && ml <= 1);
    });
    if (singleCells.length >= 4) {
      for (var i = 0; i < 4; i++) {
        try {
          singleCells[i].focus();
          setNativeInputValue(singleCells[i], pin.charAt(i));
          dispatchDigitKeys(singleCells[i], pin.charAt(i));
        } catch (eCell) {}
      }
      return true;
    }
    var multi = cells.filter(function (el) {
      var ml = parseInt(el.getAttribute('maxlength') || '0', 10) || 0;
      return ml >= 4 || el.type === 'password' || el.type === 'tel' || el.autocomplete === 'one-time-code';
    })[0] || cells[0];
    if (multi) {
      try {
        multi.focus();
        setNativeInputValue(multi, pin);
        for (var d = 0; d < 4; d++) dispatchDigitKeys(multi, pin.charAt(d));
        try { document.execCommand('selectAll', false, null); } catch (eSa) {}
        try { document.execCommand('insertText', false, pin); } catch (eIt) {}
        return true;
      } catch (ePwd) {}
    }
    // 无真实输入格时禁止「假键盘灌码」冒充成功（创建引导页曾因此烧满 attempts）
    return false;
  }

  var _dmPinLastTryAt = 0;
  var _dmPinLastToastAt = 0;

  function emitPinGiveUp(reason) {
    try {
      sessionStorage.setItem('sg_dm_pin_give_up', '1');
      window.dispatchEvent(new CustomEvent('sg-dm-pin-give-up', { detail: { reason: reason || 'give_up' } }));
    } catch (eGu) {}
  }

  function clearPinSetupState() {
    try {
      sessionStorage.removeItem('dm_pin_setup_inflight');
      sessionStorage.removeItem('dm_pin_setup_attempts');
      sessionStorage.removeItem('dm_pin_setup_at');
    } catch (e) {}
  }

  /**
   * 自动创建 X Chat 密码：点「创建密码」→ 填 chat_dm_pin(默认2546) → Next/Confirm（含二次确认）。
   * 限流或多次失败才交回手动。
   */
  function tryCreateDmPasscode() {
    var now = Date.now();
    if (isDmEncryptionModuleBroken()) {
      if (now - _dmPinLastToastAt > 15000) {
        _dmPinLastToastAt = now;
        callHook('showToast', '🔒 加密模块加载失败，交回养号', '#f85149', 3500);
        reportDmPinGate({ ok: false, reason: 'encryption_module_broken' });
      }
      emitPinGiveUp('encryption_module_broken');
      return { ok: false, encryption_broken: true };
    }
    if (isDmPinRateLimited()) {
      if (now - _dmPinLastToastAt > 15000) {
        _dmPinLastToastAt = now;
        callHook('showToast', '🔒 创建密码被限流，稍后再试', '#f85149', 3500);
        reportDmPinGate({ ok: false, reason: 'setup_rate_limited' });
      }
      clearPinSetupState();
      emitPinGiveUp('rate_limited');
      return { ok: false, rate_limited: true };
    }

    if (now - _dmPinLastTryAt < 1200) {
      return { ok: false, throttled: true, setup_pending: true };
    }

    var attempts = parseInt(sessionStorage.getItem('dm_pin_setup_attempts') || '0', 10) || 0;
    var attemptsAt = parseInt(sessionStorage.getItem('dm_pin_setup_at') || '0', 10) || 0;
    if (attempts >= 8 && attemptsAt && now - attemptsAt > 3 * 60 * 1000) {
      attempts = 0;
      sessionStorage.setItem('dm_pin_setup_attempts', '0');
      sessionStorage.removeItem('dm_pin_setup_at');
    }
    if (attempts >= 8) {
      if (now - _dmPinLastToastAt > 15000) {
        _dmPinLastToastAt = now;
        callHook('showToast', '🔒 自动创建密码失败，请手动点「创建密码」并设 2546', '#f85149', 4500);
        reportDmPinGate({ ok: false, reason: 'setup_max_attempts' });
        try {
          if (typeof SgTelemetry !== 'undefined') SgTelemetry.emit('chat.dm_pin_unlock', { ok: false, reason: 'setup_max_attempts' });
        } catch (eM) {}
      }
      clearPinSetupState();
      emitPinGiveUp('needs_setup');
      return { ok: false, needs_setup: true };
    }

    // 已离开创建引导且无验码门 → 视为创建成功
    if (!isDmPinSetupRequired() && !isDmPinGateVisible() && sessionStorage.getItem('dm_pin_setup_inflight') === '1') {
      clearPinSetupState();
      sessionStorage.setItem('dm_pin_unlocked_at', String(Date.now()));
      sessionStorage.setItem('dm_pin_unlock_attempts', '0');
      sessionStorage.removeItem('dm_pin_attempts_at');
      sessionStorage.removeItem('dm_pin_pending_verify');
      clearDmPinBlocked();
      callHook('showToast', '🔓 已自动创建 DM 密码 ' + getChatDmPin(), '#1d9bf0', 2500);
      callHook('debugChatLog', 'DM PIN 自动创建完成', { step: 'pin_setup' });
      try {
        if (typeof SgTelemetry !== 'undefined') SgTelemetry.emit('chat.dm_pin_unlock', { ok: true, reason: 'setup_done' });
      } catch (eT) {}
      return { ok: true, setup_done: true };
    }

    _dmPinLastTryAt = now;
    sessionStorage.setItem('dm_pin_setup_inflight', '1');
    var pin = getChatDmPin();

    // 已有输入格：填码并点下一步/确认（创建与二次确认同一码）
    var filled = fillPinDigits(pin);
    if (filled) {
      sessionStorage.setItem('dm_pin_setup_attempts', String(attempts + 1));
      if (!attemptsAt) sessionStorage.setItem('dm_pin_setup_at', String(now));
      clickPinConfirmButton();
      if (now - _dmPinLastToastAt > 8000) {
        _dmPinLastToastAt = now;
        callHook('showToast', '🔓 正在自动创建密码 ' + pin + '…', '#1d9bf0', 2200);
      }
      reportDmPinGate({ ok: false, reason: 'setup_filling' });
      callHook('debugChatLog', 'DM PIN 创建：已填码', { step: 'pin_setup', pin_len: pin.length });
      return { ok: true, setup_pending: true, setup_filling: true };
    }

    // 欢迎页：点「创建密码」
    if (hasCreatePasscodeButton() || isDmPinSetupRequired()) {
      var clicked = clickCreatePasscodeButton();
      if (clicked) {
        sessionStorage.setItem('dm_pin_setup_attempts', String(attempts + 1));
        if (!attemptsAt) sessionStorage.setItem('dm_pin_setup_at', String(now));
        if (now - _dmPinLastToastAt > 8000) {
          _dmPinLastToastAt = now;
          callHook('showToast', '🔓 已点「创建密码」，准备填入 ' + pin, '#1d9bf0', 2200);
        }
        reportDmPinGate({ ok: false, reason: 'setup_clicked_create' });
        callHook('debugChatLog', 'DM PIN 创建：已点创建按钮', { step: 'pin_setup' });
        return { ok: true, setup_pending: true, setup_clicked: true };
      }
    }

    reportDmPinGate({ ok: false, reason: 'setup_waiting' });
    return { ok: true, setup_pending: true, setup_waiting: true };
  }

  function tryUnlockDmPin() {
    // 创建密码引导 / 创建进行中：自动用 chat_dm_pin 创建，不交手动（失败/限流除外）
    var setupInflight = false;
    try { setupInflight = sessionStorage.getItem('dm_pin_setup_inflight') === '1'; } catch (eInf) {}
    if (isDmPinSetupRequired() || setupInflight) {
      return tryCreateDmPasscode();
    }

    var nowEarly = Date.now();
    if (isDmEncryptionModuleBroken()) {
      if (nowEarly - _dmPinLastToastAt > 15000) {
        _dmPinLastToastAt = nowEarly;
        callHook('showToast', '🔒 加密模块加载失败，交回养号', '#f85149', 3500);
        reportDmPinGate({ ok: false, reason: 'encryption_module_broken' });
      }
      emitPinGiveUp('encryption_module_broken');
      return { ok: false, encryption_broken: true };
    }

    var pending = sessionStorage.getItem('dm_pin_pending_verify');
    if (pending && !isDmPinGateVisible()) {
      sessionStorage.removeItem('dm_pin_pending_verify');
      sessionStorage.setItem('dm_pin_unlocked_at', String(Date.now()));
      sessionStorage.setItem('dm_pin_unlock_attempts', '0');
      sessionStorage.removeItem('dm_pin_attempts_at');
      clearDmPinBlocked();
      return { ok: true, verified: true };
    }
    if (!isDmPinGateVisible()) {
      var unlockedAt = parseInt(sessionStorage.getItem('dm_pin_unlocked_at') || '0', 10) || 0;
      if (unlockedAt && Date.now() - unlockedAt < 30 * 60 * 1000) {
        return { ok: true, skipped: true };
      }
      return { ok: false, not_visible: true };
    }

    var now = Date.now();
    // 平台限流：停止填码，交回调度冷却
    if (isDmPinRateLimited()) {
      if (now - _dmPinLastToastAt > 15000) {
        _dmPinLastToastAt = now;
        callHook('showToast', '🔒 Passcode 被限流，稍后再试（勿连点）', '#f85149', 3500);
        reportDmPinGate({ ok: false, reason: 'rate_limited' });
        try {
          if (typeof SgTelemetry !== 'undefined') SgTelemetry.emit('chat.dm_pin_unlock', { ok: false, reason: 'rate_limited' });
        } catch (eRl) {}
      }
      emitPinGiveUp('rate_limited');
      return { ok: false, rate_limited: true };
    }

    // 4.1.53：检出即填 2546，节流缩短避免空等
    if (now - _dmPinLastTryAt < 900) {
      return { ok: false, throttled: true };
    }
    var attempts = parseInt(sessionStorage.getItem('dm_pin_unlock_attempts') || '0', 10) || 0;
    var attemptsAt = parseInt(sessionStorage.getItem('dm_pin_attempts_at') || '0', 10) || 0;
    if (attempts >= 3 && attemptsAt && now - attemptsAt > 90 * 1000) {
      attempts = 0;
      sessionStorage.setItem('dm_pin_unlock_attempts', '0');
      sessionStorage.removeItem('dm_pin_attempts_at');
    }
    if (attempts >= 3) {
      if (now - _dmPinLastToastAt > 15000) {
        _dmPinLastToastAt = now;
        callHook('showToast', 'DM PIN 解锁失败，请手动输入 2546（或 OPS chat_dm_pin）', '#f85149', 3500);
        reportDmPinGate({ ok: false, reason: 'max_attempts' });
        try {
          if (typeof SgTelemetry !== 'undefined') SgTelemetry.emit('chat.dm_pin_unlock', { ok: false, reason: 'max_attempts' });
        } catch (eM) {}
      }
      emitPinGiveUp('max_attempts');
      return { ok: false, max_attempts: true };
    }

    _dmPinLastTryAt = now;
    var pin = getChatDmPin();
    var filled = fillPinDigits(pin);
    if (!filled) {
      // 无输入框：不计 attempt（创建页/过渡页），避免假「多次失败」
      reportDmPinGate({ ok: false, reason: 'no_input', pin_from_config: true });
      callHook('debugChatLog', 'DM PIN 未找到输入框，passcode 门禁拦截', { step: 'pin_unlock', level: 'warn' });
      return { ok: false, no_input: true };
    }
    // 仅在真正写入输入格后计数
    sessionStorage.setItem('dm_pin_unlock_attempts', String(attempts + 1));
    if (!attemptsAt) sessionStorage.setItem('dm_pin_attempts_at', String(now));
    clickPinConfirmButton();
    if (!isDmPinGateVisible()) {
      sessionStorage.removeItem('dm_pin_pending_verify');
      sessionStorage.setItem('dm_pin_unlocked_at', String(Date.now()));
      sessionStorage.setItem('dm_pin_unlock_attempts', '0');
      sessionStorage.removeItem('dm_pin_attempts_at');
      callHook('debugChatLog', 'DM PIN 自动解锁', { step: 'pin_unlock' });
      callHook('showToast', '🔓 DM PIN 已自动解锁', '#1d9bf0', 2000);
      clearDmPinBlocked();
      try {
        if (typeof SgTelemetry !== 'undefined') SgTelemetry.emit('chat.dm_pin_unlock', { ok: true });
      } catch (eT) {}
      return { ok: true };
    }
    sessionStorage.setItem('dm_pin_pending_verify', '1');
    reportDmPinGate({ ok: false, reason: 'pending_verify' });
    callHook('debugChatLog', 'DM PIN 已填入，等待门消失', { step: 'pin_unlock', pin_len: pin.length });
    return { ok: true, pending_verify: true };
  }

  function bind(nextHooks) {
    if (!nextHooks) return api;
    Object.keys(hooks).forEach(function (k) {
      if (typeof nextHooks[k] === 'function') hooks[k] = nextHooks[k];
    });
    return api;
  }

  var api = {
    bind: bind,
    getChatDmPin: getChatDmPin,
    isDmPinGateVisible: isDmPinGateVisible,
    isDmPinSetupRequired: isDmPinSetupRequired,
    isDmPinRateLimited: isDmPinRateLimited,
    isDmEncryptionModuleBroken: isDmEncryptionModuleBroken,
    isDmPinBlockedForSend: isDmPinBlockedForSend,
    reportDmPinGate: reportDmPinGate,
    clearDmPinBlocked: clearDmPinBlocked,
    tryUnlockDmPin: tryUnlockDmPin,
    tryCreateDmPasscode: tryCreateDmPasscode,
    fillPinDigits: fillPinDigits
  };

  if (typeof window !== 'undefined') {
    window.SgDmPin = api;
  }

  console.log('[C6] dm-pin.js loaded');
})();

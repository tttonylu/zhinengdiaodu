// =============================================================================
// 智能调度 — 引擎生命周期工具（轻量版，替代 EngineBase 类）
// 为 nurture 引擎提供 timer/watchdog/flag 管理
// =============================================================================

var EngineUtils = (function () {
  'use strict';

  var _states = {};

  function _ns(name, key) {
    return 'sg_' + name + '_' + key;
  }

  return {
    /** 创建可取消的间隔 timer */
    createInterval: function (fn, ms) {
      var id = setInterval(fn, ms);
      return {
        id: id,
        cancel: function () { if (id) { clearInterval(id); id = null; } },
      };
    },

    /** 创建可取消的延迟 timer */
    createTimeout: function (fn, ms) {
      var id = setTimeout(fn, ms);
      return {
        id: id,
        cancel: function () { if (id) clearTimeout(id); id = null; },
      };
    },

    /** 启动引擎（写标记） */
    start: function (name) {
      sessionStorage.setItem(_ns(name, 'running'), 'true');
      sessionStorage.removeItem(_ns(name, 'paused'));
      localStorage.setItem(_ns(name, 'running'), 'true');
      _states[name] = { lastActivity: Date.now(), running: true, paused: false };
    },

    /** 停止引擎（清标记） */
    stop: function (name) {
      sessionStorage.removeItem(_ns(name, 'running'));
      sessionStorage.removeItem(_ns(name, 'paused'));
      localStorage.removeItem(_ns(name, 'running'));
      if (_states[name]) _states[name].running = false;
    },

    /** 暂停引擎 */
    pause: function (name) {
      sessionStorage.setItem(_ns(name, 'paused'), 'true');
      if (_states[name]) _states[name].paused = true;
    },

    /** 恢复引擎 */
    resume: function (name) {
      sessionStorage.removeItem(_ns(name, 'paused'));
      if (_states[name]) { _states[name].paused = false; _states[name].lastActivity = Date.now(); }
    },

    /** 引擎是否活跃（running && !paused） */
    isActive: function (name) {
      var running = sessionStorage.getItem(_ns(name, 'running')) === 'true';
      var paused = sessionStorage.getItem(_ns(name, 'paused')) === 'true';
      return running && !paused;
    },

    /** 引擎是否正在运行（含 paused） */
    isRunning: function (name) {
      return sessionStorage.getItem(_ns(name, 'running')) === 'true';
    },

    /** 更新时间戳 */
    ping: function (name) {
      if (_states[name]) _states[name].lastActivity = Date.now();
    },

    /** 获取距上次活动毫秒 */
    idleMs: function (name) {
      var st = _states[name];
      if (!st || !st.lastActivity) return 0;
      return Date.now() - st.lastActivity;
    },

    /** 创建看门狗，idle 超过 ms 时触发 cb */
    createWatchdog: function (name, ms, cb) {
      return setInterval(function () {
        if (!EngineUtils.isActive(name)) return;
        if (EngineUtils.idleMs(name) > ms) {
          EngineUtils.ping(name);
          try { cb(); } catch (e) {}
        }
      }, 10000);
    },

    /** 清除看门狗 */
    clearWatchdog: function (id) {
      if (id) clearInterval(id);
    },

    /** 区间随机延迟 */
    randDelay: function (min, max) {
      return Math.floor(Math.random() * (max - min + 1)) + min;
    },

    /** Promise sleep */
    sleep: function (ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms); });
    },

    /**
     * 拟人输入切分：日文（含半角假名）按字符，其他按 2–6 字符词组。
     * 不变量：所有片段拼接 === 原文（禁止重叠，否则会重复/丢字）。
     */
    segmentForTyping: function (text) {
      var t = String(text == null ? '' : text);
      if (!t) return [];
      if (/[\u3040-\u309f\u30a0-\u30ff\uff66-\uff9f]/.test(t)) return t.split('');
      var segs = [];
      for (var i = 0; i < t.length;) {
        var step = EngineUtils.randDelay(2, 6);
        segs.push(t.slice(i, i + step));
        i += step;
      }
      return segs;
    },

    /** 拟人化键盘输入：走 Lexical 正规输入通道（execCommand insertText 触发 beforeinput）。
     *  禁止用 range.insertNode 直接硬塞 DOM —— 那会绕过 React 受控 state，被 reconciliation 抹掉，
     *  表现为「逐字打上去后又全部删除、发送按钮保持 disabled 卡住不动」。 */
    typeTextHumanLike: async function (editor, text) {
      if (!editor || !text) return true;
      var self = EngineUtils;

      // X compose/评论框是 Lexical contenteditable，文本即真实 state，直接读 innerText（textContent 兜底）
      function read() {
        return ((editor.innerText || editor.textContent || '') + '').trim();
      }
      function looksOk(got) {
        if (!got) return false;
        if (got === text) return true;
        var n = Math.min(8, text.length);
        return n > 0 && got.indexOf(text.slice(0, n)) >= 0;
      }
      function placeCaretAtEnd() {
        try {
          var range = document.createRange();
          range.selectNodeContents(editor);
          range.collapse(false);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        } catch (_) {}
      }

      try { editor.focus(); } catch (_) {}
      await self.sleep(self.randDelay(80, 200));

      var segs = self.segmentForTyping(text);
      for (var i = 0; i < segs.length; i++) {
        var seg = segs[i];
        var key = seg.length === 1 ? seg : '';
        var code = key ? 'Key' + key.toUpperCase() : '';
        var charCode = key ? key.charCodeAt(0) : 0;

        editor.dispatchEvent(new KeyboardEvent('keydown', { key: key, code: code, charCode: charCode, which: charCode || 0, bubbles: true, cancelable: true }));

        // 真实输入通道：execCommand insertText → 触发 beforeinput(inputType=insertText)，
        // Draft.js onBeforeInput 读取 data 并更新内部 state（不得靠手动插 DOM）
        var inserted = false;
        try {
          placeCaretAtEnd();
          inserted = document.execCommand('insertText', false, seg);
        } catch (_) {}

        // 兜底：仅 execCommand 未生效时才补发合成 beforeinput + input（避免成功后再派发 input 干扰 Lexical）
        if (!inserted) {
          try {
            editor.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: seg, bubbles: true, cancelable: true }));
          } catch (_) {}
          try {
            editor.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: seg, bubbles: true, cancelable: true }));
          } catch (_) {}
        }

        editor.dispatchEvent(new KeyboardEvent('keyup', { key: key, code: code, charCode: charCode, which: charCode || 0, bubbles: true, cancelable: true }));

        var pause = self.randDelay(30, 150);
        if (Math.random() < 0.08) pause = self.randDelay(300, 800);
        await self.sleep(pause);
      }

      return looksOk(read());
    },

    /** 拟人化鼠标点击：mousemove/mouseenter/mousedown/mouseup/click */
    humanClick: async function (el) {
      if (!el) return false;
      var self = EngineUtils;
      var rect = el.getBoundingClientRect();
      var x = rect.left + self.randDelay(4, Math.max(5, rect.width - 4));
      var y = rect.top  + self.randDelay(4, Math.max(5, rect.height - 4));

      function ev(type, opts) {
        var o = Object.assign({ bubbles: true, cancelable: true, clientX: x, clientY: y, pageX: x + window.scrollX, pageY: y + window.scrollY, button: 0 }, opts || {});
        if (type.indexOf('mouse') === 0 || type === 'click') return new MouseEvent(type, o);
        if (type.indexOf('pointer') === 0) return new PointerEvent(type, o);
        return new Event(type, o);
      }

      el.dispatchEvent(ev('mousemove'));
      await self.sleep(self.randDelay(30, 120));
      el.dispatchEvent(ev('mouseenter'));
      el.dispatchEvent(ev('mouseover'));
      await self.sleep(self.randDelay(100, 400));
      el.dispatchEvent(ev('mousedown'));
      await self.sleep(self.randDelay(50, 150));
      try { if (el.focus && !el.matches(':focus')) el.focus(); } catch (_) {}
      el.dispatchEvent(ev('mouseup'));
      await self.sleep(self.randDelay(30, 100));
      // 一次点击只发一个 click；再调 el.click() 会触发两次 onClick（重复发送/点赞）
      el.dispatchEvent(ev('click'));
      return true;
    },

    /** 命中常见反垃圾/风控文案 */
    looksLikeAntiSpam: function (fullText) {
      if (!fullText) return false;
      var t = fullText.toLowerCase();
      var patterns = [
        /此请求疑似为自动发送/, /疑似自动/, /自动发送/, /垃圾邮件/, /可疑/, /账号暂时受限/,
        /操作太频繁/, /发送过于频繁/, /请稍后再试/,
        // X 官方句式（2026-10 实机）：「该请求看上去可能是自动产生的。为了保护我们的用户免受垃圾信息…我们现在无法完成这一操作。请稍后再试。」
        /看上去.{0,8}自动/, /可能是自动产生/, /无法完成这一操作/,
        /automated/, /suspicious activity/, /spam/, /bot detected/, /unusual activity/,
        /rate limit/, /try again later/, /could not send/,
        /looks like it might be automated/, /protect our users/, /malicious activity/,
        /自動/, /迷惑メール/, /アカウントを一時的にロック/, /しばらく経ってから/, /不審/
      ];
      return patterns.some(function (re) { return re.test(t); });
    },

    /** 账号级反垃圾冷却：命中后主动退让（4.6.30 按号隔离 key，防多号连坐） */
    markAntiSpamCooldown: function (minMin, maxMin) {
      var min = minMin || 60;
      var max = maxMin || 120;
      var seed = '';
      try { seed = localStorage.getItem('matrix_my_handle') || localStorage.getItem('matrix_bit_id') || 'x'; } catch (_) {}
      var h = 2166136261;
      for (var i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
      var add = min + ((h >>> 0) % Math.max(1, max - min + 1));
      var until = Date.now() + add * 60000;
      try {
        // 按号隔离 key（§X F3↔E1/D1），防止同浏览器多号连坐
        var hdl = seed || 'global';
        localStorage.setItem('sg_antispam_cooldown_until_' + hdl, String(until));
        var cnt = parseInt(localStorage.getItem('sg_antispam_count_' + hdl) || '0', 10) || 0;
        localStorage.setItem('sg_antispam_count_' + hdl, String(cnt + 1));
      } catch (_) {}
    },

    isAntiSpamCooldown: function () {
      try {
        var hdl = '';
        try { hdl = localStorage.getItem('matrix_my_handle') || localStorage.getItem('matrix_bit_id') || 'global'; } catch (_) {}
        var until = parseInt(localStorage.getItem('sg_antispam_cooldown_until_' + hdl) || '0', 10) || 0;
        if (until > Date.now()) return true;
        if (until > 0) localStorage.removeItem('sg_antispam_cooldown_until_' + hdl);
      } catch (_) {}
      return false;
    },

    msUntilAntiSpamCooldownEnd: function () {
      try {
        var hdl = '';
        try { hdl = localStorage.getItem('matrix_my_handle') || localStorage.getItem('matrix_bit_id') || 'global'; } catch (_) {}
        var until = parseInt(localStorage.getItem('sg_antispam_cooldown_until_' + hdl) || '0', 10) || 0;
        return Math.max(0, until - Date.now());
      } catch (_) { return 0; }
    },

    getAntiSpamCount: function () {
      try {
        var hdl = '';
        try { hdl = localStorage.getItem('matrix_my_handle') || localStorage.getItem('matrix_bit_id') || 'global'; } catch (_) {}
        return parseInt(localStorage.getItem('sg_antispam_count_' + hdl) || '0', 10) || 0;
      } catch (_) { return 0; }
    },
  };
})();

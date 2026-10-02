// =============================================================================
// B4 · Soft Risk Diversion（关注填窗）
// 唯一入口：平台下方风控条（soft_*，约点满十余粉后出现）→ 休息 15–17 分
// 禁止：超时/死号/列表卡死/配额满 冒充软风控（那些只交回调度）
// 宿主：rand / updateStats / stopBot / isRunning 经 SgSoftRisk.bind 注入
// =============================================================================
(function () {
  'use strict';
  if (typeof window !== 'undefined' && window.__sg_soft_risk_loaded__) return;
  if (typeof window !== 'undefined') window.__sg_soft_risk_loaded__ = true;

  var hooks = {
    rand: null,
    updateStats: null,
    stopBot: null,
    isRunning: null,
    getAccountStats: null,
    getDailyLimit: null
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

  function defaultRand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /** Day≥3 且私信时段且 modules.chat 开 → SoftFillMode.chat_fill；否则不可塞私信 */
  function canEnterSoftRiskChat() {
    try {
      try {
        var sg = JSON.parse(localStorage.getItem('sg_state') || '{}');
        var ph = sg.softRiskPhase || '';
        if (ph === 'chat1' || ph === 'nurture' || ph === 'chat2') return false;
        if (sg.softRiskUntil && Date.now() < sg.softRiskUntil) return false;
      } catch (eSg) {}
      if (typeof SgSoftFillMode !== 'undefined' && SgSoftFillMode.resolve) {
        return !!SgSoftFillMode.resolve({ day: currentDayCount() }).allowChat;
      }
      // 无能力闸时退回旧判定
      if (typeof StageDetector !== 'undefined') {
        if (StageDetector.detect) StageDetector.detect();
        if (StageDetector.isChatTime && !StageDetector.isChatTime()) return false;
      }
      return currentDayCount() >= 3;
    } catch (e) {
      return false;
    }
  }

  function currentDayCount() {
    try {
      var stats = callHook('getAccountStats') || {};
      var d = parseInt(stats.day_count, 10);
      if (d > 0) return d;
    } catch (e) {}
    return 1;
  }

  function isPlatformSoftReason(reason) {
    return String(reason || '').indexOf('soft_') === 0;
  }

  function enterSoftRiskDiversion(reason) {
    reason = String(reason || '');
    // 硬闸：必须是平台 soft_*；空 reason / 超时换号等一律拒绝
    if (!isPlatformSoftReason(reason)) {
      try {
        if (typeof Logger !== 'undefined' && Logger.warn) {
          Logger.warn('调度', '拒绝非平台软风控 reason=' + (reason || '(empty)'));
        }
      } catch (eR) {}
      return;
    }
    try {
      var sgGuard = JSON.parse(localStorage.getItem('sg_state') || '{}');
      if (sgGuard.softRiskUntil && Date.now() < sgGuard.softRiskUntil) {
        try {
          localStorage.removeItem('matrix_follow_running');
          var msGuard = JSON.parse(sessionStorage.getItem('sg_module_follow') || '{}');
          msGuard.running = false;
          msGuard.phase = 'soft_cooldown';
          msGuard.lastActive = Date.now();
          sessionStorage.setItem('sg_module_follow', JSON.stringify(msGuard));
        } catch (eG) {}
        if (callHook('isRunning')) callHook('stopBot', { keepTask: true });
        return;
      }
    } catch (eGuard) {}

    var randFn = typeof hooks.rand === 'function' ? hooks.rand : defaultRand;
    var dur = randFn(15, 17);
    var until = Date.now() + dur * 60000;
    var day = currentDayCount();
    var fill = { mode: 'nurture_only', allowChat: false, reason: 'fallback', day: day };
    try {
      if (typeof SgSoftFillMode !== 'undefined' && SgSoftFillMode.resolve) {
        fill = SgSoftFillMode.resolve({ day: day });
      } else {
        var chatTimeOkFb = true;
        try {
          if (typeof StageDetector !== 'undefined') {
            if (StageDetector.detect) StageDetector.detect();
            if (StageDetector.isChatTime && !StageDetector.isChatTime()) chatTimeOkFb = false;
          }
        } catch (eCt) {}
        var modOn = true;
        try {
          var mods = JSON.parse(localStorage.getItem('sg_module_switches') || '{}');
          if (mods && mods.chat === false) modOn = false;
        } catch (eMod) {}
        if (!modOn) fill = { mode: 'off', allowChat: false, reason: 'chat_module_off', day: day };
        else if (day < 3) fill = { mode: 'nurture_only', allowChat: false, reason: 'day_lt_3', day: day };
        else if (!chatTimeOkFb) fill = { mode: 'nurture_only', allowChat: false, reason: 'outside_chat_hours', day: day };
        else fill = { mode: 'chat_fill', allowChat: true, reason: '', day: day };
      }
    } catch (eFill) {}
    var allowChat = !!fill.allowChat;
    var mode = allowChat ? 'chat_nurture_chat' : 'nurture';
    var phase = allowChat ? 'chat1' : 'nurture';
    var tip = allowChat
      ? ('平台风控 → 休息 ' + dur + 'm（私信→养号→私信）')
      : ('平台风控 → 休息只养号 ' + dur + 'm（' + (fill.reason || ('Day' + day)) + '）');
    callHook('updateStats', tip);
    try {
      if (typeof Logger !== 'undefined' && Logger.info) {
        Logger.info('调度', allowChat
          ? ('平台软风控休息 ' + dur + 'm → chat1→养号→chat2 SoftFill=' + fill.mode + ' reason=' + (reason || 'soft'))
          : ('平台软风控休息只养号 SoftFill=' + fill.mode + '/' + (fill.reason || '') + ' ' + dur + 'm reason=' + (reason || 'soft')));
      }
    } catch (eL) {}
    try {
      sessionStorage.setItem('sg_follow_dead_skip_count', '0');
      var sgSt = JSON.parse(localStorage.getItem('sg_state') || '{}');
      sgSt.softRiskUntil = until;
      sgSt.softRiskStartedAt = Date.now();
      sgSt.softRiskMode = mode;
      sgSt.softRiskChatDone = !allowChat;
      sgSt.softRiskOutboundDone = !allowChat;
      sgSt.softRiskIceExtendMs = 0;
      sgSt.softRiskOvertimeMs = 0;
      sgSt.softRiskPhase = phase;
      sgSt.softRiskChatPass = allowChat ? 0 : 2;
      sgSt.softFillMode = fill.mode || '';
      sgSt.followRoundEndedAt = Date.now();
      sgSt.followNextDelayUntil = until;
      localStorage.setItem('sg_state', JSON.stringify(sgSt));
      try { sessionStorage.setItem('sg_debt_only', 'false'); } catch (eDebt) {}
      try {
        sessionStorage.removeItem('sg_soft_risk_pulse_ran');
        sessionStorage.removeItem('sg_soft_risk_pulse_retry');
        sessionStorage.removeItem('sg_soft_risk_pulse_reason');
        sessionStorage.removeItem('sg_soft_chat2_prepared');
      } catch (ePulseClr) {}
      try {
        sessionStorage.removeItem('sg_chat_session_kind');
        sessionStorage.removeItem('sg_chat_session_opens');
        sessionStorage.removeItem('sg_chat_session_deadline');
        sessionStorage.removeItem('sg_chat_session_max_opens');
      } catch (eSessClr) {}
      var msPf = JSON.parse(sessionStorage.getItem('sg_module_follow') || '{}');
      msPf.running = false;
      msPf.phase = 'soft_cooldown';
      msPf.lastActive = Date.now();
      sessionStorage.setItem('sg_module_follow', JSON.stringify(msPf));
    } catch (e) {}
    try { localStorage.removeItem('matrix_follow_running'); } catch (e2a) {}
    // 先 stopBot(keepTask) 再钉 soft_fill：旧 stopBot 会写 false 盖掉旗标
    callHook('stopBot', { keepTask: true });
    try {
      sessionStorage.setItem('matrix_tab_running', 'soft_fill');
      localStorage.removeItem('matrix_follow_running');
    } catch (e2) {}
    try {
      sessionStorage.setItem('dan_ops_refresh_on_soft_risk', String(Date.now()));
      if (allowChat) {
        window.dispatchEvent(new CustomEvent('sg-soft-risk-chat-start', {
          detail: { until: until, durationMin: dur, mode: mode, pass: 1, softFillMode: fill.mode }
        }));
      }
    } catch (eEv) {}
    try {
      window.dispatchEvent(new CustomEvent('sg-soft-risk-entered', {
        detail: {
          until: until,
          durationMin: dur,
          mode: mode,
          softFillMode: fill.mode,
          allowChat: !!allowChat,
          day: day,
          reason: reason || 'soft',
          fillReason: fill.reason || '',
          platformOnly: true
        }
      }));
    } catch (eSe) {}
    try {
      document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
        detail: {
          text: allowChat
            ? ('平台风控休息 | 私信→养号→私信 | 约 ' + dur + 'm')
            : ('平台风控休息 | 只养号 ' + (fill.mode || '') + ' | 约 ' + dur + 'm')
        }
      }));
    } catch (eDiag) {}
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
    canEnterSoftRiskChat: canEnterSoftRiskChat,
    enterSoftRiskDiversion: enterSoftRiskDiversion,
    isPlatformSoftReason: isPlatformSoftReason
  };

  if (typeof window !== 'undefined') {
    window.SgSoftRisk = api;
  }

  console.log('[B4] soft-risk.js loaded (platform soft only)');
})();

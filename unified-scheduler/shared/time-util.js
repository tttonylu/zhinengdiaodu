// =============================================================================
// 上海时区时间工具 — 强制 24h（h23）；禁止 en-US 字符串正则把下午 1:xx 当成凌晨
// =============================================================================

var TimeUtil = (function () {
  'use strict';

  function pad2(n) {
    n = parseInt(n, 10) || 0;
    return (n < 10 ? '0' : '') + n;
  }

  /** Intl formatToParts + hourCycle h23；失败再用 UTC+8 墙钟（永不走 en-US 正则） */
  function shanghaiParts(optNow) {
    var now = optNow != null ? new Date(optNow) : new Date();
    try {
      var parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
      }).formatToParts(now);
      var h = 0, m = 0;
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === 'hour') h = parseInt(parts[i].value, 10);
        if (parts[i].type === 'minute') m = parseInt(parts[i].value, 10);
      }
      if (h === 24) h = 0;
      if (!isNaN(h) && !isNaN(m) && h >= 0 && h <= 23) {
        return { h: h, m: m, minutes: h * 60 + m };
      }
    } catch (e0) {}
    try {
      var parts2 = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
      }).formatToParts(now);
      var h2 = 0, m2 = 0;
      for (var j = 0; j < parts2.length; j++) {
        if (parts2[j].type === 'hour') h2 = parseInt(parts2[j].value, 10);
        if (parts2[j].type === 'minute') m2 = parseInt(parts2[j].value, 10);
      }
      if (h2 === 24) h2 = 0;
      if (!isNaN(h2) && !isNaN(m2) && h2 >= 0 && h2 <= 23) {
        return { h: h2, m: m2, minutes: h2 * 60 + m2 };
      }
    } catch (e1) {}
    // 最后兜底：按 UTC+8 墙钟（不依赖 locale 字符串）
    try {
      var utc = now.getTime() + 8 * 3600 * 1000;
      var d = new Date(utc);
      var hh = d.getUTCHours();
      var mm = d.getUTCMinutes();
      return { h: hh, m: mm, minutes: hh * 60 + mm };
    } catch (e2) {
      return null;
    }
  }

  function shanghaiDate() {
    try {
      return new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
    } catch (e) {
      return new Date().toLocaleDateString('zh-CN');
    }
  }

  /** 给定分钟数是否在 [start, end)（支持跨夜 end<=start；end>=24:00 当午夜） */
  function inRangeMinutes(t, hS, mS, hE, mE) {
    var start = (parseInt(hS, 10) || 0) * 60 + (parseInt(mS, 10) || 0);
    var end = (parseInt(hE, 10) || 0) * 60 + (parseInt(mE, 10) || 0);
    if (end >= 24 * 60) end = 24 * 60;
    if (end <= start) return t >= start || t < end;
    return t >= start && t < end;
  }

  function inRange(hS, mS, hE, mE, optNow) {
    var p = shanghaiParts(optNow);
    if (!p) return false;
    return inRangeMinutes(p.minutes, hS, mS, hE, mE);
  }

  function nowLabel(optNow) {
    var p = shanghaiParts(optNow);
    if (!p) return '?';
    return pad2(p.h) + ':' + pad2(p.m);
  }

  function hmLabel(h, m) {
    return pad2(h) + ':' + pad2(m);
  }

  /** 24小时测试模式：面板 sg_test_24h，或 OPS stagePolicy.test24h / 工作+私信窗均为全天 */
  function isTest24h() {
    try {
      if (typeof localStorage !== 'undefined' && localStorage.getItem('sg_test_24h') === 'true') return true;
    } catch (e) {}
    try {
      if (typeof localStorage === 'undefined') return false;
      var p = JSON.parse(localStorage.getItem('sg_stage_policy') || '{}');
      if (!p || typeof p !== 'object') return false;
      if (p.test24h === true || p.test24h === 1 || p.test24h === 'true') return true;
      function coversFullDay(h) {
        if (!h || !Array.isArray(h.start) || !Array.isArray(h.end)) return false;
        var s = (parseInt(h.start[0], 10) || 0) * 60 + (parseInt(h.start[1], 10) || 0);
        var e = (parseInt(h.end[0], 10) || 0) * 60 + (parseInt(h.end[1], 10) || 0);
        return s <= 0 && e >= 24 * 60;
      }
      return coversFullDay(p.workHours) && coversFullDay(p.chatHours);
    } catch (e2) {
      return false;
    }
  }

  /** 兼职粉池：私信不早于北京时间 10:00 开（与 chat_script_pool=job 绑定） */
  function isJobScriptPool() {
    try {
      if (typeof window !== 'undefined' && window.RemoteSettings && typeof window.RemoteSettings.chatScriptPool === 'function') {
        return window.RemoteSettings.chatScriptPool() === 'job';
      }
    } catch (eRs) {}
    try {
      var t = JSON.parse(localStorage.getItem('sg_config_thresholds') || '{}') || {};
      return String(t.chat_script_pool || 'dating').toLowerCase().trim() === 'job';
    } catch (e) {
      return false;
    }
  }

  /** 读 sg_stage_policy.chatHours；产品默认 dating 08:00–18:00；job 池硬窗北京 10:00–19:00 */
  function readChatHours() {
    if (isTest24h()) return { startH: 0, startM: 0, endH: 24, endM: 0 };
    var out = { startH: 8, startM: 0, endH: 18, endM: 0 };
    try {
      var p = JSON.parse(localStorage.getItem('sg_stage_policy') || '{}');
      var ch = (p.chatHours && p.chatHours.start) ? p.chatHours : null;
      if (ch && Array.isArray(ch.start) && Array.isArray(ch.end)) {
        out = {
          startH: parseInt(ch.start[0], 10) || 8,
          startM: parseInt(ch.start[1], 10) || 0,
          endH: parseInt(ch.end[0], 10) || 18,
          endM: parseInt(ch.end[1], 10) || 0
        };
      }
    } catch (e) {}
    // 兼职粉：北京时间（Asia/Shanghai）硬窗 10:00–19:00；19:00 起硬停，留到次日
    // inRange 为 [start, end)，故 end=19:00 时 19:00 起不在窗内
    if (isJobScriptPool()) {
      out.startH = 10;
      out.startM = 0;
      out.endH = 19;
      out.endM = 0;
    }
    return out;
  }

  function readWorkHours() {
    if (isTest24h()) return { startH: 0, startM: 0, endH: 24, endM: 0 };
    try {
      var p = JSON.parse(localStorage.getItem('sg_stage_policy') || '{}');
      var wh = (p.workHours && p.workHours.start) ? p.workHours : null;
      if (wh && Array.isArray(wh.start) && Array.isArray(wh.end)) {
        return {
          startH: parseInt(wh.start[0], 10) || 6,
          startM: parseInt(wh.start[1], 10) || 0,
          endH: parseInt(wh.end[0], 10) || 2,
          endM: parseInt(wh.end[1], 10) || 0
        };
      }
    } catch (e) {}
    return { startH: 6, startM: 0, endH: 2, endM: 0 };
  }

  /** 当前是否在私信时段内（含 test24h 全天） */
  function isWithinChatHours() {
    if (isTest24h()) return true;
    var h = readChatHours();
    return inRange(h.startH, h.startM, h.endH, h.endM);
  }

  /** 定格点：上海时间；dating 17:00；job 对齐私信硬停 19:00（不停窗内破冰）；24h 测试永不定格 */
  function chatFreezeMinutes() {
    if (isTest24h()) return 24 * 60;
    if (isJobScriptPool()) return 19 * 60;
    return 17 * 60;
  }

  /** 私信硬停：跟 chatHours.end（默认 18:00）；24h 测试模式永不硬停 */
  function chatStopMinutes() {
    if (isTest24h()) return 24 * 60;
    var h = readChatHours();
    return (h.endH * 60) + (h.endM || 0);
  }

  /** 是否已到定格点（含定格后全天，直到次日清） */
  function isPastChatFreeze() {
    var p = shanghaiParts();
    if (!p) return false;
    return p.minutes >= chatFreezeMinutes();
  }

  /** 是否已过私信硬停：不在私信窗内（跟 chatHours，默认 08–18） */
  function isPastChatStop() {
    if (isTest24h()) return false;
    return !isWithinChatHours();
  }

  /** 赶工窗：已停用（产品改为软风控短扫，过点不赶债） */
  function isChatRushWindow() {
    return false;
  }

  var api = {
    shanghaiParts: shanghaiParts,
    shanghaiDate: shanghaiDate,
    inRange: inRange,
    inRangeMinutes: inRangeMinutes,
    nowLabel: nowLabel,
    hmLabel: hmLabel,
    pad2: pad2,
    readChatHours: readChatHours,
    readWorkHours: readWorkHours,
    isWithinChatHours: isWithinChatHours,
    isTest24h: isTest24h,
    chatFreezeMinutes: chatFreezeMinutes,
    chatStopMinutes: chatStopMinutes,
    isPastChatFreeze: isPastChatFreeze,
    isPastChatStop: isPastChatStop,
    isChatRushWindow: isChatRushWindow
  };
  if (typeof window !== 'undefined') window.TimeUtil = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  try {
    var _ver = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest)
      ? String(chrome.runtime.getManifest().version || '') : '';
    if (_ver) {
      localStorage.setItem('sg_ext_version', _ver);
      localStorage.setItem('sg_ext_loaded_at', String(Date.now()));
    }
  } catch (eStamp) {}
  return api;
})();

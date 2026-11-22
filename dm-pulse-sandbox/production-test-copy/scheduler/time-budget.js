(function () {
  'use strict';

  /** 北京时间当前小时 0-23（强制 h23，禁止 en-US 字符串） */
  function shHour() {
    try {
      if (typeof TimeUtil !== 'undefined' && TimeUtil.shanghaiParts) {
        var sp = TimeUtil.shanghaiParts();
        if (sp && sp.h != null) return sp.h;
      }
      var parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23'
      }).formatToParts(new Date());
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === 'hour') {
          var h = parseInt(parts[i].value, 10);
          if (h === 24) h = 0;
          return h;
        }
      }
    } catch (e) {}
    try {
      return new Date(Date.now() + 8 * 3600 * 1000).getUTCHours();
    } catch (e2) {
      return 0;
    }
  }

  function shDayKey() {
    try {
      return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    } catch (e) {
      return new Date().toISOString().slice(0, 10);
    }
  }

  function loadSg() {
    try { return JSON.parse(localStorage.getItem('sg_state') || '{}') || {}; } catch (e) { return {}; }
  }

  /** 每小时预算（分钟）：08-12 outbound 偏重，12-17 inbox 偏重，17-18 仅清债 */
  function hourlyCaps(hour) {
    if (hour >= 17 && hour < 18) return { chat: 30, inbox: 30, outbound: 0, follow: 0 };
    if (hour >= 12 && hour < 17) return { chat: 35, inbox: 22, outbound: 10, follow: 25 };
    if (hour >= 8 && hour < 12) return { chat: 35, inbox: 8, outbound: 22, follow: 25 };
    return { chat: 15, inbox: 5, outbound: 5, follow: 30 };
  }

  function spentThisHour(sg, hour) {
    sg = sg || loadSg();
    var key = 'sg_budget_hour_' + shDayKey() + '_' + hour;
    try {
      return JSON.parse(sessionStorage.getItem(key) || '{}') || {};
    } catch (e) {
      return {};
    }
  }

  function recordSpend(phase, sec) {
    if (!sec || sec <= 0) return;
    var hour = shHour();
    var key = 'sg_budget_hour_' + shDayKey() + '_' + hour;
    var spent = spentThisHour(null, hour);
    var p = phase === 'inbox' ? 'inbox' : (phase === 'outbound' ? 'outbound' : 'chat');
    spent[p] = (spent[p] || 0) + Math.ceil(sec / 60);
    try { sessionStorage.setItem(key, JSON.stringify(spent)); } catch (e) {}
  }

  function remainingMin(phase, sg) {
    var hour = shHour();
    var caps = hourlyCaps(hour);
    var spent = spentThisHour(sg, hour);
    var capKey = phase === 'inbox' ? 'inbox' : (phase === 'outbound' ? 'outbound' : 'chat');
    var cap = caps[capKey] || caps.chat || 30;
    var used = spent[capKey] || 0;
    return Math.max(0, cap - used);
  }

  function canStartPhase(phase, sg) {
    return remainingMin(phase, sg) > 0;
  }

  function snapshot(sg) {
    var hour = shHour();
    return {
      hour: hour,
      caps: hourlyCaps(hour),
      spent: spentThisHour(sg, hour),
      remain: {
        chat: remainingMin('chat', sg),
        inbox: remainingMin('inbox', sg),
        outbound: remainingMin('outbound', sg)
      }
    };
  }

  var SgTimeBudget = {
    shHour: shHour,
    hourlyCaps: hourlyCaps,
    remainingMin: remainingMin,
    canStartPhase: canStartPhase,
    recordSpend: recordSpend,
    snapshot: snapshot
  };

  if (typeof window !== 'undefined') window.SgTimeBudget = SgTimeBudget;
  if (typeof self !== 'undefined') self.SgTimeBudget = SgTimeBudget;
})();

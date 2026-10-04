(function () {
  'use strict';

  var K = SKeys;

  var DEFAULT_POLICY = {
    // 北京时间 Asia/Shanghai；区间左闭右开
    workHours: { start: [6, 0], end: [2, 0] },
    chatHours:  { start: [8, 0], end: [18, 0] },
    // 早间渐进：与上班点相同=一上班就可关注（私信仍 08–18）
    morningNurtureUntil: [6, 0],
    stages: {
      S0: { priority: [] },
      // 4.6.21：Day1 先关注后养号（用户要求先点关注）
      S1: { dayMax: 1, priority: ['follow', 'nurture'] },
      // Day≥2 非私信时段：关注+养号（转帖由 A2 非私信独占，不进白天混排）
      S2: { dayMin: 2, priority: ['follow', 'nurture'] },
      // 4.6.31：取消 S3 日龄门，私信时段即全开（Day1 即可私信）
      S3: { dayMin: 1, priority: ['chat', 'follow', 'nurture'] },
      // S4 已停用，保留字段仅兼容旧配置
      S4: { maxOccupyMin: 30, priority: ['chat'], disabled: true }
    },
    cooldown: { stallCooldownSec: 180, tickIntervalMs: 10000, watchdogMs: 30000 }
  };

  function inRange(hS, mS, hE, mE) {
    if (typeof TimeUtil !== 'undefined' && TimeUtil.inRange) return TimeUtil.inRange(hS, mS, hE, mE);
    // 无 TimeUtil 时：Intl h23，禁止 en-US 正则
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
      var t = hh * 60 + mm;
      var start = hS * 60 + mS;
      var end = hE * 60 + mE;
      if (end >= 24 * 60) end = 24 * 60;
      if (end <= start) return t >= start || t < end;
      return t >= start && t < end;
    } catch (e) {
      return false;
    }
  }

  function getDayCount() {
    try {
      var h = localStorage.getItem(K.LK_MY_HANDLE) || 'unknown';
      h = h.replace('@', '').replace('#guard', '').toLowerCase();
      return (JSON.parse(localStorage.getItem('matrix_stats_' + h) || '{}')).day_count || 1;
    } catch (e) { return 1; }
  }

  function getFollowedToday() {
    try {
      var h = localStorage.getItem(K.LK_MY_HANDLE) || 'unknown';
      h = h.replace('@', '').replace('#guard', '').toLowerCase();
      return (JSON.parse(localStorage.getItem('matrix_stats_' + h) || '{}')).follows_today || 0;
    } catch (e) { return 0; }
  }

  function getLimit() {
    try {
      var h = localStorage.getItem(K.LK_MY_HANDLE) || 'unknown';
      h = h.replace('@', '').replace('#guard', '').toLowerCase();
      var st = JSON.parse(localStorage.getItem('matrix_stats_' + h) || '{}') || {};
      var locked = parseInt(st.daily_limit, 10);
      var todayKey = '';
      try { todayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }); } catch (eT) {}
      var stDay = String(st.date || '');
      var mD = stDay.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
      var stKey = mD ? (mD[1] + '-' + String(mD[2]).padStart(2, '0') + '-' + String(mD[3]).padStart(2, '0')) : stDay;
      if (!isNaN(locked) && locked > 0 && stKey && todayKey && stKey === todayKey) return locked;
      var day = Math.max(1, getDayCount());
      if (typeof RemoteSettings !== 'undefined' && RemoteSettings.followDayRange) {
        var r = RemoteSettings.followDayRange(day);
        if (r && r.max) return Math.round((r.min + r.max) / 2);
      }
      if (typeof RemoteSettings !== 'undefined' && RemoteSettings.followDailyLimit) {
        var rl = RemoteSettings.followDailyLimit(day);
        if (rl != null && rl > 0) return rl;
      }
      return (JSON.parse(localStorage.getItem(K.LK_CONSOLE_SETTINGS) || '{}')).followLimit || 255;
    } catch (e) { return 255; }
  }

  function rnd(m, x) { return Math.floor(Math.random() * (x - m + 1)) + m; }

  function isTest24h() {
    try {
      if (typeof TimeUtil !== 'undefined' && TimeUtil.isTest24h) return !!TimeUtil.isTest24h();
    } catch (e) {}
    try {
      return localStorage.getItem('sg_test_24h') === 'true';
    } catch (e2) { return false; }
  }

  function loadPolicy() {
    try {
      var raw = localStorage.getItem('sg_stage_policy');
      if (raw) {
        var p = JSON.parse(raw);
        return deepMerge(DEFAULT_POLICY, p);
      }
    } catch (e) {}
    return deepMerge({}, DEFAULT_POLICY);
  }

  function deepMerge(target, source) {
    var out = {};
    for (var k in target) { out[k] = target[k]; }
    for (var k in source) {
      if (source[k] && typeof source[k] === 'object' && !Array.isArray(source[k]) && target[k] && typeof target[k] === 'object') {
        out[k] = deepMerge(target[k], source[k]);
      } else {
        out[k] = source[k];
      }
    }
    return out;
  }

  function dropFollow(priority) {
    var out = [];
    var src = priority || [];
    for (var i = 0; i < src.length; i++) {
      if (src[i] !== 'follow') out.push(src[i]);
    }
    return out.length ? out : ['nurture'];
  }

  /** Day≤2：无论 OPS 下发顺序如何，养号必须排在关注前 */
  function preferNurtureBeforeFollow(priority) {
    var hasN = false;
    var hasF = false;
    var rest = [];
    var src = priority || [];
    for (var i = 0; i < src.length; i++) {
      if (src[i] === 'nurture') { hasN = true; continue; }
      if (src[i] === 'follow') { hasF = true; continue; }
      rest.push(src[i]);
    }
    var out = [];
    if (hasN) out.push('nurture');
    if (hasF) out.push('follow');
    return out.concat(rest);
  }

  /** 今日是否已有养号动作（新号开关注的硬条件） */
  function hasNurtureProgressToday() {
    try {
      if (typeof NurtureTracker !== 'undefined' && NurtureTracker.getStats) {
        var ns = NurtureTracker.getStats() || {};
        var u = (ns.daily && ns.daily.used) || {};
        var sum = (u.likes || 0) + (u.comments || 0) + (u.reposts || 0)
          + (u.trends || 0) + (u.profiles || 0) + (u.enters || 0);
        if (sum > 0) return true;
      }
    } catch (e0) {}
    try {
      var today = '';
      try { today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }); } catch (eT) {
        today = String(new Date().getDate());
      }
      if (localStorage.getItem('sg_newacct_nurture_ok_' + today) === '1') return true;
    } catch (e1) {}
    return false;
  }

  /** 4.3.32：新号资料是否已就绪（资料修改过 + 发过帖子）
   *  Day≥2 号默认视为就绪（已度过首日）；Day1 新号需检查
   *  - 资料修改：profile clone textDone 或 done = true
   *  - 发过帖子：repost posted_ids 非空
   *  - 手动标记：sg_newacct_ready_<handle> = '1'
   */
  function isNewAccountReady() {
    try {
      var day = getDayCount();
      if (day >= 2) return true;
    } catch (eD) {}
    // 手动标记优先（用户可在面板点「新号就绪」）
    try {
      var h = localStorage.getItem(K.LK_MY_HANDLE) || 'unknown';
      h = h.replace('@', '').replace('#guard', '').toLowerCase();
      if (localStorage.getItem('sg_newacct_ready_' + h) === '1') return true;
    } catch (eM) {}
    // 检查资料克隆是否完成
    var profileOk = false;
    try {
      var h2 = (localStorage.getItem(K.LK_MY_HANDLE) || 'unknown').replace('@', '').replace('#guard', '').toLowerCase();
      var pcs = localStorage.getItem('sg_profile_clone_state_' + h2);
      if (pcs) {
        var st = JSON.parse(pcs);
        if (st && (st.done || st.textDone)) profileOk = true;
      }
    } catch (eP) {}
    // 检查是否发过帖子（per-handle 标记，避免多号串扰）
    var postOk = false;
    try {
      var h3 = (localStorage.getItem(K.LK_MY_HANDLE) || 'unknown').replace('@', '').replace('#guard', '').toLowerCase();
      if (localStorage.getItem('sg_repost_posted_ok_' + h3) === '1') postOk = true;
    } catch (ePost) {}
    return profileOk && postOk;
  }

  function shanghaiMinutesNow() {
    if (typeof TimeUtil !== 'undefined' && TimeUtil.shanghaiParts) {
      var p = TimeUtil.shanghaiParts();
      if (p && p.minutes != null) return p.minutes;
    }
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
      return hh * 60 + mm;
    } catch (e) {
      return -1;
    }
  }

  /** 早间只养号：仅 [上班点, morningNurtureUntil)。跨夜工作窗下，午夜后 now&lt;截止 不得当早间（否则 00–02 永不开关注） */
  function isMorningNurtureOnly(policy) {
    var until = policy.morningNurtureUntil || [8, 0];
    var cut = (until[0] || 0) * 60 + (until[1] || 0);
    var nowMin = shanghaiMinutesNow();
    if (nowMin < 0) return false;
    var wh = (policy && policy.workHours) || DEFAULT_POLICY.workHours;
    var startH = (wh.start && wh.start[0] != null) ? wh.start[0] : 6;
    var startM = (wh.start && wh.start[1] != null) ? wh.start[1] : 0;
    var start = startH * 60 + startM;
    // 截止≤上班点 = 无早间空窗（如都配 06:00）
    if (cut <= start) return false;
    return nowMin >= start && nowMin < cut;
  }

  var g_isWorkTime = false;
  var g_isChatTime = false;

  function detect() {
    var policy = loadPolicy();
    var test24 = isTest24h();
    var wh = test24 ? { start: [0, 0], end: [24, 0] } : policy.workHours;
    var ch;
    if (test24) {
      ch = { start: [0, 0], end: [24, 0] };
    } else if (typeof TimeUtil !== 'undefined' && TimeUtil.readChatHours) {
      try {
        var th = TimeUtil.readChatHours();
        ch = { start: [th.startH, th.startM || 0], end: [th.endH, th.endM || 0] };
      } catch (eTh) {
        ch = policy.chatHours;
      }
    } else {
      ch = policy.chatHours;
    }
    g_isWorkTime = inRange(wh.start[0], wh.start[1], wh.end[0], wh.end[1]);
    g_isChatTime = inRange(ch.start[0], ch.start[1], ch.end[0], ch.end[1]);
    // 脏配置自愈：本地工作窗判定下班，但产品默认跨夜窗（06–02）仍在班
    // 典型：localStorage 残留 08–18 / 旧日窗，OPS 已是 06–02，晚上误进 S0 停关注
    if (!test24 && !g_isWorkTime) {
      var defWh = DEFAULT_POLICY.workHours;
      if (inRange(defWh.start[0], defWh.start[1], defWh.end[0], defWh.end[1])) {
        wh = defWh;
        g_isWorkTime = true;
        try {
          var rawHeal = JSON.parse(localStorage.getItem('sg_stage_policy') || '{}') || {};
          rawHeal.workHours = { start: [defWh.start[0], defWh.start[1]], end: [defWh.end[0], defWh.end[1]] };
          localStorage.setItem('sg_stage_policy', JSON.stringify(rawHeal));
        } catch (eHealLs) {}
        try {
          if (typeof ConfigSync !== 'undefined' && ConfigSync.fetchRemote) ConfigSync.fetchRemote();
        } catch (eHealSync) {}
      }
    }
    var dayCount = getDayCount();
    var quotaFull = getFollowedToday() >= getLimit();
    var pausedTill = parseInt(sessionStorage.getItem(K.SK_PAUSED_TILL) || '0') || 0;
    var inRetreat = pausedTill > Date.now();

    var s1 = policy.stages.S1 || {};
    var s2 = policy.stages.S2 || {};
    var s3 = policy.stages.S3 || {};
    var s1DayMax = (s1.dayMax != null) ? Number(s1.dayMax) : 1;
    // 4.6.31：S3 不再设日龄门（Day1 即可私信）；忽略 s3.dayMin，防 OPS 旧配置复活闸门

    if (!g_isWorkTime) {
      // 4.3.23：关注/养号全天可跑；不再因下班进空 priority 的 S0 静默。
      // 转帖由 A2 在「非私信时段」独占拉起，不依赖空 S0。
      if (inRetreat) {
        return { stage: 'S1', priority: ['nurture'] };
      }
      if (dayCount <= s1DayMax) {
        var pOff = preferNurtureBeforeFollow(['nurture', 'follow']);
        if (quotaFull) pOff = dropFollow(pOff);
        // 4.3.32：新号未就绪 → 禁止关注
        if (!isNewAccountReady()) pOff = dropFollow(pOff);
        return { stage: 'S1', priority: pOff };
      }
      var pOff2 = ['follow', 'nurture'];
      if (quotaFull) pOff2 = dropFollow(pOff2);
      // 4.3.32：新号未就绪 → 禁止关注
      if (!isNewAccountReady()) pOff2 = dropFollow(pOff2);
      return { stage: 'S2', priority: pOff2 };
    }

    // 卡死冷却：只养号，避免跳页风暴时硬开关注
    if (inRetreat) {
      return { stage: 'S1', priority: ['nurture'] };
    }

    // 早间渐进：仅 [上班点, morningNurtureUntil) 只养号；截止≤上班点则跳过；24h 测试跳过
    if (!test24 && isMorningNurtureOnly(policy)) {
      return { stage: 'S1', priority: ['nurture'] };
    }

    var stage;
    var priority;

    // 4.3.32/4.6.31：私信时段直接 S3 全开（Day1 即可私信，不再判日龄）
    if (g_isChatTime) {
      // 私信时段：全开；不再进入 S4 独占
      stage = 'S3';
      priority = (s3.priority || ['chat', 'follow', 'nurture']).concat();
    } else if (dayCount <= s1DayMax) {
      stage = 'S1';
      priority = (s1.priority || ['nurture', 'follow']).concat();
      // Day1：养号优先排序（软），不再硬挡关注——养号空转会导致整天 0 粉
      priority = preferNurtureBeforeFollow(priority);
    } else {
      // Day≥2 非私信时段（18:00 后 / 08:00 前）
      stage = 'S2';
      priority = (s2.priority || ['follow', 'nurture']).concat();
    }

    // 配额满：去掉 follow，其余照常（私信时段仍可 chat+nurture）
    if (quotaFull) {
      priority = dropFollow(priority);
    }

    // 4.3.32：新号未就绪（资料未修改 / 未发过帖）→ 禁止关注，仅养号+私信
    if (!isNewAccountReady()) {
      priority = dropFollow(priority);
    }

    return { stage: stage, priority: priority };
  }

  function getStagePolicy() { return loadPolicy(); }

  function isWorkTime() { return g_isWorkTime; }
  function isChatTime() { return g_isChatTime; }

  /** 供调度覆盖层查询：早间渐进窗内应只养号 */
  function isMorningNurtureOnlyPublic() {
    if (isTest24h()) return false;
    var policy = loadPolicy();
    var inWork = inRange(policy.workHours.start[0], policy.workHours.start[1], policy.workHours.end[0], policy.workHours.end[1]);
    if (!inWork) return false;
    return isMorningNurtureOnly(policy);
  }

  var StageDetector = {
    detect: detect,
    getStagePolicy: getStagePolicy,
    isWorkTime: isWorkTime,
    isChatTime: isChatTime,
    isMorningNurtureOnly: isMorningNurtureOnlyPublic,
    hasNurtureProgressToday: hasNurtureProgressToday,
    isNewAccountReady: isNewAccountReady
  };
  if (typeof window !== 'undefined') { window.StageDetector = StageDetector; }
  if (typeof self !== 'undefined') { self.StageDetector = StageDetector; }
})();

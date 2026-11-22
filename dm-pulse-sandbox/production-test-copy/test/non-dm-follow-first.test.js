'use strict';
/**
 * 4.9.124 · 非私信阶段统一「关注优先、养号兜底」
 * Day1 不再养号优先，早间也不再只有养号；硬闸（配额/新号未就绪）仍然拦住关注。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');
const vm = require('node:vm');

function makeStorage() {
  const data = Object.create(null);
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem(k, v) { data[k] = String(v); },
    removeItem(k) { delete data[k]; },
    get length() { return Object.keys(data).length; },
    key(i) { return Object.keys(data)[i] || null; },
    _data: data
  };
}

function minutesInRange(nowMin, hS, mS, hE, mE) {
  const start = hS * 60 + mS;
  let end = hE * 60 + mE;
  if (end >= 24 * 60) end = 24 * 60;
  if (end <= start) return nowMin >= start || nowMin < end;
  return nowMin >= start && nowMin < end;
}

function loadStageDetector(opts) {
  const o = opts || {};
  const day = o.day == null ? 1 : o.day;
  const nowMin = o.nowMin == null ? 11 * 60 : o.nowMin;
  const local = makeStorage();
  const session = makeStorage();
  local.setItem('matrix_my_handle', 'testhandle');
  // 本文件验证的是“正常昼夜时段”下的关注优先；24h 模式另测。
  local.setItem('sg_test_24h', 'false');
  if (o.pausedUntil) session.setItem('sg_paused_till', String(o.pausedUntil));
  local.setItem('matrix_stats_testhandle', JSON.stringify({
    day_count: day,
    follows_today: o.followsToday == null ? 0 : o.followsToday,
    daily_limit: o.dailyLimit == null ? 100 : o.dailyLimit,
    date: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
  }));
  if (o.ready !== false) local.setItem('sg_newacct_ready_testhandle', '1');

  const stages = o.stages || {
    S1: { dayMax: 1, priority: ['follow', 'nurture'] },
    S2: { dayMin: 2, priority: ['follow', 'nurture'] },
    S3: { dayMin: 2, priority: ['chat', 'follow', 'nurture'] }
  };
  const policy = {
    workHours: o.workHours || { start: [10, 0], end: [19, 0] },
    chatHours: o.chatHours || { start: [9, 0], end: [18, 0] },
    morningNurtureUntil: o.morningNurtureUntil || [10, 0],
    stages: stages
  };
  local.setItem('sg_stage_policy', JSON.stringify(policy));

  const sandbox = {
    console,
    localStorage: local,
    sessionStorage: session,
    SKeys: {
      LK_MY_HANDLE: 'matrix_my_handle',
      LK_CONSOLE_SETTINGS: 'matrix_console_settings',
      SK_PAUSED_TILL: 'sg_paused_till'
    },
    TimeUtil: {
      isTest24h() { return false; },
      shanghaiParts() { return { minutes: nowMin }; },
      inRange(hS, mS, hE, mE) { return minutesInRange(nowMin, hS, mS, hE, mE); },
      readChatHours() { return { startH: 9, startM: 0, endH: 18, endM: 0 }; }
    },
    window: {},
    self: {},
    Date,
    JSON,
    parseInt,
    Math,
    Intl,
    isNaN,
    Number,
    String,
    Array,
    Object
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'scheduler', 'stage-detector.js'), 'utf8');
  vm.runInContext(src, sandbox);
  return sandbox.StageDetector;
}

describe('非私信阶段 · 关注优先', () => {
  it('Day1 在班 → S1 关注排第一', () => {
    const r = loadStageDetector({ day: 1, nowMin: 11 * 60 }).detect();
    assert.equal(r.stage, 'S1');
    assert.equal(r.priority[0], 'follow', 'Day1 必须关注优先: ' + JSON.stringify(r.priority));
    assert.ok(r.priority.includes('nurture'));
  });

  it('Day1 下班后 → S1 关注排第一', () => {
    const r = loadStageDetector({ day: 1, nowMin: 20 * 60 }).detect();
    assert.equal(r.stage, 'S1');
    assert.equal(r.priority[0], 'follow', 'Day1 下班后仍关注优先: ' + JSON.stringify(r.priority));
  });

  it('Day2 在班但已过私信钟 → S2 关注排第一', () => {
    const r = loadStageDetector({ day: 2, nowMin: 18 * 60 + 30 }).detect();
    assert.equal(r.stage, 'S2');
    assert.equal(r.priority[0], 'follow');
  });

  it('Day2 下班后 → S2 关注排第一', () => {
    const r = loadStageDetector({ day: 2, nowMin: 20 * 60 }).detect();
    assert.equal(r.stage, 'S2');
    assert.equal(r.priority[0], 'follow');
  });

  it('早间窗（上班点后未到 morningNurtureUntil）不再只有养号', () => {
    const r = loadStageDetector({
      day: 1,
      nowMin: 10 * 60 + 30,
      morningNurtureUntil: [11, 0]
    }).detect();
    assert.equal(r.priority[0], 'follow', '早间必须关注优先: ' + JSON.stringify(r.priority));
    assert.ok(r.priority.includes('nurture'));
  });

  it('OPS 把养号下发改到前面 → 仍强制关注优先', () => {
    const r = loadStageDetector({
      day: 2,
      nowMin: 18 * 60 + 30,
      stages: {
        S1: { dayMax: 1, priority: ['nurture', 'follow'] },
        S2: { dayMin: 2, priority: ['nurture', 'follow'] },
        S3: { dayMin: 2, priority: ['chat', 'follow', 'nurture'] }
      }
    }).detect();
    assert.equal(r.priority[0], 'follow', 'OPS 顺序不得反转: ' + JSON.stringify(r.priority));
  });

  it('关注日配额满 → 不含 follow，只养号', () => {
    const r = loadStageDetector({ day: 1, nowMin: 11 * 60, followsToday: 100, dailyLimit: 100 }).detect();
    assert.ok(!r.priority.includes('follow'), '配额满不得关注: ' + JSON.stringify(r.priority));
    assert.equal(JSON.stringify(r.priority), JSON.stringify(['nurture']));
  });

  it('新号资料未就绪 → 不含 follow，只养号', () => {
    const r = loadStageDetector({ day: 1, nowMin: 11 * 60, ready: false }).detect();
    assert.ok(!r.priority.includes('follow'), '新号未就绪不得关注: ' + JSON.stringify(r.priority));
    assert.equal(JSON.stringify(r.priority), JSON.stringify(['nurture']));
  });

  it('卡死冷却期仍只养号', () => {
    const r = loadStageDetector({
      day: 2,
      nowMin: 11 * 60,
      pausedUntil: Date.now() + 5 * 60 * 1000
    }).detect();
    assert.equal(JSON.stringify(r.priority), JSON.stringify(['nurture']),
      '卡死冷却只养号: ' + JSON.stringify(r.priority));
  });

  it('非私信阶段不得出现 chat', () => {
    const day1 = loadStageDetector({ day: 1, nowMin: 9 * 60 + 30 }).detect();
    const day2Night = loadStageDetector({ day: 2, nowMin: 20 * 60 }).detect();
    assert.ok(!day1.priority.includes('chat'), 'Day1 09:30 不得含 chat: ' + JSON.stringify(day1.priority));
    assert.ok(!day2Night.priority.includes('chat'), '夜间不得含 chat: ' + JSON.stringify(day2Night.priority));
  });

  it('私信时段 S3 优先级不变（chat 仍在前）', () => {
    const r = loadStageDetector({ day: 2, nowMin: 10 * 60 }).detect();
    assert.equal(r.stage, 'S3');
    assert.equal(JSON.stringify(r.priority), JSON.stringify(['chat', 'follow', 'nurture']));
  });
});

describe('调度核 · 非私信兜底不再养号优先', () => {
  const coreSrc = fs.readFileSync(path.join(__dirname, '..', 'scheduler-core.js'), 'utf8');

  it('S0 脏窗兜底固定关注优先', () => {
    assert.ok(!/day\s*<=\s*2\s*\?\s*\['nurture',\s*'follow'\]/.test(coreSrc),
      '不得再按日龄把养号排在关注前');
    assert.match(coreSrc, /var pri = \['follow', 'nurture'\]/);
  });

  it('关注启动仍受模块开关/策略硬闸约束', () => {
    const i = coreSrc.indexOf("if (c === 'follow')");
    assert.ok(i > 0, '找不到关注启动分支');
    const seg = coreSrc.slice(i, i + 800);
    assert.match(seg, /launchPolicy && launchPolicy\.allowFollow === false/);
    assert.match(seg, /softRiskActive\(sg, now\)/);
  });
});


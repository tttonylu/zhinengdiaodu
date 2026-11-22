'use strict';
/**
 * 4.6.162 · Day≥2 才开私信（SoftFill + StageDetector）
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

function loadSoftFill() {
  const local = makeStorage();
  const session = makeStorage();
  local.setItem('sg_module_switches', JSON.stringify({ chat: true }));
  const sandbox = {
    console,
    localStorage: local,
    sessionStorage: session,
    window: {},
    StageDetector: {
      detect() {},
      isChatTime() { return true; }
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'shared', 'soft-fill-mode.js'), 'utf8');
  vm.runInContext(src, sandbox);
  return sandbox.SgSoftFillMode;
}

function loadStageDetector(day) {
  const local = makeStorage();
  const session = makeStorage();
  local.setItem('matrix_my_handle', 'testhandle');
  local.setItem('sg_test_24h', 'true');
  local.setItem('matrix_stats_testhandle', JSON.stringify({
    day_count: day,
    follows_today: 0,
    daily_limit: 100,
    date: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
  }));
  local.setItem('sg_newacct_ready_testhandle', '1');

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
      isTest24h() { return true; },
      inRange() { return true; },
      readChatHours() { return { startH: 0, startM: 0, endH: 24, endM: 0 }; }
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

describe('SoftFillMode · Day≥2 私信闸', () => {
  it('Day1 → allowChat=false reason=day_lt_2', () => {
    const api = loadSoftFill();
    const r = api.resolve({ day: 1 });
    assert.equal(r.allowChat, false);
    assert.equal(r.reason, 'day_lt_2');
    assert.equal(r.mode, 'nurture_only');
  });

  it('Day2 + 私信时段 → chat_fill', () => {
    const api = loadSoftFill();
    const r = api.resolve({ day: 2 });
    assert.equal(r.allowChat, true);
    assert.equal(r.mode, 'chat_fill');
  });
});

describe('StageDetector · S3 Day≥2', () => {
  it('Day1 私信时段 → S1 且 priority 无 chat', () => {
    const sd = loadStageDetector(1);
    const r = sd.detect();
    assert.equal(r.stage, 'S1');
    assert.ok(!r.priority.includes('chat'), 'Day1 不得含 chat: ' + JSON.stringify(r.priority));
    assert.ok(r.priority.includes('follow') || r.priority.includes('nurture'));
  });

  it('Day2 私信时段 → S3 含 chat', () => {
    const sd = loadStageDetector(2);
    const r = sd.detect();
    assert.equal(r.stage, 'S3');
    assert.ok(r.priority.includes('chat'), 'Day2 应含 chat: ' + JSON.stringify(r.priority));
  });
});

function minutesInRange(nowMin, hS, mS, hE, mE) {
  const start = hS * 60 + mS;
  let end = hE * 60 + mE;
  if (end === start) return false;
  if (end < start) return nowMin >= start || nowMin < end;
  return nowMin >= start && nowMin < end;
}

function loadStageDetectorAtClock(day, nowMin) {
  const local = makeStorage();
  const session = makeStorage();
  local.setItem('matrix_my_handle', 'testhandle');
  local.setItem('sg_test_24h', 'false');
  local.setItem('matrix_stats_testhandle', JSON.stringify({
    day_count: day,
    follows_today: 0,
    daily_limit: 100,
    date: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
  }));
  local.setItem('sg_newacct_ready_testhandle', '1');
  local.setItem('sg_stage_policy', JSON.stringify({
    workHours: { start: [10, 0], end: [19, 0] },
    chatHours: { start: [9, 0], end: [18, 0] },
    morningNurtureUntil: [10, 0],
    stages: {
      S1: { dayMax: 1, priority: ['follow', 'nurture'] },
      S2: { dayMin: 2, priority: ['follow', 'nurture'] },
      S3: { dayMin: 2, priority: ['chat', 'follow', 'nurture'] }
    }
  }));

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

describe('StageDetector · 交友上班前私信钟', () => {
  it('Day2 09:30 未上班但已进私信窗 → S3 含 chat', () => {
    const sd = loadStageDetectorAtClock(2, 9 * 60 + 30);
    const r = sd.detect();
    assert.equal(r.stage, 'S3');
    assert.ok(r.priority.includes('chat'), '09:30 应交友私信: ' + JSON.stringify(r.priority));
  });

  it('Day1 09:30 → 无 chat', () => {
    const sd = loadStageDetectorAtClock(1, 9 * 60 + 30);
    const r = sd.detect();
    assert.ok(!r.priority.includes('chat'), 'Day1 09:30 不得含 chat: ' + JSON.stringify(r.priority));
  });

  it('Day2 08:30 未到 09:00 私信开窗 → 无 chat', () => {
    const sd = loadStageDetectorAtClock(2, 8 * 60 + 30);
    const r = sd.detect();
    assert.ok(!r.priority.includes('chat'), '08:30 不得含 chat: ' + JSON.stringify(r.priority));
  });
});

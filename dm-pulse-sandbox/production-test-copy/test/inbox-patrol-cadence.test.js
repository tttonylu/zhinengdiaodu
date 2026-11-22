'use strict';

/**
 * 4.9.127：守箱必须按固定节奏来回巡查，而不是只在软风控窗口内看一次。
 * - 默认每 15 分钟进一次守箱，停留 6 分钟；
 * - 时段外一律不巡查（硬停）；
 * - 到点必须退出并交回出站，不能永远卡在 inbox。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'content_chat.js'), 'utf8');

function extractFn(src, name) {
  const sig = 'function ' + name + '(';
  const start = src.indexOf(sig);
  assert.ok(start > 0, '缺少函数 ' + name);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('函数体不闭合: ' + name);
}

function makeStore(init) {
  const map = Object.assign({}, init || {});
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null),
    setItem: (k, v) => { map[k] = String(v); },
    removeItem: (k) => { delete map[k]; },
    _map: map
  };
}

function build(deps) {
  const fnSrc = extractFn(chatSrc, deps.name);
  const factory = new Function(
    'localStorage', 'Date', 'isInboxPatrolEnabled', 'isChatWorkWindowNow', 'getRunMode',
    'getInboxPatrolGapMs', 'getInboxPatrolKeepMs', 'loadInboxState', 'saveInboxState',
    'setRunMode', 'setChatPhase', 'SgTelemetry', 'showToast', 'completeChatRound',
    'ensureChatMainEngine', 'chatGo', 'getInboxPulseIntervalMs',
    'INBOX_PATROL_AT_KEY', 'INBOX_PATROL_UNTIL_KEY', 'console',
    'return (' + fnSrc + ');'
  );
  return factory(
    deps.localStorage, deps.Date || Date,
    deps.isInboxPatrolEnabled || (() => true),
    deps.isChatWorkWindowNow || (() => true),
    deps.getRunMode || (() => 'outbound'),
    deps.getInboxPatrolGapMs || (() => 15 * 60000),
    deps.getInboxPatrolKeepMs || (() => 6 * 60000),
    deps.loadInboxState || (() => ({ running: true, busy: false })),
    deps.saveInboxState || (() => {}),
    deps.setRunMode || (() => {}),
    deps.setChatPhase || (() => {}),
    deps.SgTelemetry || { emit: () => {} },
    deps.showToast || (() => {}),
    deps.completeChatRound || (() => {}),
    deps.ensureChatMainEngine || (() => {}),
    deps.chatGo || (() => {}),
    deps.getInboxPulseIntervalMs || (() => 60000),
    'sg_inbox_patrol_at',
    'sg_inbox_patrol_until',
    { log() {}, warn() {}, error() {} }
  );
}

test('默认节奏：每 15 分钟巡查一次、每次停 6 分钟', () => {
  const start = chatSrc.indexOf('function getInboxPatrolGapMs(');
  assert.ok(start > 0);
  const gap = chatSrc.slice(start, start + 400);
  assert.match(gap, /if \(!\(min > 0\)\) min = 15;/);
  assert.match(gap, /Math\.max\(3, Math\.min\(120, min\)\)/);

  const kStart = chatSrc.indexOf('function getInboxPatrolKeepMs(');
  const keep = chatSrc.slice(kStart, kStart + 400);
  assert.match(keep, /if \(!\(min > 0\)\) min = 6;/);
  assert.match(keep, /Math\.max\(2, Math\.min\(30, min\)\)/);
});

test('守箱脉冲默认 60 秒一拍，上限 300 秒', () => {
  const start = chatSrc.indexOf('function getInboxPulseIntervalMs(');
  const body = chatSrc.slice(start, start + 500);
  assert.match(body, /return 60000;/);
  assert.match(body, /Math\.max\(20, Math\.min\(300, sec\)\)/);
});

test('时段外不巡查', () => {
  const store = makeStore({ sg_inbox_patrol_at: '0' });
  const due = build({ name: 'isInboxPatrolDue', localStorage: store, isChatWorkWindowNow: () => false });
  assert.equal(due(), false);
});

test('距上次巡查不足间隔 → 不重复进守箱', () => {
  const now = Date.now();
  const store = makeStore({ sg_inbox_patrol_at: String(now - 5 * 60000) });
  const due = build({ name: 'isInboxPatrolDue', localStorage: store });
  assert.equal(due(), false);
});

test('距上次巡查超过间隔 → 到点巡查', () => {
  const now = Date.now();
  const store = makeStore({ sg_inbox_patrol_at: String(now - 16 * 60000) });
  const due = build({ name: 'isInboxPatrolDue', localStorage: store });
  assert.equal(due(), true);
});

test('已经在守箱里时不再重复触发', () => {
  const now = Date.now();
  const store = makeStore({ sg_inbox_patrol_at: String(now - 60 * 60000) });
  const due = build({ name: 'isInboxPatrolDue', localStorage: store, getRunMode: () => 'inbox' });
  assert.equal(due(), false);
});

test('巡查到点：停脉冲、回出站、交回调度', () => {
  const now = Date.now();
  const store = makeStore({ sg_inbox_patrol_until: String(now - 1000) });
  const calls = { runMode: [], phase: [], completed: 0, saved: null, autostart: null };
  const exit = build({
    name: 'exitInboxPatrolIfDue',
    localStorage: store,
    loadInboxState: () => ({ running: true, busy: true, nextPulseAt: now }),
    saveInboxState: (st) => { calls.saved = st; },
    setRunMode: (m) => calls.runMode.push(m),
    setChatPhase: (p) => calls.phase.push(p),
    completeChatRound: () => { calls.completed++; }
  });
  assert.equal(exit(), true);
  assert.deepEqual(calls.runMode, ['outbound']);
  assert.deepEqual(calls.phase, ['outbound']);
  assert.equal(calls.completed, 1);
  assert.equal(calls.saved.running, false);
  assert.equal(store.getItem('sg_inbox_patrol_until'), null);
  assert.equal(store.getItem('sg_inbox_autostart'), '0');
});

test('巡查还没到点：不许提前收工', () => {
  const store = makeStore({ sg_inbox_patrol_until: String(Date.now() + 60000) });
  let completed = 0;
  const exit = build({ name: 'exitInboxPatrolIfDue', localStorage: store, completeChatRound: () => { completed++; } });
  assert.equal(exit(), false);
  assert.equal(completed, 0);
});

test('破冰队列做完后必须尝试进守箱巡查', () => {
  const start = chatSrc.indexOf('function finishSoftRiskFanQueueDone(');
  assert.ok(start > 0);
  const body = chatSrc.slice(start, start + 900);
  assert.match(body, /if \(isInboxPatrolDue\(\) && enterInboxPatrol\('fan_queue_done:' \+ reason\)\) return;/);
});

test('主引擎每拍先检查巡查是否到点', () => {
  const start = chatSrc.indexOf('window.__sgChatMainEngineTick = function');
  const body = chatSrc.slice(start, start + 700);
  assert.match(body, /try \{ if \(exitInboxPatrolIfDue\(\)\) return; \} catch \(ePatrolExit\) \{\}/);
});

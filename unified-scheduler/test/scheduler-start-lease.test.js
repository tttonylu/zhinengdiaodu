'use strict';
/**
 * 4.6.197 · 租约后启动：grant 前不得 running，所有早退必须释放槽
 * 运行：node --test --test-force-exit unified-scheduler/test/scheduler-start-lease.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'scheduler-core.js'), 'utf8');

function extractFunction(name, nextMarker) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, '应定义 ' + name);
  const end = src.indexOf(nextMarker, start);
  assert.ok(end > start, '应能找到 ' + name + ' 的结束位置');
  return src.slice(start, end);
}

function memoryStore(initial) {
  const store = Object.assign({}, initial || {});
  return {
    store,
    getItem(k) {
      return Object.prototype.hasOwnProperty.call(store, k) ? String(store[k]) : null;
    },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
  };
}

function loadChatFn(overrides) {
  const calls = [];
  const local = memoryStore(overrides && overrides.local);
  const session = memoryStore(overrides && overrides.session);
  const sandbox = {
    console,
    Date,
    Math,
    JSON,
    String,
    parseInt,
    isNaN,
    setTimeout,
    clearTimeout,
    localStorage: local,
    sessionStorage: session,
    K: {
      SK_CHAT_AUTO_RUN: 'dan_auto_run',
      LK_CHAT_STATUS: 'chat_status',
      LK_CHAT_RECOVERY: 'chat_recovery',
    },
    S: {},
    CustomEvent: function CustomEvent(type, init) {
      this.type = type;
      this.detail = init && init.detail;
    },
    Logger: {
      info() {},
      warn() {},
    },
    SgTelemetry: { emit() {} },
    window: { dispatchEvent() {} },
    stopFollow() { calls.push(['stopFollow']); },
    getMyHandle() { return overrides && overrides.handle != null ? overrides.handle : 'me'; },
    evaluateChatStaggerGateCo() {
      return (overrides && overrides.stagger) || { allow: true, slots: 8, mySlot: 0, activeSlot: 0 };
    },
    getScrmGateSync() {
      return overrides && Object.prototype.hasOwnProperty.call(overrides, 'gate')
        ? overrides.gate
        : { allow_chat: true };
    },
    refreshScrmGate() { calls.push(['refreshScrmGate']); },
    resolveChatStartUrl() {
      return overrides && Object.prototype.hasOwnProperty.call(overrides, 'dest')
        ? overrides.dest
        : 'https://x.com/i/chat';
    },
    coLeaseAbort() { calls.push(['coLeaseAbort'].concat(Array.from(arguments))); },
    coBeginLeasedRun() {
      calls.push(['coBeginLeasedRun'].concat(Array.from(arguments)));
      return !(overrides && overrides.beginFalse);
    },
  };
  vm.createContext(sandbox);
  const code = extractFunction('startChatAfterLease', '\n  function startChat(');
  const fn = vm.runInContext(code + '\nstartChatAfterLease', sandbox);
  return { fn, calls, local, session };
}

function loadFollowFn(overrides) {
  const calls = [];
  const local = memoryStore(overrides && overrides.local);
  const session = memoryStore(overrides && overrides.session);
  const sandbox = {
    console,
    Date,
    JSON,
    String,
    parseInt,
    setTimeout() { return 1; },
    clearTimeout() {},
    localStorage: local,
    sessionStorage: session,
    K: {
      LK_FOLLOW_RUNNING: 'follow_running',
      SK_TAB_RUNNING: 'tab_running',
      LK_CURRENT_TASK_ID: 'current_task_id',
      LK_CURRENT_CREATOR: 'current_creator',
    },
    S: {},
    FLEET_LEASE_RETRY_MS: 15000,
    Logger: { info() {}, warn() {} },
    coLoadSg() { return {}; },
    stopChat() { calls.push(['stopChat']); },
    softRiskActive() { return !!(overrides && overrides.softRisk); },
    isFollowPopFlight() { return !!(overrides && overrides.popFlight); },
    clearFollowPopFlight() { calls.push(['clearFollowPopFlight']); },
    markFollowPopFlight() { calls.push(['markFollowPopFlight']); },
    coLeaseAbort() { calls.push(['coLeaseAbort'].concat(Array.from(arguments))); },
    coBeginLeasedRun() {
      calls.push(['coBeginLeasedRun'].concat(Array.from(arguments)));
      return !(overrides && overrides.beginFalse);
    },
    getWorkerId() { return '@me#guard'; },
    CustomEvent: function CustomEvent(type, init) {
      this.type = type;
      this.detail = init && init.detail;
    },
    window: { dispatchEvent() {} },
    chrome: {
      runtime: {
        lastError: null,
        sendMessage(action, cb) {
          calls.push(['sendMessage', action]);
          void cb;
        },
      },
    },
  };
  vm.createContext(sandbox);
  const code = extractFunction(
    'startFollowAfterLease',
    '\n  /** 4.6.173：新开关注前占舰队槽 */'
  );
  const fn = vm.runInContext(code + '\nstartFollowAfterLease', sandbox);
  return { fn, calls, local, session };
}

describe('调度租约启动 · 不假 running + 早退释放', () => {
  it('私信无 handle / 错峰 / SCRM / 无目标页都会取消并释放已持有租约', () => {
    const cases = [
      [{ handle: 'unknown' }, 'no_handle'],
      [{ stagger: { allow: false, slots: 8, mySlot: 1, activeSlot: 0 } }, 'chat_stagger_wait'],
      [{ gate: { allow_chat: false, reason: 'offline' } }, 'scrm_blocked'],
      [{ dest: '' }, 'daily_cap_or_no_url'],
    ];
    for (const [opts, reason] of cases) {
      const { fn, calls } = loadChatFn(opts);
      fn('https://x.com/i/chat', false, 7, true);
      const abort = calls.find((row) => row[0] === 'coLeaseAbort');
      assert.ok(abort, reason + ' 应走 coLeaseAbort');
      assert.deepEqual(abort.slice(1), ['chat', 7, reason, 0, true]);
      assert.ok(!calls.some((row) => row[0] === 'coBeginLeasedRun'), reason + ' 不得写 running');
    }
  });

  it('私信所有闸门通过后先 beginRun 再派发命令', () => {
    const { fn, calls } = loadChatFn({});
    fn('https://x.com/i/chat', false, 8, true);
    const begin = calls.find((row) => row[0] === 'coBeginLeasedRun');
    assert.deepEqual(begin.slice(1), ['chat', 'https://x.com/i/chat', 8]);
    assert.ok(!calls.some((row) => row[0] === 'coLeaseAbort'));
  });

  it('关注软风控 / 领号飞行窗都取消并释放租约', () => {
    let loaded = loadFollowFn({ softRisk: true });
    loaded.fn('https://x.com/a/followers', 9);
    let abort = loaded.calls.find((row) => row[0] === 'coLeaseAbort');
    assert.deepEqual(abort.slice(1), ['follow', 9, 'soft_risk', 0, true]);
    assert.ok(!loaded.calls.some((row) => row[0] === 'coBeginLeasedRun'));

    loaded = loadFollowFn({ popFlight: true });
    loaded.fn('https://x.com/a/followers', 10);
    abort = loaded.calls.find((row) => row[0] === 'coLeaseAbort');
    assert.deepEqual(abort.slice(1), ['follow', 10, 'pop_flight', 15000, true]);
    assert.ok(!loaded.calls.some((row) => row[0] === 'coBeginLeasedRun'));
  });

  it('关注恢复未完成任务与正常领号都只在 token 有效时进入 running', () => {
    let loaded = loadFollowFn({
      local: {
        current_task_id: '42',
        current_creator: 'alice',
      },
    });
    loaded.fn('https://x.com/a/followers', 11);
    assert.ok(loaded.calls.some((row) => row[0] === 'coBeginLeasedRun'
      && row[2] === 'https://x.com/a/followers' && row[3] === 11));
    assert.ok(!loaded.calls.some((row) => row[0] === 'markFollowPopFlight'));

    loaded = loadFollowFn({});
    loaded.fn('https://x.com/a/followers', 12);
    assert.ok(loaded.calls.some((row) => row[0] === 'coBeginLeasedRun'));
    assert.ok(loaded.calls.some((row) => row[0] === 'markFollowPopFlight'));
    assert.ok(loaded.calls.some((row) => row[0] === 'sendMessage'));
  });

  it('coLeaseAbort 只在 leaseHeld=true 时释放 OPS 槽', () => {
    const calls = [];
    const sandbox = {
      Logger: { info() {}, warn() {} },
      coLeaseCancel(n, token, backoff) {
        calls.push(['cancel', n, token, backoff]);
        return true;
      },
      releaseFleetLeaseCo(n) { calls.push(['release', n]); },
    };
    vm.createContext(sandbox);
    const code = extractFunction('coLeaseAbort', '\n  /** 20s');
    const fn = vm.runInContext(code + '\ncoLeaseAbort', sandbox);
    fn('chat', 3, 'scrm_blocked', 0, true);
    fn('follow', 4, 'stale', 0, false);
    assert.deepEqual(calls, [
      ['cancel', 'chat', 3, 0],
      ['release', 'chat'],
      ['cancel', 'follow', 4, 0],
    ]);
  });

  it('coStart 的 follow/chat 分支先写 leasing 再调用模块 start', () => {
    const start = src.indexOf('function coStart(');
    const end = src.indexOf('\n  function coLoadSg()', start);
    const body = src.slice(start, end);
    const leaseMark = body.indexOf("coLeaseMarkPending(n, url, null)");
    const moduleStart = body.indexOf('m.start(url, leaseToken)');
    assert.ok(leaseMark > 0 && moduleStart > leaseMark, '先登记 leasing token，再调用 start');
  });
});

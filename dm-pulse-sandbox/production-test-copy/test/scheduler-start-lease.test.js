'use strict';
/**
 * 测试副本 · 租约后启动：grant 前不得 running，所有早退必须释放槽。
 * 运行：node --test --test-force-exit test/scheduler-start-lease.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const corePath = path.join(__dirname, '..', 'scheduler-core.js');
const src = fs.readFileSync(corePath, 'utf8');
const SgFleetLease = require(path.join(__dirname, '..', 'scheduler', 'fleet-lease.js'));

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

function baseSandbox(overrides, buildExtra) {
  const calls = [];
  const local = memoryStore(overrides && overrides.local);
  const session = memoryStore(overrides && overrides.session);
  const ctx = { calls, local, session, sandbox: null };
  const sandbox = Object.assign({
    calls,
    console,
    Date,
    Math,
    JSON,
    String,
    parseInt,
    setTimeout() { return 1; },
    clearTimeout() {},
    localStorage: local,
    sessionStorage: session,
    Logger: { info() {}, warn() {} },
    CustomEvent: function CustomEvent(type, init) {
      this.type = type;
      this.detail = init && init.detail;
    },
    window: { dispatchEvent() {} },
    coLeaseAbort(...args) { calls.push(['coLeaseAbort'].concat(args)); },
    coBeginLeasedRun(...args) {
      calls.push(['coBeginLeasedRun'].concat(args));
      return !(overrides && overrides.beginFalse);
    },
    releaseFleetLeaseCo(n) { calls.push(['release', n]); },
  }, typeof buildExtra === 'function' ? buildExtra(ctx) : (buildExtra || {}));
  ctx.sandbox = sandbox;
  vm.createContext(sandbox);
  return ctx;
}

function loadChatFn(overrides) {
  const ctx = baseSandbox(overrides, (self) => ({
    K: {
      SK_CHAT_AUTO_RUN: 'dan_auto_run',
      LK_CHAT_STATUS: 'chat_status',
      LK_CHAT_RECOVERY: 'chat_recovery',
    },
    S: {},
    SgTelemetry: { emit() {} },
    stopFollow() { self.calls.push(['stopFollow']); },
    getMyHandle() { return overrides && overrides.handle != null ? overrides.handle : 'me'; },
    evaluateChatStaggerGateCo() {
      return (overrides && overrides.stagger)
        || { allow: true, slots: 8, mySlot: 0, activeSlot: 0 };
    },
    getScrmGateSync() {
      return overrides && Object.prototype.hasOwnProperty.call(overrides, 'gate')
        ? overrides.gate
        : { allow_chat: true };
    },
    refreshScrmGate() { self.calls.push(['refreshScrmGate']); },
    resolveChatStartUrl() {
      return overrides && Object.prototype.hasOwnProperty.call(overrides, 'dest')
        ? overrides.dest
        : 'https://x.com/i/chat';
    },
    coLoadSg() { return {}; },
  }));
  const code = extractFunction('startChatAfterLease', '\n  function startChat(');
  const fn = vm.runInContext(code + '\nstartChatAfterLease', ctx.sandbox);
  return { fn, calls: ctx.calls };
}

function loadFollowFn(overrides) {
  const ctx = baseSandbox(overrides, (self) => ({
    K: {
      LK_FOLLOW_RUNNING: 'follow_running',
      SK_TAB_RUNNING: 'tab_running',
      LK_CURRENT_TASK_ID: 'current_task_id',
      LK_CURRENT_CREATOR: 'current_creator',
    },
    S: {},
    FLEET_LEASE_RETRY_MS: 15000,
    coLoadSg() { return {}; },
    coSaveSg() {},
    saveSG() {},
    coStop() {},
    stopChat() { self.calls.push(['stopChat']); },
    softRiskActive() { return !!(overrides && overrides.softRisk); },
    isFollowPopFlight() { return !!(overrides && overrides.popFlight); },
    clearFollowPopFlight() { self.calls.push(['clearFollowPopFlight']); },
    markFollowPopFlight() { self.calls.push(['markFollowPopFlight']); },
    getWorkerId() { return '@me#guard'; },
    chrome: {
      runtime: {
        lastError: null,
        sendMessage(action, cb) {
          self.calls.push(['sendMessage', action]);
          void cb;
        },
      },
    },
  }));
  const code = extractFunction(
    'startFollowAfterLease',
    '\n  /** 4.6.173：新开关注前占舰队槽 */'
  );
  const fn = vm.runInContext(code + '\nstartFollowAfterLease', ctx.sandbox);
  return { fn, calls: ctx.calls };
}

describe('测试副本调度租约启动 · 不假 running + 早退释放', () => {
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
      assert.equal(abort[2], 7);
      assert.equal(abort[3], reason);
      assert.equal(abort[5], true, reason + ' 应释放已持有租约');
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
    assert.equal(abort[3], 'soft_risk');
    assert.ok(!loaded.calls.some((row) => row[0] === 'coBeginLeasedRun'));

    loaded = loadFollowFn({ popFlight: true });
    loaded.fn('https://x.com/a/followers', 10);
    abort = loaded.calls.find((row) => row[0] === 'coLeaseAbort');
    assert.equal(abort[3], 'pop_flight');
    assert.equal(abort[4], 15000);
    assert.ok(!loaded.calls.some((row) => row[0] === 'coBeginLeasedRun'));
  });

  it('关注恢复未完成任务与正常领号都只在 token 有效时进入 running', () => {
    let loaded = loadFollowFn({
      local: { current_task_id: '42', current_creator: 'alice' },
    });
    loaded.fn('https://x.com/a/followers', 11);
    assert.ok(loaded.calls.some((row) => row[0] === 'coBeginLeasedRun'
      && row[2] === 'https://x.com/a/followers' && row[3] === 11));
    assert.ok(!loaded.calls.some((row) => row[0] === 'markFollowPopFlight'));

    loaded = loadFollowFn({});
    loaded.fn('https://x.com/a/followers', 12);
    assert.ok(loaded.calls.some((row) => row[0] === 'coBeginLeasedRun'));
    assert.ok(loaded.calls.some((row) => row[0] === 'markFollowPopFlight'));
  });

  it('coStart 的 follow/chat 分支先写 leasing 再调用模块 start', () => {
    const start = src.indexOf('function coStart(');
    const end = src.indexOf('\n  function coLoadSg()', start);
    assert.ok(start > 0 && end > start);
    const body = src.slice(start, end);
    const leaseMark = body.indexOf('coLeaseMarkPending(n, url, null)');
    const moduleStart = body.indexOf('m.start(url, leaseToken)');
    assert.ok(leaseMark > 0 && moduleStart > leaseMark, '先登记 leasing token，再调用 start');
  });
});

describe('SgFleetLease 状态机 · 20s 超时与晚到 token', () => {
  it('markStartPending 后 running=false，只有 beginStart 才写 running', () => {
    const m = { _state: 'stopped' };
    const r = SgFleetLease.markStartPending(m, 'https://x.com/i/chat', 1000);
    assert.equal(r.state.running, false);
    assert.equal(r.state.phase, 'leasing');
    assert.equal(m._state, 'starting');
    assert.equal(SgFleetLease.isStartPending(m, r.token), true);
    const begun = SgFleetLease.beginStart(m, 'https://x.com/i/chat', r.token, 2000);
    assert.equal(begun.running, true);
    assert.equal(SgFleetLease.isCurrentRun(m, r.token), true);
  });

  it('20s 未回包 → expireStart 清 pending 并作废旧 token', () => {
    const m = { _state: 'stopped' };
    const r = SgFleetLease.markStartPending(m, 'https://x.com/i/chat', 1000);
    assert.equal(SgFleetLease.expireStart(m, 20999, 20000, 15000), null, '未到 20s 不回收');
    const expired = SgFleetLease.expireStart(m, 21000, 20000, 15000);
    assert.ok(expired, '到 20s 应回收');
    assert.equal(expired.running, false);
    assert.equal(m._leasePending, false);
    assert.equal(SgFleetLease.isStartPending(m, r.token), false, '旧 token 失效');
    assert.equal(SgFleetLease.isStartDenied(m, 21000), true, '回收后进入重试退避');
  });

  it('停止/取消后晚到的 token 不能拉起 running', () => {
    const m = { _state: 'stopped' };
    const r = SgFleetLease.markStartPending(m, 'https://x.com/i/chat', 1000);
    SgFleetLease.cancelStart(m, r.token, 1500, 0);
    assert.equal(SgFleetLease.beginStart(m, 'https://x.com/i/chat', r.token, 2000), null);
    assert.notEqual(m._state, 'running');
    assert.equal(SgFleetLease.isCurrentRun(m, r.token), false);
  });
});

'use strict';
/**
 * 用户点停止必须立刻停，不能只挂起后在跳页/长扫中丢请求又 recover。
 * 运行：node --test --test-force-exit unified-scheduler/test/repost-stop-immediate.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadEngine(pathname) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'repost', 'repost-engine.js'), 'utf8');
  const store = {};
  const mem = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
  };
  const eu = {
    _on: false,
    start() { this._on = true; },
    stop() { this._on = false; },
    resume() { this._on = true; },
    isActive() { return this._on; },
    isRunning() { return this._on; },
    ping() {},
    createWatchdog() { return { cancel() {} }; },
    createTimeout(fn) { return { cancel() {}, _fn: fn }; },
    humanClick() {},
  };
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Promise, URL,
    window: { addEventListener() {}, dispatchEvent() {} },
    document: {
      hidden: false,
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {},
      dispatchEvent() {},
    },
    location: { pathname: pathname, href: 'https://x.com' + pathname },
    localStorage: mem,
    sessionStorage: mem,
    chrome: { runtime: { sendMessage(_m, cb) { if (cb) cb({ ok: true }); }, lastError: null } },
    EngineUtils: eu,
    SchedulerGate: {
      canSelfStart() { return true; },
      prepareLeave() {},
      go() { return true; },
      goRaw() { return true; },
    },
    RepostTracker: {
      getConfig() { return {}; },
      getDaily() { return { count: 0 }; },
      getCurrent() { return ''; },
      setCurrent() {},
      isAutoSlot() { return false; },
      clearAutoSlotFlag() {},
      getCompletedRound() { return []; },
      clearCompletedRound() {},
      markCompletedRound() {},
      markSkipped() {},
      markAutoDone() {},
      markAutoTimeout() {},
      markAutoRunning() {},
      dailyExhausted() { return false; },
      msUntilNextPostAllowed() { return 0; },
    },
  };
  sandbox.window = Object.assign(sandbox.window, { addEventListener() {}, dispatchEvent() {} });
  // 保留真实监听：引擎挂 sg-repost-command
  const listeners = {};
  sandbox.window.addEventListener = function (type, fn) {
    (listeners[type] || (listeners[type] = [])).push(fn);
  };
  sandbox.window.dispatchEvent = function (ev) {
    const list = listeners[ev.type] || [];
    list.forEach(function (fn) { fn(ev); });
    return true;
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'repost-engine.js' });
  return {
    engine: sandbox.window.RepostEngine,
    store: store,
    eu: eu,
    dispatchStop(reason) {
      sandbox.window.dispatchEvent({
        type: 'sg-repost-command',
        detail: { command: 'stop', reason: reason },
      });
    },
  };
}

test('执行中点 panel 停止：立刻清 running，不得只挂起', () => {
  const { engine, store } = loadEngine('/home');
  assert.ok(engine._test && engine._test.setProcessing, '需测试缝 setProcessing');
  store.sg_repost_running = 'true';
  engine._test.setProcessing(true);
  engine.stop('panel');
  assert.notEqual(store.sg_repost_running, 'true', '必须立刻清 sg_repost_running');
  assert.equal(engine._test.getPendingStop(), null, '不得残留 pendingStop');
  assert.equal(engine._test.isProcessing(), false);
});

test('执行中 cmd 停止：立刻清 running', () => {
  const { store, dispatchStop, engine } = loadEngine('/home');
  store.sg_repost_running = 'true';
  engine._test.setProcessing(true);
  dispatchStop('cmd');
  assert.notEqual(store.sg_repost_running, 'true');
});

test('recover 前若有用户停止闩，不得再拉起', () => {
  const { engine, store, eu } = loadEngine('/home');
  store.sg_repost_running = 'true';
  store.sg_repost_user_stop = '1';
  eu._on = false;
  engine._test.recover();
  assert.notEqual(store.sg_repost_running, 'true', '用户停止闩应阻止 recover');
  assert.equal(eu._on, false);
});

'use strict';
/**
 * 发完帖收工时，全页 /compose/post 必须离开，不能停在发帖页。
 * 运行：node --test unified-scheduler/test/repost-leave-compose.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadEngine(pathname) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'repost', 'repost-engine.js'), 'utf8');
  const goes = [];
  const store = {};
  const mem = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
  };
  const location = { pathname: pathname, href: 'https://x.com' + pathname };
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
    location: location,
    localStorage: mem,
    sessionStorage: mem,
    chrome: { runtime: { sendMessage(_m, cb) { if (cb) cb({ ok: true }); }, lastError: null } },
    EngineUtils: {
      start() {}, stop() {}, ping() {}, isActive() { return false; },
      createWatchdog() { return { cancel() {} }; },
      humanClick() {},
    },
    SchedulerGate: {
      canSelfStart() { return false; },
      prepareLeave() {},
      go(_mod, url) { goes.push(url); return true; },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'repost-engine.js' });
  return { engine: sandbox.window.RepostEngine, goes: goes, location: location };
}

test('收工时停在 /compose/post 会离开到首页', () => {
  const { engine, goes } = loadEngine('/compose/post');
  engine.stop();
  assert.ok(goes.some(function (u) { return String(u).indexOf('/home') >= 0; }), '应收工离开发帖页');
});

test('不在发帖页收工时不强制跳首页', () => {
  const { engine, goes } = loadEngine('/home');
  engine.stop();
  assert.equal(goes.length, 0);
});

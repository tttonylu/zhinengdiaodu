'use strict';
/**
 * X 发帖打回「Something went wrong…another shot」不能记成成功。
 * 运行：node --test unified-scheduler/test/repost-compose-error.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadEngine() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'repost', 'repost-engine.js'), 'utf8');
  const store = {};
  const mem = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
  };
  const doc = {
    hidden: false,
    body: { innerText: '' },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    dispatchEvent() {},
  };
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Promise, URL,
    window: { addEventListener() {}, dispatchEvent() {} },
    document: doc,
    location: { pathname: '/compose/post', href: 'https://x.com/compose/post' },
    localStorage: mem,
    sessionStorage: mem,
    chrome: { runtime: { sendMessage(_m, cb) { if (cb) cb({ ok: true }); }, lastError: null } },
    EngineUtils: {
      start() {}, stop() {}, ping() {}, isActive() { return true; },
      createWatchdog() { return { cancel() {} }; },
      humanClick() {},
    },
    SchedulerGate: {
      canSelfStart() { return false; },
      prepareLeave() {},
      go() { return true; },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'repost-engine.js' });
  return { engine: sandbox.window.RepostEngine, doc: doc };
}

test('平台打回文案出现时，编辑器被清空也不得记成功', () => {
  const { engine, doc } = loadEngine();
  doc.body.innerText = 'Something went wrong, but don’t fret — let’s give it another shot.';
  const det = engine._test.detectComposePostSuccess('https://x.com/compose/post', { beforeTextLen: 40 });
  assert.equal(det.ok, false);
  assert.equal(det.reason, 'compose_error');
});

test('时间线普通的 Something went wrong 不是发帖打回', () => {
  const { engine, doc } = loadEngine();
  doc.body.innerText = 'Something went wrong. Try again.';
  const det = engine._test.detectComposePostSuccess('https://x.com/compose/post', { beforeTextLen: 40 });
  assert.equal(det.reason === 'compose_error', false);
});

test('没有打回文案时，清空的发帖页仍算成功', () => {
  const { engine, doc } = loadEngine();
  doc.body.innerText = '';
  const det = engine._test.detectComposePostSuccess('https://x.com/compose/post', { beforeTextLen: 40 });
  assert.equal(det.ok, true);
});

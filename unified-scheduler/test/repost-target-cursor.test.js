'use strict';
/**
 * 来源名单换人后，扫描游标不在新名单里必须清掉。
 * 运行：node --test unified-scheduler/test/repost-target-cursor.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function makeLocalStorage(seed) {
  const obj = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(obj, k) && typeof obj[k] === 'string' ? obj[k] : null; },
    setItem(k, v) { obj[k] = String(v); },
    removeItem(k) { delete obj[k]; },
  };
  Object.assign(obj, seed || {});
  return obj;
}

function loadTracker(store) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'repost', 'repost-tracker.js'), 'utf8');
  const localStorage = makeLocalStorage(store);
  const document = { querySelector() { return null; } };
  const window = {};
  const sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const chrome = {
    storage: { local: { get() {}, set() {} } },
    runtime: { sendMessage() {}, lastError: null },
  };
  const names = ['window', 'document', 'localStorage', 'sessionStorage', 'chrome',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Intl', 'Date', 'JSON'];
  const vals = [window, document, localStorage, sessionStorage, chrome,
    setTimeout, clearTimeout, setInterval, clearInterval, Intl, Date, JSON];
  const factory = new Function(names.join(','), src + '\n;return window.RepostTracker;');
  return { T: factory.apply(null, vals), localStorage };
}

test('新名单不含当前游标时清掉游标', () => {
  const { T } = loadTracker({
    sg_repost_current: 'sana37_148',
    sg_repost_targets: '["sana37_148"]',
  });
  T.setTargets(['raikotsu1987']);
  assert.equal(T.getCurrent(), '');
  assert.deepEqual(T.getTargets(), ['raikotsu1987']);
});

test('游标仍在新名单里时保留', () => {
  const { T } = loadTracker({ sg_repost_current: 'raikotsu1987' });
  T.setTargets(['raikotsu1987', 'other_src']);
  assert.equal(T.getCurrent(), 'raikotsu1987');
});

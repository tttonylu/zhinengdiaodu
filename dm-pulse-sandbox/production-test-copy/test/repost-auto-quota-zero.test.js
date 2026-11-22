/**
 * E2 · 自动转帖配额 = 0（4.6.167）
 * 自动场当日即满，不拉夜场独占；手动场仍不占配额（引擎 isManualNoQuota 旁路）。
 * 运行：node unified-scheduler/test/repost-auto-quota-zero.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

function makeLocalStorage(seed) {
  const obj = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(obj, k) && typeof obj[k] === 'string' ? obj[k] : null; },
    setItem(k, v) { obj[k] = String(v); },
    removeItem(k) { delete obj[k]; }
  };
  Object.assign(obj, seed || {});
  return obj;
}

function loadTracker(opts) {
  opts = opts || {};
  const src = fs.readFileSync(path.join(__dirname, '..', 'repost', 'repost-tracker.js'), 'utf8');
  const localStorage = makeLocalStorage(opts.store || {});
  const document = { querySelector() { return null; } };
  const window = {};
  const sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const chrome = {
    storage: { local: { get: () => {}, set: () => {} } },
    runtime: { sendMessage: () => {}, lastError: null }
  };
  const names = ['window', 'document', 'localStorage', 'sessionStorage', 'chrome',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Intl', 'Date', 'JSON'];
  const vals = [window, document, localStorage, sessionStorage, chrome,
    setTimeout, clearTimeout, setInterval, clearInterval, Intl, Date, JSON];
  const factory = new Function(names.join(','), src + '\n;return window.RepostTracker;');
  return { T: factory.apply(null, vals), localStorage };
}

(function () {
  const { T } = loadTracker({ store: { matrix_my_handle: '@acct#guard' } });
  assert.equal(T.getDailyQuota(), 0, '自动日配额必须为 0');
  assert.equal(T.getEffectiveDailyLimit(), 0, '有效上限随配额为 0');
  assert.equal(T.remainingDaily(), 0, '未发帖也无自动余量');
  assert.equal(T.dailyExhausted(), true, '自动场当日即满，协调器不得独占转帖');
  console.log('ALL PASS repost-auto-quota-zero');
})();

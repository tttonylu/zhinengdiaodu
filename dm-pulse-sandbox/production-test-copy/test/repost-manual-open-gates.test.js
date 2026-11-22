/**
 * E2 · 手动启动转帖开放日程闸（4.6.168）
 * 自动配额=0 时窗默认关；面板手动场必须仍视为在窗内（私信钟/配额/开跑点全旁路）。
 * 运行：node unified-scheduler/test/repost-manual-open-gates.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

function makeStore(seed) {
  const obj = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(obj, k) && typeof obj[k] === 'string' ? obj[k] : null; },
    setItem(k, v) { obj[k] = String(v); },
    removeItem(k) { delete obj[k]; }
  };
  Object.assign(obj, seed || {});
  return obj;
}

function loadTracker(sessionSeed) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'repost', 'repost-tracker.js'), 'utf8');
  const localStorage = makeStore({ matrix_my_handle: '@acct#guard' });
  const sessionStorage = makeStore(sessionSeed || {});
  const document = { querySelector() { return null; } };
  const window = {};
  const chrome = {
    storage: { local: { get: () => {}, set: () => {} } },
    runtime: { sendMessage: () => {}, lastError: null }
  };
  const names = ['window', 'document', 'localStorage', 'sessionStorage', 'chrome',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Intl', 'Date', 'JSON'];
  const vals = [window, document, localStorage, sessionStorage, chrome,
    setTimeout, clearTimeout, setInterval, clearInterval, Intl, Date, JSON];
  const factory = new Function(names.join(','), src + '\n;return window.RepostTracker;');
  return factory.apply(null, vals);
}

(function () {
  const auto = loadTracker();
  assert.equal(auto.dailyExhausted(), true, '自动配额 0 → 满');
  assert.equal(auto.isInRepostWindowNow(), false, '自动场窗关，不得夜场独占');
  assert.equal(auto.isManualOpen && auto.isManualOpen(), false);

  const manual = loadTracker({ sg_repost_manual_slot: '1', sg_repost_manual_no_quota: '1' });
  assert.equal(manual.isManualOpen(), true, '面板启动即手动开闸');
  assert.equal(manual.isInRepostWindowNow(), true, '手动场视为在窗内');
  assert.ok(manual.getActiveWindow(), '手动场 getActiveWindow 非空');

  const noQuotaOnly = loadTracker({ sg_repost_manual_no_quota: '1' });
  assert.equal(noQuotaOnly.isInRepostWindowNow(), true, 'no_quota 键同样开窗');

  console.log('ALL PASS repost-manual-open-gates');
})();

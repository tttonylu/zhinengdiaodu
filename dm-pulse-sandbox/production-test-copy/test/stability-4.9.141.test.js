'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const followSrc = fs.readFileSync(path.join(ROOT, 'follow', 'content_follow_v1522.js'), 'utf8');

function loadPurge() {
  const start = followSrc.indexOf('function purgePoisonedFollowProgress');
  const end = followSrc.indexOf("try { purgePoisonedFollowProgress('boot', true);", start);
  assert.ok(start >= 0 && end > start, 'purgePoisonedFollowProgress block found');
  const store = {};
  const session = {};
  const toasts = [];
  const mem = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
  };
  const memSession = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(session, k) ? session[k] : null; },
    setItem(k, v) { session[k] = String(v); },
    removeItem(k) { delete session[k]; },
  };
  const sandbox = {
    localStorage: mem,
    sessionStorage: memSession,
    followToast(msg) { toasts.push(msg); },
    __clearProcessedFans() {},
    String,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    followSrc.slice(start, end) + '\n;({ purgePoisonedFollowProgress: purgePoisonedFollowProgress })',
    sandbox
  );
  return { purge: sandbox.purgePoisonedFollowProgress, store, toasts };
}

test('版本升到 4.9.157', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, '4.9.157');
});

test('boot 清关注进度只执行一次，start 仍可按任务重置', () => {
  const { purge, store, toasts } = loadPurge();
  store.matrix_follow_processed_fans = '{"blogger":["fan1"]}';

  assert.equal(purge('boot', true), true);
  assert.equal(store.matrix_follow_processed_fans, undefined);
  assert.equal(store.sg_follow_proc_cleared_46044, '1');
  assert.equal(toasts.length, 1);

  store.matrix_follow_processed_fans = '{"blogger":["fan2"]}';
  assert.equal(purge('boot', true), false, '第二次 boot 不应再清空');
  assert.equal(store.matrix_follow_processed_fans, '{"blogger":["fan2"]}');
  assert.equal(toasts.length, 1, '第二次 boot 不应再提示');

  assert.equal(purge('start'), true, '关注任务真正开始时应重置本轮进度');
  assert.equal(store.matrix_follow_processed_fans, undefined);
});

test('关注成功只走带目标的主上报，不再调用旧 reportToNAS 重复记账', () => {
  assert.match(
    followSrc,
    /await reportOpsFollowResult\(getWorkerId\(\), normalizeOpsTargetHandle\(handle\), 'success'/
  );
  assert.doesNotMatch(followSrc, /reportToNAS\(handle, count, stats\.day_count\)/);
  assert.doesNotMatch(
    followSrc,
    /const rowHandle = cell\.querySelector\('a\[href\^="\/"\]'\)\?\.getAttribute\('href'\)/
  );
});

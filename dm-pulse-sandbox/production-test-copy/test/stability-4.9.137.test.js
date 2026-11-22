'use strict';
/**
 * 4.9.137：页面重载后 sessionStorage 残留 park=1，旧逻辑早退不清理，
 * OPS 长期误报 park=true，配置同步也被 5 分钟节流。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'scheduler-core.js'), 'utf8');

function loadFn(name) {
  const re = new RegExp('function ' + name + '\\s*\\(([^)]*)\\)\\s*\\{[\\s\\S]*?\\n  \\}');
  const m = src.match(re);
  assert.ok(m, '应定义 ' + name);
  return m[0];
}

function loadApply(store, active) {
  const calls = [];
  const ctx = {
    _coIdleParkActive: active,
    sessionStorage: {
      getItem(k) { return store.has(k) ? store.get(k) : null; },
      setItem(k, v) { store.set(k, String(v)); }
    },
    window: {
      dispatchEvent(ev) { calls.push(ev); },
      _sgRemoteCmdTimer: null
    },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    reinstallClaimRemoteTimer() {},
    Logger: { info() {} }
  };
  const fn = vm.runInNewContext(loadFn('applyIdleParkMode') + '\napplyIdleParkMode;', ctx);
  return { fn, store, calls };
}

test('内存认为未 park、存储残留 1 → 必须把存储改回 0', () => {
  const h = loadApply(new Map([['sg_idle_park', '1']]), false);
  h.fn(false, 'active');
  assert.equal(h.store.get('sg_idle_park'), '0');
});

test('内存与存储都为 park → 保持 1', () => {
  const h = loadApply(new Map([['sg_idle_park', '1']]), true);
  h.fn(true, 'idle');
  assert.equal(h.store.get('sg_idle_park'), '1');
});

test('源码里同步存储必须早于早退', () => {
  const block = loadFn('applyIdleParkMode');
  const setAt = block.indexOf("sessionStorage.setItem('sg_idle_park'");
  const returnAt = block.indexOf('if (next === _coIdleParkActive) return;');
  assert.ok(setAt > 0 && returnAt > setAt, '必须先写存储再早退');
});

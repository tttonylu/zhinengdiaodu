'use strict';
/**
 * 4.6.194 · 页面瘦身接线
 * 覆盖：off / on / gray 命中 / gray 未命中 四种情况，
 * 断言 chrome.storage.local.sg_page_slim 与 localStorage.sg_page_slim 都正确。
 * 运行：unified-scheduler 下 node --test test/config-sync-page-slim.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeStorage(seed) {
  const obj = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(obj, k) && typeof obj[k] === 'string' ? obj[k] : null; },
    setItem(k, v) { obj[k] = String(v); },
    removeItem(k) { delete obj[k]; },
  };
  Object.assign(obj, seed || {});
  return obj;
}

function loadSync(opts) {
  opts = opts || {};
  const src = fs.readFileSync(path.join(__dirname, '..', 'shared', 'config-sync.js'), 'utf8');
  const local = makeStorage(opts.local);
  const session = makeStorage();
  const storageSets = [];
  const sandbox = {
    console,
    setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval() {},
    Date,
    CustomEvent: function CustomEvent() {},
    window: { addEventListener() {}, dispatchEvent() {} },
    document: { hidden: false, addEventListener() {} },
    localStorage: local,
    sessionStorage: session,
    chrome: {
      runtime: {
        sendMessage(msg, cb) {
          if (!cb) return;
          if (msg && msg.action === 'fetch_remote_config') {
            cb({
              ok: true,
              account: { x_handle: opts.accountHandle || '' },
              thresholds: opts.thresholds || {},
              intervals: {},
            });
          } else {
            cb({ ok: false });
          }
        },
      },
      storage: {
        local: {
          set(obj) { storageSets.push(obj); },
          get(keys, cb) { if (cb) cb({}); },
        },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'config-sync.js' });
  return { local, storageSets };
}

function slimOf(storageSets) {
  const hit = storageSets.filter((o) => Object.prototype.hasOwnProperty.call(o, 'sg_page_slim'));
  return hit.length ? hit[hit.length - 1].sg_page_slim : null;
}

test('page_slim_mode=on → 两处都为 1', () => {
  const s = loadSync({ thresholds: { page_slim_mode: 'on' } });
  assert.equal(slimOf(s.storageSets), '1');
  assert.equal(s.local.getItem('sg_page_slim'), '1');
});

test('page_slim_mode=off → 两处都为 0', () => {
  const s = loadSync({ thresholds: { page_slim_mode: 'off' } });
  assert.equal(slimOf(s.storageSets), '0');
  assert.equal(s.local.getItem('sg_page_slim'), '0');
});

test('gray 命中当前账号 → 1', () => {
  const s = loadSync({
    local: { sg_bound_handle: 'alice' },
    thresholds: { page_slim_mode: 'gray', page_slim_handles: 'bob,@Alice,carol' },
  });
  assert.equal(slimOf(s.storageSets), '1');
  assert.equal(s.local.getItem('sg_page_slim'), '1');
});

test('gray 未命中当前账号 → 0', () => {
  const s = loadSync({
    local: { sg_bound_handle: 'dave' },
    thresholds: { page_slim_mode: 'gray', page_slim_handles: 'bob,alice' },
  });
  assert.equal(slimOf(s.storageSets), '0');
  assert.equal(s.local.getItem('sg_page_slim'), '0');
});

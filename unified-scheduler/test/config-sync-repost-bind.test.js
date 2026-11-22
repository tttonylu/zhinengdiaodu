'use strict';
/**
 * 转帖来源绑定：导航栏本号优先；认错号时不得用全局来源覆盖本机。
 * 运行：node --test unified-scheduler/test/config-sync-repost-bind.test.js
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
  const fetches = [];
  const doc = {
    hidden: false,
    addEventListener() {},
    querySelector(sel) {
      if (sel === 'a[data-testid="AppTabBar_Profile_Link"]' && opts.navHref) {
        return { getAttribute() { return opts.navHref; }, href: opts.navHref };
      }
      return null;
    },
  };
  const sandbox = {
    console,
    setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval() {},
    Date,
    CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; },
    window: { addEventListener() {}, dispatchEvent() {} },
    document: doc,
    localStorage: local,
    sessionStorage: makeStorage(),
    chrome: {
      runtime: {
        sendMessage(msg, cb) {
          if (msg && msg.action === 'fetch_remote_config') fetches.push(msg);
          const res = opts.onFetch ? opts.onFetch(msg) : { ok: true, account: null, thresholds: {} };
          if (cb) cb(res);
        },
        lastError: null,
      },
      storage: { local: { set() {}, get(keys, cb) { if (cb) cb({}); } } },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'config-sync.js' });
  return { fetches, local, ConfigSync: sandbox.window.ConfigSync };
}

test('导航栏是本号时，拉取不得沿用被来源页改写的 matrix_my_handle', () => {
  const s = loadSync({
    navHref: '/sana37_148',
    local: { matrix_my_handle: '@raikotsu1987#guard' },
    onFetch() {
      return { ok: true, account: { x_handle: 'sana37_148' }, thresholds: { repost_targets: ['ops_source'] } };
    },
  });
  assert.equal(s.fetches.length >= 1, true);
  assert.match(String(s.fetches[0].bot_id || ''), /sana37_148/i);
  assert.equal(JSON.parse(s.local.getItem('sg_repost_targets') || '[]').join(','), 'ops_source');
});

test('来源号不在账号表时，全局来源不得覆盖本机绑定', () => {
  const s = loadSync({
    local: {
      matrix_my_handle: '@raikotsu1987#guard',
      sg_repost_targets: JSON.stringify(['kept_local']),
    },
    onFetch() {
      return { ok: true, account: { x_handle: null }, thresholds: { repost_targets: ['global_blogger'] } };
    },
  });
  assert.equal(JSON.parse(s.local.getItem('sg_repost_targets') || '[]').join(','), 'kept_local');
});

test('本号对上且 OPS 名单不同时，用 OPS 覆盖本机', () => {
  const s = loadSync({
    navHref: '/sana37_148',
    local: {
      matrix_my_handle: '@sana37_148#guard',
      sg_repost_targets: JSON.stringify(['raikotsu1987']),
    },
    onFetch(msg) {
      assert.match(String(msg.bot_id || ''), /sana37_148/i);
      return { ok: true, account: { x_handle: 'sana37_148' }, thresholds: { repost_targets: ['real_source'] } };
    },
  });
  assert.equal(JSON.parse(s.local.getItem('sg_repost_targets') || '[]').join(','), 'real_source');
});

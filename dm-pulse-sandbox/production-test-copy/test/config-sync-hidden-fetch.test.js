'use strict';
/**
 * 4.6.160 · 隐藏标签也要能拉到 tick 配置
 * 覆盖：hidden 时 5 分钟内不重复拉；满 5 分钟补拉；切回前台立刻拉。
 * 运行：unified-scheduler 下 node --test test/config-sync-hidden-fetch.test.js
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
  const fetches = [];
  const vis = [];
  const RealDate = Date;
  let nowMs = opts.nowMs != null ? opts.nowMs : RealDate.now();
  function FakeDate(...args) {
    if (!(this instanceof FakeDate)) return RealDate();
    if (!args.length) return new RealDate(nowMs);
    return new RealDate(...args);
  }
  FakeDate.now = function () { return nowMs; };
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  const doc = {
    hidden: !!opts.hidden,
    addEventListener(ev, fn) {
      if (ev === 'visibilitychange') vis.push(fn);
    },
  };
  const sandbox = {
    console,
    setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval() {},
    Date: FakeDate,
    window: { addEventListener() {}, dispatchEvent() {} },
    document: doc,
    localStorage: local, sessionStorage: session,
    chrome: {
      runtime: {
        sendMessage(msg, cb) {
          if (msg && msg.action === 'fetch_remote_config') fetches.push(msg);
          const res = (opts.responses && opts.responses[msg.action]) || { ok: true, account: {}, thresholds: {} };
          if (cb) cb(res);
        },
      },
      storage: { local: { set() {} } },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'config-sync.js' });
  return {
    fetches,
    vis,
    doc,
    ConfigSync: sandbox.window.ConfigSync,
    setNow(ms) { nowMs = ms; },
    setHidden(v) { doc.hidden = !!v; },
  };
}

test('隐藏页启动仍拉一次配置（让 30s tick 进后台标签）', () => {
  const s = loadSync({ hidden: true, nowMs: 1_000_000 });
  assert.equal(s.fetches.length, 1, 'hidden 首次 startSync 应拉配置');
});

test('隐藏页 5 分钟内重复 fetchRemote 不发第二枪', () => {
  const s = loadSync({ hidden: true, nowMs: 1_000_000 });
  s.ConfigSync.fetchRemote();
  s.ConfigSync.fetchRemote();
  assert.equal(s.fetches.length, 1, '5 分钟窗口内 hidden 应跳过');
});

test('隐藏页满 5 分钟后允许再拉', () => {
  const s = loadSync({ hidden: true, nowMs: 1_000_000 });
  s.setNow(1_000_000 + 5 * 60 * 1000);
  s.ConfigSync.fetchRemote();
  assert.equal(s.fetches.length, 2, '满 5 分钟应补拉');
});

test('切回前台立刻拉配置，不受 hidden 5 分钟窗限制', () => {
  const s = loadSync({ hidden: true, nowMs: 1_000_000 });
  assert.ok(s.vis.length >= 1, '应监听 visibilitychange');
  s.setHidden(false);
  s.vis.forEach((fn) => fn());
  assert.equal(s.fetches.length, 2, '可见后应立即 fetchRemote');
});

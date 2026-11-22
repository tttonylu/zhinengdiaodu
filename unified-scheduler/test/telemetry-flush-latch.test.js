/**
 * G3 · telemetry flush 闩：sendMessage 超时不得永真跳过
 * 运行：node --test unified-scheduler/test/telemetry-flush-latch.test.js
 */
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadTelemetry(env) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'shared', 'telemetry.js'), 'utf8');
  const sandbox = {
    console,
    setTimeout: env.setTimeout,
    clearTimeout: env.clearTimeout,
    Date,
    Math,
    JSON,
    String,
    Number,
    Array,
    Object,
    Promise,
    document: {
      hidden: false,
      addEventListener: function () {}
    },
    window: {},
    self: {},
    sessionStorage: env.sessionStorage,
    localStorage: env.localStorage,
    chrome: env.chrome
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.runInNewContext(code, sandbox, { timeout: 5000 });
  return sandbox.SgTelemetry || sandbox.window.SgTelemetry;
}

describe('G3 · telemetry flush latch', () => {
  let timers;
  let session;
  let local;
  let chromeApi;
  let pendingCb;

  beforeEach(() => {
    timers = [];
    session = {};
    local = {
      sg_config_thresholds: JSON.stringify({ telemetry_upload_min_level: 'info' })
    };
    pendingCb = null;
    chromeApi = {
      runtime: {
        sendMessage: function (_payload, cb) {
          pendingCb = cb; // 故意不回调 → 模拟 SW 挂死
        },
        onMessage: { addEventListener: function () {}, addListener: function () {} },
        getURL: function () { return ''; },
        getManifest: function () { return { version: 'test' }; }
      }
    };
  });

  afterEach(() => {
    timers.forEach((t) => clearTimeout(t.id));
  });

  it('sendMessage 超时后 flushing 可再次出队', async () => {
    const fakeNow = { t: 1_000_000 };
    const realDateNow = Date.now;
    Date.now = () => fakeNow.t;

    const api = loadTelemetry({
      sessionStorage: {
        getItem: (k) => (session[k] == null ? null : session[k]),
        setItem: (k, v) => { session[k] = String(v); },
        removeItem: (k) => { delete session[k]; }
      },
      localStorage: {
        getItem: (k) => (local[k] == null ? null : local[k]),
        setItem: (k, v) => { local[k] = String(v); },
        removeItem: (k) => { delete local[k]; }
      },
      chrome: chromeApi,
      setTimeout: (fn, ms) => {
        const id = { fn, ms, fired: false };
        timers.push(id);
        // 立即登记；测试里手动 fire
        id.native = setTimeout(() => { id.fired = true; fn(); }, 0);
        return id;
      },
      clearTimeout: (id) => {
        if (id && id.native) clearTimeout(id.native);
      }
    });

    assert.ok(api && typeof api.emit === 'function');
    // 等 init 微任务
    await new Promise((r) => setTimeout(r, 20));

    session.matrix_my_handle = '@alice#guard';
    local.matrix_my_handle = '@alice#guard';

    api.emit('system.logger_warn', { mod: 't', msg: 'latch' });
    await new Promise((r) => setTimeout(r, 30));

    // 触发 flush（scheduleFlush 2–5s；直接 flush）
    const p1 = api.flush(2);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(pendingCb, '应已向 SW 发 telemetry_emit');

    // 推进时间并让 SEND_TIMEOUT / watchdog 触发（setTimeout(0) 已排队）
    fakeNow.t += 20000;
    await new Promise((r) => setTimeout(r, 50));

    // 超时后应能再次 flush（不再 skipped 卡死）
    pendingCb = null;
    chromeApi.runtime.sendMessage = function (_payload, cb) {
      cb({ ok: true, ingested: 1, deduped: 0, failed: 0 });
    };
    const res = await api.flush(3);
    assert.equal(!!(res && res.ok), true, '超时复位后应能成功 flush');

    Date.now = realDateNow;
    await p1.catch(() => {});
  });
});

'use strict';
/**
 * 遥测补传队列必须真的出队。
 * 现场故障：成功发送后没有把剩余队列写回存储，函数重新读到的还是同一条旧批次，
 * 于是无限重发（~165 次/秒）。OPS 看到的最新事件因此停在旧批次上。
 * 运行：node --test --test-force-exit test/telemetry-queue-drain.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const bg = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const start = bg.indexOf('function queueTelemetryBatch');
const end = bg.indexOf('// ==================== 消息监听', start);
assert.ok(start > 0 && end > start, '必须能定位到遥测队列实现');
const queueCode = bg.slice(start, end);

function makeSandbox(initialQueue, response) {
  const store = { sg_telemetry_queue: JSON.parse(JSON.stringify(initialQueue)) };
  let fetches = 0;
  const chrome = {
    storage: {
      local: {
        get: function (keys, cb) {
          const out = {};
          for (const k of keys) out[k] = store[k];
          setTimeout(function () { cb(out); }, 0);
        },
        set: function (obj, cb) {
          Object.assign(store, obj);
          setTimeout(function () { if (cb) cb(); }, 0);
        }
      }
    }
  };
  const sandbox = {
    chrome,
    console,
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    Array,
    Object,
    String,
    Number,
    Promise,
    opsFetch: function () {
      fetches++;
      return Promise.resolve(response);
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(queueCode, sandbox);
  return { sandbox, store, getFetches: () => fetches };
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('OPS 遥测补传队列', () => {
  it('成功发送后必须从存储移除，不能无限重发同一条', async () => {
    const batch = Array.from({ length: 3 }, (_, i) => ({ ts: 1, events: [{ client_event_id: 'e' + i }] }));
    const env = makeSandbox(batch, { ok: true });
    vm.runInContext('flushTelemetryQueue()', env.sandbox);
    await wait(80);
    assert.equal(env.getFetches(), 3, '三条批次应各发一次');
    assert.equal((env.store.sg_telemetry_queue || []).length, 0, '队列必须清空');
  });

  it('发送失败时队列保持原样，不能 unshift 出重复副本', async () => {
    const batch = [{ ts: 1, events: [{ client_event_id: 'x' }] }];
    const env = makeSandbox(batch, { ok: false });
    vm.runInContext('flushTelemetryQueue()', env.sandbox);
    await wait(50);
    assert.equal(env.getFetches(), 1);
    assert.equal((env.store.sg_telemetry_queue || []).length, 1, '失败后仍应是 1 条，不能变 2 条');
  });

  it('启动时把重复批次合并成一份', async () => {
    const dup = { ts: 1, events: [{ client_event_id: 'same' }] };
    const env = makeSandbox([dup, JSON.parse(JSON.stringify(dup)), JSON.parse(JSON.stringify(dup))], { ok: true });
    vm.runInContext('sanitizeTelemetryQueue()', env.sandbox);
    await wait(40);
    assert.equal((env.store.sg_telemetry_queue || []).length, 1, '三份相同批次应合并成一份');
  });
});

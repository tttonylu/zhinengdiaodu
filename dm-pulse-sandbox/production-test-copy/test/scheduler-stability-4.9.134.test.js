'use strict';
/**
 * 4.9.134：空闲降频/僵尸引擎/日志噪声回归。
 *
 * 现场症状：
 * - 满额 park 后每 35s 才跑一整拍，gap 被误判成“主线程卡顿 30s”；
 * - 误升 L2 后跳过假活回收，chat/nurture 的运行旗标一直不释放；
 * - OPS 里出现 event_loop_lag / test.monitor_auto_stopped / nurture_blocked 噪声。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const coreSrc = fs.readFileSync(path.join(root, 'scheduler-core.js'), 'utf8');
const monitorSrc = fs.readFileSync(path.join(root, 'obs', 'test-monitor.js'), 'utf8');

test('空闲降频/低功耗拉长的 tick 不计入主线程压力', () => {
  const tickAt = coreSrc.indexOf('function coTick()');
  const tick = coreSrc.slice(tickAt, coreSrc.indexOf('function coTickTimed', tickAt));
  assert.match(tick, /_coSkipPressureAfterThrottle = true/);
  assert.match(tick, /if \(_coSkipPressureAfterThrottle\)/);
  const detectAt = tick.indexOf('_coDetectPressure(');
  const skipAt = tick.indexOf('if (_coSkipPressureAfterThrottle)');
  assert.ok(skipAt > 0 && detectAt > skipAt, '必须先用节流标记跳过压力检测');
});

test('养号运行旗标超过 90s 没心跳 → 判死，释放空闲 park', () => {
  const fnAt = coreSrc.indexOf('function coEngineAlive');
  const fn = coreSrc.slice(fnAt, coreSrc.indexOf('function coGentleStopFollow', fnAt));
  assert.match(fn, /sg_module_nurture/);
  assert.match(fn, /lastActive/);
  assert.match(fn, /> 90000/);
});

test('重复的 chat_blocked / nurture_blocked 上报按原因节流 5 分钟', () => {
  assert.match(coreSrc, /function emitCoBlockedTelemetry\(/);
  assert.match(coreSrc, /300000/);
  assert.match(coreSrc, /emitCoBlockedTelemetry\('scheduler\.chat_blocked'/);
  assert.match(coreSrc, /emitCoBlockedTelemetry\('scheduler\.nurture_blocked'/);
});

test('生产模式不再每页加载重复上报 test.monitor_auto_stopped warn', () => {
  const at = monitorSrc.indexOf('var productionMode');
  const block = monitorSrc.slice(at, at + 1600);
  assert.match(block, /removeItem\(STORAGE_KEY\)/);
  assert.match(block, /reason: 'production_mode'/);
  assert.match(block, /\}, 'info'\)/);
  assert.doesNotMatch(block, /\}, 'warn'\)/);
});

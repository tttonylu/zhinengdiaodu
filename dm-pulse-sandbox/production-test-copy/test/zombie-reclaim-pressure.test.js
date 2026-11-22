'use strict';
/**
 * 4.6.161 · 调度自身滞后时不把出站等待当假活回收
 * 45s 进度线不动；L2 压力或本拍 gap≥45s 时跳过 tick_progress_stale。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'scheduler-core.js'), 'utf8');

function loadHelper() {
  const m = src.match(/function shouldSkipTickProgressReclaimCo\s*\(([^)]*)\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m, '应定义 shouldSkipTickProgressReclaimCo');
  return vm.runInNewContext(m[0] + '\nshouldSkipTickProgressReclaimCo');
}

test('L2 压力跳过 tick_progress_stale 回收（45s 线不动）', () => {
  const fn = loadHelper();
  assert.equal(fn(2, 10000, 45000), true);
  assert.equal(fn(1, 10000, 45000), false);
  assert.equal(fn(0, 10000, 45000), false);
});

test('本拍 gap 已达进度阈值 → 跳过（主线程卡住，不是 chat 假活）', () => {
  const fn = loadHelper();
  assert.equal(fn(0, 45000, 45000), true);
  assert.equal(fn(0, 44999, 45000), false);
});

test('diagAlign 在 stale 回收前询问 shouldSkipTickProgressReclaimCo', () => {
  assert.ok(src.includes("reclaimChatZombieCo('tick_progress_stale')"));
  const idxSkip = src.indexOf('shouldSkipTickProgressReclaimCo()');
  const idxReclaim = src.indexOf("reclaimChatZombieCo('tick_progress_stale')");
  assert.ok(idxSkip > 0 && idxSkip < idxReclaim, '跳过判断必须在 reclaim 之前');
});

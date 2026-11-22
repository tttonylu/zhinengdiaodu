'use strict';
/**
 * 粉丝列表扫描/后台节流期间，45 秒普通出站假活线不得误杀 chat。
 * 扫描自身有超时兜底，调度侧只给 3 分钟宽限。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'scheduler-core.js'), 'utf8');

function loadWhyHelper() {
  const m = src.match(/function isChatFanScanProgressWhyCo\s*\(([^)]*)\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m, '应定义 isChatFanScanProgressWhyCo');
  return vm.runInNewContext(m[0] + '\nisChatFanScanProgressWhyCo');
}

test('粉丝扫描进度原因命中宽限', () => {
  const fn = loadWhyHelper();
  for (const why of [
    'roster_scan_active',
    'roster_seal_start',
    'outbound_fan_scan_top',
    'outbound_fan_scan_wait',
    'outbound_gap_scroll_down',
    'inbox_roster_wait_profile'
  ]) {
    assert.equal(fn(why), true, why + ' 应命中扫描宽限');
  }
});

test('普通发送/打开会话不命中扫描宽限', () => {
  const fn = loadWhyHelper();
  for (const why of ['step_ad', 'inbox_pulse_heartbeat', 'queue_drain', '']) {
    assert.equal(fn(why), false, why + ' 不得绕过 45 秒假活线');
  }
});

test('调度在 reclaim 前检查扫描宽限和 3 分钟上限', () => {
  const idxGrace = src.indexOf('isChatFanScanProgressWhyCo(progWhy)');
  const idxRoster = src.indexOf('isRosterScanActiveCo()');
  const idxReclaim = src.indexOf("reclaimChatZombieCo('tick_progress_stale')");
  assert.ok(idxGrace > 0 && idxGrace < idxReclaim, '扫描原因判断必须在 reclaim 之前');
  assert.ok(idxRoster > 0 && idxRoster < idxReclaim, '拉新扫描态判断必须在 reclaim 之前');
  assert.match(src, /var CHAT_SCAN_GRACE_MS = 180000;/);
});

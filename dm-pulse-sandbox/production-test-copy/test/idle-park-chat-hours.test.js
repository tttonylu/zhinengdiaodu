'use strict';
/**
 * 4.9.131 回归：非私信时段，私信债不能阻止关注满额后的空闲 park。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'scheduler-core.js'), 'utf8');
const Gate = require(path.join(root, 'scheduler', 'idle-park-gate.js'));

function loadEvaluate(overrides) {
  const start = src.indexOf('  function evaluateIdleParkGateCo(');
  const end = src.indexOf('  var _coIdleParkActive', start);
  assert.ok(start >= 0 && end > start, '应找到 evaluateIdleParkGateCo');
  const code = src.slice(start, end) + '\nevaluateIdleParkGateCo;';
  const opts = Object.assign({
    SgIdleParkGate: Gate,
    localStorage: { getItem() { return null; } },
    softRiskActive() { return false; },
    coIsRunning() { return false; },
    coEngineAlive() { return false; },
    hasDaytimeChatWork() { return true; },
    nightRepostShouldRun() { return false; },
    isManualRepostOpenCo() { return false; },
    getFollowedToday() { return 193; },
    getLimit() { return 193; },
    chatHoursOpenCo() { return false; },
    canStartNewChatAfterLastEntryGate() { return true; },
    isChatDailyCapReachedCo() { return false; },
    coLoadSg() { return {}; }
  }, overrides || {});
  return vm.runInNewContext(code, opts);
}

test('关注满额 + 非私信时段 → 深度 park，不因私信债空转', () => {
  const r = loadEvaluate()();
  assert.equal(r.park, true);
  assert.equal(r.deep, true);
  assert.equal(r.reason, 'follow_quota_full_idle');
});

test('关注满额 + 私信时段且有私信债 → 不 park', () => {
  const r = loadEvaluate({ chatHoursOpenCo() { return true; } })();
  assert.equal(r.park, false);
  assert.equal(r.reason, 'chat_debt_urgent');
});

test('关注满额 + 私信时段但无私信债 → 仍深度 park', () => {
  const r = loadEvaluate({
    chatHoursOpenCo() { return true; },
    hasDaytimeChatWork() { return false; }
  })();
  assert.equal(r.park, true);
  assert.equal(r.reason, 'follow_quota_full_idle');
});

test('关注满额 + 私信时段但今日末次名额已用 → 深度 park，不再每 10 秒刷 chat_last_entry_used', () => {
  const r = loadEvaluate({
    chatHoursOpenCo() { return true; },
    canStartNewChatAfterLastEntryGate() { return false; }
  })();
  assert.equal(r.park, true);
  assert.equal(r.deep, true);
  assert.equal(r.reason, 'follow_quota_full_idle');
});

test('关注满额 + 私信时段但日帽已满 → 深度 park', () => {
  const r = loadEvaluate({
    chatHoursOpenCo() { return true; },
    isChatDailyCapReachedCo() { return true; }
  })();
  assert.equal(r.park, true);
  assert.equal(r.deep, true);
  assert.equal(r.reason, 'follow_quota_full_idle');
});

'use strict';
/**
 * 4.9.136：关注满额后养号必须接上。
 * 现场 18:36 后 followed=193/193，nurture 被 follow_quota_full 拦掉，
 * idle-park 又整拍早退，导致下班后完全空闲。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'scheduler-core.js'), 'utf8');
const QuotaGate = require(path.join(ROOT, 'scheduler', 'nurture-quota-gate.js'));
const ParkGate = require(path.join(ROOT, 'scheduler', 'idle-park-gate.js'));

function loadFn(name) {
  const re = new RegExp('function ' + name + '\\s*\\(([^)]*)\\)\\s*\\{[\\s\\S]*?\\n  \\}');
  const m = src.match(re);
  assert.ok(m, '应定义 ' + name);
  return m[0];
}

function loadQuotaGate(overrides) {
  const ctx = Object.assign({
    SgNurtureQuotaGate: QuotaGate,
    softRiskActive() { return false; },
    coLoadSg() { return {}; },
    getFollowedToday() { return 193; },
    getLimit() { return 193; },
    moduleSwitchOn() { return true; },
    NurtureTracker: { isDailyExhausted() { return false; } },
    Date: Date
  }, overrides || {});
  const code = loadFn('evaluateNurtureQuotaGateCo') + '\n'
    + loadFn('nurtureDailyExhaustedCo') + '\nevaluateNurtureQuotaGateCo;';
  return vm.runInNewContext(code, ctx);
}

function loadParkGate(overrides) {
  const start = src.indexOf('  function evaluateIdleParkGateCo(');
  const end = src.indexOf('  var _coIdleParkActive', start);
  assert.ok(start >= 0 && end > start, '应找到 evaluateIdleParkGateCo');
  const ctx = Object.assign({
    SgIdleParkGate: ParkGate,
    localStorage: { getItem() { return null; } },
    softRiskActive() { return false; },
    coIsRunning() { return false; },
    coEngineAlive() { return false; },
    hasDaytimeChatWork() { return false; },
    nightRepostShouldRun() { return false; },
    isManualRepostOpenCo() { return false; },
    getFollowedToday() { return 193; },
    getLimit() { return 193; },
    chatHoursOpenCo() { return false; },
    canStartNewChatAfterLastEntryGate() { return true; },
    isChatDailyCapReachedCo() { return false; },
    moduleSwitchOn() { return true; },
    NurtureTracker: { isDailyExhausted() { return false; } },
    coLoadSg() { return {}; },
    Date: Date
  }, overrides || {});
  const code = src.slice(start, end) + '\n' + loadFn('nurtureDailyExhaustedCo') + '\nevaluateIdleParkGateCo;';
  return vm.runInNewContext(code, ctx);
}

test('关注满额 + 养号未耗尽 → 养号放行（非私信时段）', () => {
  const r = loadQuotaGate()();
  assert.equal(r.allow, true);
  assert.equal(r.reason, 'follow_quota_full_nurture_ok');
  assert.equal(loadQuotaGate({
    NurtureTracker: { isDailyExhausted() { return true; } }
  })().reason, 'nurture_daily_exhausted');
});

test('非私信时段关注满额：养号未耗尽不 park，耗尽才 park', () => {
  assert.equal(loadParkGate()().park, false);
  assert.equal(loadParkGate()().reason, 'nurture_pending');
  const exhausted = loadParkGate({
    NurtureTracker: { isDailyExhausted() { return true; } }
  })();
  assert.equal(exhausted.park, true);
  assert.equal(exhausted.deep, true);
  assert.equal(exhausted.reason, 'follow_quota_full_idle');
});

test('私信时段仍按 chat 节奏 park，不被养号兜底拖住', () => {
  const r = loadParkGate({ chatHoursOpenCo() { return true; } })();
  assert.equal(r.park, true);
  assert.equal(r.reason, 'follow_quota_full_idle');
});

test('养号模块关闭时满额仍 park', () => {
  const r = loadParkGate({ moduleSwitchOn() { return false; } })();
  assert.equal(r.park, true);
  assert.equal(r.reason, 'follow_quota_full_idle');
});

'use strict';
/**
 * 4.9.147：软风控加班封顶每个 tick 都会走一遍，原实现每次都写两条 warn
 * 并发一条遥测，18 小时刷了约 2.8 万条，OPS 被日志淹没。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'scheduler-core.js'), 'utf8');

function sliceFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, '应定义 ' + name);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(name + ' 未闭合');
}

function makeFn() {
  const warns = [];
  const emits = [];
  const ctx = {
    Logger: { warn: (mod, msg) => warns.push(mod + ':' + msg) },
    SgTelemetry: { emit: (ev, meta) => emits.push({ ev, meta }) },
    coSaveSg: () => {},
    coLoadSg: () => ({}),
    coIsRunning: () => false,
    coStop: () => {},
    clearSoftRiskFields: (sg) => {
      sg.softRiskPhase = '';
      sg.softRiskOvertimeMs = 0;
      sg.softRiskCappedAt = 0;
    },
    chatProgressAgeMsCo: () => 0,
    softRiskActive: (sg, now) => {
      const until = sg.softRiskUntil || 0;
      if (!(until > 0)) return false;
      const ph = sg.softRiskPhase || '';
      if (ph === 'chat1' || ph === 'chat2' || ph === 'nurture') return true;
      return (now || Date.now()) < until;
    }
  };
  const fn = vm.runInNewContext(
    'var _softCapLastPhase = "";\nvar _softCapLastLogAt = 0;\nvar _softNoProgProbeAt = 0;\n'
      + 'var SOFT_CAP_NO_PROGRESS_MS = 10 * 60 * 1000;\n'
      + 'var SOFT_OVERTIME_MAX_MS = 60 * 60 * 1000;\n'
      + sliceFunction(src, 'tryEndStalledCappedSoftRisk') + '\n'
      + sliceFunction(src, 'forceSoftRiskOvertimeCap') + '\n'
      + 'forceSoftRiskOvertimeCap',
    ctx
  );
  return { fn, warns, emits };
}

test('同一相位重复调用只记一次日志和遥测', () => {
  const { fn, warns, emits } = makeFn();
  const sg = { softRiskPhase: 'chat1', softRiskOvertimeMs: 3600000, softRiskUntil: Date.now() + 60000 };
  fn(sg, 'chat1', 'timer');
  fn(sg, 'chat1', 'timer');
  fn(sg, 'chat1', 'reconcile');
  assert.equal(emits.length, 1);
  assert.equal(emits[0].ev, 'scheduler.soft_overtime_cap');
  assert.equal(warns.length, 2);
});

test('相位变化后允许再记一次', () => {
  const { fn, emits } = makeFn();
  const sg = { softRiskPhase: 'nurture', softRiskOvertimeMs: 3600000, softRiskUntil: 1000000 };
  fn(sg, 'nurture', 'timer');
  fn(sg, 'chat1', 'timer');
  assert.equal(emits.length, 2);
});

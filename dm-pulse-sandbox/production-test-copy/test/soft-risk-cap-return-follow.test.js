'use strict';
/**
 * 4.9.154：软风控私信段封顶后，若私信 10 分钟没有任何进展，
 * 这一轮不可能自然收口，必须结束软窗回关注，避免永久卡死。
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

function makeHarness(progressAgeMs, chatRunning) {
  const warns = [];
  const emits = [];
  const saves = [];
  const ctx = {
    Logger: { warn: (mod, msg) => warns.push(mod + ':' + msg) },
    SgTelemetry: { emit: (ev, meta) => emits.push({ ev, meta }) },
    coSaveSg: (sg) => saves.push(JSON.parse(JSON.stringify(sg))),
    coLoadSg: () => ({}),
    coIsRunning: (name) => !!(chatRunning && name === 'chat'),
    coStop: () => {},
    clearSoftRiskFields: (sg) => {
      sg.softRiskUntil = 0;
      sg.softRiskPhase = '';
      sg.softRiskOvertimeMs = 0;
      sg.softRiskCappedAt = 0;
    },
    chatProgressAgeMsCo: () => progressAgeMs,
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
  return { fn, warns, emits, saves };
}

test('私信 2 分钟前还有进度 → 不结束软窗', () => {
  const { fn } = makeHarness(2 * 60 * 1000);
  const sg = { softRiskPhase: 'chat1', softRiskOvertimeMs: 3600000, softRiskUntil: Date.now() + 60000 };
  assert.equal(fn(sg, 'chat1', 'timer'), 'chat');
  assert.equal(sg.softRiskPhase, 'chat1');
});

test('封顶超过 10 分钟且私信无进展 → 回关注', () => {
  const { fn, emits, saves } = makeHarness(20 * 60 * 1000);
  const sg = {
    softRiskPhase: 'chat1',
    softRiskOvertimeMs: 3600000,
    softRiskUntil: Date.now() - 1000,
    softRiskCappedAt: Date.now() - 11 * 60 * 1000
  };
  assert.equal(fn(sg, 'chat1', 'timer'), 'follow');
  assert.equal(sg.softRiskPhase, '');
  assert.equal(sg.followNextDelayUntil, 0);
  assert.equal(saves.length, 1);
  const end = emits.find((e) => e.ev === 'scheduler.soft_risk_round_end');
  assert.ok(end, '应发 round_end 遥测');
  assert.equal(end.meta.reason, 'cap_no_progress');
});

test('封顶超过 10 分钟但私信仍在推进 → 不结束', () => {
  const { fn } = makeHarness(30 * 1000, true);
  const sg = {
    softRiskPhase: 'chat1',
    softRiskOvertimeMs: 3600000,
    softRiskUntil: Date.now() - 1000,
    softRiskCappedAt: Date.now() - 11 * 60 * 1000
  };
  assert.equal(fn(sg, 'chat1', 'timer'), 'chat');
  assert.equal(sg.softRiskPhase, 'chat1');
});

test('未封顶但私信 11 分钟无进展 → 也回关注', () => {
  const { fn, emits } = makeHarness(20 * 60 * 1000, false);
  const sg = {
    softRiskPhase: 'chat1',
    softRiskOvertimeMs: 0,
    softRiskUntil: Date.now() + 20 * 60 * 1000,
    softRiskCappedAt: Date.now() - 11 * 60 * 1000
  };
  assert.equal(fn(sg, 'chat1', 'timer'), 'follow');
  assert.equal(sg.softRiskPhase, '');
  const end = emits.find((e) => e.ev === 'scheduler.soft_risk_round_end');
  assert.ok(end);
  assert.equal(end.meta.reason, 'cap_no_progress');
});

test('phase 为空但 mode=chat_nurture_chat → 同样按私信段回关注', () => {
  const { fn } = makeHarness(20 * 60 * 1000, false);
  const sg = {
    softRiskPhase: '',
    softRiskMode: 'chat_nurture_chat',
    softRiskOvertimeMs: 0,
    softRiskUntil: Date.now() + 20 * 60 * 1000
  };
  assert.equal(fn(sg, '', 'timer'), 'follow');
  assert.equal(sg.softRiskPhase, '');
});

// 4.9.155：现场每 10 秒一轮「进软窗 → 立刻判无进展 → 清窗 → 关注再撞软风控」。
// 私信最后进度还停在上一次（14 小时前）时，新开的软窗不能被同一拍判死。
test('软窗刚开启 30 秒，即使历史进度很旧也不结束', () => {
  const { fn, emits } = makeHarness(14 * 60 * 60 * 1000, false);
  const sg = {
    softRiskPhase: 'chat1',
    softRiskMode: 'chat_nurture_chat',
    softRiskUntil: Date.now() + 30 * 60 * 1000,
    softRiskStartedAt: Date.now() - 30 * 1000
  };
  assert.equal(fn(sg, 'chat1', 'reconcile'), 'chat');
  assert.equal(sg.softRiskPhase, 'chat1');
  assert.equal(emits.filter((e) => e.ev === 'scheduler.soft_risk_round_end').length, 0, '不能发 round_end');
});

test('软窗已开 11 分钟仍无进展 → 这时才允许结束', () => {
  const { fn, emits } = makeHarness(14 * 60 * 60 * 1000, false);
  const sg = {
    softRiskPhase: 'chat1',
    softRiskMode: 'chat_nurture_chat',
    softRiskUntil: Date.now() + 20 * 60 * 1000,
    softRiskStartedAt: Date.now() - 11 * 60 * 1000
  };
  assert.equal(fn(sg, 'chat1', 'reconcile'), 'follow');
  assert.equal(sg.softRiskPhase, '');
  const end = emits.find((e) => e.ev === 'scheduler.soft_risk_round_end');
  assert.ok(end);
  assert.equal(end.meta.reason, 'cap_no_progress');
});

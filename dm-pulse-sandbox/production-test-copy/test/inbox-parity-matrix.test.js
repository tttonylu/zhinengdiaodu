'use strict';
/**
 * 规则镜像（inbox-decision）与运行时状态机（inbox-state）全状态对拍。
 *
 * 私信最容易出的不是单点 bug，而是“两套实现各改一半”：
 * 运行时发广告、镜像说要等；或者运行时收口、镜像还允许催加。
 * 这里把 stage × 两段式 × 有无回复 × 年龄 × 复活 × 轮次闸 全排列跑一遍，
 * 任何一项 action/route/reason 不一致就直接失败。
 *
 * 运行：node --test --test-force-exit test/inbox-parity-matrix.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(parts) {
  const src = fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
  const sandbox = { window: {}, console, Math, Number, parseInt, isFinite, Date };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.window;
}

const State = load(['chat', 'inbox-state.js']).SgInboxState;
const Decision = load(['chat', 'inbox-decision.js']).SgInboxDecision;

const NOW = 1700000000000;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function makeEntries(twoSeg) {
  const out = [];
  const add = (name, entry) => out.push({ name, entry });

  add('未破冰', { round: 0 });
  add('破冰后刚发', { round: 1, iceSentAt: NOW - 30 * 1000 });
  add('破冰已久', { round: 1, iceSentAt: NOW - 3 * HOUR });
  if (twoSeg) {
    // 两段式：广告 = 第二段含 LINE，发完即完结，不再催加。
    add('广告已发(两段式完结)', {
      round: 3, iceSentAt: NOW - 3 * HOUR, adSentAt: NOW - 2 * HOUR, adBubbleOk: 1,
      twoSegAdDoneAt: NOW - 2 * HOUR, chatClosedAt: NOW - 2 * HOUR, done: true
    });
  } else {
    add('广告已发', { round: 2, iceSentAt: NOW - 3 * HOUR, adSentAt: NOW - 2 * HOUR, adBubbleOk: 1 });
    add('广告已发·下一拍', {
      round: 2, iceSentAt: NOW - 3 * HOUR, adSentAt: NOW - 2 * HOUR,
      adBubbleOk: 1, adPulseSeq: 10
    });
    add('第一次催加后', {
      round: 2, iceSentAt: NOW - 3 * HOUR, adSentAt: NOW - 2 * HOUR, adBubbleOk: 1,
      kickCount: 1, kickSentAt: NOW - 1 * HOUR, kickPulseSeq: 20
    });
    // 同拍重入：上一动作与当前脉冲序号相同，必须只等不重发。
    add('第一次催加·同一拍', {
      round: 2, iceSentAt: NOW - 3 * HOUR, adSentAt: NOW - 2 * HOUR, adBubbleOk: 1,
      kickCount: 1, kickSentAt: NOW - 1 * MIN, kickPulseSeq: 30
    });
    // 旧台账只有 adSentAt、没有 adBubbleOk（升级前写的行）。
    add('广告已发·无气泡证据', {
      round: 2, iceSentAt: NOW - 3 * HOUR, adSentAt: NOW - 2 * HOUR
    });
    add('两次催加后', {
      round: 3, iceSentAt: NOW - 3 * HOUR, adSentAt: NOW - 2 * HOUR, adBubbleOk: 1,
      kickCount: 2, kickSentAt: NOW - 1 * HOUR, finalKickSentAt: NOW - 30 * MIN,
      chatClosedAt: NOW - 30 * MIN
    });
  }
  add('已婉拒', {
    round: 3, iceSentAt: NOW - 3 * HOUR, rejectSentAt: NOW - 2 * HOUR,
    chatClosedAt: NOW - 2 * HOUR, done: true
  });
  add('已拉黑', { round: 1, iceSentAt: NOW - 3 * HOUR, blockedAt: NOW - 2 * HOUR });
  return out;
}

const REPLY_SETS = [
  { name: '无回复', texts: [] },
  { name: '回复·年龄合格', texts: ['30です'] },
  { name: '回复·年龄不合格', texts: ['20です'] },
  { name: '回复·无年龄', texts: ['はじめまして'] }
];

function pickAge(texts) {
  for (const t of texts) {
    const m = String(t).match(/(\d{2})/);
    if (m) return Number(m[1]);
  }
  return null;
}

function normalise(r) {
  return {
    action: r.action,
    route: r.route,
    reason: r.reason
  };
}

describe('规则镜像与运行时状态机全状态对拍', () => {
  const cases = [];
  for (const twoSeg of [false, true]) {
    for (const { name, entry } of makeEntries(twoSeg)) {
      for (const reply of REPLY_SETS) {
        for (const reopened of [false, true]) {
          for (const pulseSeq of [0, 30]) {
            cases.push({ name, entry, twoSeg, reply, reopened, pulseSeq });
          }
        }
      }
    }
  }

  it('覆盖的排列足够多', () => {
    assert.ok(cases.length >= 260, '矩阵规模太小: ' + cases.length);
  });

  it('每一项 action / route / reason 完全一致', () => {
    const mismatches = [];
    for (const c of cases) {
      const age = pickAge(c.reply.texts);
      const st = State.normalizeEntry(c.entry, { twoSeg: c.twoSeg });
      const runtime = State.planAction(st, c.reply.texts, {
        now: NOW,
        age: age,
        ageRejectBelow: 25,
        twoSeg: c.twoSeg,
        adMinWaitMs: HOUR,
        kickGapMs: 0,
        finalKickGapMs: 0,
        pulseSeq: c.pulseSeq,
        reopened: c.reopened
      });
      const mirror = Decision.decideInboxAction({
        entry: c.entry,
        peerTexts: c.reply.texts,
        age: age,
        now: NOW,
        opts: {
          twoSeg: c.twoSeg,
          ageRejectBelow: 25,
          adMinWaitMs: HOUR,
          kickGapMs: 0,
          finalKickGapMs: 0,
          pulseSeq: c.pulseSeq,
          reopened: c.reopened
        }
      });
      const a = normalise(runtime);
      const b = normalise(mirror);
      if (a.action !== b.action || a.route !== b.route || a.reason !== b.reason) {
        mismatches.push({
          case: c.name + ' / ' + (c.twoSeg ? '两段式' : '非两段式') + ' / ' + c.reply.name
            + ' / reopened=' + c.reopened + ' / seq=' + c.pulseSeq,
          runtime: a,
          mirror: b
        });
      }
    }
    assert.deepEqual(mismatches.slice(0, 8), [], '镜像与运行时不一致 ' + mismatches.length + ' 处');
  });
});

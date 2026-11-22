'use strict';
/**
 * 两段式 → 非两段式切换：旧的“广告即收口”不能把会话永久判死。
 * 现象：对方回了年龄，系统却一直 stage_closed，永远不催加。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(parts) {
  const src = fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
  const window = {};
  const sandbox = { window, console, Math, Number, parseInt, isFinite, Date };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return window;
}

const State = load(['chat', 'inbox-state.js']).SgInboxState;
const NOW = 1794300000000;

describe('模式切换后的收口语义', () => {
  const twoSegClosed = {
    iceSentAt: NOW - 6 * 3600 * 1000,
    adSentAt: NOW - 5 * 3600 * 1000,
    adBubbleOk: 1,
    twoSegAdDoneAt: NOW - 5 * 3600 * 1000,
    chatClosedAt: NOW - 5 * 3600 * 1000,
    round: 3,
    done: 1,
  };

  it('两段式下：广告后就是已收口', () => {
    const st = State.normalizeEntry(twoSegClosed, { twoSeg: true });
    assert.equal(st.stage, 'closed');
    assert.equal(st.closed, true);
  });

  it('非两段式下：只由两段式广告产生的收口失效，回到第一次催加', () => {
    const st = State.normalizeEntry(twoSegClosed, { twoSeg: false });
    assert.equal(st.stage, 'kick1');
    assert.equal(st.closed, false);
    assert.equal(st.kickCount, 0);
  });

  it('非两段式下仍尊重硬收口：婉拒 / 拉黑 / 终催', () => {
    assert.equal(State.normalizeEntry({ ...twoSegClosed, rejectSentAt: NOW }, { twoSeg: false }).closed, true);
    assert.equal(State.normalizeEntry({ ...twoSegClosed, blockedAt: NOW }, { twoSeg: false }).closed, true);
    assert.equal(State.normalizeEntry({ ...twoSegClosed, finalKickSentAt: NOW }, { twoSeg: false }).closed, true);
  });

  it('非两段式：广告后对方回年龄 → 直接发催加，而不是 stage_closed', () => {
    const st = State.normalizeEntry(twoSegClosed, { twoSeg: false });
    const plan = State.planAction(st, ['40です'], {
      now: NOW, age: 40, ageRejectBelow: 25, pulseSeq: NOW,
    });
    assert.equal(plan.action, 'send');
    assert.equal(plan.route, 'kick');
  });

  it('非两段式：第一次催加发完后，下一轮才允许终催', () => {
    const st = State.normalizeEntry({
      ...twoSegClosed,
      kickCount: 1,
      kickSentAt: NOW - 1000,
      kickPulseSeq: NOW - 1000,
      lastInboundAt: NOW - 500,
      chatClosedAt: 0,
      twoSegAdDoneAt: 0,
    }, { twoSeg: false });
    assert.equal(st.stage, 'kick2');
    const sameRound = State.planAction(st, [], { now: NOW, pulseSeq: NOW - 1000, age: 40, kickGapMs: 0 });
    assert.equal(sameRound.action, 'wait');
    assert.equal(sameRound.reason, 'kick_wait');
    // 这一条只验证“轮次闸”：把时间闸设为 0，避免和 4.9.50 的 60 秒下限混在一起。
    const nextRound = State.planAction(st, [], { now: NOW, pulseSeq: NOW + 60000, age: 40, kickGapMs: 0 });
    assert.equal(nextRound.action, 'send');
    assert.equal(nextRound.route, 'kick');
  });
});

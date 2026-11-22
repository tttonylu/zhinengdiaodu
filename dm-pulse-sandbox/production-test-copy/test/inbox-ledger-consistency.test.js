'use strict';
/**
 * 台账一致性契约：发送后写入的 round/done/chatClosedAt 必须能被状态机原样推导回来。
 * 否则会出现“台账说还在跑、状态机说已完结”或反向的永久循环。
 * 运行：node --test --test-force-exit test/inbox-ledger-consistency.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadState() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'chat', 'inbox-state.js'), 'utf8');
  const window = {};
  const sandbox = { window, console, Math, Number, parseInt, isFinite, Date };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return window.SgInboxState;
}

const State = loadState();
const NOW = 1700000000000;

function apply(entry, route, twoSeg) {
  const before = State.normalizeEntry(entry, { twoSeg });
  const patch = State.afterSend(before, route, NOW);
  return Object.assign({}, entry, patch);
}

function assertConsistent(entry, twoSeg, label) {
  const st = State.normalizeEntry(entry, { twoSeg });
  assert.equal(Number(entry.round) || 0, st.round, label + '：round 与状态机推导不一致');
  assert.equal(!!entry.done, st.closed, label + '：done 与 stage 不一致');
}

describe('台账写入与状态机推导一致', () => {
  it('两段式：破冰 → 广告 → 完结', () => {
    let e = { round: 0, firstSeen: NOW };
    e = apply(e, 'ice', true);
    assertConsistent(e, true, '破冰后');
    assert.equal(!!e.iceSentAt, true);
    assert.equal(State.normalizeEntry(e, { twoSeg: true }).closed, false);

    e = apply(e, 'ad', true);
    assertConsistent(e, true, '两段式广告后');
    assert.equal(State.normalizeEntry(e, { twoSeg: true }).closed, true);
    assert.ok(e.chatClosedAt > 0, '两段式广告后必须写 chatClosedAt');
    assert.ok(e.twoSegAdDoneAt > 0, '两段式广告后必须写 twoSegAdDoneAt');
  });

  it('非两段式：破冰 → 广告 → 催加 → 终催完结', () => {
    let e = { round: 0, firstSeen: NOW };
    e = apply(e, 'ice', false);
    e = apply(e, 'ad', false);
    assertConsistent(e, false, '广告后');
    const afterAd = State.normalizeEntry(e, { twoSeg: false });
    assert.equal(afterAd.closed, false);
    assert.equal(afterAd.kickCount, 0);

    e = apply(e, 'kick', false);
    assertConsistent(e, false, '第一次催加后');
    const afterKick1 = State.normalizeEntry(e, { twoSeg: false });
    assert.equal(afterKick1.closed, false);
    assert.equal(afterKick1.kickCount, 1);
    assert.ok(!e.chatClosedAt, '第一次催加不应完结');

    e = apply(e, 'kick', false);
    assertConsistent(e, false, '第二次催加后');
    assert.equal(State.normalizeEntry(e, { twoSeg: false }).closed, true);
    assert.ok(e.chatClosedAt > 0);
    assert.ok(e.finalKickSentAt > 0);
  });

  it('婉拒后立即完结，不进入催加', () => {
    let e = { round: 0, firstSeen: NOW, iceSentAt: NOW - 1000 };
    e = apply(e, 'reject', true);
    assertConsistent(e, true, '婉拒后');
    assert.equal(State.normalizeEntry(e, { twoSeg: true }).closed, true);
    assert.ok(e.rejectSentAt > 0);
    assert.ok(e.chatClosedAt > 0);
  });

  it('重复发送不会把已完结台账退回未完结', () => {
    let e = { round: 0, firstSeen: NOW };
    e = apply(e, 'ice', true);
    e = apply(e, 'ad', true);
    const closedRound = e.round;
    e = apply(e, 'ice', true);
    assertConsistent(e, true, '完结后误发破冰');
    assert.ok(e.round >= closedRound, '完结后 round 不能回退');
  });
});

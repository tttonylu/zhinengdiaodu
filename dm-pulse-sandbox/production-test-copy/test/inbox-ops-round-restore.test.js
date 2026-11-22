'use strict';
/**
 * OPS 轮次恢复契约：
 * OPS 轮次 1=破冰 2=广告 3=首次催加 4=终催。
 * 恢复时必须同时补齐 iceSentAt / adSentAt / kickCount / finalKickSentAt，
 * 否则状态机会把已完成的人重新推导成“广告未发”，再次补发广告。
 * 运行：node --test --test-force-exit test/inbox-ops-round-restore.test.js
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeStorage() {
  const map = new Map();
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    clear() { map.clear(); }
  };
}

function loadTargetDb(storage, session) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'chat', 'target-db.js'), 'utf8');
  const window = {};
  const sandbox = {
    window,
    console,
    Math,
    Number,
    parseInt,
    isFinite,
    Date,
    Set,
    JSON,
    localStorage: storage,
    sessionStorage: session
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return window.SgTargetDb;
}

function loadState() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'chat', 'inbox-state.js'), 'utf8');
  const window = {};
  const sandbox = { window, console, Math, Number, parseInt, isFinite, Date, JSON };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return window.SgInboxState;
}

const State = loadState();

function seed(db, handle, entry) {
  const root = {};
  root.jakelu133969 = {};
  root.jakelu133969[handle] = Object.assign({ firstSeen: 1 }, entry);
  db.setItem('chat_target_db', JSON.stringify(root));
}

function read(db, handle) {
  const root = JSON.parse(db.getItem('chat_target_db'));
  return root.jakelu133969[handle];
}

function setup() {
  const db = makeStorage();
  const session = makeStorage();
  session.setItem('dan_target_username', 'jakelu133969');
  return { db, session, Target: loadTargetDb(db, session) };
}

describe('OPS 轮次恢复', () => {
  it('OPS=1 只补破冰，不补广告', () => {
    const { db, Target } = setup();
    seed(db, 'alice', { round: 0 });
    Target.applyOpsMaxRound('alice', 1);
    const e = read(db, 'alice');
    assert.ok(e.iceSentAt > 0, 'OPS=1 必须补 iceSentAt');
    assert.equal(Number(e.round), 1);
    assert.ok(!e.adSentAt, 'OPS=1 不能补广告标志');
    const st = State.normalizeEntry(e, { twoSeg: false });
    assert.equal(st.round, 1);
    assert.equal(st.stage, 'ad');
  });

  it('OPS=2 补广告，但不算催加', () => {
    const { db, Target } = setup();
    seed(db, 'bob', { round: 0 });
    Target.applyOpsMaxRound('bob', 2);
    const e = read(db, 'bob');
    assert.ok(e.iceSentAt > 0);
    assert.ok(e.adSentAt > 0);
    assert.equal(Number(e.adBubbleOk), 1);
    assert.equal(Number(e.round), 2);
    assert.equal(Number(e.kickCount) || 0, 0);
    assert.ok(!e.chatClosedAt);
    const st = State.normalizeEntry(e, { twoSeg: false });
    assert.equal(st.closed, false);
    assert.equal(st.kickCount, 0);
  });

  it('OPS=3 只补首次催加，仍可继续终催', () => {
    const { db, Target } = setup();
    seed(db, 'carol', { round: 0 });
    Target.applyOpsMaxRound('carol', 3);
    const e = read(db, 'carol');
    assert.ok(e.iceSentAt > 0);
    assert.ok(e.adSentAt > 0);
    assert.equal(Number(e.kickCount), 1);
    assert.ok(e.kickSentAt > 0);
    assert.ok(!e.finalKickSentAt);
    assert.ok(!e.chatClosedAt, 'OPS=3 不能完结');
    const st = State.normalizeEntry(e, { twoSeg: false });
    assert.equal(st.closed, false);
    assert.equal(st.kickCount, 1);
  });

  it('OPS=4 直接完结，状态机不得再补发广告', () => {
    const { db, Target } = setup();
    seed(db, 'dave', { round: 0 });
    Target.applyOpsMaxRound('dave', 4);
    const e = read(db, 'dave');
    assert.equal(Number(e.kickCount), 2);
    assert.ok(e.finalKickSentAt > 0);
    assert.ok(e.chatClosedAt > 0);
    assert.equal(e.done, true);
    assert.equal(Number(e.round), 3);
    const st = State.normalizeEntry(e, { twoSeg: false });
    assert.equal(st.closed, true, 'OPS=4 恢复后必须已完结');
    assert.equal(st.kickCount, 2);
    assert.notEqual(st.stage, 'ad', 'OPS=4 不得被重新推导成广告阶段');
    const act = State.planAction(e, { twoSeg: false, now: Date.now(), ageRejectBelow: 25 });
    assert.equal(act.action, 'skip', '已完结台账不得再产生发送动作');
  });

  it('本地轮次更高时不回退', () => {
    const { db, Target } = setup();
    seed(db, 'erin', {
      round: 3,
      iceSentAt: 10,
      adSentAt: 20,
      adBubbleOk: 1,
      kickCount: 2,
      kickSentAt: 30,
      finalKickSentAt: 40,
      chatClosedAt: 40,
      done: true
    });
    Target.applyOpsMaxRound('erin', 2);
    const e = read(db, 'erin');
    assert.equal(Number(e.kickCount), 2);
    assert.equal(Number(e.round), 3);
    assert.ok(e.chatClosedAt > 0);
  });

  it('台账里没有这个人时不得凭空建债', () => {
    const { db, Target } = setup();
    seed(db, 'frank', { round: 0 });
    Target.applyOpsMaxRound('ghost', 4);
    const root = JSON.parse(db.getItem('chat_target_db'));
    assert.ok(!root.jakelu133969.ghost, 'OPS 轮次不能新建本地台账');
  });
});

describe('本地台账 → OPS 补账选择', () => {
  it('本地终催、OPS 只到 3 → 选 round=4', () => {
    const db = {
      a: { iceSentAt: 1, adSentAt: 2, kickSentAt: 3, finalKickSentAt: 4, kickCount: 2, done: true }
    };
    const rows = State.pendingOpsReconcile(db, { a: 3 }, { limit: 5 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].round, 4);
    assert.equal(rows[0].ops_round, 3);
  });

  it('本地与 OPS 已一致时不重复补', () => {
    const db = {
      a: { iceSentAt: 1, adSentAt: 2, kickSentAt: 3, kickCount: 1 }
    };
    assert.equal(State.pendingOpsReconcile(db, { a: 3 }, { limit: 5 }).length, 0);
  });

  it('已补记成功过的不再重复', () => {
    const db = {
      a: { iceSentAt: 1, adSentAt: 2, finalKickSentAt: 4, kickCount: 2, opsReconciledRound: 4 }
    };
    assert.equal(State.pendingOpsReconcile(db, { a: 2 }, { limit: 5 }).length, 0);
  });

  it('没有发送证据的台账不补', () => {
    const db = { a: { round: 0, firstSeen: 1 } };
    assert.equal(State.pendingOpsReconcile(db, {}, { limit: 5 }).length, 0);
  });

  it('按轮次从高到低排序，终催先补', () => {
    const db = {
      a: { iceSentAt: 1 },
      b: { iceSentAt: 1, adSentAt: 2, finalKickSentAt: 3, kickCount: 2 },
      c: { iceSentAt: 1, adSentAt: 2, kickSentAt: 3, kickCount: 1 }
    };
    const rows = State.pendingOpsReconcile(db, {}, { limit: 3 });
    assert.equal(Array.from(rows, r => r.round).join(','), '4,3,1');
  });

  it('补记失败已隔离的台账不再排队', () => {
    const db = {
      a: {
        iceSentAt: 1,
        adSentAt: 2,
        finalKickSentAt: 4,
        kickCount: 2,
        opsReconcileAttempts: 5,
        opsReconcileGiveUpAt: 100,
        opsReconcileGiveUpReason: 'round_gap'
      }
    };
    assert.equal(State.pendingOpsReconcile(db, { a: 2 }, { limit: 5 }).length, 0);
  });

  it('补记失败次数会带回结果，便于上报 gave_up', () => {
    const db = {
      a: {
        iceSentAt: 1,
        adSentAt: 2,
        finalKickSentAt: 4,
        kickCount: 2,
        opsReconcileAttempts: 4
      }
    };
    const rows = State.pendingOpsReconcile(db, { a: 2 }, { limit: 5 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].attempts, 4);
  });
});

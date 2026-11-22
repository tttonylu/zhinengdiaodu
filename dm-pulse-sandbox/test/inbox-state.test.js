'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const modulePath = path.join(
  __dirname,
  '..',
  'production-test-copy',
  'chat',
  'inbox-state.js'
);

let sm;

before(() => {
  global.window = {};
  require(modulePath);
  sm = global.window.SgInboxState;
});

const NOW = 1800000000000;
const HOUR = 3600000;

describe('阶段推导：台账是唯一真相', () => {
  it('没有破冰记录 → ice / round 0', () => {
    const s = sm.normalizeEntry({}, { twoSeg: false });
    assert.equal(s.stage, 'ice');
    assert.equal(s.round, 0);
    assert.equal(s.closed, false);
  });

  it('破冰后未发广告 → ad / round 1', () => {
    const s = sm.normalizeEntry({ iceSentAt: NOW - HOUR }, { twoSeg: false });
    assert.equal(s.stage, 'ad');
    assert.equal(s.round, 1);
  });

  it('广告已发、未催加 → kick1', () => {
    const s = sm.normalizeEntry({ iceSentAt: NOW - 9 * HOUR, adSentAt: NOW - 5 * HOUR }, { twoSeg: false });
    assert.equal(s.stage, 'kick1');
    assert.equal(s.round, 2);
  });

  it('催加过一次 → kick2', () => {
    const s = sm.normalizeEntry({
      iceSentAt: NOW - 9 * HOUR, adSentAt: NOW - 5 * HOUR, kickCount: 1
    }, { twoSeg: false });
    assert.equal(s.stage, 'kick2');
  });

  it('催加满两次 → closed', () => {
    const s = sm.normalizeEntry({
      iceSentAt: NOW - 9 * HOUR, adSentAt: NOW - 5 * HOUR, kickCount: 2
    }, { twoSeg: false });
    assert.equal(s.stage, 'closed');
    assert.equal(s.round, 3);
  });

  it('两段式广告已发 → closed（不再催加）', () => {
    const s = sm.normalizeEntry({ iceSentAt: NOW - 9 * HOUR, adSentAt: NOW - HOUR }, { twoSeg: true });
    assert.equal(s.stage, 'closed');
  });

  it('婉拒 / 拉黑 → closed', () => {
    assert.equal(sm.normalizeEntry({ rejectSentAt: NOW }, {}).stage, 'closed');
    assert.equal(sm.normalizeEntry({ blockedAt: NOW }, {}).stage, 'closed');
  });

  it('旧 done 标记不再单独决定阶段', () => {
    const s = sm.normalizeEntry({ done: true, iceSentAt: NOW - HOUR }, { twoSeg: false });
    assert.equal(s.stage, 'ad');
    assert.equal(s.closed, false);
  });
});

describe('动作决策', () => {
  const ice = sm.normalizeEntry({}, { twoSeg: false });
  const ad = sm.normalizeEntry({ iceSentAt: NOW - 3 * HOUR }, { twoSeg: false });
  const kick = sm.normalizeEntry({ iceSentAt: NOW - 9 * HOUR, adSentAt: NOW - 5 * HOUR }, { twoSeg: false });
  const closed = sm.normalizeEntry({ rejectSentAt: NOW }, { twoSeg: false });

  it('未破冰 + 对方先来信 → 直接发广告', () => {
    const p = sm.planAction(ice, ['はじめまして'], { now: NOW });
    assert.equal(p.action, 'send');
    assert.equal(p.route, 'ad');
  });

  it('未破冰 + 空会话 → 破冰', () => {
    const p = sm.planAction(ice, [], { now: NOW });
    assert.equal(p.route, 'ice');
    assert.equal(p.round, 0);
  });

  it('待发广告 + 对方回复 → 发广告', () => {
    const p = sm.planAction(ad, ['40です'], { now: NOW });
    assert.equal(p.route, 'ad');
  });

  it('待发广告 + 年龄不足 → 婉拒', () => {
    const p = sm.planAction(ad, ['19'], { now: NOW, age: 19, ageRejectBelow: 25 });
    assert.equal(p.route, 'reject');
  });

  it('待发广告 + 无回复 + 两段式等待满 → 发广告', () => {
    const s = sm.normalizeEntry({ iceSentAt: NOW - 3 * HOUR }, { twoSeg: true });
    const p = sm.planAction(s, [], { now: NOW, adMinWaitMs: HOUR });
    assert.equal(p.route, 'ad');
  });

  it('待发广告 + 无回复 + 等待未满 → 等', () => {
    const p = sm.planAction(ad, [], { now: NOW, adMinWaitMs: 6 * HOUR });
    assert.equal(p.action, 'wait');
  });

  it('催加阶段 → 发催加', () => {
    const p = sm.planAction(kick, [], { now: NOW });
    assert.equal(p.route, 'kick');
  });

  it('已完结 → 跳过', () => {
    assert.equal(sm.planAction(closed, [], { now: NOW }).action, 'skip');
  });
});

describe('发送后台账推进', () => {
  it('破冰成功 → round 1', () => {
    const patch = sm.afterSend(sm.normalizeEntry({}, { twoSeg: false }), 'ice', NOW);
    assert.equal(patch.iceSentAt, NOW);
    assert.equal(patch.round, 1);
    assert.equal(patch.done, false);
  });

  it('经典模式广告成功 → round 2', () => {
    const patch = sm.afterSend(sm.normalizeEntry({ iceSentAt: NOW - HOUR }, { twoSeg: false }), 'ad', NOW);
    assert.equal(patch.adSentAt, NOW);
    assert.equal(patch.round, 2);
    assert.equal(patch.done, false);
  });

  it('两段式广告成功 → round 3 + done', () => {
    const patch = sm.afterSend(sm.normalizeEntry({ iceSentAt: NOW - HOUR }, { twoSeg: true }), 'ad', NOW);
    assert.equal(patch.round, 3);
    assert.equal(patch.done, true);
  });

  it('第一次催加 → kickCount 1，仍开放', () => {
    const base = sm.normalizeEntry({ iceSentAt: NOW - 9 * HOUR, adSentAt: NOW - 5 * HOUR }, { twoSeg: false });
    const patch = sm.afterSend(base, 'kick', NOW);
    assert.equal(patch.kickCount, 1);
    assert.equal(patch.done, false);
    assert.equal(patch.round, 2);
  });

  it('第二次催加 → 完结 round 3', () => {
    const base = sm.normalizeEntry({ iceSentAt: NOW - 9 * HOUR, adSentAt: NOW - 5 * HOUR, kickCount: 1 }, { twoSeg: false });
    const patch = sm.afterSend(base, 'kick', NOW);
    assert.equal(patch.kickCount, 2);
    assert.equal(patch.done, true);
    assert.equal(patch.round, 3);
  });
});

/**
 * A2 · 满额窗外空闲降频（4.6.172）
 * 运行：node unified-scheduler/test/idle-park-gate.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Gate = require(path.join(__dirname, '..', 'scheduler', 'idle-park-gate.js'));

describe('SgIdleParkGate', () => {
  it('关注未满 → 不降频', () => {
    const r = Gate.evaluate({ followedToday: 10, followLimit: 80 });
    assert.equal(r.park, false);
    assert.equal(r.reason, 'under_quota');
  });

  it('关注已满且无引擎 → 深度 park', () => {
    const r = Gate.evaluate({ followedToday: 83, followLimit: 83 });
    assert.equal(r.park, true);
    assert.equal(r.deep, true);
    assert.equal(r.reason, 'follow_quota_full_idle');
  });

  it('有紧急私信债 → 不 park', () => {
    const r = Gate.evaluate({ followedToday: 100, followLimit: 80, chatDebtUrgent: true });
    assert.equal(r.park, false);
    assert.equal(r.reason, 'chat_debt_urgent');
  });

  it('软风控中满额不降频', () => {
    const r = Gate.evaluate({ followedToday: 100, followLimit: 80, softRiskActive: true });
    assert.equal(r.park, false);
    assert.equal(r.reason, 'soft_risk');
  });

  it('chat 在跑不降频', () => {
    const r = Gate.evaluate({ followedToday: 100, followLimit: 80, chatRunning: true });
    assert.equal(r.park, false);
    assert.equal(r.reason, 'chat_busy');
  });

  it('follow 在跑不降频', () => {
    const r = Gate.evaluate({ followedToday: 100, followLimit: 80, followRunning: true });
    assert.equal(r.park, false);
    assert.equal(r.reason, 'follow_busy');
  });

  it('无有效限额 → 不降频', () => {
    const r = Gate.evaluate({ followedToday: 99, followLimit: 0 });
    assert.equal(r.park, false);
    assert.equal(r.reason, 'no_limit');
  });

  it('满额但夜场/手动转帖到期 → 不 park（4.6.179）', () => {
    const r = Gate.evaluate({ followedToday: 100, followLimit: 80, repostDue: true });
    assert.equal(r.park, false);
    assert.equal(r.deep, false);
    assert.equal(r.reason, 'repost_due');
  });

  it('满额且转帖未到期 → 仍深度 park', () => {
    const r = Gate.evaluate({ followedToday: 100, followLimit: 80, repostDue: false });
    assert.equal(r.park, true);
    assert.equal(r.deep, true);
    assert.equal(r.reason, 'follow_quota_full_idle');
  });
});

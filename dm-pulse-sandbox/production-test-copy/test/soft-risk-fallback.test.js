'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const TimeUtil = require(path.join(__dirname, '..', 'shared', 'time-util.js'));
const { softRiskChatBlockedDecision } = require(path.join(__dirname, '..', 'scheduler', 'soft-risk-fallback-decision.js'));

describe('TimeUtil 24h / h23', () => {
  it('inRangeMinutes: afternoon 13:36 inside 07:00-23:00', () => {
    const t = 13 * 60 + 36;
    assert.equal(TimeUtil.inRangeMinutes(t, 7, 0, 23, 0), true);
  });

  it('inRangeMinutes: hour=1 (false 12h parse) outside 07:00-23:00', () => {
    const t = 1 * 60 + 36;
    assert.equal(TimeUtil.inRangeMinutes(t, 7, 0, 23, 0), false);
  });

  it('inRangeMinutes: overnight 06:00-02:00 includes 13:36', () => {
    const t = 13 * 60 + 36;
    assert.equal(TimeUtil.inRangeMinutes(t, 6, 0, 2, 0), true);
  });

  it('shanghaiParts returns hour 0-23', () => {
    const p = TimeUtil.shanghaiParts();
    assert.ok(p);
    assert.ok(p.h >= 0 && p.h <= 23);
    assert.ok(p.m >= 0 && p.m <= 59);
    assert.equal(p.minutes, p.h * 60 + p.m);
  });

  it('nowLabel is HH:MM 24h padded', () => {
    const lbl = TimeUtil.nowLabel();
    assert.match(lbl, /^\d{2}:\d{2}$/);
  });
});

describe('softRiskChatBlockedDecision', () => {
  it('inactive → null', () => {
    assert.equal(softRiskChatBlockedDecision({ softRiskActive: false, phase: 'chat1' }), null);
  });

  it('chat 相位挂起 → nurture', () => {
    assert.equal(softRiskChatBlockedDecision({ softRiskActive: true, phase: 'chat1' }), 'nurture');
  });

  it('任意相位挂起 → nurture（4.6.78 单段一轮）', () => {
    assert.equal(softRiskChatBlockedDecision({ softRiskActive: true, phase: 'chat2' }), 'nurture');
  });
});

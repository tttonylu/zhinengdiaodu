/**
 * A2 · 养号日预算闸（4.9.136）
 * 运行：node unified-scheduler/test/nurture-quota-gate.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Gate = require(path.join(__dirname, '..', 'scheduler', 'nurture-quota-gate.js'));

describe('SgNurtureQuotaGate', () => {
  it('关注未满 → 放行', () => {
    const r = Gate.evaluate({ followedToday: 10, followLimit: 80 });
    assert.equal(r.allow, true);
    assert.equal(r.reason, 'under_quota');
  });

  it('关注已满但养号预算未耗尽 → 放行兜底', () => {
    const r = Gate.evaluate({ followedToday: 83, followLimit: 83 });
    assert.equal(r.allow, true);
    assert.equal(r.reason, 'follow_quota_full_nurture_ok');
  });

  it('养号日预算耗尽 → 拦截', () => {
    const r = Gate.evaluate({ followedToday: 83, followLimit: 83, nurtureDailyExhausted: true });
    assert.equal(r.allow, false);
    assert.equal(r.reason, 'nurture_daily_exhausted');
  });

  it('软风控中预算耗尽仍放行', () => {
    const r = Gate.evaluate({
      followedToday: 100, followLimit: 80, softRiskActive: true, nurtureDailyExhausted: true
    });
    assert.equal(r.allow, true);
    assert.equal(r.reason, 'soft_risk');
  });

  it('模块关闭 → 拦截', () => {
    const r = Gate.evaluate({ followedToday: 0, followLimit: 80, moduleOn: false });
    assert.equal(r.allow, false);
  });

  it('无有效限额 → 放行', () => {
    const r = Gate.evaluate({ followedToday: 99, followLimit: 0 });
    assert.equal(r.allow, true);
    assert.equal(r.reason, 'no_limit');
  });
});

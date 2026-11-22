/**
 * A2 · 私信时间片错峰（4.6.163）
 * 运行：node unified-scheduler/test/chat-stagger.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const SgChatStagger = require(path.join(__dirname, '..', 'scheduler', 'chat-stagger.js'));

describe('SgChatStagger', () => {
  it('slots≤1 关闭错峰', () => {
    const r = SgChatStagger.evaluate({
      handle: 'alice',
      thresholds: { chat_stagger_slots: '1' },
      shanghaiMinutes: 600
    });
    assert.equal(r.allow, true);
    assert.equal(r.reason, 'stagger_off');
  });

  it('已在跑 / 软风控 / force 旁路', () => {
    assert.equal(SgChatStagger.evaluate({ alreadyRunning: true }).reason, 'already_running');
    assert.equal(SgChatStagger.evaluate({ softRiskActive: true }).reason, 'soft_risk_bypass');
    assert.equal(SgChatStagger.evaluate({ force: true }).reason, 'force');
  });

  it('同 handle 槽位稳定', () => {
    const a = SgChatStagger.hashHandle('@Bob#guard');
    const b = SgChatStagger.hashHandle('bob');
    assert.equal(a, b);
  });

  it('slots=2 时约一半时刻放行', () => {
    const handle = 'matrix_test_user';
    const my = SgChatStagger.hashHandle(handle) % 2;
    const thr = { chat_stagger_slots: 2, chat_stagger_slot_min: 30 };
    const on = SgChatStagger.evaluate({
      handle: handle,
      thresholds: thr,
      shanghaiMinutes: my * 30
    });
    const off = SgChatStagger.evaluate({
      handle: handle,
      thresholds: thr,
      shanghaiMinutes: ((my + 1) % 2) * 30
    });
    assert.equal(on.allow, true);
    assert.equal(on.reason, 'slot_match');
    assert.equal(off.allow, false);
    assert.equal(off.reason, 'chat_stagger_wait');
  });

  it('不同 handle 可分到不同槽', () => {
    const thr = { chat_stagger_slots: 2, chat_stagger_slot_min: 30 };
    let saw0 = false;
    let saw1 = false;
    for (var i = 0; i < 40; i++) {
      var h = 'acct_' + i;
      var slot = SgChatStagger.hashHandle(h) % 2;
      if (slot === 0) saw0 = true;
      if (slot === 1) saw1 = true;
    }
    assert.equal(saw0 && saw1, true, '40 个号应覆盖两槽');
  });
});

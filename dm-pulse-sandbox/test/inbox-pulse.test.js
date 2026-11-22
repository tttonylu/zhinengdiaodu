'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const modulePath = path.join(
  __dirname,
  '..',
  'production-test-copy',
  'chat',
  'inbox-pulse.js'
);

let pulse;

before(() => {
  global.window = {};
  require(modulePath);
  pulse = global.window.SgInboxPulse;
});

const NOW = 1800000000000;

describe('守箱脉冲状态', () => {
  it('空状态给出安全默认值', () => {
    const st = pulse.normalizeState(null, NOW);
    assert.equal(st.running, false);
    assert.equal(st.phase, 'scan');
    assert.equal(st.intervalMs, 60000);
    assert.equal(st.nextPulseAt, 0);
    assert.equal(st.stats.pulses, 0);
  });

  it('脉冲间隔有下限，避免空转', () => {
    const st = pulse.normalizeState({ intervalMs: 1000 }, NOW);
    assert.equal(st.intervalMs, 20000);
  });

  it('完成脉冲后排下一次时间', () => {
    const st = pulse.normalizeState({ intervalMs: 60000 }, NOW);
    const next = pulse.finishPulse(st, { ok: true, sent: true, opened: true }, NOW);
    assert.equal(next.busy, false);
    assert.equal(next.phase, 'scan');
    assert.equal(next.nextPulseAt, NOW + 60000);
    assert.equal(next.stats.pulses, 1);
    assert.equal(next.stats.sent, 1);
    assert.equal(next.stats.opened, 1);
  });

  it('未到时间不触发，到时间才触发', () => {
    const st = pulse.normalizeState({ running: true, intervalMs: 60000, nextPulseAt: NOW + 1000 }, NOW);
    assert.equal(pulse.isDue(st, NOW), false);
    assert.equal(pulse.isDue(st, NOW + 1000), true);
  });

  it('剩余等待时间不为负', () => {
    const st = pulse.normalizeState({ nextPulseAt: NOW - 5000 }, NOW);
    assert.equal(pulse.nextPulseIn(st, NOW), 0);
  });
});

describe('守箱脉冲选目标', () => {
  it('精确未读优先于台账任务', () => {
    const picked = pulse.selectTarget([
      { key: 'debt', unread: false, unreadPrecise: false, adDebt: true },
      { key: 'unread', unread: true, unreadPrecise: true }
    ], NOW);
    assert.equal(picked.key, 'unread');
  });

  it('对方最后发言（预览非“你:”）优先于广告债', () => {
    const picked = pulse.selectTarget([
      { key: 'debt', unread: false, peerLast: false, adDebt: true },
      { key: 'peer-last', unread: false, peerLast: true }
    ], NOW);
    assert.equal(picked.key, 'peer-last');
  });

  it('我方最后发言（预览为“你:”）不算待办', () => {
    const picked = pulse.selectTarget([
      { key: 'mine', unread: false, peerLast: false, previewFromSelf: true }
    ], NOW);
    assert.equal(picked, null);
  });

  it('冷却目标跳过，除非有新未读', () => {
    const picked = pulse.selectTarget([
      { key: 'cold', unread: false, cooldown: true, adDebt: true },
      { key: 'hot', unread: true, unreadPrecise: true, cooldown: true }
    ], NOW);
    assert.equal(picked.key, 'hot');
  });

  it('已关闭目标一律跳过', () => {
    const picked = pulse.selectTarget([
      { key: 'closed', unread: true, unreadPrecise: true, closed: true },
      { key: 'ok', unread: true, unreadPrecise: true }
    ], NOW);
    assert.equal(picked.key, 'ok');
  });

  it('没有任务返回 null', () => {
    assert.equal(pulse.selectTarget([], NOW), null);
    assert.equal(pulse.selectTarget([{ key: 'x', closed: true }], NOW), null);
  });
});

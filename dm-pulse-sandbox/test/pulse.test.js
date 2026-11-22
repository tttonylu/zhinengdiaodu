'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runReadonlyPulse } = require('../extension/src/pulse');
const {
  unreadFixture,
  readFixture,
  scrollWindowA,
  scrollWindowB,
  scrollWindowC
} = require('../fixtures/xchat-v2-samples');

const loading = { surface: 'list', listReady: false, loading: true, emptyState: false, rows: [] };
const empty = { surface: 'list', listReady: true, loading: false, emptyState: true, rows: [] };
const repeat = (sample, count) => Array.from({ length: count }, () => sample);
const sequence = (...groups) => groups.flatMap(([sample, count]) => repeat(sample, count));

describe('readonly pulse', () => {
  it('早期空读后能识别未读，并等待稳定采样', () => {
    const result = runReadonlyPulse({ samples: sequence([loading, 6], [unreadFixture, 2]) });
    assert.equal(result.verdict, 'unread_found');
    assert.equal(result.visibleRows, 9);
    assert.equal(result.unreadRows, 1);
    assert.equal(result.samples.length, 8);
  });

  it('有行无未读经过稳定窗口才确认', () => {
    const result = runReadonlyPulse({ samples: sequence([readFixture, 2]) });
    assert.equal(result.verdict, 'no_unread_confirmed');
    assert.equal(result.samples.length, 2);
  });

  it('持续加载不能报无未读或空列表', () => {
    const result = runReadonlyPulse({ samples: repeat(loading, 31) });
    assert.equal(result.verdict, 'loading_timeout');
    assert.equal(result.durationMs, 15000);
  });

  it('可信空态经过宽限期才能确认空列表', () => {
    const result = runReadonlyPulse({ samples: repeat(empty, 12) });
    assert.equal(result.verdict, 'empty_confirmed');
    assert.ok(result.durationMs >= 5500);
  });

  it('错误页面和摘要变化不提前收工', () => {
    assert.equal(runReadonlyPulse({ samples: [{ ...unreadFixture, surface: 'conversation' }] }).verdict, 'wrong_surface');
    const result = runReadonlyPulse({ samples: [unreadFixture, readFixture, readFixture] });
    assert.equal(result.verdict, 'no_unread_confirmed');
    assert.equal(result.samples.length, 3);
  });

  it('行结构退化不能伪装成无未读', () => {
    const degraded = { ...unreadFixture, rows: unreadFixture.rows.map(row => ({ ...row, inboxRow: false })) };
    const result = runReadonlyPulse({ samples: [degraded, degraded] });
    assert.equal(result.verdict, 'selector_degraded');
    assert.notEqual(result.verdict, 'no_unread_confirmed');
  });

  it('初始加载中的部分行和未就绪列表不能确认', () => {
    const partial = { ...readFixture, loading: true };
    assert.equal(runReadonlyPulse({ samples: repeat(partial, 31) }).verdict, 'loading_timeout');
    const notReady = { ...readFixture, listReady: false };
    assert.equal(runReadonlyPulse({ samples: repeat(notReady, 31) }).verdict, 'loading_timeout');
  });

  it('深扫跨虚拟列表窗口聚合唯一行与未读', () => {
    const result = runReadonlyPulse({
      mode: 'deep',
      samples: [scrollWindowA, scrollWindowB, scrollWindowC],
      now: [0, 700, 1400],
      scrollMeta: {
        scrollSteps: 2,
        bottomReached: true,
        restoredScroll: true,
        scrollAvailable: true,
        scanComplete: true
      }
    });
    assert.equal(result.verdict, 'unread_found');
    assert.equal(result.uniqueRowsSeen, 6);
    assert.equal(result.uniqueUnreadRows, 2);
    assert.equal(result.visibleRows, 3);
    assert.equal(result.unreadRows, 2);
    assert.equal(result.scrollSteps, 2);
    assert.equal(result.bottomReached, true);
    assert.equal(result.restoredScroll, true);
    assert.equal(result.scanComplete, true);
  });

  it('深扫不因前两拍稳定而提前收工', () => {
    const result = runReadonlyPulse({
      mode: 'deep',
      samples: [readFixture, readFixture, unreadFixture],
      now: [0, 700, 1400]
    });
    assert.equal(result.verdict, 'unread_found');
    assert.equal(result.uniqueRowsSeen, 9);
    assert.equal(result.uniqueUnreadRows, 1);
  });

  it('深扫无未读需要至少两个有效样本', () => {
    assert.equal(
      runReadonlyPulse({ mode: 'deep', samples: [readFixture], now: [0] }).verdict,
      'samples_exhausted'
    );
    assert.equal(
      runReadonlyPulse({ mode: 'deep', samples: [readFixture, readFixture], now: [0, 700] }).verdict,
      'no_unread_confirmed'
    );
  });

  it('深扫保留可信空态宽限与结构退化判定', () => {
    const emptyResult = runReadonlyPulse({
      mode: 'deep',
      samples: repeat(empty, 12),
      now: Array.from({ length: 12 }, (_, index) => index * 500)
    });
    assert.equal(emptyResult.verdict, 'empty_confirmed');

    const degraded = { ...unreadFixture, rows: unreadFixture.rows.map(row => ({ ...row, inboxRow: false })) };
    assert.equal(
      runReadonlyPulse({ mode: 'deep', samples: [degraded, degraded] }).verdict,
      'selector_degraded'
    );
  });

  it('深扫在页面被导航后报 wrong_surface', () => {
    const result = runReadonlyPulse({
      mode: 'deep',
      samples: [readFixture, { ...readFixture, surface: 'conversation' }],
      now: [0, 700]
    });
    assert.equal(result.verdict, 'wrong_surface');
  });
});

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildPublicReport } = require('../extension/src/report');
const { runReadonlyPulse } = require('../extension/src/pulse');
const {
  unreadFixture,
  scrollWindowA,
  scrollWindowB,
  scrollWindowC
} = require('../fixtures/xchat-v2-samples');

describe('public pulse report', () => {
  it('仅保留匿名计数和结构诊断', () => {
    const report = buildPublicReport(runReadonlyPulse({ samples: [unreadFixture, unreadFixture] }));
    const serialized = JSON.stringify(report);
    assert.equal(report.verdict, 'unread_found');
    assert.equal(report.visibleRows, 9);
    assert.doesNotMatch(serialized, /previewText|displayName|avatarUrl|dm-conversation-option-\d/);
    assert.doesNotMatch(serialized, /変態|むーみん|1921556032637345792/);
  });

  it('深扫报告保留滚动摘要且不泄露真实会话标识', () => {
    const report = buildPublicReport(runReadonlyPulse({
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
    }));
    const serialized = JSON.stringify(report);
    assert.equal(report.mode, 'deep');
    assert.equal(report.uniqueRowsSeen, 6);
    assert.equal(report.uniqueUnreadRows, 2);
    assert.equal(report.scrollSteps, 2);
    assert.equal(report.bottomReached, true);
    assert.equal(report.restoredScroll, true);
    assert.equal(report.scanComplete, true);
    assert.doesNotMatch(serialized, /dm-conversation-option-\d/);
    assert.doesNotMatch(serialized, /previewText|displayName|avatarUrl|href/);
  });
});

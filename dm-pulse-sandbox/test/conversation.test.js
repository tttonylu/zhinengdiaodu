'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyConversationSurface,
  directionOf,
  summarizeBubbles,
  buildConversationReport
} = require('../extension/src/conversation');

describe('conversation probe', () => {
  it('区分列表、会话和错误页面', () => {
    assert.equal(classifyConversationSurface('/i/chat'), 'list');
    assert.equal(classifyConversationSurface('/i/chat/123-456'), 'conversation');
    assert.equal(classifyConversationSurface('/home'), 'other');
  });

  it('按水平位置区分自己和对方气泡', () => {
    assert.equal(directionOf(400, 0, 600), 'own');
    assert.equal(directionOf(100, 0, 600), 'peer');
    assert.equal(directionOf(300, 0, 600), 'unknown');
    assert.equal(directionOf(100, 0, 0), 'unknown');
  });

  it('汇总气泡方向、文本、链接和附件', () => {
    const summary = summarizeBubbles([
      { direction: 'peer', textLength: 8, linkCount: 1, hasAttachment: false },
      { direction: 'own', textLength: 3, linkCount: 0, hasAttachment: false },
      { direction: 'peer', textLength: 0, linkCount: 0, hasAttachment: true }
    ]);
    assert.equal(summary.bubbleCount, 3);
    assert.equal(summary.peerBubbles, 2);
    assert.equal(summary.ownBubbles, 1);
    assert.equal(summary.unknownBubbles, 0);
    assert.equal(summary.textBubbles, 2);
    assert.equal(summary.linkBubbles, 1);
    assert.equal(summary.attachmentGroups, 1);
    assert.equal(summary.lastDirection, 'peer');
    assert.equal(summary.maxTextLength, 8);

    const withExtras = summarizeBubbles(
      [{ direction: 'peer', textLength: 1, linkCount: 0, hasAttachment: false }],
      { attachmentGroups: 1 }
    );
    assert.equal(withExtras.attachmentGroups, 1);
  });

  it('报告只保留统计，不返回正文、句柄或 URL', () => {
    const report = buildConversationReport({
      verdict: 'conversation_probed',
      opened: true,
      durationMs: 1200,
      bubbleCount: 2,
      peerBubbles: 2,
      ownBubbles: 0,
      textBubbles: 2,
      lastDirection: 'peer',
      maxTextLength: 18,
      hasComposer: true,
      composerHasText: false,
      messageText: '私有正文',
      handle: '@leak',
      url: 'https://x.com/i/chat/1-2',
      errors: [{ atMs: 10, reason: 'open_timeout', messageText: 'leak' }]
    });
    const serialized = JSON.stringify(report);
    assert.equal(report.verdict, 'conversation_probed');
    assert.equal(report.opened, true);
    assert.equal(report.markedRead, true);
    assert.equal(report.bubbleCount, 2);
    assert.equal(report.hasComposer, true);
    assert.equal(report.composerHasText, false);
    assert.deepEqual(report.errors, [{ atMs: 10, reason: 'open_timeout' }]);
    assert.doesNotMatch(serialized, /私有正文|@leak|messageText|handle|url|https?:/);
  });
});

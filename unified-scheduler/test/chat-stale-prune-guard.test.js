/**
 * 48h 清理契约：有入站证据的目标不能被当成「未回复」拉黑。
 * 运行：node --test --test-force-exit test/chat-stale-prune-guard.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'chat', 'content_chat.js'), 'utf8');
const catalog = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'obs', 'event-catalog.json'), 'utf8')
);

describe('pruneStaleNoReply 入站证据保护', () => {
  it('最近一次我方消息之后有入站则跳过', () => {
    const start = source.indexOf('function pruneStaleNoReply');
    assert.ok(start > 0);
    const block = source.slice(start, start + 1600);
    assert.match(block, /entry\.lastInboundAt && entry\.lastInboundAt >= lastDm/);
    assert.match(block, /entry\.replySeenAt && entry\.replySeenAt >= lastDm/);
    assert.match(block, /entry\.unreadSeenAt && entry\.unreadSeenAt >= lastDm/);
    assert.match(block, /entry\.lastNonTextInboundAt && entry\.lastNonTextInboundAt >= lastDm/);
  });

  it('没有扫描证据时只延后，不永久拉黑', () => {
    const start = source.indexOf('function pruneStaleNoReply');
    const end = source.indexOf('function pruneStaleIfNeeded', start);
    assert.ok(start > 0 && end > start);
    const block = source.slice(start, end);
    assert.match(block, /Number\(entry\.conversationScannedAt\)/);
    assert.match(block, /if \(!watchedAt \|\| watchedAt < lastDm\)/);
    assert.match(block, /staleDeferredReason = 'scan_evidence_missing'/);
    assert.match(block, /staleDeferredAt/);
    assert.doesNotMatch(block.slice(0, block.indexOf('if (now - lastDm < staleMs)')), /markPeerBlocked/);
  });

  it('清理结论上报 chat.stale_prune 且已登记事件目录', () => {
    assert.match(source, /reportChatMetric\('chat\.stale_prune'/);
    assert.ok((catalog.events || []).some((ev) => ev && ev.id === 'chat.stale_prune'));
  });
});

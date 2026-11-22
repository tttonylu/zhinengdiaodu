'use strict';
/**
 * 收口会话复活契约：有新入站证据必须真正读取，并交回既有回复判定，不能静默丢弃。
 * 草稿/预览不算对方发言；硬封（婉拒/拉黑）永不复活。
 * 运行：node --test --test-force-exit test/inbox-closed-reopen.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const decisionSrc = fs.readFileSync(
  path.join(__dirname, '..', 'chat', 'inbox-decision.js'),
  'utf8'
);
const chatSrc = fs.readFileSync(
  path.join(__dirname, '..', 'chat', 'content_chat.js'),
  'utf8'
);

function loadDecision() {
  const window = {};
  const sandbox = { window, console, Math, Number, parseInt, isFinite };
  vm.createContext(sandbox);
  vm.runInContext(decisionSrc, sandbox);
  return window.SgInboxDecision;
}

const D = loadDecision();

describe('decideClosedReopen · 收口后新来信', () => {
  const closedAt = 1700000000000;
  const baseClosed = {
    chatClosedAt: closedAt,
    lastDM: closedAt - 1000,
    round: 3,
  };

  it('未收口会话返回 not_closed', () => {
    const r = D.decideClosedReopen({ round: 1, lastDM: closedAt }, {});
    assert.equal(r.reopen, false);
    assert.equal(r.reason, 'not_closed');
  });

  it('硬封（婉拒/拉黑）永不复活', () => {
    const rejected = D.decideClosedReopen(
      Object.assign({ rejectSentAt: closedAt }, baseClosed),
      { unreadPrecise: true, lastInboundAt: closedAt + 5000 }
    );
    assert.equal(rejected.reopen, false);
    assert.equal(rejected.reason, 'hard_closed_rejected_or_blocked');

    const blocked = D.decideClosedReopen(
      Object.assign({ blockedAt: closedAt }, baseClosed),
      { lastInboundAt: closedAt + 5000 }
    );
    assert.equal(blocked.reopen, false);
    assert.equal(blocked.reason, 'hard_closed_rejected_or_blocked');
  });

  it('精确未读 → 复活（优先于时间比较）', () => {
    const r = D.decideClosedReopen(Object.assign({}, baseClosed), {
      unreadPrecise: true,
    });
    assert.equal(r.reopen, true);
    assert.equal(r.reason, 'precise_unread_after_close');
  });

  it('收口后 lastInboundAt 更新 → 复活', () => {
    const r = D.decideClosedReopen(Object.assign({}, baseClosed), {
      lastInboundAt: closedAt + 1,
    });
    assert.equal(r.reopen, true);
    assert.equal(r.reason, 'inbound_after_close');
  });

  it('收口后 replySeenAt 更新 → 复活', () => {
    const r = D.decideClosedReopen(Object.assign({}, baseClosed), {
      replySeenAt: closedAt + 1,
    });
    assert.equal(r.reopen, true);
    assert.equal(r.reason, 'reply_after_close');
  });

  it('只有预览/草稿、没有入站时间 → 不复活', () => {
    const r = D.decideClosedReopen(Object.assign({}, baseClosed), {
      hasPreview: true,
      pendingDraft: true,
      lastInboundAt: closedAt - 100,
      replySeenAt: closedAt - 100,
    });
    assert.equal(r.reopen, false);
    assert.equal(r.reason, 'closed_without_new_inbound');
  });

  it('同一批旧证据只复活一次（用 reopenedAt 去重）', () => {
    const surfacedAt = closedAt + 10000;
    const entry = Object.assign({ reopenedAt: surfacedAt }, baseClosed);
    const same = D.decideClosedReopen(entry, {
      lastInboundAt: surfacedAt,
      replySeenAt: 0,
    });
    assert.equal(same.reopen, false);
    assert.equal(same.reason, 'already_surfaced');

    const newer = D.decideClosedReopen(entry, {
      lastInboundAt: surfacedAt + 1,
      replySeenAt: 0,
    });
    assert.equal(newer.reopen, true);
    assert.equal(newer.reason, 'inbound_after_close');
  });

  it('列表最后一条明确是对方 → 收口后新来信，复活一次', () => {
    const first = D.decideClosedReopen(Object.assign({}, baseClosed), {
      peerLast: true,
    });
    assert.equal(first.reopen, true);
    assert.equal(first.reason, 'peer_last_after_close');

    const again = D.decideClosedReopen(
      Object.assign({ reopenedAt: closedAt + 1000 }, baseClosed),
      { peerLast: true }
    );
    assert.equal(again.reopen, false);
    assert.equal(again.reason, 'already_surfaced');
  });

  it('上次读过后预览又变了 → 是新来信，必须再核对一次', () => {
    const surfacedAt = closedAt + 10000;
    const entry = Object.assign({
      reopenedAt: surfacedAt,
      reopenedPreview: '何が？'
    }, baseClosed);
    const same = D.decideClosedReopen(entry, {
      peerLast: true,
      preview: '何が？',
      lastInboundAt: surfacedAt,
      replySeenAt: 0
    });
    assert.equal(same.reopen, false);
    assert.equal(same.reason, 'already_surfaced');

    const changed = D.decideClosedReopen(entry, {
      peerLast: true,
      preview: '会いましょう',
      lastInboundAt: surfacedAt,
      replySeenAt: 0
    });
    assert.equal(changed.reopen, true);
    assert.equal(changed.reason, 'peer_last_changed');
  });

  it('读到回复但判定“等下一轮才发” → 到点前报排队重试，不许记成已处理', () => {
    const now = closedAt + 20000;
    const retryAt = now + 60000;
    const entry = Object.assign({ reopenRetryAt: retryAt }, baseClosed);
    const waiting = D.decideClosedReopen(entry, {
      peerLast: true,
      lastInboundAt: closedAt + 10000,
      replySeenAt: closedAt + 10000,
      now: now,
    });
    assert.equal(waiting.reopen, false);
    assert.equal(waiting.reason, 'reopen_retry_wait');
    assert.equal(waiting.retryAt, retryAt);

    const due = D.decideClosedReopen(entry, {
      peerLast: true,
      lastInboundAt: closedAt + 10000,
      replySeenAt: closedAt + 10000,
      now: retryAt + 1,
    });
    assert.equal(due.reopen, true);
    assert.ok(
      due.reason === 'inbound_after_close' || due.reason === 'peer_last_after_close',
      '到点后必须重新进入核对，实际=' + due.reason
    );
  });

  it('重试等待期间真有新来信 → 立即复活，不被等待压住', () => {
    const now = closedAt + 20000;
    const entry = Object.assign({
      reopenAt: 0,
      reopenRetryAt: now + 60000,
      reopenedPreview: '40です',
    }, baseClosed);
    const r = D.decideClosedReopen(entry, {
      peerLast: true,
      preview: '会いましょう',
      lastInboundAt: closedAt + 10000,
      replySeenAt: closedAt + 10000,
      now: now,
    });
    assert.equal(r.reopen, true);
    assert.equal(r.reason, 'peer_last_changed');
  });
});

describe('candidatePriority · 收口与复活排序', () => {
  it('复活会话优先级最高，普通收口被剔除', () => {
    assert.equal(D.candidatePriority({ closed: true, revived: true }), 0);
    assert.equal(D.candidatePriority({ closed: true, revived: false }), 99);
    assert.equal(D.candidatePriority({ closed: true }), 99);
    assert.equal(D.candidatePriority({ excluded: true }), 99);
  });

  it('历史校准排在到期广告/催加之后，但排在普通探测之前', () => {
    assert.equal(D.candidatePriority({ noIceProbe: true, lastSpeaker: 'peer' }), 4);
    assert.equal(D.candidatePriority({ lastSpeaker: 'own', adDebt: true }), 3);
    assert.equal(D.candidatePriority({ lastSpeaker: 'unknown', probeable: true }), 5);
    assert.equal(D.candidatePriority({ unboundProbe: true }), 6);
  });
});

describe('content_chat 守卫 · 草稿不算对方发言、复活走既有回复判定', () => {
  it('预览判 peerLast 时排除我方发出预览与待发草稿', () => {
    const start = chatSrc.indexOf('var peerLast =');
    assert.ok(start > 0, '应存在 peerLast 计算');
    const line = chatSrc.slice(start, chatSrc.indexOf(';', start) + 1);
    assert.match(line, /isOwnSentPreview/);
    assert.match(line, /pendingDraft/);
  });

  it('收口后新入站不另开人工分支，交回既有判定', () => {
    assert.doesNotMatch(chatSrc, /reopened_manual_review/);
    assert.match(chatSrc, /收口后复活也走同一套回复判定/);
    assert.match(chatSrc, /decideClosedReopen/);
    assert.match(chatSrc, /reopenedAt/);
    assert.match(chatSrc, /reopenedReason/);
    assert.match(chatSrc, /revived_reason/);
  });

  it('“等下一轮”不能写入 reopenedAt（否则下一拍永久 already_surfaced）', () => {
    const start = chatSrc.indexOf('var reopenSettled =');
    assert.ok(start > 0, '应存在 reopenSettled 计算');
    const block = chatSrc.slice(start, start + 420);
    assert.match(block, /decisionRes\.action === 'skip'/);
    assert.doesNotMatch(block, /action !== 'send'/);
    // 等到期必须落到明确的重试时间，而不是已读
    assert.match(chatSrc, /reopenRetryAt = nowTs \+ Math\.max\(15 \* 1000, retryDelay\)/);
    assert.match(chatSrc, /reopenRetryReason/);
  });
});

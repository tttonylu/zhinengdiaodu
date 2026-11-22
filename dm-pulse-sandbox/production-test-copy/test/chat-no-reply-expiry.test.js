'use strict';
/**
 * 4.9.129 回归：非两段式没有回复不发广告；超过 3 天按台账时间过期。
 * 运行：node --test --test-force-exit test/chat-no-reply-expiry.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const chatSrc = fs.readFileSync(path.join(root, 'chat', 'content_chat.js'), 'utf8');
const gateSrc = fs.readFileSync(path.join(root, 'chat', 'chat-gates.js'), 'utf8');
const coreSrc = fs.readFileSync(path.join(root, 'scheduler-core.js'), 'utf8');

function loadInboxState() {
  const window = {};
  const sandbox = { window, console, Math, Number, parseInt, isFinite, Date };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'chat', 'inbox-state.js'), 'utf8'), sandbox);
  return window.SgInboxState;
}

const State = loadInboxState();
const NOW = 1700000000000;
const HOUR = 60 * 60 * 1000;

function plan(entry, texts, opts) {
  const state = State.normalizeEntry(entry, { twoSeg: false });
  return State.planAction(state, texts || [], Object.assign({
    now: NOW,
    kickGapMs: 2 * HOUR,
  }, opts || {}));
}

describe('无回复不发广告', () => {
  it('破冰后没有回复，即使过了很多小时也只等待', () => {
    const r = plan({ iceSentAt: NOW - 10 * HOUR }, []);
    assert.equal(r.action, 'wait');
    assert.equal(r.route, 'none');
    assert.equal(r.reason, 'await_reply');
  });

  it('确认对方回复过，才允许发广告', () => {
    const r = plan({ iceSentAt: NOW - 2 * HOUR }, [], {
      replyKnown: true,
      age: 30,
      ageRejectBelow: 25,
    });
    assert.equal(r.action, 'send');
    assert.equal(r.route, 'ad');
    assert.equal(r.reason, 'age_ok');
  });
});

describe('超过 3 天按台账时间过期', () => {
  it('无回复且最后我方消息超过 3 天 → 跳过', () => {
    const r = plan({ iceSentAt: NOW - 4 * 24 * HOUR }, []);
    assert.equal(r.action, 'skip');
    assert.equal(r.reason, 'expired_3d_no_reply');
  });

  it('超过 3 天但之后有对方入站 → 不过期', () => {
    const r = plan({
      iceSentAt: NOW - 4 * 24 * HOUR,
      lastInboundAt: NOW - 2 * HOUR,
    }, [], { replyKnown: true, age: 30, ageRejectBelow: 25 });
    assert.equal(r.action, 'send');
    assert.equal(r.route, 'ad');
  });

  it('粉丝队列、OPS 回灌、守箱候选共用过期判定', () => {
    assert.match(chatSrc, /function isExpiredNoReply\(entry, now\)/);
    assert.match(chatSrc, /reason: 'expired_3d_no_reply'/);
    assert.match(chatSrc, /skipped_expired_3d: skippedExpired/);
    assert.match(chatSrc, /dropSample\(handle, 'ledger_activity_older_than_3d'\)/);
  });

  it('双方都沉默了超过 3 天，即使最后一条是对方 → 旧会话过期', () => {
    const r = plan({
      iceSentAt: NOW - 6 * 24 * HOUR,
      lastInboundAt: NOW - 5 * 24 * HOUR,
    }, []);
    assert.equal(r.action, 'skip');
    assert.equal(r.reason, 'expired_3d_stale');
  });

  it('只有对方很久以前来过一句、我方从未回复 → 也按过期处理', () => {
    const r = plan({ lastInboundAt: NOW - 5 * 24 * HOUR }, []);
    assert.equal(r.action, 'skip');
    assert.equal(r.reason, 'expired_3d_stale');
  });

  it('沉默很久后对方刚回新消息 → 仍然有效，不能误杀', () => {
    const r = plan({
      iceSentAt: NOW - 10 * 24 * HOUR,
      lastInboundAt: NOW - 30 * 60 * 1000,
    }, [], { replyKnown: true, age: 30, ageRejectBelow: 25 });
    assert.equal(r.action, 'send');
    assert.equal(r.route, 'ad');
  });

  it('破冰队列出队前会跳过过期旧会话', () => {
    assert.match(chatSrc, /function isExpiredStaleConversation\(entry, now\)/);
    assert.match(chatSrc, /it\.reason = 'expired_3d_stale'/);
    assert.match(chatSrc, /reason: 'expired_3d_stale'/);
  });

  it('非两段式闸门不再生成无回复广告', () => {
    assert.match(gateSrc, /return \{ ok: false, reason: 'await_reply', wait_left_ms: 0 \}/);
    assert.doesNotMatch(chatSrc, /next_poll_ad_no_reply/);
  });

  it('旧的 replySeenAt 早于破冰时不算回复，不能放行广告', () => {
    assert.match(chatSrc, /var hasReply = !!\(iceAtReplyScan && lastReplyAtScan > iceAtReplyScan\)/);
    assert.match(chatSrc, /if \(iceAtForReply && lastReplyAt > iceAtForReply\) return true/);
    assert.match(coreSrc, /if \(lastReply > e\.iceSentAt\) n\+\+/);
  });
});

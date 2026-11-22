'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const modulePath = path.join(
  __dirname,
  '..',
  'production-test-copy',
  'chat',
  'inbox-decision.js'
);

let decision;

before(() => {
  global.window = {};
  require(modulePath);
  decision = global.window.SgInboxDecision;
});

const NOW = 1800000000000;
const HOUR = 60 * 60 * 1000;

function decide(overrides) {
  return decision.decideInboxAction(Object.assign({
    now: NOW,
    entry: { round: 1, iceSentAt: NOW - 3 * HOUR },
    peerTexts: ['40代ですよ'],
    opts: { twoSeg: true, adMinWaitMs: HOUR, ageRejectBelow: 25 }
  }, overrides || {}));
}

describe('守箱决策：已关闭会话', () => {
  it('done 目标不再处理', () => {
    const r = decide({ entry: { round: 1, iceSentAt: NOW - HOUR, done: true } });
    assert.equal(r.action, 'skip');
    assert.equal(r.reason, 'chat_closed');
  });

  it('round>=3 或已发终催不再处理', () => {
    assert.equal(decide({ entry: { round: 3 } }).reason, 'chat_closed');
    assert.equal(decide({ entry: { round: 2, finalKickSentAt: NOW } }).reason, 'chat_closed');
  });

  it('身份未证明时不开火', () => {
    const r = decide({ identityOk: false });
    assert.equal(r.action, 'skip');
    assert.equal(r.reason, 'identity_pending');
  });
});

describe('守箱决策：破冰与首条回复', () => {
  it('空会话无我方气泡 → 先破冰', () => {
    const r = decide({
      entry: { round: 0 },
      peerTexts: [],
      hasOwnBubble: false
    });
    assert.equal(r.action, 'send');
    assert.equal(r.route, 'ice');
    assert.equal(r.round, 0);
  });

  it('对方先来信且台账未破冰 → 直接用广告回（greeting_ad）', () => {
    const r = decide({
      entry: { round: 0 },
      peerTexts: ['はじめまして'],
      hasOwnBubble: false
    });
    assert.equal(r.action, 'send');
    assert.equal(r.route, 'greeting_ad');
    assert.equal(r.round, 1);
  });

  it('会话里已有我方气泡但台账没记 iceSentAt → 只补记状态，不重复破冰', () => {
    const r = decide({
      entry: { round: 0 },
      peerTexts: [],
      hasOwnBubble: true
    });
    assert.equal(r.action, 'skip');
    assert.equal(r.reason, 'ice_already_visible');
  });
});

describe('守箱决策：广告轮', () => {
  it('已破冰 + 对方回复 → 发广告', () => {
    const r = decide();
    assert.equal(r.action, 'send');
    assert.equal(r.route, 'ad');
    assert.equal(r.round, 1);
  });

  it('广告已发（adSentAt）→ 不重复发', () => {
    const r = decide({
      entry: { round: 1, iceSentAt: NOW - 3 * HOUR, adSentAt: NOW - HOUR }
    });
    assert.equal(r.action, 'skip');
    assert.equal(r.reason, 'ad_already_sent');
  });

  it('广告气泡已确认（adBubbleOk）→ 不重复发', () => {
    const r = decide({
      entry: { round: 1, iceSentAt: NOW - 3 * HOUR, adBubbleOk: 1 }
    });
    assert.equal(r.reason, 'ad_already_sent');
  });

  it('无回复但两段式等待已满 → 按等待发广告', () => {
    const r = decide({ peerTexts: [] });
    assert.equal(r.action, 'send');
    assert.equal(r.route, 'ad_wait_elapsed');
  });

  it('无回复且等待未满 → 继续等', () => {
    const r = decide({
      entry: { round: 1, iceSentAt: NOW - 5 * 60 * 1000 },
      peerTexts: []
    });
    assert.equal(r.action, 'wait');
    assert.equal(r.reason, 'await_reply');
  });

  it('经典模式无回复 → 等对方回复，不硬发', () => {
    const r = decide({
      peerTexts: [],
      opts: { twoSeg: false, adMinWaitMs: HOUR, ageRejectBelow: 25 }
    });
    assert.equal(r.action, 'wait');
    assert.equal(r.reason, 'await_reply');
  });

  it('年龄低于门槛 → 用婉拒文案', () => {
    const r = decide({ peerTexts: ['18歳です'], age: 18 });
    assert.equal(r.action, 'send');
    assert.equal(r.route, 'reject');
    assert.equal(r.reason, 'age_below_25');
  });

  it('年龄达标 → 发广告', () => {
    const r = decide({ peerTexts: ['28歳です'], age: 28 });
    assert.equal(r.route, 'ad');
    assert.equal(r.reason, 'age_ok');
  });

  it('job 模式明确拒绝 → 婉拒', () => {
    const r = decide({
      peerTexts: ['やらない'],
      jobIntent: 'no',
      opts: { twoSeg: false, adMinWaitMs: HOUR, ageRejectBelow: 25, jobMode: true }
    });
    assert.equal(r.route, 'reject');
    assert.equal(r.reason, 'job_intent_no');
  });
});

describe('守箱决策：催加轮', () => {
  it('两段式不发催加', () => {
    const r = decide({ entry: { round: 2, iceSentAt: NOW - 9 * HOUR, adSentAt: NOW - 5 * HOUR } });
    assert.equal(r.action, 'skip');
    assert.equal(r.reason, 'two_seg_no_kick');
  });

  it('经典模式且催加未满 → 发盾牌或催加', () => {
    const r = decide({
      entry: { round: 2, iceSentAt: NOW - 9 * HOUR, adSentAt: NOW - 5 * HOUR },
      peerTexts: [],
      opts: { twoSeg: false, adMinWaitMs: HOUR, ageRejectBelow: 25 }
    });
    assert.equal(r.action, 'send');
    assert.equal(r.round, 2);
    assert.equal(r.route, 'kick');
  });

  it('催加已满两次 → 关闭', () => {
    const r = decide({
      entry: { round: 2, kickCount: 2 },
      opts: { twoSeg: false, adMinWaitMs: HOUR, ageRejectBelow: 25 }
    });
    assert.equal(r.reason, 'chat_closed');
  });
});

describe('守箱候选排序：未读优先', () => {
  it('精确未读排在所有台账债务之前', () => {
    const items = [
      { key: 'debt-reply', unread: false, unreadPrecise: false, hasReply: true },
      { key: 'debt-wait', unread: false, unreadPrecise: false, probeable: true },
      { key: 'unread-visual', unread: true, unreadPrecise: false },
      { key: 'unread-precise', unread: true, unreadPrecise: true }
    ];
    const sorted = decision.sortInboxCandidates(items).map((it) => it.key);
    assert.deepEqual(sorted, ['unread-precise', 'unread-visual', 'debt-reply', 'debt-wait']);
  });

  it('关闭目标被剔除，冷却只压非未读', () => {
    const items = [
      { key: 'closed', unread: true, unreadPrecise: true, closed: true },
      { key: 'cooldown-cold', unread: false, unreadPrecise: false, cooldown: true, hasReply: true },
      { key: 'cooldown-unread', unread: true, unreadPrecise: true, cooldown: true },
      { key: 'ok', unread: true, unreadPrecise: true }
    ];
    const sorted = decision.sortInboxCandidates(items).map((it) => it.key);
    assert.deepEqual(sorted, ['cooldown-unread', 'ok']);
  });

  it('没有候选时返回空数组', () => {
    assert.deepEqual(decision.sortInboxCandidates([]), []);
  });
});

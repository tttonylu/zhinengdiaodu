'use strict';
/**
 * 规则契约与运行时状态机必须完全一致。
 * 运行时用 inbox-state.planAction；inbox-decision.decideInboxAction 是同一套规则的独立实现。
 * 只比 action 会漏掉“动作一样、发的东西不一样”（route）和“反馈说不清为什么”（reason），
 * 所以这里逐项比对 action / route / reason / waitLeftMs。
 *
 * 运行：node --test --test-force-exit test/inbox-action-parity.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(pathParts) {
  const src = fs.readFileSync(path.join(__dirname, '..', ...pathParts), 'utf8');
  const window = {};
  const sandbox = {
    window,
    console,
    Math,
    Number,
    parseInt,
    isFinite,
    Date,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return window;
}

const W1 = load(['chat', 'inbox-state.js']);
const W2 = load(['chat', 'inbox-decision.js']);
const State = W1.SgInboxState;
const Decision = W2.SgInboxDecision;

const NOW = 1700000000000;
const HOUR = 60 * 60 * 1000;
const KICK_GAP = 2 * HOUR;
const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'content_chat.js'), 'utf8');

function statePlan(c) {
  const st = State.normalizeEntry(c.entry, { twoSeg: c.twoSeg });
  return State.planAction(st, c.texts || [], Object.assign({
    now: NOW,
    kickGapMs: KICK_GAP,
    hasOwnBubble: !!c.hasOwnBubble,
  }, c.opts || {}));
}

describe('OPS 台账轮次 · 两次催加必须各占一轮', () => {
  it('破冰/广告/婉拒映射到 1/2/2', () => {
    assert.equal(State.opsRoundForSend('ice', 0), 1);
    assert.equal(State.opsRoundForSend('ad', 0), 2);
    assert.equal(State.opsRoundForSend('reject', 0), 2);
  });

  it('首次催加=3，终催=4（不能复用 3）', () => {
    assert.equal(State.opsRoundForSend('kick', 1), 3);
    assert.equal(State.opsRoundForSend('kick', 2), 4);
  });

  it('运行时按发送后的 kickCount 选轮次', () => {
    assert.match(chatSrc, /opsRoundForSend\(decisionRes\.route, kickCountAfter\)/);
    assert.match(chatSrc, /kickCountAfter >= 2 \? 4 : 3/);
  });

  it('婉拒后补第 3 轮完结标记，OPS 才能显示为婉拒而不是广告', () => {
    assert.match(chatSrc, /\[age_reject_done\]/);
    assert.match(chatSrc, /\[job_intent_reject_done\]/);
    assert.match(chatSrc, /opsDmRecord\(targetHandle, 3, rejMarker, 'success'\)/);
  });

  it('首次催加与终催文案分开存，补记不会把终催填到第 3 轮', () => {
    assert.match(chatSrc, /entry\.lastKick1Text = text/);
    assert.match(chatSrc, /entry\.lastFinalKickText = text/);
    assert.match(chatSrc, /r === 4 && \(entry\.lastFinalKickText/);
  });
});

function decisionPlan(c) {
  return Decision.decideInboxAction({
    entry: c.entry,
    peerTexts: c.texts || [],
    hasOwnBubble: !!c.hasOwnBubble,
    identityOk: c.identityOk !== false,
    age: c.opts && c.opts.age,
    jobIntent: c.opts && c.opts.jobIntent,
    replyKnown: !!(c.opts && c.opts.replyKnown),
    opts: Object.assign({
      twoSeg: c.twoSeg,
      now: NOW,
      kickGapMs: KICK_GAP,
    }, c.opts || {}),
  });
}

const ICE = { iceSentAt: NOW - 3 * HOUR };
const AD = { iceSentAt: NOW - 3 * HOUR, adSentAt: NOW - 3 * HOUR };
const KICK1 = { iceSentAt: NOW - 6 * HOUR, adSentAt: NOW - 5 * HOUR, kickSentAt: NOW - 10 * 60 * 1000, kickCount: 1 };

const CASES = [
  // ---------- 破冰段：只能从粉丝列表发起，守箱一律不发 ----------
  {
    name: '没破冰、没回复 → 守箱不补破冰',
    entry: { round: 0 },
    twoSeg: false,
    texts: [],
    expect: { action: 'skip', route: 'none', reason: 'ice_via_roster_only' },
  },
  {
    name: '没破冰但会话已有我方气泡 → 仍不从守箱发破冰',
    entry: { round: 0 },
    twoSeg: false,
    texts: [],
    hasOwnBubble: true,
    expect: { action: 'skip', route: 'none', reason: 'ice_via_roster_only' },
  },
  {
    name: '没破冰、对方先来信、年龄 20 < 25 → 守箱也不婉拒（没破冰就不进入年龄分流）',
    entry: { round: 0 },
    twoSeg: false,
    texts: ['20歳です'],
    opts: { age: 20, ageRejectBelow: 25 },
    expect: { action: 'skip', route: 'none', reason: 'ice_via_roster_only' },
  },
  {
    name: '没破冰、对方先来信、年龄 30 → 守箱也不发广告',
    entry: { round: 0 },
    twoSeg: false,
    texts: ['30歳です'],
    opts: { age: 30, ageRejectBelow: 25 },
    expect: { action: 'skip', route: 'none', reason: 'ice_via_roster_only' },
  },
  {
    name: 'job 池没破冰 → 同样不从守箱发（不因为意向为否就婉拒）',
    entry: { round: 0 },
    twoSeg: false,
    texts: ['やらない'],
    opts: { jobMode: true, jobIntent: 'no' },
    expect: { action: 'skip', route: 'none', reason: 'ice_via_roster_only' },
  },

  // ---------- 广告段：非两段式 ----------
  {
    name: '非两段式：破冰后无回复 → 只等待，不发广告',
    entry: ICE,
    twoSeg: false,
    texts: [],
    expect: { action: 'wait', route: 'none', reason: 'await_reply' },
  },
  {
    name: '非两段式：无回复超过 3 天 → 台账过期，不再动作',
    entry: { iceSentAt: NOW - 4 * 24 * HOUR },
    twoSeg: false,
    texts: [],
    expect: { action: 'skip', route: 'none', reason: 'expired_3d_no_reply' },
  },
  {
    name: '非两段式：超过 3 天但之后有对方回复 → 不过期',
    entry: { iceSentAt: NOW - 4 * 24 * HOUR, lastInboundAt: NOW - 2 * HOUR },
    twoSeg: false,
    texts: [],
    opts: { replyKnown: true, age: 30, ageRejectBelow: 25 },
    expect: { action: 'send', route: 'ad', reason: 'age_ok' },
  },
  {
    name: '非两段式：广告发送失败后确认对方回复过 → 允许重试广告',
    entry: { iceSentAt: NOW - 5 * HOUR, lastInboundAt: NOW - 4 * HOUR },
    twoSeg: false,
    texts: [],
    opts: { replyKnown: true, age: 30, ageRejectBelow: 25 },
    expect: { action: 'send', route: 'ad', reason: 'age_ok' },
  },
  {
    name: '非两段式：有回复、年龄 20 < 25 → 婉拒',
    entry: ICE,
    twoSeg: false,
    texts: ['20歳'],
    opts: { age: 20, ageRejectBelow: 25 },
    expect: { action: 'send', route: 'reject', reason: 'age_below_25' },
  },
  {
    name: '非两段式：有回复、年龄 30 → 发广告',
    entry: ICE,
    twoSeg: false,
    texts: ['30歳'],
    opts: { age: 30, ageRejectBelow: 25 },
    expect: { action: 'send', route: 'ad', reason: 'age_ok' },
  },
  {
    name: '非两段式：有回复但没解析出年龄 → 照样发广告',
    entry: ICE,
    twoSeg: false,
    texts: ['はじめまして'],
    opts: { age: null, ageRejectBelow: 25 },
    expect: { action: 'send', route: 'ad', reason: 'age_unknown_ad' },
  },

  // ---------- 广告段：两段式 ----------
  {
    name: '两段式：等待期未满 → 等',
    entry: { iceSentAt: NOW - 10 * 60 * 1000 },
    twoSeg: true,
    texts: [],
    expect: { action: 'wait', route: 'none', reason: 'await_reply' },
  },
  {
    name: '两段式：等待期满但没有回复 → 仍然只等回复',
    entry: { iceSentAt: NOW - 2 * HOUR },
    twoSeg: true,
    texts: [],
    expect: { action: 'wait', route: 'none', reason: 'await_reply' },
  },

  // ---------- 催加段：非两段式 ----------
  {
    name: '非两段式：广告后未满催加间隔 → 明确等待，不连发',
    entry: {
      iceSentAt: NOW - HOUR,
      adSentAt: NOW - 10 * 60 * 1000,
      lastInboundAt: NOW - 5 * 60 * 1000
    },
    twoSeg: false,
    texts: [],
    expect: { action: 'wait', route: 'none', reason: 'kick_wait' },
  },
  {
    name: '非两段式：广告后满催加间隔 → 发第一次催加',
    entry: {
      iceSentAt: NOW - 5 * HOUR,
      adSentAt: NOW - 3 * HOUR,
      lastInboundAt: NOW - 2 * HOUR
    },
    twoSeg: false,
    texts: [],
    expect: { action: 'send', route: 'kick', reason: 'kick_ready' },
  },
  {
    name: '非两段式：第一次催加后未满间隔 → 等待，不发终催',
    entry: Object.assign({}, KICK1, { lastInboundAt: NOW - 5 * 60 * 1000 }),
    twoSeg: false,
    texts: [],
    expect: { action: 'wait', route: 'none', reason: 'kick_wait' },
  },
  {
    name: '非两段式：第一次催加后满间隔 → 发终催',
    entry: {
      iceSentAt: NOW - 9 * HOUR,
      adSentAt: NOW - 8 * HOUR,
      kickSentAt: NOW - 3 * HOUR,
      kickCount: 1,
      lastInboundAt: NOW - 2 * HOUR
    },
    twoSeg: false,
    texts: [],
    expect: { action: 'send', route: 'kick', reason: 'kick_ready' },
  },
  {
    name: '非两段式：对方有回复时按催加处理',
    entry: {
      iceSentAt: NOW - 5 * HOUR,
      adSentAt: NOW - 3 * HOUR,
      lastInboundAt: NOW - 2 * HOUR
    },
    twoSeg: false,
    texts: ['どうすればいい？'],
    expect: { action: 'send', route: 'kick', reason: 'kick_ready' },
  },
  {
    name: '两段式：发完 LINE 后不再催加',
    entry: { iceSentAt: NOW - 6 * HOUR, adSentAt: NOW - 5 * HOUR, twoSegAdDoneAt: NOW - 5 * HOUR, chatClosedAt: NOW - 5 * HOUR },
    twoSeg: true,
    texts: ['hi'],
    expect: { action: 'skip', route: 'none', reason: 'stage_closed' },
  },
  {
    name: '已婉拒 → 永远不再发',
    entry: { iceSentAt: NOW - 6 * HOUR, rejectSentAt: NOW - 5 * HOUR, chatClosedAt: NOW - 5 * HOUR },
    twoSeg: false,
    texts: ['hi'],
    expect: { action: 'skip', route: 'none', reason: 'stage_closed' },
  },
  {
    name: '已发终催 → 不再发',
    entry: { iceSentAt: NOW - 20 * HOUR, adSentAt: NOW - 18 * HOUR, kickSentAt: NOW - 3 * HOUR, finalKickSentAt: NOW - 1 * HOUR, kickCount: 2 },
    twoSeg: false,
    texts: ['hi'],
    expect: { action: 'skip', route: 'none', reason: 'stage_closed' },
  },

  // ---------- 台账字段互相矛盾时：阶段只由发送痕迹推导，不看 round ----------
  {
    name: 'round=2 但没有 iceSentAt → 守箱判定“没破冰”，不发',
    entry: { round: 2 },
    twoSeg: false,
    texts: [],
    expect: { action: 'skip', route: 'none', reason: 'ice_via_roster_only' },
  },
  {
    name: '没有 iceSentAt 但广告痕迹已在 → 两侧都判 ad_already_sent（不补发）',
    entry: { round: 2, adSentAt: NOW - 3 * HOUR, adBubbleOk: 1 },
    twoSeg: false,
    texts: [],
    expect: { action: 'skip', route: 'none', reason: 'ad_already_sent' },
  },
  {
    name: 'round=2 但没有 adSentAt、对方没回 → 不补广告',
    entry: { round: 2, iceSentAt: NOW - 3 * HOUR },
    twoSeg: false,
    texts: [],
    expect: { action: 'wait', route: 'none', reason: 'await_reply' },
  },
  {
    name: 'round=1 但广告已发、间隔已满且有回复 → 按催加处理',
    entry: {
      round: 1,
      iceSentAt: NOW - 5 * HOUR,
      adSentAt: NOW - 3 * HOUR,
      lastInboundAt: NOW - 2 * HOUR
    },
    twoSeg: false,
    texts: [],
    expect: { action: 'send', route: 'kick', reason: 'kick_ready' },
  },
];

describe('规则契约与运行时状态机逐项一致', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const a = statePlan(c);
      const b = decisionPlan(c);
      assert.equal(b.action, a.action, `${c.name}：action 不一致`);
      assert.equal(b.route, a.route, `${c.name}：route 不一致（会发成别的消息）`);
      assert.equal(b.reason, a.reason, `${c.name}：reason 不一致（反馈说不清原因）`);
      if (a.waitLeftMs != null || b.waitLeftMs != null) {
        assert.ok(
          Math.abs((Number(a.waitLeftMs) || 0) - (Number(b.waitLeftMs) || 0)) <= 1000,
          `${c.name}：waitLeftMs 不一致`
        );
      }
      if (c.expect) {
        assert.equal(a.action, c.expect.action, `${c.name}：预期 action=${c.expect.action}`);
        assert.equal(a.route, c.expect.route, `${c.name}：预期 route=${c.expect.route}`);
        assert.equal(a.reason, c.expect.reason, `${c.name}：预期 reason=${c.expect.reason}`);
      }
    });
  }
});

describe('非两段式：只有年龄能改变路线', () => {
  it('年龄合格与不合格，唯一差别是婉拒/广告', () => {
    const base = { entry: ICE, twoSeg: false, texts: ['25歳'] };
    const young = statePlan(Object.assign({}, base, { opts: { age: 24, ageRejectBelow: 25 } }));
    const ok = statePlan(Object.assign({}, base, { opts: { age: 25, ageRejectBelow: 25 } }));
    const unknown = statePlan(Object.assign({}, base, { opts: { age: null, ageRejectBelow: 25 } }));
    assert.equal(young.route, 'reject');
    assert.equal(ok.route, 'ad');
    assert.equal(unknown.route, 'ad');
  });

  it('广告之后没有新回复就等，有新回复才走催加', () => {
    const adSent = { iceSentAt: NOW - 5 * HOUR, adSentAt: NOW - 3 * HOUR };
    const noReply = statePlan({
      entry: adSent,
      twoSeg: false,
      texts: [],
      opts: { age: 20, ageRejectBelow: 25, jobMode: true, jobIntent: 'no' },
    });
    assert.equal(noReply.action, 'wait');
    assert.equal(noReply.reason, 'await_reply');
    const replies = [['ありがとう'], ['20歳'], ['やらない']];
    for (const texts of replies) {
      const plan = statePlan({
        entry: adSent,
        twoSeg: false,
        texts,
        opts: { age: 20, ageRejectBelow: 25, jobMode: true, jobIntent: 'no' },
      });
      assert.equal(plan.route, 'kick', '广告后出现意外路线：' + JSON.stringify(texts));
    }
  });
});

describe('非两段式：整条链路按真实时间推进', () => {
  function tick(entry, texts, at, opts) {
    const st = State.normalizeEntry(entry, { twoSeg: false });
    const plan = State.planAction(st, texts || [], Object.assign({
      now: at,
      kickGapMs: KICK_GAP,
    }, opts || {}));
    return { plan: plan, entry: entry };
  }

  function applySend(entry, route, at) {
    const st = State.normalizeEntry(entry, { twoSeg: false });
    const patch = State.afterSend(st, route, at);
    return Object.assign({}, entry, patch);
  }

  it('破冰（粉丝列表完成）→ 等回复 → 有回复发广告 → 两次催加 → 收口，不会同一拍连发', () => {
    const t0 = NOW;
    // 破冰由拉新阶段从粉丝列表发出；守箱接手时台账已有 iceSentAt
    let entry = { round: 1, iceSentAt: t0 };

    let r = tick(entry, [], t0 + 60 * 1000);
    assert.equal(r.plan.action, 'wait');
    assert.equal(r.plan.reason, 'await_reply');

    r = tick(entry, ['30歳です'], t0 + 5 * 60 * 1000, { age: 30, ageRejectBelow: 25 });
    assert.equal(r.plan.route, 'ad');
    assert.equal(r.plan.reason, 'age_ok');
    entry = applySend(entry, 'ad', t0 + 5 * 60 * 1000);
    // 广告发出后对方又回了一句，才允许第一次催加
    const afterAdReply = t0 + 5 * 60 * 1000 + 5 * 60 * 1000;
    entry = Object.assign({}, entry, { lastInboundAt: afterAdReply });

    // 守箱永远不补破冰
    r = tick({ round: 0 }, [], t0 + 60 * 1000);
    assert.equal(r.plan.action, 'skip');
    assert.equal(r.plan.reason, 'ice_via_roster_only');

    // 广告后同一拍/下一拍不能立刻催加（测试显式配置 2 小时下限）
    r = tick(entry, [], t0 + 7 * 60 * 1000);
    assert.equal(r.plan.action, 'wait');
    assert.equal(r.plan.reason, 'kick_wait');

    // 满 2 小时：第一次催加
    r = tick(entry, [], t0 + 2 * HOUR + 10 * 60 * 1000);
    assert.equal(r.plan.route, 'kick');
    assert.equal(r.plan.reason, 'kick_ready');
    entry = applySend(entry, 'kick', t0 + 2 * HOUR + 10 * 60 * 1000);
    assert.equal(entry.kickCount, 1);
    assert.ok(!entry.chatClosedAt, '第一次催加不应收口');
    // 第一次催加后对方又回了一句，才允许终催
    const afterKickReply = t0 + 2 * HOUR + 10 * 60 * 1000 + 30 * 1000;
    entry = Object.assign({}, entry, { lastInboundAt: afterKickReply });

    // 再过 1 分钟：终催还不能发
    r = tick(entry, [], t0 + 2 * HOUR + 11 * 60 * 1000);
    assert.equal(r.plan.reason, 'kick_wait');

    // 满 2 小时：终催 + 收口
    r = tick(entry, [], t0 + 4 * HOUR + 10 * 60 * 1000);
    assert.equal(r.plan.route, 'kick');
    assert.equal(r.plan.reason, 'kick_ready');
    entry = applySend(entry, 'kick', t0 + 4 * HOUR + 10 * 60 * 1000);
    assert.equal(entry.kickCount, 2);
    assert.ok(entry.finalKickSentAt, '第二次催加必须写 finalKickSentAt');
    assert.ok(entry.chatClosedAt, '第二次催加必须收口');

    // 收口后永不再发
    r = tick(entry, ['まだ？'], t0 + 5 * HOUR);
    assert.equal(r.plan.action, 'skip');
    assert.equal(r.plan.reason, 'stage_closed');
  });
});

describe('催加默认由轮询轮次驱动', () => {
  const adSent = {
    iceSentAt: NOW - HOUR,
    adSentAt: NOW - 10 * 60 * 1000,
    lastInboundAt: NOW - 5 * 60 * 1000
  };
  const kickSent = {
    iceSentAt: NOW - HOUR,
    adSentAt: NOW - 40 * 60 * 1000,
    kickSentAt: NOW - 10 * 60 * 1000,
    kickCount: 1,
    lastInboundAt: NOW - 5 * 60 * 1000
  };

  function plan(entry, at, pulseSeq) {
    const st = State.normalizeEntry(entry, { twoSeg: false });
    return State.planAction(st, [], { now: at, pulseSeq: pulseSeq });
  }

  it('默认没有时间闸：只看是不是下一轮轮询', () => {
    const sameRound = plan(Object.assign({ adPulseSeq: 100 }, adSent), NOW, 100);
    assert.equal(sameRound.action, 'wait');
    assert.equal(sameRound.reason, 'kick_wait');
    assert.equal(sameRound.nextRound, true);
    assert.equal(sameRound.waitLeftMs, undefined);

    const nextRound = plan(Object.assign({ adPulseSeq: 100 }, adSent), NOW + 60 * 1000, 101);
    assert.equal(nextRound.action, 'send');
    assert.equal(nextRound.route, 'kick');
  });

  it('第一次催加同样要等下一轮', () => {
    const sameRound = plan(Object.assign({ adPulseSeq: 100, kickPulseSeq: 101 }, kickSent), NOW, 101);
    assert.equal(sameRound.nextRound, true);

    const nextRound = plan(Object.assign({ adPulseSeq: 100, kickPulseSeq: 101 }, kickSent), NOW + 60 * 1000, 102);
    assert.equal(nextRound.action, 'send');
  });

  it('契约侧与运行时对轮次闸的结论一致', () => {
    const entry = Object.assign({ adPulseSeq: 100 }, adSent);
    const a = plan(entry, NOW, 100);
    const b = Decision.decideInboxAction({
      entry: entry,
      peerTexts: [],
      opts: { twoSeg: false, now: NOW, pulseSeq: 100 },
    });
    assert.equal(a.action, b.action);
    assert.equal(a.reason, b.reason);
    assert.equal(!!a.nextRound, !!b.nextRound);
  });

  it('OPS 配了时间下限时，轮次过了也要等满时间', () => {
    const entry = Object.assign({ adPulseSeq: 100 }, adSent);
    const st = State.normalizeEntry(entry, { twoSeg: false });
    const r = State.planAction(st, [], {
      now: NOW,
      pulseSeq: 101,
      kickGapMs: 30 * 60 * 1000,
      lastInboundAt: NOW - 5 * 60 * 1000
    });
    assert.equal(r.reason, 'kick_wait');
    assert.ok(r.waitLeftMs > 0);
  });
});

describe('收口后收到真回复：必须重新开一轮，不能只标已读', () => {
  const CLOSED = {
    iceSentAt: NOW - 5 * HOUR,
    adSentAt: NOW - 4 * HOUR,
    kickSentAt: NOW - 3 * HOUR,
    kickCount: 2,
    finalKickSentAt: NOW - 3 * HOUR,
    chatClosedAt: NOW - 3 * HOUR,
    round: 3,
    done: true,
  };

  it('收口 = 不复活时一律 stage_closed（不会自己找上门）', () => {
    const a = statePlan({ entry: CLOSED, twoSeg: false, texts: ['40です'] });
    const b = decisionPlan({ entry: CLOSED, twoSeg: false, texts: ['40です'] });
    assert.equal(a.action, 'skip');
    assert.equal(a.reason, 'stage_closed');
    assert.equal(b.action, a.action);
    assert.equal(b.reason, a.reason);
  });

  it('收口后对方真回复（reopened）→ 年龄合格发广告', () => {
    const c = { entry: CLOSED, twoSeg: false, texts: ['40です'], opts: { reopened: true, age: 40, ageRejectBelow: 25 } };
    const a = statePlan(c);
    const b = decisionPlan(c);
    assert.equal(a.action, 'send');
    assert.equal(a.route, 'ad');
    assert.equal(b.action, a.action);
    assert.equal(b.route, a.route);
  });

  it('收口后对方真回复但年龄不合格 → 只发婉拒', () => {
    const c = { entry: CLOSED, twoSeg: false, texts: ['20です'], opts: { reopened: true, age: 20, ageRejectBelow: 25 } };
    const a = statePlan(c);
    const b = decisionPlan(c);
    assert.equal(a.action, 'send');
    assert.equal(a.route, 'reject');
    assert.equal(a.reason, 'age_below_25');
    assert.equal(b.route, a.route);
    assert.equal(b.reason, a.reason);
  });

  it('收口后只有历史气泡、最后一条是我方 → 禁止重发广告', () => {
    const c = {
      entry: CLOSED,
      twoSeg: false,
      texts: ['40です'],
      opts: { reopened: true, lastBubbleDirection: 'own', age: 40, ageRejectBelow: 25 }
    };
    const a = statePlan(c);
    const b = decisionPlan(c);
    assert.equal(a.action, 'skip');
    assert.equal(a.reason, 'reopen_no_new_peer_last');
    assert.equal(b.action, a.action);
    assert.equal(b.route, a.route);
    assert.equal(b.reason, a.reason);
  });

  it('收口后最后一条确实是对方 → 仍按年龄发广告', () => {
    const c = {
      entry: CLOSED,
      twoSeg: false,
      texts: ['40です'],
      opts: { reopened: true, lastBubbleDirection: 'peer', age: 40, ageRejectBelow: 25 }
    };
    const a = statePlan(c);
    const b = decisionPlan(c);
    assert.equal(a.action, 'send');
    assert.equal(a.route, 'ad');
    assert.equal(b.action, a.action);
    assert.equal(b.route, a.route);
  });

  it('运行时必须把最后一条气泡方向交给状态机，且不再靠旧标记单独复活', () => {
    assert.match(chatSrc, /lastBubbleDirection: directionAudit\.lastDirection/);
    assert.match(chatSrc, /legacyInboundProof/);
    assert.doesNotMatch(chatSrc, /entry\.closedInboundNoReply \|\|/);
  });

  it('复活后重新开一轮：清掉终催/收口，保留破冰与广告历史', () => {
    const st = State.normalizeEntry(CLOSED, { twoSeg: false });
    const patch = State.afterSend(st, 'ad', NOW, { reopened: true });
    assert.equal(patch.finalKickSentAt, 0);
    assert.equal(patch.kickCount, 0);
    assert.equal(patch.chatClosedAt, 0);
    assert.equal(patch.done, false);
    assert.ok(patch.reopenCycleAt > 0);
    // OPS 轮次要接着往后排（5/6/7…），否则会被 (bot,target,round) 唯一键吞掉
    assert.equal(patch.reopenCycleSeq, 1);
    const p2seq = State.afterSend(
      State.normalizeEntry(Object.assign({}, CLOSED, { reopenCycleSeq: 1 }), { twoSeg: false }),
      'ad', NOW, { reopened: true }
    );
    assert.equal(p2seq.reopenCycleSeq, 2);
    // 真婉拒/拉黑永远不能因为复活被清掉
    const rej = State.normalizeEntry(Object.assign({}, CLOSED, { rejectSentAt: NOW - 1000 }), { twoSeg: false });
    const p2 = State.afterSend(rej, 'ad', NOW, { reopened: true });
    assert.notEqual(p2.rejectSentAt, 0);
  });

  it('未复活时，已收口会话依然禁止补发（防重复广告）', () => {
    const st = State.normalizeEntry(CLOSED, { twoSeg: false });
    const patch = State.afterSend(st, 'ad', NOW);
    assert.equal(Object.keys(patch).length, 0);
  });
});

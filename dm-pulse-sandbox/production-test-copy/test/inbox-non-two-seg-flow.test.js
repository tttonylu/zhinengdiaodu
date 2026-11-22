'use strict';
/**
 * 非两段式守箱流程：运行时接线检查。
 * 规则本身由 inbox-state / inbox-decision 负责，这里只保证 content_chat 真的把
 * “等待期、催加间隔、破冰已显示”这些条件接上，而不是只在测试里成立。
 *
 * 运行：node --test --test-force-exit test/inbox-non-two-seg-flow.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'content_chat.js'), 'utf8');
const gatesSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'chat-gates.js'), 'utf8');

describe('非两段式 · 等待期与催加间隔', () => {
  it('破冰后未到等待期，不算可处理（不空转开会话）', () => {
    const start = chatSrc.indexOf('var adWaitElapsed =');
    assert.ok(start > 0, '应存在 adWaitElapsed 计算');
    const line = chatSrc.slice(start, chatSrc.indexOf(';', start) + 1);
    assert.match(line, /adAdvanceMs/);
    // 非两段式：下一拍（60 秒）推进；两段式仍用 adMinWait
    assert.match(chatSrc, /var adAdvanceMs = isTwoSegChatMode\(\) \? getAdMinWaitMs\(\) : \(60 \* 1000\)/);

    const startActionable = chatSrc.indexOf('var adDebt =');
    const block = chatSrc.slice(startActionable, startActionable + 400);
    assert.match(block, /adDebt = round === 1 && !adDone && adWaitElapsed/);

    // 探测本身也要限速，否则等满一小时后又会退回每 8 分钟一次
    const startProbe = chatSrc.indexOf('var lastScanAt =');
    assert.ok(startProbe > 0, '应存在 lastScanAt 计算');
    const probeBlock = chatSrc.slice(startProbe, startProbe + 400);
    assert.match(probeBlock, /inboxWatchedAt/);
    assert.match(probeBlock, /adAdvanceMs/);
  });

  it('催加必须按间隔放行：首次看广告时间，第二次看上次催加时间', () => {
    const start = chatSrc.indexOf('var kickSince =');
    assert.ok(start > 0, '应存在 kickSince 计算');
    const block = chatSrc.slice(start, start + 700);
    assert.match(block, /kickCount\) \|\| 0\) >= 1/);
    assert.match(block, /entry\.kickSentAt/);
    assert.match(block, /entry\.adSentAt/);
    assert.match(block, /getInboxFinalKickGapMs\(\)/);
    assert.match(block, /getInboxKickGapMs\(\)/);
    assert.match(chatSrc, /function getInboxKickGapMs\(\)/);
    assert.match(gatesSrc, /function getInboxKickGapMs\(\)/);
    assert.match(gatesSrc, /chat_inbox_kick_min_minutes/);
  });

  it('催加默认 3 小时、终催默认 12 小时，仍可被 OPS 覆盖', () => {
    const start = gatesSrc.indexOf('inboxKickMinMinutes:');
    const block = gatesSrc.slice(start, start + 480);
    assert.match(block, /n = isNaN\(h\) \? 180 : h \* 60/);
    assert.match(block, /Math\.max\(0, n\)/);
    assert.match(gatesSrc, /if \(isNaN\(n\)\) return 720;/);
    // 终催可单独配置，0 表示跟随首次催加
    assert.match(gatesSrc, /function getInboxFinalKickGapMs\(\)/);
    assert.match(gatesSrc, /cfg\.inboxFinalKickMinMinutes \|\| cfg\.inboxKickMinMinutes/);
  });

  it('轮次闸已接线：脉冲发号、发送时打戳、判定时比对', () => {
    assert.match(chatSrc, /function nextInboxPulseSeq\(\)/);
    assert.match(chatSrc, /var pulseSeq = nextInboxPulseSeq\(\);/);
    assert.match(chatSrc, /entry\.adPulseSeq = pulseSeq/);
    assert.match(chatSrc, /entry\.kickPulseSeq = pulseSeq/);
    assert.match(chatSrc, /var tickSeq = Number\(opts\.pulseSeq\) \|\| nextInboxPulseSeq\(\)/);
    assert.match(chatSrc, /pulseSeq: tickSeq/);
    assert.match(chatSrc, /scanSeq <= kickLastSeq/);
  });

  it('“下一轮轮询”的节奏由会话复查间隔控制，可配置', () => {
    assert.match(chatSrc, /function getInboxRevisitCooldownMs\(\)/);
    assert.match(chatSrc, /sg_inbox_revisit_min/);
    assert.match(chatSrc, /return \(Date\.now\(\) - at\) < getInboxRevisitCooldownMs\(\)/);
  });

  it('运行状态机拿到同样的间隔和“已显示破冰”证据', () => {
    const start = chatSrc.indexOf('var stPlan = window.SgInboxState.planAction');
    assert.ok(start > 0);
    const block = chatSrc.slice(start, start + 700);
    assert.match(block, /kickGapMs: getInboxKickGapMs\(\)/);
    assert.match(block, /finalKickGapMs: getInboxFinalKickGapMs\(\)/);
    assert.match(block, /hasOwnBubble: hasOwnBubble/);
  });
});

describe('非两段式 · 不回复也要有明确原因', () => {
  it('kick_wait / await_reply 都有中文解释', () => {
    assert.match(chatSrc, /kick_wait: '催加等待中：本轮已经对它会话做过动作/);
    assert.match(chatSrc, /await_reply: '还在等回复/);
  });

  it('等待期与催加间隔未到的目标单独计数并进脉冲反馈', () => {
    assert.match(chatSrc, /drop\.adWait\+\+/);
    assert.match(chatSrc, /drop\.kickWait\+\+/);
    assert.match(chatSrc, /已破冰、等回复未到探测时间/);
    assert.match(chatSrc, /本轮已做过动作、等下一轮催加/);
  });

  it('复活会话一律放行，不会因为“已收口”被再次丢掉', () => {
    assert.match(chatSrc, /!peerLastActionable && !revived && !actionableLedger/);
  });

  it('收口后新来信不再写“人工复核”', () => {
    assert.doesNotMatch(chatSrc, /人工复核/);
  });
});

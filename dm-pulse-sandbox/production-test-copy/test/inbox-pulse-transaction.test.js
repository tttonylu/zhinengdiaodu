'use strict';
/**
 * 4.9.26：脉冲事务边界。
 *
 * 现场根因：扫描阶段就把 reopenedAt 写成“已提醒”，但会话还没打开；
 * 只要中间抛一次异常，目标就会被永久当成 already_surfaced，以后再也不碰。
 * 这里锁死两个契约：
 * 1. 扫描只排队（closedInboundPendingAt），不写“已读”；
 * 2. pulse_exception 保留 pending、5 秒重试，并记录崩在哪一步。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'content_chat.js'), 'utf8');

describe('私信脉冲事务边界', () => {
  it('扫描阶段只排队，不能提前写 reopenedAt', () => {
    const at = chatSrc.indexOf('closed_inbound_queued_for_reply_check');
    assert.ok(at > 0, '找不到收口后来信排队分支');
    const block = chatSrc.slice(at, at + 1600);
    assert.match(block, /closedInboundPendingAt/);
    assert.match(block, /reopenedReason/);
    assert.doesNotMatch(block, /reopenedAt\s*=/);
  });

  it('pulse_exception 必须保留 pending、5 秒重试并记录阶段', () => {
    const at = chatSrc.indexOf("result.reason = 'pulse_exception'");
    assert.ok(at > 0, '找不到 pulse_exception 分支');
    const block = chatSrc.slice(at, at + 500);
    assert.match(block, /result\.stage = inboxStageRead\(\)/);
    assert.match(block, /result\.retryInMs = 5000/);
    assert.match(chatSrc, /result\.reason === 'pulse_exception'/);
  });

  it('正文读成功也不能立刻写已核对，必须等整拍走完', () => {
    const readAt = chatSrc.indexOf("var closedInboundCheckVerdict = ''");
    assert.ok(readAt > 0, '找不到收口核对暂存变量');
    const readBlock = chatSrc.slice(readAt, readAt + 1400);
    assert.match(readBlock, /closedInboundCheckVerdict = replyVerdict/);
    assert.doesNotMatch(readBlock, /closedInboundCheckedAt\s*=/);

    const applyAt = chatSrc.indexOf('cDb[targetHandle].closedInboundCheckedAt = Date.now()');
    assert.ok(applyAt > readAt, '已核对标记必须在整拍末尾再写');
  });

  it('旧版异常留下的已读标记会一次性重核', () => {
    assert.match(chatSrc, /sg_inbox_recheck_closed_inbound_v4926/);
    assert.match(chatSrc, /function migrateClosedInboundRecheckOnce\(\)/);
    assert.match(chatSrc, /chat\.inbox_ledger_recheck/);
    assert.match(chatSrc, /migrateClosedInboundRecheckOnce\(\)/);
  });

  it('有积压时必须连续排水，不能每 60 秒才处理一个', () => {
    // 只对“未读/对方最后发言/复活/广告债/催加”排水；
    // 纯探测不参与 8 秒排水，否则 100+ 个等待回复的人会把脉冲压成 8 秒一拍。
    assert.match(chatSrc, /var actionableRemaining = 0;/);
    assert.match(chatSrc, /result\.remainingCandidates = Math\.max\(0, actionableRemaining - 1\)/);
    assert.match(chatSrc, /hasBacklog \? 8000 : st\.intervalMs/);
    assert.match(chatSrc, /remaining_candidates: result\.remainingCandidates \|\| 0/);
    assert.match(chatSrc, /backlog_drain: !!result\.backlogDrain/);
  });

  it('每次 tick 必须带出台账阶段，能直接解释为什么发或不发', () => {
    assert.match(chatSrc, /ledger_stage: stateInfo \? \(stateInfo\.stage \|\| ''\) : ''/);
    assert.match(chatSrc, /ledger_ad_sent: !!\(dbEntry && \(dbEntry\.adSentAt \|\| dbEntry\.adBubbleOk\)\)/);
    assert.match(chatSrc, /ledger_kick_count: dbEntry \? \(Number\(dbEntry\.kickCount\) \|\| 0\) : 0/);
    assert.match(chatSrc, /ledger_closed: stateInfo \? !!stateInfo\.closed : false/);
  });
});

'use strict';
/**
 * 4.9.50 回归守卫：
 *  1) 收口后真回复必须重新开一轮，并且“没发出去就不算处理过”；
 *  2) 脉冲必须真的下滑（扫描节流阈值不能等于脉冲间隔）；
 *  3) 两次催加之间至少隔一次轮询（默认 60 秒）；
 *  4) 最小化窗口不允许被插件强行还原。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const chatSrc = fs.readFileSync(path.join(root, 'chat', 'content_chat.js'), 'utf8');
const stateSrc = fs.readFileSync(path.join(root, 'chat', 'inbox-state.js'), 'utf8');
const decisionSrc = fs.readFileSync(path.join(root, 'chat', 'inbox-decision.js'), 'utf8');
const gatesSrc = fs.readFileSync(path.join(root, 'chat', 'chat-gates.js'), 'utf8');
const bgSrc = fs.readFileSync(path.join(root, 'background.js'), 'utf8');

describe('收口后复活必须真的处理', () => {
  it('运行时与契约都支持 reopened', () => {
    assert.match(stateSrc, /state\.closed && opts\.reopened/);
    assert.match(stateSrc, /reopen_inbound/);
    assert.match(decisionSrc, /isFullyClosed\(entry\) && opts\.reopened/);
  });

  it('发送失败不能写 reopenedAt / checkedAt；只有读成功且状态机明确不发才结案', () => {
    assert.match(chatSrc, /var reopenSettled = sent/);
    assert.match(chatSrc, /replyVerdict === 'no_new_reply'/);
    assert.match(chatSrc, /decisionRes\.action !== 'send'/);
    assert.match(chatSrc, /effectiveRevived && reopenSettled/);
    assert.match(chatSrc, /closedInboundCheckVerdict && targetHandle/);
    assert.match(chatSrc, /sent \|\| replyVerdict === 'no_new_reply'/);
  });

  it('一次性的历史修复：把“只标已读”的人放回队列', () => {
    assert.match(chatSrc, /sg_inbox_reopen_cycle_v4950/);
    assert.match(chatSrc, /migrateReopenCycleOnce\(\)/);
  });

  it('超时放弃与“发送开关关闭”要分开报', () => {
    assert.match(chatSrc, /sendAbortedByTimeout = true/);
    assert.match(chatSrc, /pulse_aborted/);
    assert.match(chatSrc, /上一拍已超时放弃（本拍不再发送）/);
  });

  it('心跳带台账规模，能直接看出有没有这个人', () => {
    assert.match(chatSrc, /total: 0, with_peer: 0, iced: 0, closed: 0, no_peer_iced: 0, no_display: 0/);
  });
});

describe('脉冲必须真的下滑', () => {
  it('深扫 3 分钟一次，中间拍用整份列表的文字快照，不能只看首屏', () => {
    assert.match(chatSrc, /\(Date\.now\(\) - lastDeepAt\) > 180000/);
    assert.doesNotMatch(chatSrc, /\(Date\.now\(\) - lastDeepAt\) > 25000/);
    assert.match(chatSrc, /loadInboxDeepRowsCache\(8 \* 60 \* 1000\)/);
    assert.match(chatSrc, /served_from_cache: true/);
    assert.match(chatSrc, /saveInboxDeepRowsCache/);
  });

  it('peerLast 统计整张列表，而不是只看候选', () => {
    assert.match(chatSrc, /scanInfo\.peerLast = Number\(speakerCounts\.peer\) \|\| 0;/);
  });

  it('深扫要验证真实滚动容器，并确认真的回到顶部', () => {
    assert.match(chatSrc, /function canMoveByScrollTop/);
    assert.match(chatSrc, /evidence\.scrollerVerified = true/);
    assert.match(chatSrc, /evidence\.topResetOk/);
    const reveal = chatSrc.slice(
      chatSrc.indexOf('async function revealInboxRowForItem'),
      chatSrc.indexOf('async function revealInboxRowForItem') + 3200
    );
    const scrollerFn = chatSrc.slice(
      chatSrc.indexOf('function getInboxListScroller'),
      chatSrc.indexOf('function getInboxListScroller') + 3600
    );
    assert.match(scrollerFn, /function canMove/);
    assert.match(reveal, /scrollIntoView/);
  });

  it('深度扫描选中的目标不在首屏时，不能整拍放弃', () => {
    assert.match(chatSrc, /if \(!candidates\.length && \(opts\.pickKey \|\| opts\.pickItem\)\) \{/);
    assert.match(chatSrc, /if \(opts\.pickItem\) candidates = \[opts\.pickItem\];/);
  });
});

describe('催加节奏 = 真实间隔', () => {
  it('运行时/契约保留 60 秒下限，闸门默认 3 小时', () => {
    assert.match(stateSrc, /var DEFAULT_KICK_GAP_MS = 60 \* 1000;/);
    assert.match(decisionSrc, /var INBOX_KICK_GAP_MS = 60 \* 1000;/);
    assert.match(gatesSrc, /isNaN\(h\) \? 180 : h \* 60/);
  });
});

describe('不再强行弹出 Chrome 窗口', () => {
  it('最小化窗口直接延后，不 windows.update(state:normal)', () => {
    assert.match(bgSrc, /error: 'window_minimized'/);
    assert.match(bgSrc, /guardMinimized\(function \(\)/);
  });
});

// 用户截图里一屏人没回，后台却只有几个数字 —— 因为旧心跳只统计
// 「已破冰、还欠广告或催加」的人，看不到没破冰/已婉拒/对方关闭收件箱的分布。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const chatSrc = fs.readFileSync(path.join(root, 'chat', 'content_chat.js'), 'utf8');
const stateSrc = fs.readFileSync(path.join(root, 'chat', 'inbox-state.js'), 'utf8');

test('心跳要带全台账「为什么不回」分布', () => {
  assert.match(chatSrc, /function inboxNoReplyBreakdown\(\)/);
  assert.match(chatSrc, /no_reply_breakdown: inboxNoReplyBreakdown\(\)/);
});

test('分类必须覆盖没破冰/欠广告/欠催加/已完结/已婉拒/已拉黑/对方关闭', () => {
  const at = chatSrc.indexOf('function inboxNoReplyBreakdown()');
  assert.ok(at > 0);
  const block = chatSrc.slice(at, at + 3000);
  for (const bucket of ['not_iced', 'ad_pending', 'kick_pending', 'closed_done', 'rejected', 'blocked', 'inbox_closed']) {
    assert.match(block, new RegExp(bucket), '缺少分类 ' + bucket);
  }
});

test('已拉黑/已婉拒必须优先于「没破冰」判定', () => {
  const at = chatSrc.indexOf('function inboxNoReplyBreakdown()');
  const block = chatSrc.slice(at, at + 3000);
  const blockedAt = block.indexOf("bucket = 'blocked'");
  const rejectedAt = block.indexOf("bucket = 'rejected'");
  const notIcedAt = block.indexOf("bucket = 'not_iced'");
  assert.ok(blockedAt > 0 && rejectedAt > 0 && notIcedAt > 0);
  assert.ok(blockedAt < notIcedAt, '已拉黑不能被归到没破冰');
  assert.ok(rejectedAt < notIcedAt, '已婉拒不能被归到没破冰');
});

test('对方关闭收件箱要单独成一类，不能混进已完结', () => {
  const at = chatSrc.indexOf('function inboxNoReplyBreakdown()');
  const block = chatSrc.slice(at, at + 3000);
  const closedAt = block.indexOf("bucket = 'inbox_closed'");
  const doneAt = block.indexOf("bucket = 'closed_done'");
  assert.ok(closedAt > 0 && doneAt > 0);
  assert.ok(closedAt < doneAt, '关闭收件箱必须先判，否则会被算成已完结');
});

test('样本只留还在进行中的人，已完结不占位', () => {
  const at = chatSrc.indexOf('function inboxNoReplyBreakdown()');
  const block = chatSrc.slice(at, at + 3200);
  assert.match(block, /bucket !== 'closed_done' && bucket !== 'rejected' && bucket !== 'blocked'/);
  assert.match(block, /out\.samples\.length < 12/);
});

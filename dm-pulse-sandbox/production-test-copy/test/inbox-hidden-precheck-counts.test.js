// 后台标签页预检：必须先把「未读」「对方最后发言」算完，再决定有没有活。
// 现场问题（2026-11-13 13:58）：OPS 每拍都是 unread=0 / peer_last=0，
// 同一份列表在可见拍却是 peer_last=16，导致无法回答「到底有没有回复」。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const chatSrc = fs.readFileSync(path.join(root, 'chat', 'content_chat.js'), 'utf8');

function bodyOf(fnName) {
  const start = chatSrc.indexOf('function ' + fnName);
  assert.ok(start > 0, '缺少 ' + fnName);
  const end = chatSrc.indexOf('\n    async function ', start + 10);
  return chatSrc.slice(start, end > 0 ? end : start + 20000);
}

test('隐藏预检在候选判定之前就算完未读与对方最后发言', () => {
  const body = bodyOf('hiddenInboxHasWork');
  const countAt = body.indexOf('out.peer_last++');
  const candAt = body.indexOf('collectInboxWatchCandidates');
  assert.ok(countAt > 0, '隐藏预检必须统计 peer_last');
  assert.ok(candAt > 0, '隐藏预检必须复用候选判定');
  assert.ok(
    countAt < candAt,
    'peer_last 计数必须在候选判定之前完成，否则候选分支 return 后 OPS 永远是 0'
  );
});

test('隐藏预检的未读计数同样先于候选判定', () => {
  const body = bodyOf('hiddenInboxHasWork');
  const unreadAt = body.indexOf('if ((getInboxRowUnread(rowC0) || {}).unread) out.unread++');
  const candAt = body.indexOf('collectInboxWatchCandidates');
  assert.ok(unreadAt > 0, '隐藏预检必须先统计未读');
  assert.ok(unreadAt < candAt, '未读计数必须在候选判定之前');
});

test('蓝点取证必须同时看行内与父级容器', () => {
  assert.match(chatSrc, /pDots: parentDots/);
  assert.match(chatSrc, /probeUnreadDots\(rowP\.parentElement, 8\)/);
});

test('未读与对方最后发言只统计一次，不能在兜底分支重复累加', () => {
  const body = bodyOf('hiddenInboxHasWork');
  const unreadIncs = body.match(/out\.unread\+\+/g) || [];
  const peerIncs = body.match(/out\.peer_last\+\+/g) || [];
  assert.equal(unreadIncs.length, 1, '未读只能有一个累加点，否则候选判定异常时会重复计数');
  assert.equal(peerIncs.length, 1, '对方最后发言只能有一个累加点');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'content_chat.js'), 'utf8');
const adapterSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'inbox-v2-adapter.js'), 'utf8');

function block(startMarker, endMarker) {
  const start = chatSrc.indexOf(startMarker);
  assert.ok(start >= 0, '缺少起点：' + startMarker);
  const end = endMarker ? chatSrc.indexOf(endMarker, start) : chatSrc.length;
  assert.ok(end > start, '缺少终点：' + endMarker);
  return chatSrc.slice(start, end);
}

test('破冰之后的对方文本全部纳入，不再只取最后一条我方气泡之后', () => {
  const fn = block('function collectPeerTextsAfterIceTurn()', '守箱专用兜底');
  assert.match(fn, /iceIdx \+ 1/);
  assert.match(fn, /classified\[j\]\.kind === 'peer'/);
  assert.doesNotMatch(fn, /lastOwn|lastOwnIdx/);
});

test('破冰气泡被虚拟列表回收时，全部可见对方文本作为破冰后回复', () => {
  const fn = block('function collectPeerTextsAfterIceTurn()', '守箱专用兜底');
  assert.match(fn, /ownCnt === 0/);
  assert.match(fn, /pushPeer\(classified\[pj\]\.text/);
});

test('会话页会向上回翻寻找破冰气泡，再回到底部', () => {
  const fn = block('async function loadOlderDmHistoryForIce', '守箱专用兜底');
  assert.match(fn, /sc\.scrollTop = 0/);
  assert.match(fn, /foundIce/);
  assert.match(fn, /scrollDmConversationToBottom\(\)/);
  assert.match(fn, /Math\.min\(4/);
});

test('等待消息渲染期间持续贴底，滚动容器按真实祖先识别', () => {
  const scrollFn = block('function findDmScrollContainer()', 'function waitMs(');
  assert.match(scrollFn, /parentElement/);
  assert.match(scrollFn, /overflowY/);
  assert.match(scrollFn, /scored\.sort/);
  const waitBlock = block('while (Date.now() < msgDeadline)', 'inboxStageMark(\'msg_wait_done\')');
  assert.match(waitBlock, /scrollDmConversationToBottom\(\)/);
  assert.match(waitBlock, /loadOlderDmHistoryForIce/);
});

test('候选行与打开地址不一致时必须 open_target_mismatch，且不读回复不写台账', () => {
  const fn = block("reason: 'open_target_mismatch'", 'try { inboxAutoProbe()');
  assert.match(fn, /本拍不读回复、不写台账、不发送/);
  assert.match(chatSrc, /open_target_mismatch: '打开的会话与候选行不是同一个人/);
  assert.match(chatSrc, /result\.reason === 'open_target_mismatch'/);
});

test('单段 row.id 必须用 href 补齐两段 id', () => {
  assert.match(adapterSrc, /firstId: byId \? byId\[1\] : \(byHref \? byHref\[1\] : ''\)/);
  assert.match(adapterSrc, /secondId: byId \? byId\[2\] : \(byHref \? byHref\[2\] : ''\)/);
});

test('同一批对方文本用指纹只执行一次，发送失败不写指纹', () => {
  assert.match(chatSrc, /lastProcessedPeerHash/);
  assert.match(chatSrc, /peerTextUnchanged/);
  assert.match(chatSrc, /identity\.ok && peerHashNow && peerBatchSettled/);
});

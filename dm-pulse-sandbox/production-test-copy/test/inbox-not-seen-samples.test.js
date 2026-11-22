// 台账有、列表找不到的人必须点名上报。
// 这类会话在收件箱列表里根本不出现，未读和“对方最后发言”都抓不到它，
// 只给一个 not_seen_in_list 数字，现场无法回答“到底是谁丢了”。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const chatSrc = fs.readFileSync(path.join(root, 'chat', 'content_chat.js'), 'utf8');

test('完整扫描未命中台账目标时要留点名样本', () => {
  assert.match(chatSrc, /notSeenSamples: \[\]/);
  assert.match(chatSrc, /drop\.notSeenSamples\.push\(/);
  const incAt = chatSrc.indexOf('drop.notSeenInList++;');
  const pushAt = chatSrc.indexOf('drop.notSeenSamples.push(');
  assert.ok(incAt > 0 && pushAt > 0);
  assert.ok(pushAt > incAt, '点名样本必须和计数在同一处，且不能早于计数');
});

test('OPS 扫描丢弃事件要带 not_seen_samples', () => {
  assert.match(chatSrc, /not_seen_samples: \(dropD\.notSeenSamples \|\| \[\]\)\.slice\(0, 6\)/);
});

test('未命中样本必须包含 handle / round / 结论，能直接定位到人', () => {
  const at = chatSrc.indexOf('drop.notSeenSamples.push(');
  assert.ok(at > 0);
  const block = chatSrc.slice(at, at + 700);
  assert.match(block, /handle:/);
  assert.match(block, /round:/);
  assert.match(block, /verdict:/);
  assert.match(block, /miss:/);
});

test('没有 peerId 也没有显示名的台账不能按“会话不存在”收口', () => {
  // 这类条目永远匹配不上列表行，旧逻辑仍累加 miss，
  // 12 次后按 conversation_not_in_inbox 关掉，真实会话就被永久丢弃。
  assert.match(chatSrc, /var canMatchRow = !!\(String\(me\.peerId \|\| ''\)\.replace\(\/\\D\/g, ''\)/);
  const at = chatSrc.indexOf('if (!canMatchRow) {');
  assert.ok(at > 0, '缺少「不可匹配」分支');
  const block = chatSrc.slice(at, at + 900);
  assert.match(block, /continue;/, '不可匹配必须跳过收口判定');
  assert.match(block, /unmatchable_no_identity/);
  assert.match(block, /notSeenUnmatchable/);
});

test('不可匹配人数要单独上报，不能混进“找不到会话”', () => {
  assert.match(chatSrc, /not_seen_unmatchable: Number\(dropD\.notSeenUnmatchable\) \|\| 0/);
});

test('p<peerId> 台账要把 peerId 从键里补回字段，不能当无身份', () => {
  // 键本身就是 peerId，只是没写进 peerId 字段。旧逻辑把它当「无身份」，
  // 于是这条台账永远匹配不上列表，本人就再也不会被处理。
  assert.match(chatSrc, /var keyPeer = String\(mh \|\| ''\)\.match\(\/\^p\(\\d\{5,\}\)\$\/\)/);
  assert.match(chatSrc, /me\.peerId = keyPeer\[1\]/);
  assert.match(chatSrc, /peerIdFromKeyAt/);
});

test('真实 @handle 也要算可匹配，只有 dn_/p<数字> 合成键才算无身份', () => {
  assert.match(chatSrc, /!\/\^dn_\/i\.test\(String\(mh \|\| ''\)\) && !\/\^p\\d\{5,\}\$\/\.test\(String\(mh \|\| ''\)\)/);
});

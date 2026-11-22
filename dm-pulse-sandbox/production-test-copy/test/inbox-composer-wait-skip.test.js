// 对方关闭收件箱/会话只读时，X 永远不会给输入框。
// 旧逻辑在“等输入框”这段空等满 30 秒，一拍只有 3–4 分钟，这 30 秒纯浪费；
// 而且这个会话本来就发不出去，等再久也不会变。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const chatSrc = fs.readFileSync(path.join(root, 'chat', 'content_chat.js'), 'utf8');

test('等输入框期间要能提前识别只读会话并停止空等', () => {
  assert.match(chatSrc, /var composerWaitSkip = '';/);
  assert.match(chatSrc, /composerWaitSkip = 'peer_inbox_closed';/);
});

test('提前退出必须真的跳出等待循环，而不是只置标记', () => {
  const at = chatSrc.indexOf("composerWaitSkip = 'peer_inbox_closed';");
  assert.ok(at > 0);
  const block = chatSrc.slice(at, at + 200);
  assert.match(block, /break;/);
});

test('提前退出后结论仍要落成 peer_inbox_closed，不能变成 no_composer 技术失败', () => {
  assert.match(chatSrc, /if \(!peerInboxClosed && composerWaitSkip === 'peer_inbox_closed'\) \{/);
  const at = chatSrc.indexOf("if (!peerInboxClosed && composerWaitSkip === 'peer_inbox_closed') {");
  const block = chatSrc.slice(at, at + 300);
  assert.match(block, /peerInboxClosed = 'peer_inbox_closed';/);
});

test('提前探测不能每 500ms 跑一次，至少等 1.2 秒再查横幅', () => {
  const at = chatSrc.indexOf('var closedEarly =');
  assert.ok(at > 0);
  const before = chatSrc.slice(Math.max(0, at - 400), at);
  assert.match(before, /compWaitMs > 1200/);
});

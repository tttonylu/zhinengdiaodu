// 蓝点探测必须能自证：只报 dots:[] 无法区分
// 「这行真的没有蓝点」和「蓝点的尺寸/颜色不在判定清单里」。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const chatSrc = fs.readFileSync(path.join(root, 'chat', 'content_chat.js'), 'utf8');

test('未读探针要带右缘候选元素清单', () => {
  assert.match(chatSrc, /var rightEdge = \[\];/);
  assert.match(chatSrc, /edge: rightEdge/);
});

test('右缘清单必须记录尺寸、位置与颜色，才能判断为什么没命中', () => {
  const at = chatSrc.indexOf('var rightEdge = [];');
  assert.ok(at > 0);
  const block = chatSrc.slice(at, at + 2200);
  assert.match(block, /w: Math\.round\(rQ\.width\)/);
  assert.match(block, /dx: Math\.round\(rrP\.right - rQ\.right\)/);
  assert.match(block, /bg: stQ \? String\(stQ\.backgroundColor/);
  assert.match(block, /fill:/);
});

test('右缘清单要限制范围，不能把整行元素都塞进事件', () => {
  const at = chatSrc.indexOf('var rightEdge = [];');
  const block = chatSrc.slice(at, at + 2200);
  assert.match(block, /rightEdge\.length < 10/);
  assert.match(block, /rQ\.left < rrP\.right - 70/);
  assert.match(block, /rQ\.width > 40 \|\| rQ\.height > 40/);
});

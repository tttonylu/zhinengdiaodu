'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadAdapter() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'chat', 'inbox-v2-adapter.js'), 'utf8');
  const window = {};
  vm.runInNewContext(src, { window, document: {}, NodeFilter: { SHOW_ELEMENT: 1 } });
  return window.SgInboxV2Adapter;
}

function row(id, href) {
  return {
    id,
    innerText: '',
    getAttribute(name) {
      if (name === 'href') return href;
      return '';
    }
  };
}

test('单段 row.id + 两段 href：解析出完整两段 id', () => {
  const adapter = loadAdapter();
  const parsed = adapter.parseIds(row(
    'dm-conversation-option-1921556032637345792',
    '/i/chat/1921556032637345792-2077611630628884480'
  ));
  assert.equal(parsed.valid, true);
  assert.equal(parsed.firstId, '1921556032637345792');
  assert.equal(parsed.secondId, '2077611630628884480');
});

test('单段 row.id 时按本号 id 反推对方，不会把本号当成 peer', () => {
  const adapter = loadAdapter();
  const parsed = adapter.resolvePeerId(row(
    'dm-conversation-option-1921556032637345792',
    '/i/chat/1921556032637345792-2077611630628884480'
  ), '2077611630628884480');
  assert.equal(parsed.valid, true);
  assert.equal(parsed.peerId, '1921556032637345792');
  assert.equal(parsed.order, 'peer-first');
});

test('两段 id 都不等于本号时判定为 unresolved，不允许猜对方', () => {
  const adapter = loadAdapter();
  const parsed = adapter.resolvePeerId(row(
    'dm-conversation-option-111111111111111',
    '/i/chat/222222222222222-333333333333333'
  ), '999999999999999');
  assert.equal(parsed.valid, false);
  assert.equal(parsed.peerId, '');
});

test('detectMyId 只统计两段都完整的行', () => {
  const adapter = loadAdapter();
  const rows = [
    row('dm-conversation-option-111:999', '/i/chat/111-999'),
    row('dm-conversation-option-222:999', '/i/chat/222-999'),
    row('dm-conversation-option-333', '')
  ];
  assert.equal(adapter.detectMyId(rows), '999');
});

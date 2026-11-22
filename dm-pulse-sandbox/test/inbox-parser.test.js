'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseInboxSample } = require('../extension/src/inbox-parser');
const { unreadFixture, readFixture } = require('../fixtures/xchat-v2-samples');

describe('xchat-v2 inbox parser', () => {
  it('识别 9 行且只把 circle-fill 行当未读', () => {
    const result = parseInboxSample(unreadFixture);
    assert.equal(result.schema, 'xchat-v2');
    assert.equal(result.rows.length, 9);
    assert.deepEqual(result.rows.map(row => row.unread), [true, false, false, false, false, false, false, false, false]);
    assert.equal(result.rows[0].selfPreview, false);
    assert.equal(result.rows[8].selfPreview, true);
    assert.equal(result.selectorHealth.valid, true);
  });

  it('全已读不被认证图标误判', () => {
    const result = parseInboxSample(readFixture);
    assert.equal(result.unreadRows, 0);
    assert.equal(result.rows.length, 2);
  });

  it('非法会话 ID 和旧 schema 显式失败', () => {
    assert.throws(() => parseInboxSample({ ...unreadFixture, rows: [{ ...unreadFixture.rows[0], id: 'bad' }] }), /idShapeValid/);
    assert.equal(parseInboxSample({ surface: 'list', listReady: true, rows: [{ kind: 'legacy' }] }).verdict, 'unsupported_schema');
  });

  it('匿名键来自真实会话身份而非数组位置', () => {
    const replaced = { ...unreadFixture, rows: unreadFixture.rows.map((row, index) => index === 0 ? { ...row, id: 'dm-conversation-option-3000000000000000000:4000000000000000000', href: '/i/chat/3000000000000000000-4000000000000000000' } : row) };
    const original = parseInboxSample(unreadFixture);
    const changed = parseInboxSample(replaced);
    assert.notEqual(original.rows[0].conversationKey, changed.rows[0].conversationKey);
    assert.equal(original.rows[1].conversationKey, changed.rows[1].conversationKey);
    assert.doesNotMatch(original.rows[0].conversationKey, /\d{5,}/);
  });

  it('拒绝与会话行 ID 不匹配的链接', () => {
    const invalid = { ...unreadFixture, rows: [{ ...unreadFixture.rows[0], href: '/home' }] };
    assert.throws(() => parseInboxSample(invalid), /hrefMatchesId/);
  });
});

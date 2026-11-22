'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('UMD browser compatibility', () => {
  it('selectors 在浏览器全局暴露 DmPulseSelectors', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'src', 'selectors.js'), 'utf8');
    assert.match(src, /DmPulseSelectors/);
    assert.doesNotMatch(src, /^const .* = require\(/m);
  });

  it('inbox-parser 在浏览器全局暴露 DmPulseInboxParser', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'src', 'inbox-parser.js'), 'utf8');
    assert.match(src, /DmPulseInboxParser/);
    assert.doesNotMatch(src, /node:crypto/);
  });

  it('pulse 在浏览器全局暴露 DmPulsePulse', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'src', 'pulse.js'), 'utf8');
    assert.match(src, /DmPulsePulse/);
  });

  it('report 在浏览器全局暴露 DmPulseReport', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'src', 'report.js'), 'utf8');
    assert.match(src, /DmPulseReport/);
  });

  it('conversation 在浏览器全局暴露 DmPulseConversation', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'src', 'conversation.js'), 'utf8');
    assert.match(src, /DmPulseConversation/);
  });

  it('匿名键由真实 ID 派生且不含长数字串', () => {
    const { parseInboxSample } = require('../extension/src/inbox-parser');
    const { unreadFixture } = require('../fixtures/xchat-v2-samples');
    const result = parseInboxSample(unreadFixture);
    assert.ok(result.rows[0].conversationKey.startsWith('conversation-'));
    assert.doesNotMatch(result.rows[0].conversationKey, /\d{5,}/);
    const changed = { ...unreadFixture, rows: [{ ...unreadFixture.rows[0], id: 'dm-conversation-option-9999999999999999999:8888888888888888888', href: '/i/chat/9999999999999999999-8888888888888888888' }] };
    const result2 = parseInboxSample(changed);
    assert.notEqual(result.rows[0].conversationKey, result2.rows[0].conversationKey);
  });

  it('深扫探针只滚动列表，不填写、不写存储', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'probe.js'), 'utf8');
    assert.match(source, /scrollTop/);
    assert.doesNotMatch(source, /\.fill\(|localStorage\.(setItem|removeItem|clear)|sessionStorage\.(setItem|removeItem|clear)|fetch\(/);
    assert.doesNotMatch(source, /location\.(assign|replace|href)\s*=/);
  });

  it('会话探针只允许显式打开，且不填写输入框', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'probe.js'), 'utf8');
    assert.match(source, /opts\.action === 'read_unread'/);
    assert.match(source, /opts\.allowOpen !== true/);
    assert.match(source, /target\.click\(\)/);
    assert.match(source, /role="article"/);
    assert.doesNotMatch(source, /\.fill\(|\.value\s*=|composer\.focus|pressKey|Enter/);
  });
});

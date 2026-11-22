/**
 * B3 · 关注语言门（4.6.40：产品关闭只点日文，onlyJapanese 恒 false → 一律放行）
 * Run: node unified-scheduler/test/follow-ja-gate.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function hasJapaneseText(s) {
  return /[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/.test(String(s || ''));
}
function hasJaOrZhText(s) {
  return hasJapaneseText(s);
}

function decideFollowTargetJa(name, bio, onlyJapanese, extra) {
  var n = String(name || '').trim();
  var b = String(bio || '').trim();
  var x = String(extra || '').trim();
  var content = [n, b, x].filter(Boolean).join(' | ');
  var isJp = hasJaOrZhText(n) || hasJaOrZhText(b) || hasJaOrZhText(x);
  var isPureEng = /[a-zA-Z]/.test(content) && !isJp;
  var isEmpty = !content;
  if (!onlyJapanese) {
    return { pass: true, reason: 'lang_gate_off', isJp: isJp, isPureEng: isPureEng };
  }
  if (isJp) return { pass: true, reason: 'ja_zh', isJp: true, isPureEng: false };
  if (isEmpty) return { pass: false, reason: 'empty', isJp: false, isPureEng: false };
  if (isPureEng) return { pass: false, reason: 'pure_eng', isJp: false, isPureEng: true };
  return { pass: false, reason: 'no_ja_zh', isJp: false, isPureEng: false };
}

describe('B3 · 4.6.40 语言门关闭', () => {
  it('onlyJapanese=false 纯英文也过', () => {
    const r = decideFollowTargetJa('John', 'Hello world', false);
    assert.equal(r.pass, true);
    assert.equal(r.reason, 'lang_gate_off');
  });
  it('onlyJapanese=false 空也过', () => {
    assert.equal(decideFollowTargetJa('', '', false).pass, true);
  });
});

describe('B3 · 语言门开启时（保留逻辑，供日后重开）', () => {
  it('纯中文过', () => assert.equal(decideFollowTargetJa('小明', '', true).pass, true));
  it('纯英文踢', () => assert.equal(decideFollowTargetJa('John', 'Hi', true).pass, false));
  it('extra 救回', () => {
    assert.equal(decideFollowTargetJa('John', 'Hi', true, '東京在住').pass, true);
  });
});

describe('B3 · 源码强制关闭', () => {
  it('isOnlyJapaneseEnabled 恒 return false', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'follow', 'content_follow_v1522.js'),
      'utf8'
    );
    assert.match(src, /function isOnlyJapaneseEnabled\(\)\s*\{\s*return false;/);
    assert.match(src, /lang_gate_off/);
  });
});

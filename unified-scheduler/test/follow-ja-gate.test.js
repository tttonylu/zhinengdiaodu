/**
 * B3 · 关注防老外日文门（4.6.37）
 * 与 follow/content_follow_v1522.js 的 hasJapaneseText / decideFollowTargetJa 保持同步。
 * Run: node unified-scheduler/test/follow-ja-gate.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// --- 纯函数副本（须与 content_follow_v1522.js 一致）---
function hasJapaneseText(s) {
  return /[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/.test(String(s || ''));
}

function decideFollowTargetJa(name, bio, onlyJapanese) {
  var n = String(name || '').trim();
  var b = String(bio || '').trim();
  var content = [n, b].filter(Boolean).join(' | ');
  var isJp = hasJapaneseText(n) || hasJapaneseText(b);
  var isPureEng = /[a-zA-Z]/.test(content) && !isJp;
  var isEmpty = !content;
  if (onlyJapanese) {
    if (isJp) return { pass: true, reason: 'ja', isJp: true, isPureEng: false };
    if (isEmpty) return { pass: false, reason: 'empty', isJp: false, isPureEng: false };
    if (isPureEng) return { pass: false, reason: 'pure_eng', isJp: false, isPureEng: true };
    return { pass: false, reason: 'no_ja', isJp: false, isPureEng: false };
  }
  if (isEmpty) return { pass: false, reason: 'empty', isJp: isJp, isPureEng: isPureEng };
  return { pass: true, reason: 'all_mode', isJp: isJp, isPureEng: isPureEng };
}

describe('B3 follow JA gate · hasJapaneseText', () => {
  it('短平假名', () => assert.equal(hasJapaneseText('みく'), true));
  it('短片假名', () => assert.equal(hasJapaneseText('ミク'), true));
  it('纯汉字日名', () => assert.equal(hasJapaneseText('山田太郎'), true));
  it('半角假名', () => assert.equal(hasJapaneseText('ﾐｸ'), true));
  it('英文无日文', () => assert.equal(hasJapaneseText('Hello world'), false));
  it('空串', () => assert.equal(hasJapaneseText(''), false));
});

describe('B3 follow JA gate · decideFollowTargetJa (onlyJapanese=true)', () => {
  it('短日文名 → 过（不再 length>8）', () => {
    const r = decideFollowTargetJa('みく', '', true);
    assert.equal(r.pass, true);
    assert.equal(r.reason, 'ja');
  });

  it('纯汉字短日名 → 过', () => {
    const r = decideFollowTargetJa('山田太郎', '', true);
    assert.equal(r.pass, true);
  });

  it('日文名 + 英文简介 → 过（名侧救回）', () => {
    const r = decideFollowTargetJa('さくら', 'I love coffee and travel around the world', true);
    assert.equal(r.pass, true);
    assert.equal(r.reason, 'ja');
  });

  it('英文名 + 日文简介 → 过', () => {
    const r = decideFollowTargetJa('Sakura', 'こんにちは', true);
    assert.equal(r.pass, true);
  });

  it('半角假名简介 → 过', () => {
    const r = decideFollowTargetJa('User', 'ｶﾜｲｲ', true);
    assert.equal(r.pass, true);
  });

  it('纯英文名+简介 → 踢 pure_eng', () => {
    const r = decideFollowTargetJa('John Smith', 'Software engineer in Tokyo', true);
    assert.equal(r.pass, false);
    assert.equal(r.reason, 'pure_eng');
  });

  it('英译简介无日文名 → 踢（模拟未点显示原文）', () => {
    const r = decideFollowTargetJa('Mike', 'Hello everyone nice to meet you', true);
    assert.equal(r.pass, false);
    assert.equal(r.isPureEng, true);
  });

  it('空 name+bio → 踢 empty', () => {
    const r = decideFollowTargetJa('', '', true);
    assert.equal(r.pass, false);
    assert.equal(r.reason, 'empty');
  });

  it('短日文简介 ≤8 → 过', () => {
    const r = decideFollowTargetJa('', 'こんにちは', true);
    assert.equal(r.pass, true);
  });
});

describe('B3 follow JA gate · onlyJapanese=false', () => {
  it('纯英文也过', () => {
    const r = decideFollowTargetJa('John', 'Hello', false);
    assert.equal(r.pass, true);
    assert.equal(r.reason, 'all_mode');
  });

  it('完全空仍踢', () => {
    const r = decideFollowTargetJa('', '', false);
    assert.equal(r.pass, false);
    assert.equal(r.reason, 'empty');
  });
});

describe('B3 follow JA gate · 源文件导出锚点', () => {
  it('content_follow 含 SgFollowJaGate 与 decideFollowTargetJa', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'follow', 'content_follow_v1522.js'),
      'utf8'
    );
    assert.match(src, /function hasJapaneseText\(/);
    assert.match(src, /function decideFollowTargetJa\(/);
    assert.match(src, /window\.SgFollowJaGate\s*=/);
    // 旧 length>8 硬门不得残留在判定路径
    assert.equal(/isSubstantial\s*=\s*content\.length\s*>\s*8/.test(src), false);
  });
});

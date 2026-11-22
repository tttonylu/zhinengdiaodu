/**
 * 兼职粉意向解析冒烟（与 content_chat.parseJobIntent 规则对齐）
 * node unified-scheduler/test/job-intent.test.js
 */
'use strict';

function parseJobIntent(texts) {
  var text = '';
  try {
    if (Array.isArray(texts)) text = texts.join('\n');
    else text = String(texts || '');
  } catch (e) { text = String(texts || ''); }
  text = String(text || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'unknown';
  if (/やらな[いぃ]|やらねえ|やんない|やりません|やらなくて|いらない|要らない|興味ない|興味がありません|興味はありません|結構です|大丈夫です|辞退|無理|できない|嫌|やめ|不要|no thanks|pass|不做|不要做/i.test(text)) {
    return 'no';
  }
  if (/(^|[^\u3040-\u30ff\u4e00-\u9faf])やる([^\u3040-\u30ff\u4e00-\u9faf\u3089]|$)|^やる[！!。．]?$|やりたい|やってみたい|やります|やるよ|やるね|やるで|興味[ぁあ]?[るり]|興味あります|いいよ|いいです|お願いします|お願い|ぜひ|もちろん|OK|ＯＫ|ok\b|おｋ|了解.*やる|やる.*了解|したい|做$|^做[！!。．]?$/i.test(text)) {
    return 'yes';
  }
  return 'unknown';
}

var cases = [
  [['やる'], 'yes'],
  [['やらない'], 'no'],
  [['やりたい、24歳'], 'yes'],
  [['興味あるよ\n25です'], 'yes'],
  [['興味ない'], 'no'],
  [['大丈夫です'], 'no'],
  [['こんにちは'], 'unknown'],
  [['21歳です'], 'unknown'],
  [['やりたいけど21歳'], 'yes']
];

var fail = 0;
cases.forEach(function (c) {
  var got = parseJobIntent(c[0]);
  if (got !== c[1]) {
    console.error('FAIL', c[0], 'expected', c[1], 'got', got);
    fail++;
  } else {
    console.log('OK', JSON.stringify(c[0]), '→', got);
  }
});
if (fail) process.exit(1);
console.log('all passed');

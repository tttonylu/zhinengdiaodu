/**
 * Pure-logic QA：只要日语（须假名；拒外国文/纯中文/英文/纯图）
 * Run: node unified-scheduler/test/japanese-tweet-gate.test.js
 */
'use strict';

function hasKana(s) {
  return /[\u3040-\u309f\u30a0-\u30ff\uff66-\uff9f]/.test(String(s || ''));
}
function hasForeignScript(s) {
  return /[\u0900-\u097F\u0600-\u06FF\u0400-\u04FF\u0E00-\u0E7F\uAC00-\uD7AF\u0370-\u03FF]/.test(String(s || ''));
}
function decide(text, lang, hasPhoto) {
  if (!text) return false; // 纯图也不放行
  if (hasForeignScript(text)) return false;
  if (hasKana(text)) return true;
  return false;
}

var cases = [
  ['Hindi-only', 'नमस्ते दुनिया', 'hi', false, false],
  ['Hindi + lang=ja spoof', 'जरा सी चूक से हाथ', 'ja', false, false],
  ['English', 'Hello world nice day', 'en', false, false],
  ['Chinese-only', '你好世界今天天气', 'zh', false, false],
  ['Korean', '안녕하세요', 'ko', false, false],
  ['Arabic', 'مرحبا', 'ar', false, false],
  ['Japanese kana', 'こんにちは', '', false, true],
  ['Japanese mixed', '今日の天気はいい', 'ja', false, true],
  ['Romaji + lang=ja', 'ohayo', 'ja', false, false],
  ['Photo-only', '', '', true, false],
  ['Empty no photo', '', '', false, false],
  ['Kanji-only JP-looking', '今日天気', '', false, false],
  ['Mixed HI+JA', 'नमस्ते こんにちは', '', false, false],
  ['JA with URL', 'これ見て https://x.com/a すごい', '', false, true]
];

var fail = 0;
cases.forEach(function (c) {
  var got = decide(c[1], c[2], c[3]);
  var ok = got === c[4];
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + c[0] + ' → ' + got + ' (want ' + c[4] + ')');
  if (!ok) fail++;
});

if (fail) {
  console.error('FAILED ' + fail);
  process.exit(1);
}
console.log('ALL PASS');

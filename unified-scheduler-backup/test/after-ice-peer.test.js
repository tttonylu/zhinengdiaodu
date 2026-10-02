/**
 * 破冰后 peer 正文流冒烟（与 content_chat.collectPeerTextsAfterIceTurn 规则对齐）
 * node unified-scheduler/test/after-ice-peer.test.js
 */
'use strict';

function isOwnScriptText(line) {
  // 近似真实话术池：整句破冰才算 own；单独「やらない」是 peer 回复
  return /やる[？?／\/].*やらない|明日.*(動画|给)|part.?time|アルバイト/i.test(line);
}

function collectPeerAfterIceFromLines(lines) {
  var classified = [];
  var lastOwnIdx = -1;
  for (var i = 0; i < lines.length; i++) {
    var line = String(lines[i] || '').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (isOwnScriptText(line)) {
      classified.push({ kind: 'own', text: line });
      lastOwnIdx = classified.length - 1;
    } else {
      classified.push({ kind: 'peer', text: line });
    }
  }
  var out = [];
  if (lastOwnIdx >= 0) {
    for (var j = lastOwnIdx + 1; j < classified.length; j++) {
      if (classified[j].kind === 'peer') out.push(classified[j].text);
    }
  }
  return out;
}

var cases = [
  [['はなそーん', 'やる？やらない？'], []],
  [['やる？やらない？', 'やる'], ['やる']],
  [['やる？やらない？', 'やらない'], ['やらない']],
  [['こんにちは', 'やる？やらない？', 'はい'], ['はい']],
  [['はなそーん', 'やる？やらない？', 'やらない'], ['やらない']]
];

var fail = 0;
cases.forEach(function (c) {
  var got = collectPeerAfterIceFromLines(c[0]);
  var exp = c[1];
  var ok = got.length === exp.length && got.every(function (t, i) { return t === exp[i]; });
  if (!ok) {
    console.error('FAIL', c[0], 'expected', exp, 'got', got);
    fail++;
  } else {
    console.log('OK', JSON.stringify(c[0]), '→', JSON.stringify(got));
  }
});
if (fail) process.exit(1);
console.log('all passed');

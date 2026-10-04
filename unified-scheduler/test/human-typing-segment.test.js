/**
 * E1/D1 · 拟人输入/点击纯逻辑 QA（4.6.2）
 * 1) EngineUtils.segmentForTyping：片段拼接必须与原文完全一致（禁止重叠/丢字）
 * 2) EngineUtils.humanClick：一次点击只发一个 click 事件（禁止重复触发 onClick）
 * 运行：node unified-scheduler/test/human-typing-segment.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

/** 用最小沙箱加载真实 engine-utils.js，返回 EngineUtils */
function loadEngineUtils() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'shared', 'engine-utils.js'), 'utf8');
  const noop = function () {};
  const store = { getItem: function () { return null; }, setItem: noop, removeItem: noop };
  const names = ['window', 'document', 'sessionStorage', 'localStorage',
    'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
    'MouseEvent', 'PointerEvent', 'Event'];
  const vals = [{}, {}, store, store, function () { return 0; }, noop, setTimeout, clearTimeout,
    FakeEvent, FakeEvent, FakeEvent];
  const factory = new Function(names.join(','), src + '\n;return EngineUtils;');
  return factory.apply(null, vals);
}

function FakeEvent(type, init) {
  this.type = type;
  if (init) { for (var k in init) this[k] = init[k]; }
}

function makeEl() {
  return {
    _events: [],
    dispatchEvent: function (e) { this._events.push(e.type); return true; },
    getBoundingClientRect: function () { return { left: 10, top: 10, width: 100, height: 40 }; },
    focus: function () {},
    matches: function () { return true; },
    click: function () { this._events.push('native-click'); }
  };
}

(async function () {
  const E = loadEngineUtils();

  // ---- 1) 分段不变量：拼接 === 原文 ----
  const cases = [
    'Hello world',
    'https://x.com/abc123',
    'https://example.com/path?q=1&r=2',
    '\n\nhttps://x.com/a',
    'ABCDEFGHIJKLMNOP',
    'a', 'ab', 'abc', 'abcd', 'abcde',
    'The quick brown fox jumps over 13 lazy dogs.',
    'x'.repeat(500)
  ];
  cases.forEach(function (t) {
    const segs = E.segmentForTyping(t);
    assert.ok(segs.length > 0, 'segment 非空: ' + JSON.stringify(t));
    assert.equal(segs.join(''), t, '拼接必须还原原文: ' + JSON.stringify(t));
    segs.forEach(function (s) {
      assert.ok(s.length >= 1 && s.length <= 6, '非日文片段长度 1..6: ' + JSON.stringify(s));
    });
  });

  // 随机压力：确保任何随机切分都不重叠
  for (let run = 0; run < 300; run++) {
    const t = 'The quick brown fox https://x.com/a?b=c 1234567890';
    assert.equal(E.segmentForTyping(t).join(''), t, '随机切分不得重叠');
  }

  // 日文（含半角假名）按字符切
  ['こんにちは', 'カタカナデス', 'ﾊﾝｶｸｶﾅ', '今日はいい天気ですね'].forEach(function (t) {
    const segs = E.segmentForTyping(t);
    assert.equal(segs.length, t.length, '假名按字符切: ' + t);
    assert.equal(segs.join(''), t);
  });

  // 空值
  assert.deepEqual(E.segmentForTyping(''), []);
  assert.deepEqual(E.segmentForTyping(null), []);

  // ---- 2) humanClick 只产生一次 click ----
  const el = makeEl();
  await E.humanClick(el);
  const clicks = el._events.filter(function (t) { return t === 'click'; }).length;
  const native = el._events.filter(function (t) { return t === 'native-click'; }).length;
  assert.equal(native, 0, 'humanClick 不得再调用 el.click()');
  assert.equal(clicks, 1, 'humanClick 必须只产生一次 click，实际 ' + clicks);
  ['mousemove', 'mouseenter', 'mouseover', 'mousedown', 'mouseup'].forEach(function (t) {
    assert.ok(el._events.indexOf(t) >= 0, 'humanClick 缺少 ' + t);
  });

  console.log('ALL PASS human-typing-segment');
})().catch(function (e) {
  console.error(e && e.stack || e);
  process.exit(1);
});
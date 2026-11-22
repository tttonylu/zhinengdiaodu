/**
 * 保护号文案验收（与 content_follow_v1522 isProtectedProfileText 对齐）
 * 运行：node --test unified-scheduler/test/protected-profile-phrase.test.js
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');

var src = fs.readFileSync(
  path.join(__dirname, '..', 'follow', 'content_follow_v1522.js'),
  'utf8'
);
var m = src.match(/function isProtectedProfileText\(t\) \{[\s\S]*?\n    \}/);
assert.ok(m, '应能抽出 isProtectedProfileText');
// eslint-disable-next-line no-new-func
var isProtectedProfileText = new Function('return (' + m[0] + ')')();

test('实机简中空态整段命中', function () {
  var t = '这些帖子受到保护\n只有经过批准的关注者才可查看 @rrrrrrcoz 的帖子。若要申请访问，点击关注。了解更多。';
  assert.equal(isProtectedProfileText(t), true);
});

test('零宽字符插入仍命中', function () {
  var t = '这些帖子受\u200b到保护';
  assert.equal(isProtectedProfileText(t), true);
});

test('繁中已受保護命中', function () {
  assert.equal(isProtectedProfileText('這些貼文已受保護。只有已核准的跟隨者可以查看。'), true);
});

test('普通公开主页不误杀', function () {
  assert.equal(isProtectedProfileText('关注 正在关注 帖子 回复 媒体'), false);
});

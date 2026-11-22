/**
 * K1 · X 人机文案（有主壳也须命中）
 * 运行：node --test unified-scheduler/test/challenge-guard-x-human.test.js
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var vm = require('node:vm');

var src = fs.readFileSync(
  path.join(__dirname, '..', 'shared', 'challenge-guard.js'),
  'utf8'
);

function loadGuard(bodyText, hasPrimaryColumn) {
  var store = {};
  var body = {
    innerText: bodyText || '',
    textContent: bodyText || ''
  };
  var doc = {
    title: 'X',
    body: body,
    querySelector: function (sel) {
      if (hasPrimaryColumn && sel.indexOf('primaryColumn') >= 0) {
        return { tag: 'div' };
      }
      return null;
    }
  };
  var sandbox = {
    window: {},
    document: doc,
    location: { pathname: '/home', href: 'https://x.com/home' },
    localStorage: {
      getItem: function (k) { return store[k] == null ? null : store[k]; },
      setItem: function (k, v) { store[k] = String(v); },
      removeItem: function (k) { delete store[k]; }
    },
    Date: Date,
    console: console
  };
  sandbox.window = sandbox;
  vm.runInNewContext(src, sandbox);
  return sandbox.window.ChallengeGuard;
}

test('抽出 isXHumanChallengeText', function () {
  var m = src.match(/function isXHumanChallengeText\(txt\) \{[\s\S]*?\n  \}/);
  assert.ok(m, '应导出/定义 isXHumanChallengeText');
  // eslint-disable-next-line no-new-func
  var fn = new Function('return (' + m[0] + ')')();
  assert.equal(fn("Let's confirm you are a human"), true);
  assert.equal(fn('Please confirm you are a human to continue'), true);
  assert.equal(fn('For you · Following · What is happening'), false);
});

test('有 X 主壳时 confirm-you-are-a-human 仍 hit', function () {
  var Guard = loadGuard("Let's confirm you are a human\nComplete this challenge", true);
  var d = Guard.detect();
  assert.equal(d.hit, true);
  assert.equal(d.kind, 'x-human');
  assert.ok(d.signals.indexOf('x-human-text') >= 0);
});

test('普通首页有主壳不误杀', function () {
  var Guard = loadGuard('Home\nFor you\nFollowing\nWhat is happening?!', true);
  var d = Guard.detect();
  assert.equal(d.hit, false);
});

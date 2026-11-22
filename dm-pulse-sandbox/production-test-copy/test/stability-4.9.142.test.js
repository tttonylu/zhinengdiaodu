'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const chatSrc = fs.readFileSync(path.join(ROOT, 'chat', 'content_chat.js'), 'utf8');
const inboxStateSrc = fs.readFileSync(path.join(ROOT, 'chat', 'inbox-state.js'), 'utf8');

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1700000000000;

function loadInboxState() {
  const window = {};
  const sandbox = { window, console, Math, Number, parseInt, isFinite, Date };
  vm.createContext(sandbox);
  vm.runInContext(inboxStateSrc, sandbox);
  return window.SgInboxState;
}

const State = loadInboxState();

function plan(entry) {
  return State.planAction(State.normalizeEntry(entry, { twoSeg: false }), [], {
    now: NOW,
    kickGapMs: 2 * 60 * 60 * 1000,
  });
}

test('版本升到 4.9.157', () => {
  assert.equal(manifest.version, '4.9.157');
  assert.match(manifest.description, /超过 3 天/);
});

test('三处入口共用“最后活动超过 3 天即过期”判定', () => {
  assert.match(chatSrc, /function isExpiredStaleConversation\(entry, now\)/);
  assert.match(chatSrc, /reason: 'expired_3d_stale'/);
  assert.match(chatSrc, /it\.reason = 'expired_3d_stale'/);
  assert.match(chatSrc, /expired_3d_stale: '双方超过 3 天没有任何往来/);
  assert.match(inboxStateSrc, /function isExpiredStale\(entry, now\)/);
  assert.match(inboxStateSrc, /return skip\('expired_3d_stale'\)/);
  assert.match(inboxStateSrc, /isExpiredStale: isExpiredStale/);
});

test('双方沉默超过 3 天：对方最后发言也判过期', () => {
  const r = plan({
    iceSentAt: NOW - 8 * DAY,
    lastInboundAt: NOW - 4 * DAY,
  });
  assert.equal(r.action, 'skip');
  assert.equal(r.reason, 'expired_3d_stale');
});

test('只有对方历史入站且超过 3 天：同样过期', () => {
  const r = plan({ lastInboundAt: NOW - 4 * DAY });
  assert.equal(r.action, 'skip');
  assert.equal(r.reason, 'expired_3d_stale');
});

test('3 天内的新回复仍正常进入流程', () => {
  const r = State.planAction(State.normalizeEntry({
    iceSentAt: NOW - 8 * DAY,
    lastInboundAt: NOW - 2 * DAY,
  }, { twoSeg: false }), [], {
    now: NOW,
    kickGapMs: 2 * 60 * 60 * 1000,
    replyKnown: true,
    age: 30,
    ageRejectBelow: 25,
  });
  assert.equal(r.action, 'send');
  assert.equal(r.route, 'ad');
});

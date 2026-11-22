/**
 * C5 · 交友两段式 canSendAdNow / canSendKickNow
 * 运行：node --test unified-scheduler/test/chat-two-seg-gate.test.js
 */
'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

global.window = {};
global.self = global.window;
global.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] == null ? null : this._d[k]; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; }
};

eval(fs.readFileSync(path.join(__dirname, '..', 'chat', 'chat-gates.js'), 'utf8'));

const G = global.window.SgChatGates;
const HOUR = 60 * 60 * 1000;

describe('C5 · two-seg ad gate', () => {
  beforeEach(() => {
    global.localStorage._d = {};
    global.localStorage.setItem('sg_config_thresholds', JSON.stringify({
      chat_two_seg_mode: 'on',
      chat_script_pool: 'dating'
    }));
    global.localStorage.setItem('sg_config_intervals', JSON.stringify({
      chat_ad_min_wait_min: 60
    }));
    const db = {};
    G.bind({
      normalizeChatHandle: (h) => String(h || '').replace(/^@/, '').toLowerCase(),
      loadTargetDB: () => db,
      saveTargetDB: () => {},
      loadSgState: () => ({}),
      chatShanghaiDate: () => '2026-11-03',
      isMessagesPage: () => false
    });
    global.__testDb = db;
  });

  it('isTwoSegMode dating 默认 on', () => {
    assert.equal(G.isTwoSegMode(), true);
  });

  it('无 peer（无论等多久）→ 都不放行', () => {
    global.__testDb.alice = { iceSentAt: Date.now() - 10 * 60 * 1000, round: 1 };
    const r = G.canSendAdNow('alice', [], global.__testDb.alice);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'await_reply');
  });

  it('无 peer 但满 1h → 仍不放行，等待回复', () => {
    global.__testDb.alice = { iceSentAt: Date.now() - HOUR - 1000, round: 1 };
    const r = G.canSendAdNow('alice', [], global.__testDb.alice);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'await_reply');
  });

  it('有任意回复 → 放行（不等满 1h）', () => {
    global.__testDb.alice = { iceSentAt: Date.now() - 5 * 60 * 1000, round: 1 };
    const r = G.canSendAdNow('alice', ['はい'], global.__testDb.alice);
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'peer_texts_in_session');
  });

  it('两段式禁止 kick', () => {
    global.__testDb.alice = { iceSentAt: Date.now() - HOUR, adSentAt: Date.now(), round: 2, kickCount: 0 };
    assert.equal(G.canSendKickNow('alice', global.__testDb.alice), false);
  });

  it('classic 关两段：无 peer 时永远不发广告', () => {
    global.localStorage.setItem('sg_config_thresholds', JSON.stringify({
      chat_two_seg_mode: 'classic',
      chat_script_pool: 'dating'
    }));
    global.__testDb.alice = { iceSentAt: Date.now() - HOUR - 1000, round: 1 };
    const r = G.canSendAdNow('alice', [], global.__testDb.alice);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'await_reply');
  });

  it('classic 关两段：刚破冰没回复 → 同样等回复', () => {
    global.localStorage.setItem('sg_config_thresholds', JSON.stringify({
      chat_two_seg_mode: 'classic',
      chat_script_pool: 'dating'
    }));
    global.__testDb.alice = { iceSentAt: Date.now() - 10 * 1000, round: 1 };
    const r = G.canSendAdNow('alice', [], global.__testDb.alice);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'await_reply');
  });
});

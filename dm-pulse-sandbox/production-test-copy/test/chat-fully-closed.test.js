/**
 * C5 · isChatFullyClosed 完结判定测试
 * 验证：round≥3 / done=true 均应判为完结
 * 修复：旧数据 round=3 但 kickCount=1 时，原逻辑误判为「还能发催加」
 * 运行：node --test unified-scheduler/test/chat-fully-closed.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

// 在 Node 里模拟 window/document，加载 chat-gates IIFE
global.window = {};
global.self = global.window;
// classic：本文件测旧三轮 kick；两段式默认 on 会让 canSendKickNow 恒 false
global.localStorage = {
  _d: { sg_config_thresholds: JSON.stringify({ chat_two_seg_mode: 'classic' }) },
  getItem(k) { return this._d[k] == null ? null : this._d[k]; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; }
};

const code = fs.readFileSync(
  path.join(__dirname, '..', 'chat', 'chat-gates.js'),
  'utf8'
);
// 去掉 "use strict" 包裹 IIFE，直接执行
eval(code);

const { isChatFullyClosed, canSendKickNow, getKickCount, KICK_MAX_COUNT } = global.window.SgChatGates;

describe('C5 · isChatFullyClosed 完结判定', () => {

  it('空 entry → 不关闭', () => {
    assert.equal(isChatFullyClosed(null), false);
    assert.equal(isChatFullyClosed(undefined), false);
    assert.equal(isChatFullyClosed({}), false);
  });

  it('kickCount=2 → 关闭（盾牌+催加都发了）', () => {
    assert.equal(isChatFullyClosed({ round: 2, kickCount: 2 }), true);
  });

  it('kickCount=1 且 round=2 → 不关闭（只发了盾牌，还能催加）', () => {
    assert.equal(isChatFullyClosed({ round: 2, kickCount: 1 }), false);
  });

  it('rejectSentAt → 关闭（婉拒）', () => {
    assert.equal(isChatFullyClosed({ round: 1, rejectSentAt: Date.now() }), true);
  });

  it('blockedAt → 关闭（拉黑）', () => {
    assert.equal(isChatFullyClosed({ round: 1, blockedAt: Date.now() }), true);
  });

  // ===== 修复验证：以下是本次修复覆盖的场景 =====

  it('round=3 + done=true + kickCount=1 → 关闭（旧数据：round到顶但 kickCount 未回填）', () => {
    assert.equal(
      isChatFullyClosed({ round: 3, done: true, kickCount: 1 }),
      true,
      'round=3 且 done=true 应判为完结，即使 kickCount<2'
    );
  });

  it('round=3 但 kickCount=0 → 关闭（round≥3 即完结，不看 kickCount）', () => {
    assert.equal(
      isChatFullyClosed({ round: 3, kickCount: 0 }),
      true,
      'round=3 就应完结，与 C1/C2 语义对齐'
    );
  });

  it('done=true 但 round=2 → 关闭（done 是更强的完结标记）', () => {
    assert.equal(
      isChatFullyClosed({ round: 2, done: true, kickCount: 1 }),
      true,
      '目标库标记 done 即完结'
    );
  });

  it('round=2 + kickCount=1 + done=false → 不关闭（正常待催加）', () => {
    assert.equal(
      isChatFullyClosed({ round: 2, done: false, kickCount: 1 }),
      false,
      'round=2 kickCount=1 未完结，应还能发催加'
    );
  });

  it('finalKickSentAt → 关闭（最终催加已发）', () => {
    assert.equal(isChatFullyClosed({ round: 2, finalKickSentAt: Date.now() }), true);
  });

  it('chatClosedAt → 关闭', () => {
    assert.equal(isChatFullyClosed({ round: 2, chatClosedAt: Date.now() }), true);
  });
});

describe('C5 · canSendKickNow 与 isChatFullyClosed 联动', () => {

  it('round=3 kickCount=1 → 不能发催加（修复后）', () => {
    // canSendKickNow 内部先调 isChatFullyClosed，所以 round=3 应返回 false
    assert.equal(
      canSendKickNow('test', { round: 3, done: true, kickCount: 1 }),
      false,
      'round=3 已完结，不能再发催加'
    );
  });

  it('round=2 kickCount=1 → 能发催加（正常场景）', () => {
    assert.equal(
      canSendKickNow('test', {
        round: 2,
        kickCount: 1,
        adSentAt: Date.now() - 20 * 60 * 60 * 1000,
        kickSentAt: Date.now() - 13 * 60 * 60 * 1000,
        lastInboundAt: Date.now() - 10 * 60 * 1000
      }),
      true,
      'round=2 kickCount=1 且有新回复时应能发第二次跟进（催加）'
    );
  });

  it('旧台账 round=1 但广告已发 → 允许首次催加（与状态机一致）', () => {
    assert.equal(
      canSendKickNow('test', {
        round: 1,
        kickCount: 0,
        adSentAt: Date.now() - 4 * 60 * 60 * 1000,
        lastInboundAt: Date.now() - 60 * 60 * 1000
      }),
      true,
      '广告痕迹已存在、之后有新回复且已过 3 小时，round 停留在 1 不应把催加永久拦住'
    );
    assert.equal(
      canSendKickNow('test', { round: 1, kickCount: 0, adSentAt: Date.now() }),
      false,
      '广告刚发出时不能立刻催加'
    );
    assert.equal(
      canSendKickNow('test', { round: 1, kickCount: 0 }),
      false,
      '没有广告痕迹时仍不能发催加'
    );
    assert.equal(
      canSendKickNow('test', {
        round: 2,
        kickCount: 0,
        adSentAt: Date.now() - 4 * 60 * 60 * 1000
      }),
      false,
      '广告后没有新回复时不能发催加'
    );
  });

  it('KICK_MAX_COUNT 应为 2（盾牌+催加共 2 步）', () => {
    assert.equal(KICK_MAX_COUNT, 2);
  });
});

/**
 * A5 · scrmAllowsChat fail-open 测试（4.4.1 现行行为）
 * 验证：SCRM 闸门未就绪/异常时默认放行，避免服务不可用导致私信全面停摆。
 * 历史：4.3.31 曾改 fail-closed；4.4.1 因 SCRM 服务不可用止损改回 fail-open。
 *      本测试对齐现行代码，旧的 scrm-gate-failclosed.test.js 已作废删除。
 * 运行：node unified-scheduler/test/scrm-gate-failopen.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

// 模拟 window，加载 chat-strategy.js（IIFE 挂 window）
global.window = {};
global.self = global.window;
global.document = { addEventListener: () => {} };
global.localStorage = {
  _data: {},
  getItem(k) { return this._data[k] ?? null; },
  setItem(k, v) { this._data[k] = String(v); },
  removeItem(k) { delete this._data[k]; },
  length: 0,
  key() { return null; }
};
global.sessionStorage = {
  _data: {},
  getItem(k) { return this._data[k] ?? null; },
  setItem(k, v) { this._data[k] = String(v); },
  removeItem(k) { delete this._data[k]; }
};

const code = fs.readFileSync(
  path.join(__dirname, '..', 'scheduler', 'chat-strategy.js'),
  'utf8'
);

eval(code);

const { resolveChatPolicy } = global.window.SgChatStrategy;

describe('A5 · scrmAllowsChat fail-open 策略（4.4.1）', () => {

  it('getScrmGateSync 不存在 → 放行（fail-open）', () => {
    delete global.getScrmGateSync;
    const result = resolveChatPolicy({
      sg: { softRiskUntil: 0, softRiskPhase: '' },
      debt: 5,
      replyPending: 0
    });
    assert.equal(result.reason === 'scrm_offline', false, 'SCRM 函数缺失不应挡私信（fail-open）');
    assert.equal(result.allowChat, true);
  });

  it('SCRM 缓存未就绪（返回 undefined）→ 放行', () => {
    global.getScrmGateSync = function () { return undefined; };
    const result = resolveChatPolicy({
      sg: { softRiskUntil: 0, softRiskPhase: '' },
      debt: 5,
      replyPending: 0
    });
    assert.equal(result.reason === 'scrm_offline', false, '缓存未就绪不应挡私信');
    assert.equal(result.allowChat, true);
    delete global.getScrmGateSync;
  });

  it('SCRM allow_chat=true → 不被 SCRM 挡', () => {
    global.getScrmGateSync = function () { return { allow_chat: true, reason: '' }; };
    const result = resolveChatPolicy({
      sg: { softRiskUntil: 0, softRiskPhase: '' },
      debt: 0,
      replyPending: 0
    });
    assert.equal(result.reason === 'scrm_offline', false, 'SCRM 放行时不应因 scrm_offline 被挡');
    delete global.getScrmGateSync;
  });

  it('SCRM allow_chat=false → 拦截（服务端不放行 / 快照过期 / 刷新失败无有效缓存 同此路径）', () => {
    global.getScrmGateSync = function () {
      return { allow_chat: false, reason: '客服离线' };
    };
    const result = resolveChatPolicy({
      sg: { softRiskUntil: 0, softRiskPhase: '' },
      debt: 5,
      replyPending: 0
    });
    assert.equal(result.allowChat, false);
    assert.equal(result.reason, 'scrm_offline');
    delete global.getScrmGateSync;
  });

  it('getScrmGateSync 抛异常 → 放行（fail-open）', () => {
    global.getScrmGateSync = function () { throw new Error('SCRM 异常'); };
    const result = resolveChatPolicy({
      sg: { softRiskUntil: 0, softRiskPhase: '' },
      debt: 5,
      replyPending: 0
    });
    assert.equal(result.reason === 'scrm_offline', false, 'SCRM 抛异常不应挡私信（fail-open）');
    assert.equal(result.allowChat, true);
    delete global.getScrmGateSync;
  });
});

describe('A5 · 日龄闸已全面移除（4.3.32 策略层移除 / 4.6.31 stage 层 S3.dayMin 一并移除）', () => {

  it('resolveChatPolicy 不再返回 day_lt_3（日龄由 stage-detector 承担）', () => {
    global.getScrmGateSync = () => ({ allow_chat: true });
    global.window.__sgGetMyHandle = () => 'newuser';
    global.localStorage._data['matrix_stats_newuser'] = JSON.stringify({ day_count: 1, follows_today: 0 });

    const result = resolveChatPolicy({
      sg: { softRiskUntil: 0, softRiskPhase: '' },
      debt: 5,
      replyPending: 0
    });
    assert.notEqual(result.reason, 'day_lt_3', 'A5 策略层已不管日龄（4.3.32 移除）');

    delete global.getScrmGateSync;
    delete global.window.__sgGetMyHandle;
  });
});
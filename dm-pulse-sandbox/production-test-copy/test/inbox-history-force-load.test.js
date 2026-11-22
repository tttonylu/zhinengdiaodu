'use strict';
/**
 * 4.9.112 现场回归：
 * 1) clearAllTimers 之后守箱主循环必须自动重新挂上，否则脉冲只能等看门狗
 *    每 3 分钟唤醒一次，回复检测被拖到几分钟才一拍。
 * 2) 会话只有 1–2 条气泡（没有滚动条）时，必须强制向上回翻历史，
 *    不能因为 findDmScrollContainer 返回 null 就放弃，
 *    否则读不到我方破冰气泡会被误判成「对方先私信」。
 *
 * 运行：node --test --test-force-exit test/inbox-history-force-load.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'content_chat.js'), 'utf8');

describe('守箱主循环不能被 clearAllTimers 清掉后失联', () => {
  it('clearAllTimers 在守箱开启时会重新挂主循环', () => {
    const block = chatSrc.match(/function clearAllTimers\(\)[\s\S]*?\n    \}/);
    assert.ok(block, 'clearAllTimers 必须存在');
    assert.match(block[0], /ensureChatMainEngine\(\)/,
      'clearAllTimers 清完定时器必须按需重新挂主循环');
    assert.match(block[0], /getRunMode\(\) === 'inbox'/,
      '重新挂主循环必须只在守箱模式生效，不能影响出站/关注');
    assert.match(block[0], /isInboxWatchEnabled\(\)/,
      '守箱开关关闭时不应重新挂主循环');
  });

  it('重新挂之前要清掉旧 id，否则 ensureChatMainEngine 会误判已存在', () => {
    const block = chatSrc.match(/function clearAllTimers\(\)[\s\S]*?\n    \}/);
    assert.match(block[0], /_sgChatMainEngineId = null/);
  });
});

describe('只有一两条气泡时也必须回翻历史', () => {
  it('没有滚动容器时会走强制回翻，而不是直接放弃', () => {
    const fn = chatSrc.match(/async function loadOlderDmHistoryForIce\([\s\S]*?\n    \}/);
    assert.ok(fn, 'loadOlderDmHistoryForIce 必须存在');
    assert.match(fn[0], /forceLoadOlderDmMessages/,
      '没有滚动条时必须强制回翻，否则会误判成对方先私信');
    assert.match(fn[0], /no_scroller_forced_top/,
      '强制回翻后必须落明确原因，便于 OPS 核对');
  });

  it('强制回翻必须有界，不能无限滚动', () => {
    const fn = chatSrc.match(/async function forceLoadOlderDmMessages\([\s\S]*?\n    \}/);
    assert.ok(fn, 'forceLoadOlderDmMessages 必须存在');
    assert.match(fn[0], /Math\.min\(4,/,
      '强制回翻最多 4 轮，避免拖垮渲染进程');
    assert.match(fn[0], /await waitMs\(/,
      '每轮之间必须等待，让 X 有机会挂载更早的消息');
  });
});

describe('回复判定必须能区分「没读全」和「确实没有我方气泡」', () => {
  it('回翻证据要带 forced / bubblesBefore / bubblesAfter', () => {
    assert.match(chatSrc, /forced: false/);
    assert.match(chatSrc, /bubblesBefore: 0/);
    assert.match(chatSrc, /bubblesAfter: 0/);
  });
});

'use strict';
/**
 * 4.9.125 · 守箱模式自愈
 * 残留 sg_run_mode=inbox 会让自动出站轮次被改写到 /i/chat，破冰队列永远不 drain。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const coreSrc = fs.readFileSync(path.join(__dirname, '..', 'scheduler-core.js'), 'utf8');

describe('守箱模式自愈', () => {
  it('相位已是 outbound 时，把残留 inbox 改回 outbound', () => {
    const i = coreSrc.indexOf("if (rmLease === 'inbox' && phLease === 'outbound')");
    assert.ok(i > 0, '缺少守箱自愈分支');
    const seg = coreSrc.slice(i, i + 900);
    assert.match(seg, /setItem\('sg_run_mode', 'outbound'\)/);
    assert.match(seg, /setItem\('sg_test_inbox_watch', 'false'\)/);
    assert.match(seg, /sg_inbox_watch_on: false/);
  });

  it('自愈必须在改写 /i/chat 之前执行', () => {
    const healAt = coreSrc.indexOf("if (rmLease === 'inbox' && phLease === 'outbound')");
    const rewriteAt = coreSrc.indexOf("if (rmLease === 'inbox') targetUrl = 'https://x.com/i/chat'");
    assert.ok(healAt > 0 && rewriteAt > 0);
    assert.ok(healAt < rewriteAt, '自愈顺序错了，先改写就没救了');
  });

  it('显式守箱相位不受影响（相位 inbox 不自愈）', () => {
    assert.ok(!/rmLease === 'inbox' && phLease !== 'inbox'/.test(coreSrc),
      '不得放宽到「只要不是 inbox 就自愈」，避免误伤守箱测试');
  });
});

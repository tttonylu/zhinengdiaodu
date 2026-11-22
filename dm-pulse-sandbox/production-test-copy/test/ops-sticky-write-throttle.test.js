'use strict';
/**
 * OPS 地址 sticky 写风暴守卫。
 * 现场证据：chrome.storage.local 的 LevelDB 在 2 分钟内写入 ~1.6 万次
 * sg_failover_sticky（约 165 次/秒），把后台消息和遥测上报一起拖死。
 * 运行：node --test --test-force-exit test/ops-sticky-write-throttle.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

describe('OPS sticky 不得每次请求都写盘', () => {
  it('同一组地址 10 秒内只落盘一次', () => {
    const start = src.indexOf('function saveFailoverSticky()');
    assert.ok(start > 0);
    const block = src.slice(start, start + 1400);
    assert.match(block, /stickySaveKey/);
    assert.match(block, /stickySaveAt/);
    assert.match(block, /< 10000/);
    assert.match(block, /stickySaveTimer/);
  });

  it('地址变化仍然立即写，不会被节流吞掉', () => {
    const start = src.indexOf('function saveFailoverSticky()');
    const block = src.slice(start, start + 1400);
    assert.match(block, /if \(key === stickySaveKey && \(now - stickySaveAt\) < 10000\)/);
    assert.match(block, /stickySaveKey = key;/);
    assert.match(block, /stickySaveAt = now;/);
  });
});

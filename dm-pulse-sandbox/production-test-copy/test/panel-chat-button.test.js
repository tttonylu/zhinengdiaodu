'use strict';
/**
 * “只私信”按钮曾经点不动：guardChatDayOrFlash 恒返回 true，
 * 处理函数第一行就 return，命令永远发不出去。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const panelSrc = fs.readFileSync(path.join(__dirname, '..', 'ui', 'panel.js'), 'utf8');

describe('面板“只私信”按钮必须真的发命令', () => {
  it('限额守卫返回 false 表示放行，不能恒真拦截', () => {
    const fn = panelSrc.slice(
      panelSrc.indexOf('function guardChatDayOrFlash(label)'),
      panelSrc.indexOf('function guardChatDayOrFlash(label)') + 400
    );
    assert.match(fn, /return false;/);
    assert.doesNotMatch(fn, /return true;/);
  });

  it('“只私信”点击后能走到 sendCmd', () => {
    const block = panelSrc.slice(
      panelSrc.indexOf("bindElClick('btn-ch'"),
      panelSrc.indexOf("bindElClick('btn-ch-test'")
    );
    assert.match(block, /if \(guardChatDayOrFlash\('只私信'\)\) return;/);
    assert.match(block, /sendCmd\('sg_manual_chat', '只私信'\)/);
  });

  it('“私信测试”点击后能触发测试事件', () => {
    const block = panelSrc.slice(
      panelSrc.indexOf("bindElClick('btn-ch-test'"),
      panelSrc.indexOf("bindElClick('btn-dry-run'")
    );
    assert.match(block, /if \(guardChatDayOrFlash\('私信测试'\)\) return;/);
    assert.match(block, /sg-chat-test-command/);
  });
});

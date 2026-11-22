'use strict';
/**
 * 4.9.30 回归：
 * 收口后确认有新入站的 revived 会话，即使列表没有未读、预览也不是对方文本，
 * 也必须进入候选；否则它会永远停在 closed_inbound_queued_for_reply_check。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const decisionSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'inbox-decision.js'), 'utf8');
const pulseSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'inbox-pulse.js'), 'utf8');
const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'content_chat.js'), 'utf8');

function loadModules() {
  const window = {};
  const sandbox = { window, console, Math, Number, parseInt, isFinite };
  vm.createContext(sandbox);
  vm.runInContext(decisionSrc, sandbox);
  vm.runInContext(pulseSrc, sandbox);
  return window;
}

describe('脉冲选目标 · revived 不能被过滤', () => {
  it('无未读、无对方预览、仅 revived 的收口会话仍会被选中', () => {
    const window = loadModules();
    const picked = window.SgInboxPulse.selectTarget([
      {
        key: 'zero45058493',
        handle: 'zero45058493',
        closed: true,
        revived: true,
        revivedReason: 'legacy_unchecked_inbound',
        unread: false,
        unreadPrecise: false,
        peerLast: false,
        preview: 'test',
      },
    ], Date.now());
    assert.ok(picked, 'revived 候选必须被选中');
    assert.equal(picked.handle, 'zero45058493');
  });

  it('真正无信号的普通会话仍然不会被选中', () => {
    const window = loadModules();
    const picked = window.SgInboxPulse.selectTarget([
      {
        handle: 'quiet',
        closed: false,
        unread: false,
        peerLast: false,
        preview: '',
      },
    ], Date.now());
    assert.equal(picked, null);
  });
});

describe('打开失败冷却不能压太久', () => {
  it('连续 2 次失败用 10 分钟，不再用 30 分钟', () => {
    assert.match(chatSrc, /if \(\(Number\(rec\.count\) \|\| 1\) >= 2\) return age < 10 \* 60 \* 1000;/);
    assert.doesNotMatch(chatSrc, /return age < 30 \* 60 \* 1000;/);
  });

  it('hidden → visible 时清掉 peer-open 失败冷却', () => {
    const at = chatSrc.indexOf('function resetInboxFailuresAfterHidden()');
    const block = chatSrc.slice(at, at + 1400);
    assert.match(block, /localStorage\.removeItem\(PEER_OPEN_FAIL_KEY\)/);
    assert.match(block, /out\.peerOpen/);
  });
});

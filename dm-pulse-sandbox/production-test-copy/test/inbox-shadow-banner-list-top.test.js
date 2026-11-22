'use strict';
/**
 * 4.9.78 现场回归：
 * 1) X 私信面板在 open shadowRoot 里，body.innerText 读不到“收件箱已关闭”；
 * 2) 深扫/硬跳回 /i/chat 后，X 恢复旧 scrollTop，页面停在 18 周前旧会话。
 * 运行：node --test --test-force-exit test/inbox-shadow-banner-list-top.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadDecision() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'chat', 'inbox-decision.js'), 'utf8');
  const window = {};
  const sandbox = {
    window,
    console,
    Math,
    Number,
    parseInt,
    isFinite,
    Date,
    document: { querySelectorAll: () => [], querySelector: () => null }
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return window.SgInboxDecision;
}

const Decision = loadDecision();
const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'content_chat.js'), 'utf8');

describe('关闭收件箱文案判定（穿透 shadowRoot 后的文本）', () => {
  it('中文横幅被 span/换行拆开也能命中', () => {
    assert.equal(Decision.inboxClosedVerdict('@abc 的收件箱\n已关闭。如果知道他们的 X 安全码，你仍然可以发私信。'),
      'peer_inbox_closed');
    assert.equal(Decision.inboxClosedVerdict('收件箱 已被 关闭'),
      'peer_inbox_closed');
    assert.equal(Decision.inboxClosedVerdict('收件箱已关闭。\n如果知道他们的 X 安全码，你仍然可以给他们发私信。'),
      'peer_inbox_closed');
  });

  it('日文与英文横幅同样命中', () => {
    assert.equal(Decision.inboxClosedVerdict('@abc の受信トレイ\nが閉じられています。セーフティコードが必要です。'),
      'peer_inbox_closed');
    assert.equal(Decision.inboxClosedVerdict('This person\'s inbox is closed. You can still message them if you know their safety code.'),
      'peer_inbox_closed');
  });

  it('只有“安全码”+私信组合才命中，普通收件箱字样不误判', () => {
    assert.equal(Decision.inboxClosedVerdict('收件箱里有 3 条新消息'), '');
    assert.equal(Decision.inboxClosedVerdict('私信设置'), '');
    assert.equal(Decision.inboxClosedVerdict('如果知道 X 安全码，你仍然可以给他们发私信'),
      'peer_inbox_closed');
  });
});

describe('关闭横幅必须读 shadowRoot，不能只读 body.innerText', () => {
  it('detectPeerInboxClosedBanner 使用穿透文本收集器', () => {
    const at = chatSrc.indexOf('function detectPeerInboxClosedBanner()');
    assert.ok(at > 0);
    const fn = chatSrc.slice(at, at + 2600);
    assert.match(fn, /__dmCollectTextDeep/);
    assert.match(fn, /document\.body\.innerText/);
    assert.match(fn, /document\.body\.textContent/);
    assert.match(fn, /inboxClosedVerdict/);
  });

  it('找不到输入框时把 deep 文本命中片段写进 OPS 探针', () => {
    const at = chatSrc.indexOf('function inboxComposerProbe()');
    assert.ok(at > 0);
    const fn = chatSrc.slice(at, at + 3600);
    assert.match(fn, /deepTextLen/);
    assert.match(fn, /closedBanner/);
    assert.match(fn, /pageTextHit/);
    assert.match(fn, /__dmCollectTextDeep/);
  });
});

describe('深扫/硬跳回列表后必须置顶', () => {
  it('软跳与硬跳去 /i/chat 都会写置顶标记', () => {
    const softAt = chatSrc.indexOf('function inboxSoftGo(url)');
    assert.ok(softAt > 0);
    const softFn = chatSrc.slice(softAt, softAt + 1800);
    assert.match(softFn, /markInboxListTop\('soft_go_list'\)/);

    const hardAt = chatSrc.indexOf('function inboxHardNavigate(url, reason, opts)');
    assert.ok(hardAt > 0);
    const hardFn = chatSrc.slice(hardAt, hardAt + 1800);
    assert.match(hardFn, /markInboxListTop\(reason \|\| 'hard_navigate_list'\)/);
  });

  it('深扫收尾与主 tick 都会消费置顶标记', () => {
    assert.match(chatSrc, /markInboxListTop\('deep_scan_complete'\)/);
    const tickAt = chatSrc.indexOf('function runInboxModeTick()');
    assert.ok(tickAt > 0);
    const tickFn = chatSrc.slice(tickAt, tickAt + 1600);
    assert.match(tickFn, /enforceInboxListTopIfNeeded\(false\)/);
  });

  it('置顶函数只作用于列表根，并设置真实 scrollTop', () => {
    const at = chatSrc.indexOf('function enforceInboxListTopIfNeeded(force)');
    assert.ok(at > 0);
    const fn = chatSrc.slice(at, at + 2600);
    assert.match(fn, /isDmInboxListRootPath\(\)/);
    assert.match(fn, /sc\.scrollTop = 0/);
    assert.match(fn, /120000/);
  });
});

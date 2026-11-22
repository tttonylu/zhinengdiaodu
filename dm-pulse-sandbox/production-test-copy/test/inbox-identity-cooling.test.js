'use strict';
/**
 * 4.9.44 现场回归：身份识别误取导航栏本号 → header_handle_mismatch →
 * 同一个“未读”目标每拍霸占队首，后面的会话永远轮不到。
 *
 * 覆盖：
 * - 会话头只认消息区上方、非气泡内的对方资料链接，并排除本号；
 * - 低可信度 main 兜底不得单独判“点错人”；
 * - 身份连续失败 2 次后冷却 30 分钟，未读也不能绕过；
 * - 列表预览变化立即解除冷却；
 * - match_repair 只有真回写才上报。
 *
 * 运行：node --test --test-force-exit test/inbox-identity-cooling.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const decisionSrc = fs.readFileSync(path.join(root, 'chat', 'inbox-decision.js'), 'utf8');
const chatSrc = fs.readFileSync(path.join(root, 'chat', 'content_chat.js'), 'utf8');
const watchSrc = fs.readFileSync(path.join(root, 'chat', 'inbox-watch.js'), 'utf8');

function loadDecision() {
  const window = {};
  const sandbox = { window, console, Math, Number, parseInt, isFinite, Date };
  vm.createContext(sandbox);
  vm.runInContext(decisionSrc, sandbox);
  return window.SgInboxDecision;
}

const D = loadDecision();

describe('identityCooling · 身份未证明必须让位', () => {
  const now = 1800000000000;

  it('没有失败记录时不冷却', () => {
    const r = D.identityCooling({}, '何が？', now);
    assert.equal(r.cooling, false);
    assert.equal(r.count, 0);
  });

  it('连续 2 次证明不了身份 → 冷却 30 分钟（未读也一样）', () => {
    const r = D.identityCooling({
      identityPendingCount: 2,
      identityPendingAt: now - 60 * 1000,
      identityPendingPreview: '何が？'
    }, '何が？', now);
    assert.equal(r.cooling, true);
    assert.equal(r.reason, 'identity_unverifiable_cooling');
    assert.equal(r.until, now - 60 * 1000 + 30 * 60 * 1000);
  });

  it('列表预览变化 → 立即解除冷却并清零', () => {
    const r = D.identityCooling({
      identityPendingCount: 5,
      identityPendingAt: now - 60 * 1000,
      identityPendingPreview: '何が？'
    }, '新しく来たメッセージ', now);
    assert.equal(r.cooling, false);
    assert.equal(r.reset, true);
    assert.equal(r.count, 0);
  });

  it('冷却到期 → 允许重试', () => {
    const r = D.identityCooling({
      identityPendingCount: 2,
      identityPendingAt: now - 31 * 60 * 1000,
      identityPendingPreview: '何が？'
    }, '何が？', now);
    assert.equal(r.cooling, false);
  });
});

describe('会话头身份 · 只认对方资料链接', () => {
  it('新增 role=log 消息区定位', () => {
    assert.match(chatSrc, /function getDmConversationLogRoot\(\)/);
    assert.match(chatSrc, /div\[role="log"\]/);
  });

  it('会话头必须来自消息区上方的面板链接，并排除本号', () => {
    assert.match(chatSrc, /function readDmConversationHeaderInfo\(\)/);
    assert.match(chatSrc, /source = 'panel_header'/);
    assert.match(chatSrc, /confident = true/);
    assert.match(chatSrc, /function dmSelfHandle\(\)/);
    assert.match(chatSrc, /if \(self && cand === self\) return ''/);
  });

  it('main 兜底只作低可信度线索，不能单独判点错人', () => {
    assert.match(chatSrc, /source = 'main_fallback'/);
    assert.match(chatSrc, /confident = false/);
    assert.match(chatSrc, /headerInfo\.confident\) \{\s*out\.reason = 'header_handle_mismatch'/);
  });
});

describe('候选隔离 · 技术失败不得霸占队首', () => {
  it('身份冷却在候选阶段直接让位，未读不能绕过', () => {
    assert.match(chatSrc, /if \(identityCool\) \{\s*drop\.identityCooling\+\+[\s\S]{0,200}continue;/);
  });

  it('身份失败时记录当次列表预览，供预览变化解锁', () => {
    assert.match(chatSrc, /identityPendingPreview = String\(\(item && item\.preview\) \|\| ''\)/);
    assert.match(chatSrc, /identityPendingPreview = ''/);
  });

  it('裸 peerId（无 handle、台账对不上）不得占用脉冲', () => {
    assert.match(chatSrc, /drop\.unboundNoHandle\+\+/);
    assert.match(chatSrc, /drop\.notInLedger\+\+/);
    assert.match(chatSrc, /not_in_ledger_stranger/);
  });

  it('match_repair 只在真正回写台账后上报', () => {
    assert.match(watchSrc, /if \(dirty\) \{[\s\S]{0,500}emitMatchRepair\(/);
    const badBlock = /if \(matchBy === 'displayName' \|\| matchBy === 'peerId'\) \{\s*emitMatchRepair/;
    assert.doesNotMatch(watchSrc, badBlock);
  });
});

describe('新版气泡结构 · role=article', () => {
  it('消息正文收集支持 div[role="article"] 内最长 [dir="auto"]', () => {
    assert.match(chatSrc, /querySelectorAll\('div\[role="article"\], article\[role="article"\]'\)/);
    assert.match(chatSrc, /findDmTextLeaf\(art\) \|\| art/);
  });

  it('气泡计数不再只认 message-text-*', () => {
    assert.match(chatSrc, /Math\.max\(leaves, articles\)/);
  });
});

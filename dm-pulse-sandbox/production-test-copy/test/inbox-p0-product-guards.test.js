'use strict';
/**
 * 4.9.1–4.9.2 产品口径守卫：
 *   1. 首扫只建台账，不给存量粉丝群发破冰；
 *   2. 催加节奏 = 下一次轮询，不被 8 分钟复查冷却压住；
 *   3. 普通收口后来信必须进会话读取，再由既有状态机给出结论。
 * 运行：node --test --test-force-exit test/inbox-p0-product-guards.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'content_chat.js'), 'utf8');
const pulseSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'inbox-pulse.js'), 'utf8');
const decisionSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'inbox-decision.js'), 'utf8');

function loadPure(src, key) {
  const window = {};
  const sandbox = { window, console, Math, Number, parseInt, isFinite, Date };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return window[key];
}

describe('P0-1 · 首扫只建台账，不群发破冰', () => {
  it('存量粉（基线之前 firstSeen）判为 deferred/baseline_seed，不进 pending', () => {
    assert.match(chatSrc, /function isPreBaselineFollower\(entry\)/);
    assert.match(chatSrc, /return !seen \|\| seen < at;/);
    const start = chatSrc.indexOf('if (eff <= 0) {');
    const block = chatSrc.slice(start, start + 700);
    assert.match(block, /isPreBaselineFollower\(entry\)/);
    assert.match(block, /reason: 'baseline_seed'/);
    assert.match(block, /status: 'deferred'/);
  });

  it('首扫 harvest 只登记台账，不入队', () => {
    assert.match(chatSrc, /firstScanLedgerOnly = !baselineOkH && !isRosterFirstScanIceAll\(\)/);
    assert.match(chatSrc, /stat\.baseline_ledger_only\+\+/);
    const idx = chatSrc.indexOf('if (firstScanLedgerOnly) {');
    assert.ok(idx > 0);
    assert.match(chatSrc.slice(idx, idx + 200), /continue;/);
  });

  it('存量粉不算破冰债，也不会被灌回 pending', () => {
    assert.match(chatSrc, /if \(isPreBaselineFollower\(e\)\) continue;/);
    const seedIdx = chatSrc.indexOf('if (cls.kind === \'ice\') {');
    assert.ok(seedIdx > 0);
    assert.match(chatSrc.slice(seedIdx, seedIdx + 400), /if \(cls\.status !== 'pending'\) continue;/);
  });

  it('给存量补破冰必须显式打开 sg_roster_first_scan_ice=all', () => {
    assert.match(chatSrc, /sg_roster_first_scan_ice/);
    assert.match(chatSrc, /=== 'all'/);
  });

  it('台账里的不可达旧债不再挡新粉入队', () => {
    assert.match(chatSrc, /blockNewIce = baselineOkH && pendingIce > 0;/);
    assert.match(chatSrc, /function isStaleUnseenFollower\(entry\)/);
    assert.match(chatSrc, /reason: 'left_followers'/);
    assert.match(chatSrc, /if \(isStaleUnseenFollower\(e\)\) continue;/);
  });
});

describe('P0-2 · 催加节奏 = 下一次轮询', () => {
  const P = loadPure(pulseSrc, 'SgInboxPulse');

  it('有催加待办时不受 8 分钟复查冷却影响', () => {
    const picked = P.selectTarget(
      [{ handle: 'a', cooldown: true, kickReady: true, adDebt: false }],
      Date.now()
    );
    assert.ok(picked, '催加到点必须被选中');
    assert.equal(picked.handle, 'a');

    const notPicked = P.selectTarget(
      [{ handle: 'b', cooldown: true, kickReady: false, adDebt: false, unread: false }],
      Date.now()
    );
    assert.equal(notPicked, null, '没有待办的复查仍然要被冷却压住');
  });

  it('广告债同样不受复查冷却影响', () => {
    const picked = P.selectTarget(
      [{ handle: 'c', cooldown: true, adDebt: true }],
      Date.now()
    );
    assert.ok(picked);
    assert.equal(picked.handle, 'c');
  });

  it('运行时也要主动放行，而不是只靠选择器兜底', () => {
    assert.match(chatSrc, /var debtDue = !!\(adDebt \|\| kickReady\);/);
    // 到期动作必须能在“下一次轮询”执行：adDebt 自身有 ad_min_wait + probe gap，
    // kickReady 自身有 kick gap + pulseSeq 闸，所以不再被 8 分钟复查冷却压住。
    assert.match(chatSrc, /var debtDue = !!\(adDebt \|\| kickReady\);/);
    assert.match(chatSrc, /var watchedRecently = !!\(entry && entry\.inboxWatchedAt\)/);
    assert.match(chatSrc, /var newInboundSignal = !!unreadInfo\.unread \|\| !!peerLast \|\| !!revived;/);
    assert.match(chatSrc, /if \(debtDue && !renderFailCool && !identityCool\) \{\s*cooldown = false;/);
    assert.match(chatSrc, /chat_inbox_kick_min_minutes/);
  });

  it('状态机保留轮次闸：同一轮绝不连发', () => {
    const D = loadPure(decisionSrc, 'SgInboxDecision');
    const entry = {
      iceSentAt: 1,
      adSentAt: Date.now() - 1000,
      lastInboundAt: Date.now() - 500,
      adBubbleOk: 1,
      round: 2,
      adPulseSeq: 9
    };
    const r = D.decideInboxAction({
      entry,
      peerTexts: [],
      opts: { twoSeg: false, pulseSeq: 9 }
    });
    assert.equal(r.action, 'wait');
    assert.equal(r.reason, 'kick_wait');
    assert.equal(r.nextRound, true);
  });
});

describe('P0-3 · 收口后来信先读正文，再由既有状态机判定', () => {
  const P = loadPure(pulseSrc, 'SgInboxPulse');

  it('硬拒绝/拉黑终止；普通收口后来信进入候选', () => {
    assert.match(chatSrc, /var revived = false;/);
    assert.match(chatSrc, /var hardClosed = !!\(window\.SgInboxDecision && window\.SgInboxDecision\.isHardClosed/);
    assert.match(chatSrc, /if \(closedInbound && !hardClosed\) \{/);
    assert.match(chatSrc, /revived = true;/);
    const idx = chatSrc.indexOf('var closedInbound = false;');
    assert.ok(idx > 0, '必须有“收口后来信”的独立判定');
    assert.match(chatSrc.slice(idx, idx + 1800), /closedInbound = !!reopenInfo\.reopen/);
    assert.match(chatSrc, /legacy_unchecked_inbound/);
  });

  it('普通收口后来信不在列表层丢弃，先入队等待会话读取', () => {
    const idx = chatSrc.indexOf('if (closed) {');
    assert.ok(idx > 0);
    const block = chatSrc.slice(idx, idx + 1900);
    assert.match(block, /drop\.closedAfterInbound\+\+/);
    assert.match(block, /closed_inbound_queued_for_reply_check/);
    assert.match(block, /closedInboundPendingAt/);
    assert.doesNotMatch(block, /closedInboundNoReply = 1/);
    assert.match(chatSrc, /closedInboundCheckedAt = Date\.now\(\)/);
  });

  it('候选里不会出现 closed + revived 的放行项', () => {
    assert.doesNotMatch(chatSrc, /closed: revived \? false : closed/);
  });

  it('收口后来信已复活时，脉冲必须真的选中它', () => {
    const picked = P.selectTarget(
      [{ handle: 'revived', closed: true, revived: true, unread: true, lastSpeaker: 'peer' }],
      Date.now()
    );
    assert.ok(picked, '复活会话不能被 closed 一刀切跳过');
    assert.equal(picked.handle, 'revived');

    const hardClosed = P.selectTarget(
      [{ handle: 'still_closed', closed: true, revived: false, unread: true, lastSpeaker: 'peer' }],
      Date.now()
    );
    assert.equal(hardClosed, null, '未复活的收口会话仍然不能打开');
    assert.match(pulseSrc, /cand\.closed && !cand\.revived/);
    assert.match(pulseSrc, /item\.closed && !item\.revived/);
  });
});

describe('P0-3b · 没 handle 的对方最后发言行必须可核对，不再一律丢弃', () => {
  it('扫描阶段允许 unbound 对方最后发言行进入一次探测', () => {
    assert.match(chatSrc, /pickReason: 'unbound_peer_last'/);
    assert.match(chatSrc, /unboundProbe: true/);
    assert.match(chatSrc, /drop\.unboundProbe\+\+/);
  });

  it('打开后按会话头/URL 命中台账，并支持“收口后复活”', () => {
    assert.match(chatSrc, /var effectiveRevived = !!\(item && item\.revived\);/);
    assert.match(chatSrc, /window\.SgInboxDecision\.isFullyClosed\(dbEntry\)/);
    assert.match(chatSrc, /reopened: effectiveRevived/);
  });

  it('发送确认不能把“旧气泡重新渲染”当成发送成功', () => {
    const at = chatSrc.indexOf('function confirmTick()');
    const block = chatSrc.slice(at, at + 1400);
    const composerAt = block.indexOf('if (composerStillFull) return null;');
    const bubbleAt = block.indexOf('__newOwnMatchesNeedles');
    assert.ok(composerAt > 0, 'confirmTick 必须检查输入框是否清空');
    assert.ok(bubbleAt > composerAt, '输入框检查必须排在气泡命中之前');
  });

  it('LINE 链接卡拆节点导致文本针失效时，输入框清空 + 我方气泡增加仍算发送成功', () => {
    assert.match(chatSrc, /own_bubble_grew/);
    assert.match(chatSrc, /!composerFinal && ownAfterCount > ownBeforeCount/);
  });

  it('列表归属优先「你:」前缀；补证只认台账里刚发过的催加/广告原文', () => {
    assert.match(chatSrc, /var ownBySentText = !previewData\.isDraft/);
    assert.match(chatSrc, /var isOwnSentPreview = \(!!previewData\.fromSelf && !previewData\.isDraft\) \|\| ownBySentText;/);
    // 不能退回到“整池话术模糊匹配”：对方回一句同款破冰不能判成我方
    assert.doesNotMatch(chatSrc, /previewData\.fromSelf \|\| ownPreviewByScript/);
  });
});

describe('P0-4 · 私信只在工作时段运行', () => {
  it('调度入口在非私信时段直接返回，不扫不开不发', () => {
    const start = chatSrc.indexOf('function runInboxModeTick() {');
    assert.ok(start > 0);
    const end = chatSrc.indexOf('window.__sgChatMainEngineTick', start);
    const block = chatSrc.slice(start, end > start ? end : start + 5200);
    // 4.9.14：时段结果先求值，便于心跳在早退之前上报；闸门仍必须存在。
    assert.match(block, /var workWindowNow = isChatWorkWindowNow\(\)/);
    assert.match(block, /if \(!workWindowNow\)/);
    assert.match(block, /reportInboxPausedOnce\(\)/);
    assert.match(block, /return;/);
  });

  it('拉新跨进夜间时只切回守箱，不导航、不打开收件箱', () => {
    assert.match(chatSrc, /exitInboxRosterPhase\('outside_chat_hours', \{ navigate: false, checkAt: false \}\)/);
    assert.match(chatSrc, /if \(opts\.navigate === false\) return true;/);
  });

  it('脉冲本身也有第二道时段闸', () => {
    const start = chatSrc.indexOf('async function runInboxPulse(opts) {');
    assert.ok(start > 0);
    const block = chatSrc.slice(start, start + 2000);
    assert.match(block, /reason: 'outside_chat_hours'/);
  });

  it('手动/批量守箱循环也受同一时段闸约束', () => {
    const start = chatSrc.indexOf('async function runInboxWatchLoop(opts) {');
    assert.ok(start > 0);
    const block = chatSrc.slice(start, start + 900);
    assert.match(block, /if \(!isChatWorkWindowNow\(\)\)/);
    assert.doesNotMatch(block, /ignoreChatHours/);
    assert.match(block, /reason: 'outside_chat_hours'/);
  });

  it('发送前还有硬闸：跨出时段也绝不发出', () => {
    assert.match(chatSrc, /var sendBlockedByHours = false;/);
    assert.match(chatSrc, /sendError = sendBlockedByHours\s*\? 'outside_chat_hours'/);
    // 超时放弃与“开关关闭”必须分开报，不能再混成 send_disabled
    assert.match(chatSrc, /sendAbortedByTimeout \? 'pulse_aborted' : 'send_disabled'/);
  });

  it('暂停原因每小时只上报一次，并带私信时段', () => {
    assert.match(chatSrc, /chat\.inbox_paused/);
    assert.match(chatSrc, /sg_inbox_paused_at/);
    assert.match(chatSrc, /function chatHoursLabel\(\)/);
  });

  it('夜间只跑关注/养号/手动转帖，守箱不产生任何私信动作', () => {
    assert.match(chatSrc, /非私信时段：守箱不扫列表、不打开会话、不发任何私信/);
  });
});

describe('年龄口径 · 读不出照常发广告，但原因单独标出', () => {
  it('运行时与契约两侧都返回 age_unknown_ad', () => {
    assert.match(
      fs.readFileSync(path.join(__dirname, '..', 'chat', 'inbox-state.js'), 'utf8'),
      /age !== null \? 'age_ok' : 'age_unknown_ad'/
    );
    assert.match(decisionSrc, /age !== null \? 'age_ok' : 'age_unknown_ad'/);
  });

  it('OPS 有对应的中文解释', () => {
    assert.match(chatSrc, /年龄没读出来，按规则照常发广告/);
  });
});

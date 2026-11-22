'use strict';

/**
 * 4.9.79 回归：
 * 1) 收件箱关闭横幅必须能穿透多层 shadowRoot（深度 12）。
 * 2) 台账 round=0 但对方最后发言 → 允许打开会话做历史校准，不再直接丢弃。
 * 3) 会话里有我方气泡 → 补认破冰；没有我方气泡 → 明确 peer_dm_before_ice。
 * 4) 非两段式广告节奏 = 下一次轮询，不能再用 60 分钟等待。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const chatSrc = fs.readFileSync(path.join(root, 'chat/content_chat.js'), 'utf8');

test('关闭横幅文本穿透 shadowRoot 深度必须是 12', () => {
  const start = chatSrc.indexOf('function __dmCollectTextDeep');
  assert.ok(start > 0, '缺少 __dmCollectTextDeep');
  const body = chatSrc.slice(start, start + 2200);
  assert.match(body, /depth > 12/);
  assert.doesNotMatch(body, /depth > 6/);
});

test('关闭横幅必须先扫私信容器，不能从全页 200k 预算里碰运气', () => {
  assert.match(chatSrc, /function __dmConversationTextForClosedBanner/);
  const start = chatSrc.indexOf('function detectPeerInboxClosedBanner');
  // 4.9.113：新增了「无身份不可匹配」分支，窗口相应放宽。
  const body = chatSrc.slice(start, start + 3600);
  assert.match(body, /__dmConversationTextForClosedBanner\(\)/);
  assert.match(body, /__dmCollectTextDeep\(document\.documentElement \|\| document\.body, 60000, 0\)/);
  assert.match(chatSrc, /scopedTextLen/);
});

test('台账没破冰但对方最后发言：进入核对候选，不再直接 no_ice 丢弃', () => {
  const start = chatSrc.indexOf('if (handle && !iceAt) {');
  assert.ok(start > 0, '缺少 no-ice 分支');
  const body = chatSrc.slice(start, start + 6200);
  assert.match(body, /noIceProbe/);
  assert.match(body, /no_ice_peer_last_reconcile/);
  assert.match(body, /if \(!peerLast \|\| pendingDraft\)/);
  // 临时条目不再无条件丢弃：对方真的回了要允许按证据再核对一次
  assert.match(body, /no_ice_synthetic_recheck/);
  assert.match(body, /spPreviewChanged/);
  // 4.9.106：从未成功核对过的临时条目必须给一次验证打开的机会，
  // 否则永远拿不到会话头的真实 @handle，也就永远并不回真实账号。
  assert.match(body, /spNeverVerified/);
  // 4.9.110：未核对过的临时条目不能再靠“一次尝试”永久锁死；
  // 现在由 spRetryDue 保证退避到期后一定重试。
  assert.match(body, /spPreviewChanged \|\| spRetryDue/);
  assert.match(body, /spAttemptAt/);
  assert.match(body, /unreadInfo\.unread && spFailCount < 2/);
  // 旧实现“一生最多 3 次”会在对方第 4 次回信时永久漏掉，必须移除
  assert.doesNotMatch(body, /spCount < 3/);
});

test('临时条目只认 watchOnly 标记，不能按 p+数字猜（真实账号可能就叫 p89089212）', () => {
  assert.match(chatSrc, /no_ice_synthetic_identity_unknown/);
  assert.match(chatSrc, /var syntheticNoIceKey = !!entry\.watchOnly/);
  // 形似 p<peerId> 的真实 handle 不能再被正则误判
  assert.doesNotMatch(chatSrc, /\^p\\d\{5,\}\$\/\.test\(String\(handle\)\)/);
  assert.match(chatSrc, /\^dn_/i);
});

test('临时条目核对只在读成功后记预览，读失败不能把预览当已核对', () => {
  // 打开阶段只写时间与次数
  const early = chatSrc.indexOf('if (item && item.syntheticRecheck) {');
  assert.ok(early > 0, '缺少 syntheticRecheck 打开留痕');
  const earlyBody = chatSrc.slice(early, early + 400);
  assert.doesNotMatch(earlyBody, /lastProbePreview =/);
  // 成功分支才写预览
  assert.match(chatSrc, /lastProbePreview = String\(item\.preview \|\| ''\)\.slice\(0, 60\)/);
});

test('临时条目读失败后按时间退避重试，预览变化立即重试', () => {
  assert.match(chatSrc, /lastProbeAttemptPreview = String\(item\.preview \|\| ''\)\.slice\(0, 60\)/);
  assert.match(chatSrc, /lastProbeAttemptAt = Date\.now\(\)/);
  assert.match(chatSrc, /probeFailCount = \(Number\(vDb\[targetHandle\]\.probeFailCount\) \|\| 0\) \+ 1/);
  assert.match(chatSrc, /probeFailCount = 0/);
  // 4.9.106：“已核对”只认真正读成功过的 lastProbePreview；
  // 失败尝试单独记在 lastProbeAttemptPreview，不能让它冒充“已核对”，
  // 否则从未拿到真实 @handle 的临时记录会被永久跳过。
  assert.match(chatSrc, /var spLastPreview = String\(spEntry\.lastProbePreview \|\| ''\)/);
  assert.match(chatSrc, /var spLastAttemptPreview = String\(spEntry\.lastProbeAttemptPreview \|\| ''\)/);
  // 4.9.110：旧规则「同一预览只尝试一次」会让一次后台白屏把这个人永久锁死。
  // 现在失败后按 10 分钟退避重试；预览变化（对方真的又发了消息）立即重试。
  assert.match(chatSrc, /var spAttemptAt = Number\(spEntry\.lastProbeAttemptAt\) \|\| 0/);
  assert.match(chatSrc, /var spRetryWaitMs = 10 \* 60 \* 1000/);
  assert.match(chatSrc, /var spRetryDue = !spAttemptAt \|\| \(Date\.now\(\) - spAttemptAt\) >= spRetryWaitMs/);
  assert.match(chatSrc, /spPreviewChanged \|\| spRetryDue/);
  assert.doesNotMatch(chatSrc, /spPreview === spLastAttemptPreview\) \{\s*\n\s*spNeverVerified = false;/);
});

test('历史补认破冰时识别到我方广告气泡 → 直接补认广告，避免重复发广告', () => {
  const start = chatSrc.indexOf('var ownHasAdBubble = false;');
  assert.ok(start > 0, '缺少 ownHasAdBubble 判定');
  const body = chatSrc.slice(start, start + 1500);
  assert.match(body, /line\\\.me\\\//i);
  assert.match(body, /LINE\\s\*ID/);
  assert.match(body, /adAdoptedFromHistoryAt/);
  assert.match(body, /Math\.max\(2, Number\(adoptDb\[targetHandle\]\.round\) \|\| 0\)/);
});

test('X 缺「你:」前缀时，用台账已发催加/广告原文补判我方，避免每拍空转', () => {
  assert.match(chatSrc, /function previewMatchesOwnSentText/);
  const start = chatSrc.indexOf('function previewMatchesOwnSentText');
  const body = chatSrc.slice(start, start + 1400);
  assert.match(body, /lastKick1Text/);
  assert.match(body, /lastFinalKickText/);
  assert.match(body, /lastAdText/);
  assert.match(chatSrc, /entry\.lastAdText = text/);
  assert.match(chatSrc, /var ownBySentText = !previewData\.isDraft/);
  assert.match(chatSrc, /previewData\.fromSelf && !previewData\.isDraft\) \|\| ownBySentText/);
});

test('台账目标连续完整扫描都找不到 → 有明确收口原因，不能永久挂在待处理', () => {
  assert.match(chatSrc, /scanComplete: !!\(deepEvidence && deepEvidence\.complete\)/);
  const start = chatSrc.indexOf('if (opts.scanComplete) {');
  assert.ok(start > 0, '缺少 scanComplete 分支');
  // 4.9.113：新增了「无身份不可匹配」分支，窗口相应放宽。
  const body = chatSrc.slice(start, start + 3600);
  assert.match(body, /seenHandles\[mh\]/);
  assert.match(body, /ledgerMissCount/);
  assert.match(body, /ledgerMissCount >= 12/);
  assert.match(body, /24 \* 60 \* 60 \* 1000/);
  assert.match(body, /closedWhy = 'conversation_not_in_inbox'/);
  assert.match(body, /notSeenClosed/);
});

test('无 handle 的陌生会话只有未读才做身份探测', () => {
  assert.match(chatSrc, /peerLast && !pendingDraft && unreadInfo\.unread/);
});

test('页面没渲染时不能判定“对方先私信”（技术失败不能写业务结论）', () => {
  const start = chatSrc.indexOf('peerDmBeforeIceAt = Date.now()');
  assert.ok(start > 0, '缺少 peerDmBeforeIce 写入点');
  const before = chatSrc.slice(Math.max(0, start - 1400), start);
  assert.match(before, /ownBubbleCount === 0/);
  assert.match(before, /domProbe\.rootFound && \(domProbe\.leaves > 0 \|\| domProbe\.articles > 0\)/);
});

test('续跑时地址对但正文是空壳：必须退回点击列表行重开', () => {
  const start = chatSrc.indexOf('chat.inbox_resume_empty');
  assert.ok(start > 0, '缺少空壳续跑检测');
  const around = chatSrc.slice(Math.max(0, start - 1600), start + 200);
  assert.match(around, /alreadyOpen = false/);
  assert.match(around, /countVisibleDmMessageNodes\(\)/);
  assert.match(around, /empty_pane_reopen_by_click/);
});

test('同一预览 30 分钟内不再反复“复活”（防止收口会话每拍空转）', () => {
  const start = chatSrc.indexOf('revive_cooldown_same_preview');
  assert.ok(start > 0, '缺少复活冷却');
  const body = chatSrc.slice(Math.max(0, start - 900), start + 300);
  assert.match(body, /lastReviveAt/);
  assert.match(body, /lastRevivePreview/);
  assert.match(chatSrc, /item\.revived && replyVerdict === 'no_new_reply'/);
});

test('收口之前的“待核对来信”不能被当成收口后新入站', () => {
  const start = chatSrc.indexOf('legacyPendingIsNew');
  assert.ok(start > 0, '缺少收口前后时间比较');
  const body = chatSrc.slice(Math.max(0, start - 700), start + 260);
  assert.match(body, /closedAtForLegacy/);
  assert.match(body, /pendingForLegacy > closedAtForLegacy/);
});

test('列表最后一条是我方的陌生会话要登记身份，但不进破冰队列', () => {
  assert.match(chatSrc, /adopted_inbox_own_last/);
  const start = chatSrc.indexOf('adopted_inbox_own_last');
  assert.ok(start > 0);
  const body = chatSrc.slice(Math.max(0, start - 900), start + 260);
  assert.match(body, /isOwnSentPreview && !pendingDraft/);
  assert.match(body, /watchOnly: 1/);
  assert.match(body, /peerId: peerId/);
  // 只登记身份，不发送
  assert.doesNotMatch(body, /\bsend\w*\(/);
  // 破冰队列必须仍然排除只有 watchOnly 的占位行
  assert.match(chatSrc, /if \(entry\.watchOnly && !entry\.iceSentAt\) continue;/);
});

test('台账批量写盘的脏标记声明在扫描函数内（防止 pulse_exception）', () => {
  const fn = chatSrc.indexOf('function collectInboxWatchCandidates(');
  assert.ok(fn > 0);
  const decl = chatSrc.indexOf('var dbDirty = 0;', fn);
  assert.ok(decl > 0 && decl < fn + 900, 'dbDirty 必须声明在 collectInboxWatchCandidates 开头');
  const use = chatSrc.indexOf('dbDirty++', fn);
  assert.ok(use > decl, 'dbDirty++ 必须在声明之后');
});

test('打开会话后用我方气泡补认破冰；没有我方气泡写明 peer_dm_before_ice', () => {
  assert.match(chatSrc, /iceAdoptedFromHistory/);
  assert.match(chatSrc, /iceAdoptEvidence = 'own_bubbles:'/);
  assert.match(chatSrc, /peerDmBeforeIceAt/);
  assert.match(chatSrc, /decisionRes\.reason = 'peer_dm_before_ice'/);
  assert.match(chatSrc, /peer_dm_before_ice: '对方先发来私信/);
});

test('非两段式广告在下一拍推进，两段式仍等 adMinWait', () => {
  assert.match(
    chatSrc,
    /var adAdvanceMs = isTwoSegChatMode\(\) \? getAdMinWaitMs\(\) : \(60 \* 1000\)/
  );
});

test('扫到但未处理明细单独上报，避免主事件被瘦身截断', () => {
  assert.match(chatSrc, /reportChatMetric\('chat\.inbox_scan_drop'/);
  assert.match(chatSrc, /peer_last_samples: \(dropD\.peerLastSamples \|\| \[\]\)\.slice\(0, 5\)/);
  assert.match(chatSrc, /h: String\(s\.handle \|\| ''\)\.slice\(0, 32\)/);
  assert.match(chatSrc, /st: String\(le\.stage \|\| ''\)\.slice\(0, 12\)/);
});

test('积压标记独立于 inbox state：上一拍还有候选就强制深扫', () => {
  assert.match(chatSrc, /sg_inbox_backlog_mark/);
  assert.match(chatSrc, /backlogDeep = true/);
  assert.match(chatSrc, /sessionStorage\.setItem\('sg_inbox_backlog_mark'/);
});

test('同一目标 60 分钟内最多直开 3 次，不会一次失败锁一小时', () => {
  const start = chatSrc.indexOf("var firstNav = inboxHardNavigate(navUrl, 'open_direct'");
  const body = chatSrc.slice(start, start + 400);
  assert.match(body, /maxCount: 3/);
  assert.match(body, /overflowEveryMs: 20 \* 60000/);
});

/**
 * 回复逻辑契约：不允许把「技术没读到」当成「对方没回复」。
 * 运行：node --test --test-force-exit test/inbox-reply-logic.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const chatSource = fs.readFileSync(path.join(__dirname, '..', 'chat', 'content_chat.js'), 'utf8');
const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'obs', 'event-catalog.json'), 'utf8'));

function catalogHas(id) {
  return (catalog.events || []).some(ev => ev && ev.id === id);
}

describe('4.9.110 后台预检不得把“没扫全”当成“没活”', () => {
  it('预检必须回报数据来源：是否用缓存、缓存多少行、实时可见多少行', () => {
    const start = chatSource.indexOf('function hiddenInboxHasWork');
    assert.ok(start > 0, '缺少 hiddenInboxHasWork');
    const body = chatSource.slice(start, start + 3200);
    assert.match(body, /cache_used/);
    assert.match(body, /cache_rows/);
    assert.match(body, /cache_age_ms/);
    assert.match(body, /live_rows/);
    assert.match(body, /full_list/);
  });

  it('列表不完整时不得回 no_task，必须先去激活标签做完整扫描', () => {
    // 只有 full_list 为真才允许 no_task；旧逻辑只要候选 0 就判定没活，
    // 于是“只看到顶部 12 行”会永久压住整箱未读。
    assert.match(chatSource, /hiddenPre\.actionable === 0 && hiddenPre\.full_list !== false/);
  });

  it('hidden_no_work 必须带出丢弃明细，后台能回答“为什么没处理”', () => {
    const start = chatSource.indexOf("reason: 'hidden_no_work'");
    assert.ok(start > 0, '缺少 hidden_no_work 分支');
    const body = chatSource.slice(start, start + 1400);
    assert.match(body, /drop: hiddenPre\.drop/);
    assert.match(body, /samples: hiddenPre\.samples/);
    assert.match(body, /full_list: hiddenPre\.full_list !== false/);
  });
});

describe('4.9.110 临时台账读失败必须能重试，不能永久锁死', () => {
  it('记录尝试时间并按 10 分钟退避重试', () => {
    assert.match(chatSource, /lastProbeAttemptAt = Date\.now\(\)/);
    assert.match(chatSource, /var spAttemptAt = Number\(spEntry\.lastProbeAttemptAt\) \|\| 0/);
    assert.match(chatSource, /var spRetryWaitMs = 10 \* 60 \* 1000/);
    assert.match(chatSource, /var spRetryDue = !spAttemptAt \|\| \(Date\.now\(\) - spAttemptAt\) >= spRetryWaitMs/);
    assert.match(chatSource, /spPreviewChanged \|\| spRetryDue/);
  });

  it('退避未到期要单独计数，不能混进“规则不回”', () => {
    assert.match(chatSource, /drop\.probeRetryWait = \(Number\(drop\.probeRetryWait\) \|\| 0\) \+ 1/);
  });
});

describe('48h 清理不得误伤已回复目标', () => {
  it('有 lastInboundAt / replySeenAt 的目标直接跳过', () => {
    const start = chatSource.indexOf('function pruneStaleNoReply');
    assert.ok(start > 0);
    const block = chatSource.slice(start, start + 1600);
    assert.match(block, /entry\.lastInboundAt && entry\.lastInboundAt >= lastDm/);
    assert.match(block, /entry\.replySeenAt && entry\.replySeenAt >= lastDm/);
    assert.match(block, /entry\.unreadSeenAt && entry\.unreadSeenAt >= lastDm/);
    assert.match(block, /entry\.lastNonTextInboundAt && entry\.lastNonTextInboundAt >= lastDm/);
  });

  it('没有扫描证据时只延后，不永久拉黑', () => {
    const start = chatSource.indexOf('function pruneStaleNoReply');
    const end = chatSource.indexOf('function pruneStaleIfNeeded', start);
    assert.ok(start > 0 && end > start);
    const block = chatSource.slice(start, end);
    assert.match(block, /var watchedAt = Number\(entry\.inboxWatchedAt\) \|\| 0;/);
    assert.match(block, /if \(!watchedAt \|\| watchedAt < lastDm\)/);
    assert.match(block, /staleDeferredReason = 'scan_evidence_missing'/);
    assert.match(block, /staleDeferredAt/);
    assert.doesNotMatch(block.slice(0, block.indexOf('if (now - lastDm < staleMs)')), /markPeerBlocked/);
  });

  it('白屏/空壳不能写扫描证据', () => {
    assert.match(chatSource, /var scanEvidenceOk = !!\(domProbe\.rootFound/);
    assert.match(chatSource, /else if \(scanEvidenceOk\) \{\s*wDb\[targetHandle\]\.inboxWatchedAt = nowTs/);
    // 身份没证明时不得写任何回复/入站证据
    assert.match(chatSource, /if \(!identity\.ok\) \{[\s\S]{0,240}identityBlockedAt/);
  });
});

describe('每个会话都必须有可检索的结论', () => {
  it('单会话结论上报 chat.inbox_tick', () => {
    assert.match(chatSource, /reportChatMetric\('chat\.inbox_tick'/);
    assert.match(chatSource, /reply_reason: decisionRes\.reason/);
    assert.match(chatSource, /reply_reason_zh: tickReasonText/);
    assert.match(chatSource, /identity_reason: identity\.reason/);
    assert.match(chatSource, /send_error: sendError/);
  });

  it('脉冲结论上报 chat.inbox_pulse', () => {
    assert.match(chatSource, /reportChatMetric\('chat\.inbox_pulse'/);
    assert.match(chatSource, /scan_drop: \(result\.scan && result\.scan\.drop\)/);
    assert.match(chatSource, /scan_drop_zh/);
    assert.match(chatSource, /扫到但未处理：/);
    assert.match(chatSource, /reason_zh: pulseReasonText/);
  });

  it('事件目录已登记两个新事件', () => {
    assert.equal(catalogHas('chat.inbox_pulse'), true);
    assert.equal(catalogHas('chat.inbox_tick'), true);
  });

  it('48h 清理也上报可对账结论', () => {
    assert.match(chatSource, /reportChatMetric\('chat\.stale_prune'/);
    assert.equal(catalogHas('chat.stale_prune'), true);
  });

  it('非文本入站单独上报并可检索', () => {
    assert.match(chatSource, /reportChatMetric\('chat\.inbox_non_text'/);
    assert.doesNotMatch(chatSource, /chat\.inbox_manual_review/);
    assert.equal(catalogHas('chat.inbox_non_text'), true);
  });

  it('现场诊断能列出待人工与卡住的目标', () => {
    assert.match(chatSource, /diag\.followUps = followUps/);
    assert.match(chatSource, /diag\.scanDrop = window\.__sgInboxScanDrop/);
    assert.match(chatSource, /diag\.pulseState = loadInboxState\(\)/);
    assert.match(chatSource, /reopened_after_close/);
    assert.match(chatSource, /identity_unverifiable/);
  });

  it('放弃待处理目标必须留台账和 OPS 证据', () => {
    assert.match(chatSource, /function abandonInboxPending/);
    assert.match(chatSource, /sendAbandonedAt/);
    assert.match(chatSource, /sendAbandonedReason/);
    assert.match(chatSource, /reportChatMetric\('chat\.inbox_task_abandoned'/);
    assert.match(chatSource, /pending_target_mismatch/);
    assert.match(chatSource, /pending_expired/);
    assert.equal(catalogHas('chat.inbox_task_abandoned'), true);
  });

  it('待重试目标优先续跑，且重试次数不被重置', () => {
    assert.match(chatSource, /pendingCarryTries = \(resumeItem && \(Number\(resumeItem\.tries\) \|\| 0\)\) \|\| 0/);
    assert.match(chatSource, /result\.pendingResume = true/);
    assert.match(chatSource, /pending_not_in_list/);
    assert.match(chatSource, /tries: pendingCarryTries/);
    assert.match(chatSource, /pending_resume: !!result\.pendingResume/);
  });
});

describe('非文本入站与空会话必须分开', () => {
  it('有气泡节点但无文本 → peer_non_text_unhandled', () => {
    assert.match(chatSource, /var nonTextInbound = !!\(domProbe\.rootFound && domProbe\.articles > domProbe\.leaves/);
    assert.match(chatSource, /reason: 'peer_non_text_unhandled'/);
    assert.match(chatSource, /lastNonTextInboundAt/);
  });
});

describe('身份证明不得静默改写台账', () => {
  it('台账已有 peerId 时不覆盖，会话头证明后才修复', () => {
    assert.match(chatSource, /if \(peerId && !prevPeerId\)/);
    assert.match(chatSource, /peerIdConflictPrev = prevPeerId/);
    assert.match(chatSource, /peerIdRepairedFrom = prevPeerId/);
    assert.match(chatSource, /headerProvesTarget/);
  });

  it('连续无法证明身份要计数并升级告警', () => {
    assert.match(chatSource, /identityPendingCount = \(Number\(idStat\.identityPendingCount\) \|\| 0\) \+ 1/);
    assert.match(chatSource, /if \(identityPendingCount >= 3\) tickSeverity = 'error'/);
    assert.match(chatSource, /identity_alert/);
    assert.match(chatSource, /identity_reason_zh/);
  });
});

describe('每个判定原因都必须有中文解释', () => {
  const decisionSrc = fs.readFileSync(
    path.join(__dirname, '..', 'chat', 'inbox-decision.js'),
    'utf8'
  );

  it('inbox-decision 的 reason 全部能在 tickReasonZh 找到', () => {
    const reasons = new Set();
    for (const m of decisionSrc.matchAll(/(?:skipResult|waitResult|sendResult)\(\s*'([a-z0-9_]+)'/g)) {
      reasons.add(m[1]);
    }
    const mapStart = chatSource.indexOf('var tickReasonZh');
    assert.ok(mapStart > 0, '应存在 tickReasonZh');
    const block = chatSource.slice(mapStart, chatSource.indexOf('};', mapStart) + 2);
    const keys = new Set([...block.matchAll(/^\s*([a-z0-9_]+):/gm)].map((m) => m[1]));
    const missing = [...reasons].filter((r) => !keys.has(r));
    assert.deepEqual(missing, [], '缺少中文解释: ' + missing.join(', '));
  });

  it('动态 age_below_N 与未登记原因都有兜底文案', () => {
    assert.match(chatSource, /\^age_below_\\d\+\$/);
    assert.match(chatSource, /未登记原因：/);
  });
});

describe('4.9.41 漏回复根因守卫', () => {
  const decisionSrc = fs.readFileSync(
    path.join(__dirname, '..', 'chat', 'inbox-decision.js'),
    'utf8'
  );

  it('我方最后发言时视觉蓝点不算未读（只有精确未读才算）', () => {
    assert.match(chatSource, /visualUnreadSuppressed/);
    assert.match(chatSource, /lastSpeaker === 'own' \|\| lastSpeaker === 'draft'/);
    assert.match(chatSource, /_own_last_suppressed/);
  });

  it('旧版 48h 误杀可按台账进度自动解开', () => {
    assert.match(chatSource, /peer_stop_text\|stale_48h_no_reply/);
    assert.match(chatSource, /unblockedReason = 'stale_48h_false_positive'/);
    assert.match(chatSource, /function migrateStaleFalseBlocksOnce/);
    assert.match(chatSource, /chat\.inbox_ledger_unblock/);
    assert.match(chatSource, /e\.round = 3;[\s\S]{0,80}e\.done = true/);
  });

  it('打开会话时的 48h 判定不再直接永久拉黑', () => {
    const start = chatSource.indexOf('function enforceLedgerOnDmOpen');
    const end = chatSource.indexOf('function applyLedgerSkipFromEnforce', start);
    assert.ok(start > 0 && end > start);
    const block = chatSource.slice(start, end);
    assert.doesNotMatch(block, /markPeerBlocked/);
    assert.doesNotMatch(block, /stale_48h_no_reply', block: true/);
    assert.match(block, /staleDeferredReason = 'scan_evidence_missing'/);
  });

  it('收口后列表预览变化才算新来信', () => {
    assert.match(decisionSrc, /peer_last_changed/);
    assert.match(decisionSrc, /entry\.reopenedPreview/);
    assert.match(chatSource, /reopenedPreview = String\(\(item && item\.preview\)/);
  });

  it('守箱 running 丢失会自动恢复，且心跳先于早退', () => {
    assert.match(chatSource, /function autoResumeInboxWatchIfNeeded/);
    assert.match(chatSource, /page_reload_autostart/);
    assert.match(chatSource, /paused_reason: 'inbox_not_running'/);
    assert.match(chatSource, /sg_inbox_autostart/);
  });

  it('软跳优先点站内真实链接，避免 pushState 只改地址不重绘', () => {
    const start = chatSource.indexOf('function inboxSoftGo');
    const end = chatSource.indexOf('function resetInboxSoftRemount', start);
    assert.ok(start > 0 && end > start);
    const block = chatSource.slice(start, end);
    assert.match(block, /a\[href="' \+ wantPath \+ '"\]/);
    assert.match(block, /la\.click\(\)/);
    assert.match(block, /sg_inbox_nav_at/);
  });

  it('只有收件箱路径才判白屏，路由切换给 25 秒挂载宽限', () => {
    assert.match(chatSource, /onInboxPathForBlank/);
    assert.match(chatSource, /page_route_settle/);
    assert.match(chatSource, /navAtForBlank\) < 25000/);
    // /home 等中转页必须走 navigate_to_list，不能进入软重挂
    assert.match(chatSource, /if \(!onInboxPathForBlank\) \{[\s\S]{0,200}navigate_to_list/);
  });

  it('白屏以 DOM 挂载为准：innerText 读不到但页面已渲染时不能重挂', () => {
    assert.match(chatSource, /var domNodeCount/);
    assert.match(chatSource, /var appMounted = domNodeCount >= 80/);
    assert.match(chatSource, /bodyLen < 30 && !appMounted/);
  });
});

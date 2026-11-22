'use strict';
/**
 * 4.9.8 现场回归：后台标签页不渲染、打开判据不严、渲染失败无隔离。
 * 运行：node --test --test-force-exit test/inbox-render-verdict.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(pathParts) {
  const src = fs.readFileSync(path.join(__dirname, '..', ...pathParts), 'utf8');
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
  return window;
}

const Decision = load(['chat', 'inbox-decision.js']).SgInboxDecision;
const Adapter = load(['chat', 'inbox-v2-adapter.js']).SgInboxV2Adapter;
const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'content_chat.js'), 'utf8');
const bgSrc = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const pulseSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'inbox-pulse.js'), 'utf8');

describe('回复结论 replyVerdict 必须唯一且可查', () => {
  it('消息区完全读不到 → reply_read_failed', () => {
    assert.equal(Decision.replyVerdict({
      rootFound: false, leaves: 0, articles: 0, texts: [], identityOk: true
    }), 'reply_read_failed');
    assert.equal(Decision.replyVerdict({
      rootFound: true, leaves: 0, articles: 0, texts: [], identityOk: true
    }), 'reply_read_failed');
  });

  it('有气泡但身份未证明 → identity_unproven', () => {
    assert.equal(Decision.replyVerdict({
      rootFound: true, leaves: 2, articles: 2, texts: ['hi'], identityOk: false
    }), 'identity_unproven');
  });

  it('只有非文本气泡 → non_text_inbound', () => {
    assert.equal(Decision.replyVerdict({
      rootFound: true, leaves: 0, articles: 3, texts: [], identityOk: true
    }), 'non_text_inbound');
  });

  it('读到对方新文本 → reply_detected；只有我方 → no_new_reply', () => {
    assert.equal(Decision.replyVerdict({
      rootFound: true, leaves: 2, articles: 2, texts: ['hello'], hasPeerNew: true, identityOk: true
    }), 'reply_detected');
    assert.equal(Decision.replyVerdict({
      rootFound: true, leaves: 2, articles: 2, texts: [], hasPeerNew: false,
      lastDirection: 'own', identityOk: true
    }), 'no_new_reply');
    // 消息根节点没命中，但文本兜底读到了：仍算读到，不能报“读失败”
    assert.equal(Decision.replyVerdict({
      rootFound: false, leaves: 0, articles: 0, texts: ['fallback text'], hasPeerNew: true, identityOk: true
    }), 'reply_detected');
  });

  it('最后气泡方向不明 → 技术未判明，不得当成无回复', () => {
    assert.equal(Decision.replyVerdict({
      rootFound: true, leaves: 2, articles: 2, texts: [], hasPeerNew: false,
      lastDirection: 'unknown', identityOk: true
    }), 'direction_unproven');
    assert.equal(Decision.replyVerdict({
      rootFound: true, leaves: 2, articles: 2, texts: [], hasPeerNew: false,
      lastDirection: 'none', identityOk: true
    }), 'direction_unproven');
  });
});

describe('渲染失败冷却', () => {
  const NOW = 1700000000000;
  const MIN = 60 * 1000;

  it('连续 2 次失败后 30 分钟内冷却', () => {
    const r = Decision.renderCooling({ renderFailCount: 2, renderFailAt: NOW - 5 * MIN }, '', NOW);
    assert.equal(r.cooling, true);
    assert.equal(r.reason, 'render_failed_cooling');
  });

  it('单次失败后 90 秒内不重复同一目标', () => {
    const r = Decision.renderCooling({ renderFailCount: 1, renderFailAt: NOW - 30 * 1000 }, '', NOW);
    assert.equal(r.cooling, true);
    assert.equal(r.reason, 'render_retry_wait');
  });

  it('超过 30 分钟自动解除', () => {
    const r = Decision.renderCooling({ renderFailCount: 2, renderFailAt: NOW - 31 * MIN }, '', NOW);
    assert.equal(r.cooling, false);
  });

  it('列表预览变化 = 真来了新消息，立即解除冷却', () => {
    const r = Decision.renderCooling(
      { renderFailCount: 2, renderFailAt: NOW - 5 * MIN, renderFailPreview: '旧消息' },
      '新消息',
      NOW
    );
    assert.equal(r.cooling, false);
    assert.equal(r.reset, true);
    assert.equal(r.reason, 'preview_changed');
  });
});

describe('会话直达地址', () => {
  it('peerId + myId 生成 /i/chat/<peer>-<my>', () => {
    assert.equal(Adapter.buildConversationUrl('1941627275159412737', '1837000000000000000'),
      '/i/chat/1941627275159412737-1837000000000000000');
  });

  it('缺 myId 或自己等于对方时不生成，交给点击回退', () => {
    assert.equal(Adapter.buildConversationUrl('1941627275159412737', ''), '');
    assert.equal(Adapter.buildConversationUrl('12345678901', '12345678901'), '');
  });
});

describe('守卫：后台标签必须先激活，且不能用刷新恢复空壳', () => {
  it('内容脚本会请求激活标签并在仍 hidden 时延后', () => {
    assert.match(chatSrc, /function activateInboxTab\(\)/);
    assert.match(chatSrc, /action: 'sg_activate_tab'/);
    assert.match(chatSrc, /page_hidden_deferred/);
    assert.match(chatSrc, /document\.visibilityState !== 'hidden'/);
    const start = chatSrc.indexOf('function activateInboxTab()');
    const end = chatSrc.indexOf('function readDmConversationHeaderHandle', start);
    const fn = chatSrc.slice(start, end);
    // 4.9.36：只激活窗口内的标签，绝不抢窗口焦点（否则每拍把 Chrome 弹到前台）。
    assert.match(fn, /send\(\{ action: 'sg_activate_tab' \}/);
    assert.doesNotMatch(fn, /focusWindow: true/);
    assert.match(fn, /document\.visibilityState !== 'hidden'/);
  });

  it('后台只激活 sender tab，默认不抢窗口焦点', () => {
    assert.match(bgSrc, /request\.action === 'sg_activate_tab'/);
    assert.match(bgSrc, /chrome\.tabs\.update\(tabId, \{ active: true \}/);
    assert.match(bgSrc, /disabled_by_default/);
    assert.match(bgSrc, /request\.allowWindowFocus !== true/);
    // 连续多拍激活失败必须升 error，不能每分钟静默 defer
    assert.match(chatSrc, /sg_inbox_hidden_streak/);
    assert.match(chatSrc, /hiddenAlert = hiddenStreak >= 3/);
    assert.match(chatSrc, /hidden_alert: !!result\.hiddenAlert/);
    assert.match(chatSrc, /result\.retryInMs = 20000/);
    assert.match(chatSrc, /next\.nextPulseAt = Date\.now\(\) \+ Math\.max\(5000/);
    assert.match(chatSrc, /result\.retryInMs = 5000/);
    assert.match(chatSrc, /resetInboxFailuresAfterHidden/);
    assert.match(chatSrc, /render_reset: result\.renderReset/);
    // 找不到滚动容器时用 scrollIntoView 兜底，不能直接放弃
    assert.match(chatSrc, /scrollMode = 'scroll_into_view'/);
    assert.match(chatSrc, /scroll_into_view_no_new_rows/);
    // 整页跳转丢掉 pending 时，用 URL peerId 重建
    assert.match(chatSrc, /reconstructed: true/);
    assert.match(chatSrc, /pending: st\.pending \?/);
    assert.match(chatSrc, /next_pulse_at: next\.nextPulseAt/);
    // 必须先激活再深度扫描：hidden 状态下列表不会真正挂载/滚动
    const activateAt = chatSrc.indexOf('vis = await activateInboxTab()');
    const deepScanAt = chatSrc.indexOf('allRowsScanned = await scanInboxRowsDeep');
    assert.ok(activateAt > 0 && deepScanAt > 0);
    assert.ok(activateAt < deepScanAt, '激活必须发生在深度扫描之前');
  });

  it('列表根不能被当成会话已打开', () => {
    assert.match(chatSrc, /if \(isDmInboxListRootPath\(\)\) return false;/);
    assert.match(chatSrc, /if \(!pathHasConversationId\(\)\) return false;/);
  });

  it('不再有按目标整页硬刷新恢复会话的旧路径', () => {
    assert.doesNotMatch(chatSrc, /dan_inbox_hard_reload_/);
    assert.doesNotMatch(chatSrc, /会话未渲染（leaves=0, 无会话头）→ 硬刷新当前会话/);
  });

  it('停在冷却中的会话页时，也不会立刻重试同一个空壳', () => {
    assert.match(chatSrc, /function inboxPendingCooling\(pend\)/);
    assert.match(chatSrc, /inboxPendingCooling\(pendResume\)/);
    assert.match(chatSrc, /reason === 'render_failed_cooling'/);
  });
});

describe('脉冲反馈与排序', () => {
  it('脉冲事件带 hidden/activated/verdict/next_pulse', () => {
    assert.match(chatSrc, /hidden: !!result\.hidden/);
    assert.match(chatSrc, /activated_tab: !!result\.activatedTab/);
    assert.match(chatSrc, /reply_verdict: result\.replyVerdict/);
    assert.match(chatSrc, /next_pulse_at: next\.nextPulseAt/);
    assert.match(chatSrc, /build: extensionVersion\(\)/);
    assert.match(chatSrc, /bubble_own_count: directionAudit\.own/);
    assert.match(chatSrc, /bubble_peer_count: directionAudit\.peer/);
    assert.match(chatSrc, /bubble_direction_unknown_count: directionAudit\.unknown/);
    assert.match(chatSrc, /last_bubble_direction: directionAudit\.lastDirection/);
  });

  it('方向未知不会被兜底当作对方，且脉冲记录方向审计', () => {
    assert.match(chatSrc, /function auditDmMessageDirections\(\)/);
    assert.match(chatSrc, /return 'unknown';/);
    assert.match(chatSrc, /classifyDmMessageOwnPeer\(raw, leaf\) !== 'peer'/);
    assert.match(chatSrc, /replyVerdict === 'direction_unproven'/);
  });

  it('新增守箱心跳事件', () => {
    assert.match(chatSrc, /reportChatMetric\('chat\.inbox_loop'/);
  });

  it('排序统一由 inbox-decision 提供，不再维护第二套', () => {
    assert.match(pulseSrc, /SgInboxDecision\.sortInboxCandidates/);
    assert.match(pulseSrc, /SgInboxDecision\.candidatePriority/);
  });

  it('直开导航未落地时不得被白屏刷新打断', () => {
    assert.match(chatSrc, /blank_page_wait_navigation/);
    assert.match(chatSrc, /stBlank\.pending && blankPendingAge < 30000/);
    assert.match(chatSrc, /st\.pending && !onConvPage && !_inboxPulseBusy/);
    assert.match(chatSrc, /noteChatProgress\('inbox_nav_pending'\)/);
    assert.match(chatSrc, /keepPending =[\s\S]*blank_page_wait_navigation/);
  });

  it('未处理样本必须带 peerId/显示名/列表预览', () => {
    assert.match(chatSrc, /peer_id: String\(peerId \|\| ''\)/);
    assert.match(chatSrc, /display: String\(displayName \|\| ''\)/);
    assert.match(chatSrc, /preview: String\(\(previewData && previewData\.preview\) \|\| ''\)/);
  });
});

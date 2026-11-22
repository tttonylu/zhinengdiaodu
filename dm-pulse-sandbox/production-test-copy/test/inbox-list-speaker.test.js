/**
 * 现场回归：脉冲必须真的下滑；进会话前先按列表最后发言者分层。
 * 运行：node --test --test-force-exit test/inbox-list-speaker.test.js
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

const D = load(['chat', 'inbox-decision.js']).SgInboxDecision;
const Scan = load(['chat', 'inbox-list-scan.js']).SgInboxListScan;
const Adapter = load(['chat', 'inbox-v2-adapter.js']).SgInboxV2Adapter;
const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'content_chat.js'), 'utf8');
const adapterSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'inbox-v2-adapter.js'), 'utf8');
const watchSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'inbox-watch.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));

describe('列表级判据 · 最后发言者决定先回谁', () => {
  it('多行我方消息不能被误判成对方最后发言', () => {
    // 现场：列表里显示「你: まだかなー🥺 / こっちの方が… / test」，
    // 旧逻辑只取最后一行 → preview="test"、fromSelf=false，
    // 于是每拍把已经回复过的人重新打开，还会把收口会话复活。
    const p = Adapter.parsePreviewLines([
      '熊谷のZERO',
      '你: 最後のメッセージだよ🙏',
      'LINEの方が楽だよ💕',
      'test',
      '2 天',
    ]);
    assert.equal(p.fromSelf, true);
    assert.equal(p.isDraft, false);
    assert.match(p.preview, /最後のメッセージだよ/);

    const peer = Adapter.parsePreviewLines(['れん', '40です', '2 天']);
    assert.equal(peer.fromSelf, false);
    assert.equal(peer.preview, '40です');

    const draft = Adapter.parsePreviewLines(['れん', '草稿：あとで送る', '2 天']);
    assert.equal(draft.isDraft, true);
    assert.equal(draft.fromSelf, true);
  });

  it('对方最后发言且未读 → 最高优先级', () => {
    assert.equal(D.candidatePriority({
      lastSpeaker: 'peer', unread: true, unreadPrecise: true
    }), 0);
    assert.equal(D.candidatePriority({
      lastSpeaker: 'peer', unread: true, unreadPrecise: false
    }), 1);
  });

  it('对方最后发言但已读 → 仍排在“我方最后发言”之前', () => {
    assert.equal(D.candidatePriority({ lastSpeaker: 'peer', unread: false }), 2);
    assert.equal(D.candidatePriority({
      lastSpeaker: 'own', adDebt: true, hasReply: true
    }), 3);
  });

  it('我方最后发言且无到期动作 → 视为已回复，不打开', () => {
    assert.equal(D.candidatePriority({
      lastSpeaker: 'own', unread: false, hasReply: true
    }), 99);
    assert.equal(D.candidatePriority({
      lastSpeaker: 'draft', unread: false
    }), 99);
  });

  it('台账 hasReply 不能压过列表证据', () => {
    assert.equal(D.candidatePriority({
      lastSpeaker: 'own', unread: false, hasReply: true, replied: true
    }), 99);
    assert.equal(D.candidatePriority({
      lastSpeaker: 'peer', unread: false, hasReply: false
    }), 2);
  });

  it('排序结果：最新未读 > 对方最后 > 我方最后但欠广告/催加', () => {
    const sorted = D.sortInboxCandidates([
      { key: 'own-debt', lastSpeaker: 'own', adDebt: true },
      { key: 'peer', lastSpeaker: 'peer' },
      { key: 'peer-unread', lastSpeaker: 'peer', unread: true, unreadPrecise: true }
    ]);
    assert.equal(sorted.map((x) => x.key).join(','), 'peer-unread,peer,own-debt');
  });
});

describe('深度扫描 · 真的下滑并留下证据', () => {
  it('优先选列表自己的 overflow:auto 祖先，不选页面滚动条', () => {
    const idx = Scan.pickScrollCandidate([
      { overflowY: 'visible', scrollHeight: 800, clientHeight: 800 },
      { overflowY: 'auto', scrollHeight: 4800, clientHeight: 800 },
      { overflowY: 'visible', scrollHeight: 9000, clientHeight: 900 }
    ]);
    assert.equal(idx, 1);
  });

  it('没有原生滚动容器时退回第一个可滚节点', () => {
    const idx = Scan.pickScrollCandidate([
      { overflowY: 'visible', scrollHeight: 300, clientHeight: 300 },
      { overflowY: 'visible', scrollHeight: 5000, clientHeight: 900 }
    ]);
    assert.equal(idx, 1);
  });

  it('行快照不能用索引当键：虚拟列表回收后会把不同人合并', () => {
    assert.notEqual(
      Scan.snapshotKey({ id: 'dm-conversation-option-1:9' }, 0),
      Scan.snapshotKey({ id: 'dm-conversation-option-2:9' }, 0)
    );
    assert.equal(
      Scan.snapshotKey({ text: '张三\n10:20\n你好' }, 3),
      Scan.snapshotKey({ text: '张三\n10:20\n你好' }, 8)
    );
  });

  it('滚到底/滚不动/滚轮无效都必须给出停止原因', () => {
    assert.equal(Scan.stepOutcome({
      rowsBefore: 12, rowsAfter: 12, moved: true, atBottom: true
    }).reason, 'bottom_reached');
    assert.equal(Scan.stepOutcome({
      rowsBefore: 12, rowsAfter: 12, moved: false, atBottom: false
    }).reason, 'scroll_not_moved');
    assert.equal(Scan.stepOutcome({
      rowsBefore: 12, rowsAfter: 12, moved: false, atBottom: false, wheelFallback: true
    }).reason, 'wheel_no_new_rows');
    assert.equal(Scan.stepOutcome({
      rowsBefore: 12, rowsAfter: 24, moved: true, atBottom: false
    }).stop, false);
  });
});

describe('列表预览 · 我方前缀识别', () => {
  it('中文/英文/日语的“你:”都判为我方最后发言', () => {
    ['你: 你好', 'You: hello', 'あなた: こんにちは'].forEach((line) => {
      const p = Adapter.rowPreview({ __sgSnapshot: true, text: '名前\n' + line });
      assert.equal(p.fromSelf, true, line);
      assert.ok(p.preview.length > 0);
    });
  });

  it('草稿不算我方已发送，单独标记 isDraft', () => {
    const p = Adapter.rowPreview({ __sgSnapshot: true, text: '名前\n草稿: 未发送内容' });
    assert.equal(p.isDraft, true);
    assert.equal(p.fromSelf, true);
  });
});

describe('运行时接线 · 不能只在测试里成立', () => {
  it('扫描结果带滚动证据与行数', () => {
    assert.match(chatSrc, /all\.scrollEvidence = evidence/);
    assert.match(chatSrc, /evidence\.scrolledPx \+= 700/);
    assert.match(chatSrc, /scanInfo\.scrolledPx = deepEvidence/);
    assert.match(chatSrc, /scanInfo\.scrollSteps = deepEvidence/);
    assert.match(chatSrc, /SgInboxListScan\.pickScrollCandidate/);
    assert.match(chatSrc, /SgInboxListScan\.stepOutcome/);
    assert.match(chatSrc, /scanInboxRowsDeep\(opts\.deepSteps \|\| 0\)/);
    assert.match(chatSrc, /requiredSteps = Math\.ceil\(scroller\.dy \/ 700\) \+ 3/);
    assert.match(chatSrc, /evidence\.complete = !!evidence\.reachedBottom/);
  });

  it('latestUnread 从全量扫描快照计算，包含被业务闸门挡下的未读', () => {
    assert.match(chatSrc, /for \(var lu = 0; lu < allRowsScanned\.length; lu\+\+\)/);
    assert.match(chatSrc, /scanInfo\.latestUnreadDropReason/);
    assert.match(chatSrc, /closed_inbound_queued_for_reply_check/);
  });

  it('扫描快照冻结 id/href/文本，避免虚拟列表回收串号', () => {
    assert.match(chatSrc, /__sgSnapshot: true/);
    assert.match(chatSrc, /snap\.id = String\(row\.id \|\| ''\)/);
    assert.match(chatSrc, /snap\.text = String\(row\.innerText \|\| ''\)/);
    assert.match(adapterSrc, /row\.__sgSnapshot/);
    assert.match(watchSrc, /row\.__sgSnapshot/);
  });

  it('候选对象带 lastSpeaker，OPS 有逐类计数', () => {
    assert.match(chatSrc, /var lastSpeaker = pendingDraft/);
    assert.match(chatSrc, /lastSpeaker: lastSpeaker/);
    assert.match(chatSrc, /speakerCounts: \{ peer: 0, own: 0, draft: 0, unknown: 0 \}/);
    assert.match(chatSrc, /scanInfo\.lastSpeakerCounts = speakerCounts/);
    assert.match(chatSrc, /drop\.ownLastReplied\+\+/);
    assert.match(chatSrc, /列表最后一条是我方、视为已回复/);
    assert.match(chatSrc, /lastListSpeaker = item\.lastSpeaker/);
  });

  it('台账 hasReply 不再单独放行候选', () => {
    const start = chatSrc.indexOf('var actionableLedger =');
    assert.ok(start > 0);
    const block = chatSrc.slice(start, start + 260);
    assert.doesNotMatch(block, /hasReply/);
    assert.match(block, /adDebt \|\| kickReady \|\| probeable/);
  });

  it('快照行打开前会换回活行', () => {
    assert.match(chatSrc, /function resolveLiveInboxRow/);
    assert.match(chatSrc, /var row = resolveLiveInboxRow\(item\)/);
  });

  it('未读蓝点支持伪元素与按钮容器，不再只认 icon-circle-fill', () => {
    assert.match(watchSrc, /function hasPseudoUnreadDot/);
    assert.match(watchSrc, /source: 'visual_dot_pseudo'/);
    assert.match(watchSrc, /div, span, i, button, svg, circle, ellipse, use/);
    assert.match(watchSrc, /content === 'none' \|\| content === 'normal'/);
    assert.doesNotMatch(watchSrc, /if \(!content \|\| content === 'none'/);
  });

  it('已见过的快照要补刷未读，晚挂上的蓝点不能被永久冻结成 false', () => {
    const start = chatSrc.indexOf('function harvest()');
    const block = chatSrc.slice(start, start + 1400);
    assert.match(chatSrc, /var byKey = \{\}/);
    assert.match(block, /old\.unreadInfo = snap\.unreadInfo/);
    assert.match(block, /if \(snap\.text\) old\.text = snap\.text/);
  });

  it('丢弃样本带未读来源，方便核对“蓝点为什么没算未读”', () => {
    assert.match(chatSrc, /unread: !!\(unreadInfo && unreadInfo\.unread\)/);
    assert.match(chatSrc, /unread_source: String\(\(unreadInfo && unreadInfo\.source\)/);
  });

  it('新扫描模块已登记到 manifest', () => {
    const registered = (manifest.content_scripts || []).some(
      (cs) => Array.isArray(cs.js) && cs.js.includes('chat/inbox-list-scan.js')
    );
    assert.ok(registered);
  });
});

'use strict';
/**
 * 身份证明契约：
 *   - 会话头 @handle 命中 → 通过，并把 URL 里的对方 id 回写台账；
 *   - 台账 peerId 与 URL 一致 → 通过；
 *   - 台账没 peerId、会话头也没 @，但本次导航地址与候选行 href 逐字一致 → 通过（新增）；
 *   - 真冲突（会话头指向别人 / peerId 不一致）→ 一律阻断。
 *
 * 现场回归：rinz/れん 台账没有 peerId，会话头无 @，旧逻辑永远 identity_pending，
 * 读到「40です」也发不出去，还被写身份拉黑。
 *
 * 运行：node --test --test-force-exit test/inbox-identity-proof.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(pathParts) {
  const src = fs.readFileSync(path.join(__dirname, '..', ...pathParts), 'utf8');
  const window = {};
  const sandbox = { window, console, Math, Number, parseInt, isFinite, Date };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return window;
}

const Decision = load(['chat', 'inbox-decision.js']).SgInboxDecision;
const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'content_chat.js'), 'utf8');

const PEER = '2077616088045884800';
const ME = '1921556032637345792';

describe('identityProof · 三条正向证据', () => {
  it('会话头命中目标 → ok_header，并回写缺失的 peerId', () => {
    const r = Decision.identityProof({
      targetHandle: 'rinzkumk9',
      headerHandle: 'rinzkumk9',
      headerConfident: true,
      urlPeerId: PEER,
      dbPeerId: ''
    });
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'ok_header');
    assert.equal(r.adoptPeerId, PEER);
  });

  it('台账 peerId 与 URL 一致 → ok_peer，不再回写', () => {
    const r = Decision.identityProof({
      targetHandle: 'rinzkumk9',
      urlPeerId: PEER,
      dbPeerId: PEER
    });
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'ok_peer');
    assert.equal(r.adoptPeerId, '');
  });

  it('没有 peerId、没有会话头，但导航地址与候选行一致 → ok_row_href', () => {
    const r = Decision.identityProof({
      targetHandle: 'rinzkumk9',
      headerHandle: '',
      headerConfident: false,
      urlPeerId: PEER,
      dbPeerId: '',
      navProven: true
    });
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'ok_row_href');
    assert.equal(r.adoptPeerId, PEER);
  });

  it('没有任何证据 → identity_pending（不许发消息）', () => {
    const r = Decision.identityProof({
      targetHandle: 'rinzkumk9',
      urlPeerId: '',
      dbPeerId: '',
      navProven: false
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'identity_pending');
  });

  it('导航未证明时，只有 URL 也不能放行（防止点错会话）', () => {
    const r = Decision.identityProof({
      targetHandle: 'rinzkumk9',
      urlPeerId: PEER,
      dbPeerId: '',
      navProven: false
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'identity_pending');
  });
});

describe('identityProof · 冲突必须阻断', () => {
  it('可信会话头指向别人 → header_handle_mismatch', () => {
    const r = Decision.identityProof({
      targetHandle: 'rinzkumk9',
      headerHandle: 'someone_else',
      headerConfident: true,
      urlPeerId: PEER,
      navProven: true
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'header_handle_mismatch');
  });

  it('台账 peerId 与 URL 不一致 → peer_id_mismatch（即使导航已证明）', () => {
    const r = Decision.identityProof({
      targetHandle: 'rinzkumk9',
      urlPeerId: PEER,
      dbPeerId: '11111111',
      navProven: true
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'peer_id_mismatch');
  });

  it('URL 取到本号自己 → 不能当对方 id 回写', () => {
    const r = Decision.identityProof({
      targetHandle: 'rinzkumk9',
      urlPeerId: ME,
      dbPeerId: '',
      navProven: true,
      myId: ME
    });
    assert.equal(r.ok, false);
    assert.equal(r.adoptPeerId, '');
  });

  it('空目标 → no_target', () => {
    const r = Decision.identityProof({ urlPeerId: PEER });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_target');
  });

  it('合成 p<peerId> 目标允许按地址证明身份', () => {
    const r = Decision.identityProof({
      targetHandle: 'p' + PEER,
      urlPeerId: PEER,
      dbPeerId: '',
      navProven: true
    });
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'ok_row_href');
  });
});

describe('identityProof · 4.9.111 发错人回归', () => {
  // 现场：台账 @rinzkumk9 的 peerId 被同名「れん」的会话改写成别人的 id，
  // 之后「URL == 台账」自证通过，催加消息发给了陌生人。
  it('低可信会话头显示的是另一个账号 → 不能用「URL == 台账」放行', () => {
    const r = Decision.identityProof({
      targetHandle: 'rinzkumk9',
      headerHandle: 'naxmhf57sh7732',
      headerConfident: false,
      urlPeerId: '1754882000924590080',
      dbPeerId: '1754882000924590080'
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'header_conflict_unconfirmed');
  });

  it('台账 peerId 有改写痕迹 → 不能只靠台账自证（ledger_peer_untrusted）', () => {
    const r = Decision.identityProof({
      targetHandle: 'rinzkumk9',
      urlPeerId: '1754882000924590080',
      dbPeerId: '1754882000924590080',
      ledgerPeerSuspect: true
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'ledger_peer_untrusted');
  });

  it('台账 peerId 可疑但会话头可信且命中目标 → 仍可放行', () => {
    const r = Decision.identityProof({
      targetHandle: 'rinzkumk9',
      headerHandle: 'rinzkumk9',
      headerConfident: true,
      urlPeerId: '1754882000924590080',
      dbPeerId: '1754882000924590080',
      ledgerPeerSuspect: true
    });
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'ok_header');
  });
});

describe('运行时接线守卫', () => {
  it('只有可信会话头才能改写台账 peerId', () => {
    assert.match(chatSrc, /var headerProvesTarget = !!\(headerConfident && headerHandle/);
  });

  it('显示名匹配不得改写台账 peerId', () => {
    assert.match(chatSrc, /var rowProvesTarget = \(ledgerMatchedBy === 'row_handle'[\s\S]{0,80}rowHrefProvesTarget\);/);
    assert.match(chatSrc, /displayOnlyMatch/);
  });

  it('会话头说是别人时，禁止改写台账 peerId', () => {
    assert.match(chatSrc, /var headerSaysOther = !!\(headerHandle/);
    assert.match(chatSrc, /header_says_other/);
  });

  it('台账证明我方发过话时，读不到我方气泡不得判成「对方先私信」', () => {
    assert.match(chatSrc, /function ledgerProvesWeSpoke\(entry\)/);
    assert.match(chatSrc, /&& !ledgerProvesWeSpoke\(dbEntry\)/);
  });

  it('“只读模式”要当终态（对方不能再收私信），不能每拍重试', () => {
    assert.equal(Decision.inboxClosedVerdict('此对话当前处于只读模式。'), 'peer_inbox_closed');
    assert.equal(Decision.inboxClosedVerdict('This conversation is currently in read-only mode.'), 'peer_inbox_closed');
    assert.equal(Decision.inboxClosedVerdict('この会話は現在読み取り専用モードです'), 'peer_inbox_closed');
    assert.equal(Decision.inboxClosedVerdict('普通聊天内容，没有异常'), '');
  });

  it('只读判定只在会话页生效，避免误伤其它页面', () => {
    assert.match(chatSrc, /if \(!pathHasConversationId\(location\.pathname\)\) return '';/);
  });

  it('识别“对方关闭收件箱”：落终态、不再当技术失败重试', () => {
    assert.match(chatSrc, /function detectPeerInboxClosedBanner\(\)/);
    // 4.9.78：横幅在 open shadowRoot 里，判定逻辑抽到纯函数并穿透收集文本
    assert.match(chatSrc, /inboxClosedVerdict/);
    assert.match(chatSrc, /__dmCollectTextDeep/);
    assert.equal(Decision.inboxClosedVerdict('收件箱\n已关闭'), 'peer_inbox_closed');
    assert.match(chatSrc, /sendError = 'peer_inbox_closed'/);
    assert.match(chatSrc, /inboxClosedReason = 'peer_closed_inbox'/);
    // 4.9.115：关闭收件箱不再是永久终态，改为“等复查”并点名上报，
    // 对方重开或预览变化后会重新打开核对。
    assert.match(chatSrc, /dropSample\(handle, 'peer_inbox_closed_recheck_wait'\)/);
  });

  it('守箱打开会话时把导航地址证据传给身份判定', () => {
    assert.match(chatSrc, /rowHrefProvesTarget = !!\(normalizedExpectedPath/);
    assert.match(chatSrc, /navProven: rowHrefProvesTarget/);
  });

  it('身份证明成功后清掉旧的 identityBlockedAt', () => {
    assert.match(chatSrc, /idStat\.identityBlockedAt = 0/);
  });

  it('提供一次性解冻，且只处理没有 peerId 的误判条目', () => {
    assert.match(chatSrc, /sg_inbox_identity_unblock_v4975/);
    assert.match(chatSrc, /identityUnblockedReason = 'nav_address_proof'/);
    // 读到却没发出去的，必须把“已读/已提醒”标记一起回滚，否则永远 already_surfaced
    assert.match(chatSrc, /if \(!Number\(e\.reopenCycleAt\)\) \{[\s\S]{0,200}e\.reopenedAt = 0;/);
  });

  it('同名不同人：显示名与行 peerId 冲突时不得复用台账', () => {
    assert.match(chatSrc, /if \(dnPeer && dnPeer !== peerId\) \{[\s\S]{0,80}dnHandle = '';/);
  });

  it('同名但最后一条消息文本一致 → 允许认回原目标（历史 peerId 被带偏的修复口）', () => {
    assert.match(chatSrc, /handleMatchedBy = 'display_name_preview'/);
    assert.match(chatSrc, /storedPreview === nowPreview/);
  });

  it('显示名匹配不得改写 peerId（只有行 @handle / 导航地址可以）', () => {
    assert.match(chatSrc, /var rowProvesTarget = \(ledgerMatchedBy === 'row_handle'[\s\S]{0,120}rowHrefProvesTarget\);/);
  });

  it('同名改写过的 peerId 要在迁移里还原', () => {
    assert.match(chatSrc, /if \(String\(e\.peerIdRepairedBy \|\| ''\) === 'display_name'\)/);
  });
});

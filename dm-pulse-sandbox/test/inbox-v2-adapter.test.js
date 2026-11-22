'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const adapterPath = path.join(
  __dirname,
  '..',
  'production-test-copy',
  'chat',
  'inbox-v2-adapter.js'
);

let adapter;

before(() => {
  global.window = {};
  require(adapterPath);
  adapter = global.window.SgInboxV2Adapter;
});

describe('inbox v2 adapter pure helpers', () => {
  it('从新 row.id 和 href 解析 peerId/myId', () => {
    const ids = adapter.parseConversationIds(
      'dm-conversation-option-1921556032637345792:2055104981112635393',
      '',
      '/i/chat/1921556032637345792-2055104981112635393'
    );
    assert.equal(ids.valid, true);
    assert.equal(ids.peerId, '1921556032637345792');
    assert.equal(ids.myId, '2055104981112635393');
    assert.equal(ids.source, 'row.id');
  });

  it('兼容旧 testid，并拒绝 id/href 不一致', () => {
    const legacy = adapter.parseConversationIds(
      '',
      'dm-conversation-item-123456:789012',
      '/i/chat/123456-789012'
    );
    assert.equal(legacy.valid, true);
    assert.equal(legacy.peerId, '123456');

    const mismatch = adapter.parseConversationIds(
      'dm-conversation-option-111111:222222',
      '',
      '/i/chat/333333-222222'
    );
    assert.equal(mismatch.valid, false);
    assert.equal(mismatch.source, 'mismatch');
  });

  it('从显示名/时间/预览行中提取预览，并跳过时间与新标记', () => {
    const parsed = adapter.parsePreviewLines([
      'むーみん',
      '1 周',
      '変態さん来てください😃💜',
      '新'
    ]);
    assert.equal(parsed.displayName, 'むーみん');
    assert.equal(parsed.preview, '変態さん来てください😃💜');
    assert.equal(parsed.fromSelf, false);
  });

  it('识别本方预览并去掉“你:”前缀', () => {
    const parsed = adapter.parsePreviewLines([
      'momo',
      '6 周',
      '你: こんにちは'
    ]);
    assert.equal(parsed.preview, 'こんにちは');
    assert.equal(parsed.fromSelf, true);
  });

  it('草稿预览视为本方（未发送，不是对方回复）', () => {
    const parsed = adapter.parsePreviewLines([
      'れい@帝札幌',
      '1 小时',
      '草稿： ごめんね🙏 25歳以上の方と話したくて…'
    ]);
    assert.equal(parsed.fromSelf, true);
    assert.equal(parsed.isDraft, true);
  });

  it('只有显示名和时间时不伪造预览', () => {
    const parsed = adapter.parsePreviewLines(['hinata', '14 周']);
    assert.equal(parsed.displayName, 'hinata');
    assert.equal(parsed.preview, '');
    assert.equal(parsed.fromSelf, false);
  });

  it('ID 顺序不固定时用本号 ID 反推对方 ID', () => {
    const MY = '1921556032637345792';
    const peerFirst = adapter.parseConversationIds(
      'dm-conversation-option-62463247:' + MY, '', '/i/chat/62463247-' + MY
    );
    assert.equal(peerFirst.firstId, '62463247');
    assert.equal(peerFirst.secondId, MY);

    const meFirst = adapter.parseConversationIds(
      'dm-conversation-option-' + MY + ':2018329273564815360', '',
      '/i/chat/' + MY + '-2018329273564815360'
    );
    assert.equal(meFirst.firstId, MY);
    assert.equal(meFirst.secondId, '2018329273564815360');
  });

  it('按 myId 提示解析 peer 时两种顺序都能取到对方', () => {
    const MY = '1921556032637345792';
    const makeRow = (id) => ({
      id,
      getAttribute: () => null
    });

    const a = adapter.resolvePeerId(makeRow('dm-conversation-option-62463247:' + MY), MY);
    assert.equal(a.peerId, '62463247');
    assert.equal(a.order, 'peer-first');

    const b = adapter.resolvePeerId(makeRow('dm-conversation-option-' + MY + ':2018329273564815360'), MY);
    assert.equal(b.peerId, '2018329273564815360');
    assert.equal(b.order, 'me-first');
  });
});

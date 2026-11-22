/**
 * 现场回归：蓝色认证徽章不是未读点。
 * 认证徽章约 16–20px、位于昵称后面；未读点是 6–10px、贴在行最右侧。
 * 旧实现按「3–28px + 行宽 35% 起」扫描，把认证账号全判成未读，
 * 于是 latest_unread 每拍都是「预览为我方最后一句」的假未读。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fakeEl(rect, style, text) {
  return {
    innerText: text || '',
    textContent: text || '',
    tagName: 'DIV',
    getBoundingClientRect: () => rect,
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

function makeRow(badge) {
  const rowRect = { left: 0, right: 470, top: 0, bottom: 72, width: 470, height: 72 };
  return {
    innerText: 'name\n你: hello',
    id: 'dm-conversation-option-1:2',
    getBoundingClientRect: () => rowRect,
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: (sel) => (sel.indexOf('div, span') === 0 ? [badge] : []),
    parentElement: null,
  };
}

function loadWatch() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'chat', 'inbox-watch.js'), 'utf8');
  const styles = new Map();
  const sandbox = {
    window: {
      getComputedStyle: (el) => styles.get(el) || {},
    },
    console,
    Map,
    Math,
    Number,
    parseInt,
    isFinite,
    Date,
    setTimeout,
    clearTimeout,
    document: {
      querySelectorAll: () => [],
      querySelector: () => null,
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    sessionStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
  };
  sandbox.window.localStorage = sandbox.localStorage;
  sandbox.window.sessionStorage = sandbox.sessionStorage;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { api: sandbox.window.SgInboxWatch, styles };
}

describe('未读蓝点判定边界', () => {
  it('昵称后的蓝色认证徽章不能当成未读点', () => {
    const { api, styles } = loadWatch();
    const badge = fakeEl(
      { left: 300, right: 318, top: 10, bottom: 28, width: 18, height: 18 },
      { backgroundColor: 'rgb(29, 155, 240)', borderRadius: '50%', display: 'block', visibility: 'visible', opacity: '1' }
    );
    styles.set(badge, { backgroundColor: 'rgb(29, 155, 240)', borderRadius: '50%', display: 'block', visibility: 'visible', opacity: '1' });
    const info = api.getInboxRowUnread(makeRow(badge));
    assert.equal(info.unread, false);
  });

  it('行最右侧 8px 蓝点仍然识别为未读', () => {
    const { api, styles } = loadWatch();
    const dot = fakeEl(
      { left: 452, right: 460, top: 32, bottom: 40, width: 8, height: 8 },
      { backgroundColor: 'rgb(29, 155, 240)', borderRadius: '50%', display: 'block', visibility: 'visible', opacity: '1' }
    );
    styles.set(dot, { backgroundColor: 'rgb(29, 155, 240)', borderRadius: '50%', display: 'block', visibility: 'visible', opacity: '1' });
    const info = api.getInboxRowUnread(makeRow(dot));
    assert.equal(info.unread, true);
    assert.equal(info.source, 'visual_dot');
  });
});

describe('台账 peerId 冲突修复', () => {
  it('列表 handle/唯一昵称命中时允许修正历史误写的 peerId', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'chat', 'content_chat.js'), 'utf8');
    assert.match(src, /var rowProvesTarget = \(ledgerMatchedBy === 'row_handle'/);
    assert.match(src, /headerProvesTarget \|\| rowProvesTarget/);
    assert.match(src, /peerIdRepairedBy = headerProvesTarget/);
  });
});

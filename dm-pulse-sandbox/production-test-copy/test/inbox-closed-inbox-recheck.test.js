// 「对方关闭收件箱」不是永久终态。
// 现场证据：台账里 3 条被记成 peer_inbox_closed 后永远不再打开，
// 后台心跳只剩 inbox_closed=3，谁重新开放了、谁又来信了都看不出来。
// 规则：预览变化立即复查；否则 6 小时复查一次；复查发现横幅消失即解除。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const decisionSrc = fs.readFileSync(path.join(root, 'chat', 'inbox-decision.js'), 'utf8');
const chatSrc = fs.readFileSync(path.join(root, 'chat', 'content_chat.js'), 'utf8');

function loadDecision() {
  const sandbox = { window: {}, console, Date };
  vm.createContext(sandbox);
  vm.runInContext(decisionSrc, sandbox);
  return sandbox.window.SgInboxDecision;
}

const HOUR = 60 * 60 * 1000;

test('没有关闭记录时不需要复查', () => {
  const D = loadDecision();
  const r = D.inboxClosedRecheck({}, 'こんにちは', Date.now());
  assert.equal(r.recheck, false);
  assert.equal(r.reason, 'not_closed');
});

test('刚关闭且预览没变：压住，不占脉冲队列', () => {
  const D = loadDecision();
  const now = Date.now();
  const r = D.inboxClosedRecheck(
    { inboxClosedAt: now - 10 * 60 * 1000, inboxClosedPreview: 'こんにちは' },
    'こんにちは',
    now
  );
  assert.equal(r.recheck, false);
  assert.equal(r.reason, 'closed_recently');
  assert.ok(r.dueAt > now);
});

test('列表预览变了：立即复查（对方可能重开并来信）', () => {
  const D = loadDecision();
  const now = Date.now();
  const r = D.inboxClosedRecheck(
    { inboxClosedAt: now - 10 * 60 * 1000, inboxClosedPreview: 'こんにちは' },
    '40です',
    now
  );
  assert.equal(r.recheck, true);
  assert.equal(r.reason, 'preview_changed');
});

test('满 6 小时：到期复查一次', () => {
  const D = loadDecision();
  const now = Date.now();
  const r = D.inboxClosedRecheck(
    { inboxClosedAt: now - 6 * HOUR - 1000, inboxClosedPreview: 'こんにちは' },
    'こんにちは',
    now
  );
  assert.equal(r.recheck, true);
  assert.equal(r.reason, 'recheck_due');
});

test('复查窗口常量必须是 6 小时，避免又变成“永久跳过”', () => {
  const D = loadDecision();
  assert.equal(D.INBOX_CLOSED_RECHECK_MS, 6 * HOUR);
});

test('候选过滤不能再用“一记下就永远 continue”', () => {
  const at = chatSrc.indexOf('if (entry && Number(entry.inboxClosedAt)) {');
  assert.ok(at > 0);
  const block = chatSrc.slice(at, at + 2200);
  assert.match(block, /inboxClosedRecheck/);
  assert.match(block, /peerInboxClosedRecheck/);
  assert.match(block, /peer_inbox_closed_recheck:/);
});

test('复查时横幅消失要解除关闭状态并上报', () => {
  assert.match(chatSrc, /wDb\[targetHandle\]\.inboxClosedClearedAt = nowTs/);
  assert.match(chatSrc, /wDb\[targetHandle\]\.inboxClosedAt = 0/);
  assert.match(chatSrc, /chat\.inbox_reopened_by_peer/);
});

test('关闭时要记下当时的列表预览，供下次比对', () => {
  const at = chatSrc.indexOf('wDb[targetHandle].inboxClosedAt = nowTs');
  assert.ok(at > 0);
  const block = chatSrc.slice(at, at + 900);
  assert.match(block, /inboxClosedPreview/);
});

test('后台预检要把到期复查算成有活，否则复查永远不会触发', () => {
  assert.match(chatSrc, /closedRecheckDue/);
  const at = chatSrc.indexOf('var closedRecheckDue = false;');
  assert.ok(at > 0);
  const block = chatSrc.slice(at, at + 800);
  assert.match(block, /inboxClosedRecheck/);
  assert.match(block, /if \(closedRecheckDue\) closed = false;/);
});

test('OPS 要能区分“等复查”和“正在复查”', () => {
  assert.match(chatSrc, /peer_inbox_closed_recheck: Number\(auditDrop\.peerInboxClosedRecheck\)/);
  assert.match(chatSrc, /peer_inbox_closed_samples/);
});

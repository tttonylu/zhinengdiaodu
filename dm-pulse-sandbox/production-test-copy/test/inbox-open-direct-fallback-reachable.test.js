// 现场证据（2026-11-13 11:54–12:02）：连续 6 拍 reply_read_failed，
// 全部 open_mode=click、url_peer_id 为空、dom_leaves=0、dom_articles=0。
// 说明点击列表行后根本没进会话，而“按地址直达”的兜底从未触发。
// 根因：那段兜底代码写在一个无条件 return 之后，是永远执行不到的死代码。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const chatSrc = fs.readFileSync(path.join(root, 'chat', 'content_chat.js'), 'utf8');

function clickBlock() {
  const at = chatSrc.indexOf('if (!rendered) {');
  assert.ok(at > 0, '找不到点击失败分支');
  return chatSrc.slice(at, at + 6000);
}

test('点击失败后必须真的尝试直达，不能被 return 挡在死代码里', () => {
  const block = clickBlock();
  const navAt = block.indexOf("inboxHardNavigate(retryUrl, 'open_after_click'");
  assert.ok(navAt > 0, '直达兜底调用不见了');
  // 在直达调用之前，除 pending_render 分支外不允许有其它无条件 return。
  const before = block.slice(0, navAt);
  const pendingReturnAt = before.indexOf("reason: 'pending_render'");
  assert.ok(pendingReturnAt > 0, 'pending_render 分支应保留（已进入会话地址，只是正文没渲染完）');
  // pending_render 的 return 必须在 if (pathHasConversationId()) 里面，
  // 而不是整条分支无条件返回。
  const guardAt = before.indexOf('if (pathHasConversationId()) {');
  assert.ok(guardAt > 0 && guardAt < pendingReturnAt,
    'pending_render 的 return 必须受 pathHasConversationId() 保护');
  // 直达调用之后不能紧跟一个必然命中的 return
  assert.ok(!/return\s*\{\s*ok:\s*false,\s*reason:\s*'click_render_timeout'/.test(block),
    'click_render_timeout 的无条件 return 必须删除，否则直达永远执行不到');
});

test('直达不可用时才记失败并换目标', () => {
  const block = clickBlock();
  assert.match(block, /noteInboxRenderFailure\(handle, item\.preview, 'open_unreachable'\)/);
  assert.match(block, /markInboxPeerOpenFailure\(item\.peerId, item\.preview, 'open_unreachable'\)/);
  // open_unreachable 必须排在直达尝试之后
  const navAt = block.indexOf("inboxHardNavigate(retryUrl, 'open_after_click'");
  const failAt = block.indexOf("'open_unreachable'");
  assert.ok(failAt > navAt, '失败记账必须在直达尝试之后');
});

test('直达被后台标签挡住要明确区分，不能记成对方没回', () => {
  const block = clickBlock();
  assert.match(block, /reason: 'deferred_not_visible'/);
  assert.match(block, /标签页在后台/);
});

test('整页跳转预算耗尽时换目标，不反复撞同一个人', () => {
  const block = clickBlock();
  assert.match(block, /reason: 'nav_budget_wait'/);
  assert.match(block, /本拍换下一个目标/);
});

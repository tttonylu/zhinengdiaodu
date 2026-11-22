'use strict';
/**
 * 4.9.15：脉冲扫描与打开会话的现场加固。
 *
 * 现场问题（2026-11-12 19:51）：
 * 1) 会话栏当时停在列表中间，扫描只往下滑，最上面最新的会话（しほ）没被扫到；
 * 2) 优先用「peerId + 本号 id」拼接地址直开，某个无 handle 的行白屏；
 * 3) 白屏后整页 reload，OPS 只剩 blank_page_reload，没有回复结论；
 * 4) 同一失败目标没有 handle，无法写台账冷却，下一拍还会重撞。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'content_chat.js'), 'utf8');
const watchSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'inbox-watch.js'), 'utf8');
const bgSrc = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function block(src, marker, length) {
  const at = src.indexOf(marker);
  assert.ok(at >= 0, '找不到代码块: ' + marker);
  return src.slice(at, at + (length || 2000));
}

describe('脉冲必须从列表顶部开始扫描', () => {
  it('深度扫描先回顶部，再记录 rowsBefore / 往下滑', () => {
    const fn = block(chatSrc, 'async function scanInboxRowsDeep(maxSteps)', 20000);
    const reset = fn.indexOf('scrollTop = 0');
    const harvestAt = fn.indexOf('evidence.rowsBefore = harvest()');
    const loop = fn.indexOf('for (var step = 0; step < maxSteps; step++)');
    assert.ok(reset > 0, '缺少回顶部动作');
    assert.ok(harvestAt > reset, 'rowsBefore 必须在回顶部之后采集');
    assert.ok(loop > harvestAt, '扫描循环必须在回顶部之后');
    assert.match(fn, /evidence\.resetToTop = true/);
  });
});

describe('打开会话的地址优先级', () => {
  it('无活行时先滚回该行；仍找不到就上报 deep_row_gone，不再整页直达', () => {
    const fn = block(chatSrc, 'var directUrl = buildInboxConversationUrl', 3200);
    assert.match(fn, /var navUrl = hrefUrl \|\| directUrl/);
    assert.match(fn, /var navMode = hrefUrl \? 'row_href' : 'direct'/);
    assert.match(chatSrc, /async function revealInboxRowForItem/);
    // 4.9.98：直达地址在现场读不到任何气泡，只留 item.forced 人工测试入口。
    assert.match(fn, /if \(item\.forced\s*\n\s*&& !row\s*\n\s*&& navUrl/);
    assert.match(fn, /actualOpenMode = navMode/);
    assert.match(chatSrc, /openMode: actualOpenMode/);
    assert.match(chatSrc, /X 会把 \/i\/chat\/<peer>-<my> 重定向回列表/);
    // 4.9.31：后台标签页不跳转、不记失败；预算按会话隔离。
    assert.match(fn, /deferred_not_visible/);
    assert.match(fn, /key: item\.peerId \|\| handle \|\| 'direct'/);
    assert.match(fn, /inboxHardNavigate\(navUrl, 'open_direct'/);
    assert.match(fn, /open_mode: navMode/);
    assert.match(chatSrc, /reason: 'deep_row_gone'/);
    assert.match(chatSrc, /scroller: scDiag/);
  });
});

describe('技术失败必须有结论，不能停在白屏', () => {
  it('整页刷新受全局预算约束，超限必须停止并给 reload_suppressed', () => {
    assert.match(chatSrc, /INBOX_HARD_NAV_KEY = 'sg_inbox_hard_nav_times'/);
    assert.match(chatSrc, /function inboxHardNavGuard\(reason, opts\)/);
    assert.match(chatSrc, /reason: 'budget_exhausted'/);
    assert.match(chatSrc, /reason: 'cooldown'/);
    assert.match(chatSrc, /reason: 'hidden'/);
    assert.match(chatSrc, /result\.reason = 'reload_suppressed'/);
    assert.match(chatSrc, /inboxHardNavGuard\('blank_page'/);
    assert.match(chatSrc, /inboxHardNavGuard\('list_empty'/);
  });

  it('X 明确显示加载中时等待并反馈，不进入空白页刷新分支', () => {
    const start = chatSrc.indexOf('var xLoadingVisible = false');
    assert.ok(start > 0, '缺少 X 加载状态识别');
    const end = chatSrc.indexOf('if (bodyLen < 30', start);
    assert.ok(end > start, '加载状态判断必须先于空白页恢复');
    const fn = chatSrc.slice(start, end);
    assert.match(fn, /document\.querySelector\('\[role="progressbar"\]'\)/);
    assert.match(fn, /page_loading_wait/);
    assert.match(fn, /page_loading_stuck/);
    assert.match(fn, /inboxPathForLoading/);
    assert.match(fn, /if \(xLoadingVisible && inboxPathForLoading && !inboxRowsReadyForLoading\)/);
    assert.match(fn, /inboxRowsReadyForLoading/);
    assert.match(fn, /loadingAgeMs >= 120000 \? 60000 : 10000/);
    assert.match(fn, /return result;/);
    assert.doesNotMatch(fn, /window\.location\.reload\(\)/);
  });

  it('会话页白屏 → 记失败、回列表、给 reply_read_failed，不再整页 reload', () => {
    const start = chatSrc.indexOf('// 白屏恢复：body 几乎没有文本');
    assert.ok(start > 0);
    const convStart = chatSrc.indexOf('var blankConvPath', start);
    const convEnd = chatSrc.indexOf('// 连续白屏时退避', convStart);
    assert.ok(convStart > start && convEnd > convStart);
    const convBranch = chatSrc.slice(convStart, convEnd);
    assert.match(convBranch, /blankConvPath/);
    assert.match(convBranch, /markInboxPeerOpenFailure\(pidBlank, pvBlank, 'blank_conversation'\)/);
    assert.match(convBranch, /result\.replyVerdict = 'reply_read_failed'/);
    assert.match(convBranch, /inboxSoftGo\('\/i\/chat'\)/);
    assert.ok(convBranch.length > 100);
    assert.doesNotMatch(convBranch, /window\.location\.reload\(\)/);
  });

  it('直开跳转中的那拍必须给 pending_navigation，下一拍再给最终结论', () => {
    const start = chatSrc.indexOf("result.replyVerdict = (tick && tick.replyVerdict) || ''");
    assert.ok(start > 0);
    const fn = chatSrc.slice(start, start + 900);
    assert.match(fn, /pending_navigation/);
    assert.match(fn, /下一拍读取回复结论/);
  });

  it('尾斜杠空白路由只做软纠正，不能整页卸载页面', () => {
    const start = chatSrc.indexOf("pathI === '/i/chat/'");
    assert.ok(start > 0, '缺少尾斜杠路由识别');
    const fn = chatSrc.slice(start, start + 900);
    assert.match(fn, /slash_route_fix/);
    assert.match(fn, /history\.replaceState/);
    assert.match(fn, /result\.retryInMs = 5000/);
    assert.doesNotMatch(fn, /window\.location\.href/);
    assert.doesNotMatch(fn, /location\.reload/);
  });

  it('页面重新加载后，旧版本留下的长退避必须收回', () => {
    assert.match(chatSrc, /var pageStart = Number\(window\.performance && window\.performance\.timeOrigin\)/);
    assert.match(chatSrc, /Number\(st\.lastAt\) < pageStart/);
    assert.match(chatSrc, /st\.nextPulseAt = Date\.now\(\) \+ 5000/);
  });

  it('回列表必须优先点 X 的真实返回按钮，不能只改地址', () => {
    const start = chatSrc.indexOf('var shouldReturnToList');
    assert.ok(start > 0, '缺少回列表分支');
    const fn = chatSrc.slice(start, start + 1800);
    assert.match(fn, /tryClickDmConversationBack\(\)/);
    assert.ok(
      fn.indexOf('tryClickDmConversationBack') < fn.indexOf("inboxSoftGo('/i/chat')"),
      '真实返回按钮必须优先于软跳地址'
    );
    assert.match(fn, /history\.back\(\)/);
    assert.match(fn, /returnMode = 'back_btn'/);
    assert.match(fn, /returnToListMode = returnMode/);
    assert.doesNotMatch(fn, /inboxHardNavigate\(/);
  });

  it('回列表结果必须写进返回对象，不能写到不存在的 result 变量', () => {
    const start = chatSrc.indexOf('async function runInboxWatchTick');
    const end = chatSrc.indexOf('async function runInboxWatchLoop', start);
    assert.ok(start > 0 && end > start, '找不到守箱 tick 函数范围');
    const fn = chatSrc.slice(start, end);
    assert.match(fn, /var returnToListMode = 'none'/);
    assert.match(fn, /returnToListMode = returnMode/);
    assert.match(fn, /returnMode: returnToListMode/);
    assert.doesNotMatch(fn, /\bresult\.returnMode\s*=/);
  });
});

describe('无 handle 的失败目标也要冷却', () => {
  it('peerId 级失败记录存在，并在选候选时拦截', () => {
    assert.match(chatSrc, /PEER_OPEN_FAIL_KEY = 'sg_inbox_peer_open_fail'/);
    assert.match(chatSrc, /function markInboxPeerOpenFailure/);
    assert.match(chatSrc, /function inboxPeerOpenCooling/);
    const fn = block(chatSrc, 'function collectInboxWatchCandidates(opts)', 12000);
    assert.match(fn, /inboxPeerOpenCooling\(peerId, previewData\.preview/);
    assert.match(fn, /peer_open_cooling/);
    assert.match(chatSrc, /markInboxPeerOpenFailure\(item\.peerId \|\| '', item\.preview, 'open_direct_pending'\)/);
  });

  it('读到回复/确认无新回复时清零，不会永久冷却', () => {
    assert.match(chatSrc, /function clearInboxPeerOpenFailure/);
    assert.match(chatSrc, /replyVerdict === 'reply_detected' \|\| replyVerdict === 'no_new_reply'\) && item\.peerId/);
  });
});

describe('列表预览必须分清我方/对方（含自动翻译）', () => {
  it('中文「你:」必须算我方前缀', () => {
    assert.match(watchSrc, /INBOX_PREVIEW_SELF_PREFIX_RE = \/\^\(You:\|You sent\|Me:\|我\[:：\]\?\|你\[:：\]/);
  });

  it('原文 + 中文译文两行时，按上一行的「你:」判我方', () => {
    assert.match(watchSrc, /picks\.length < 2/);
    assert.match(watchSrc, /innerText-self-translated/);
    const start = watchSrc.indexOf('var picks = []');
    assert.ok(start > 0);
    const block = watchSrc.slice(start, start + 1200);
    assert.match(block, /isInboxPreviewFromSelf\(prevLine\)/);
    assert.match(block, /result\.fromSelf = true/);
  });
});

describe('OPS 反馈字段完整', () => {
  it('脉冲事件带 target / peer_id，便于直接定位会话', () => {
    const at = chatSrc.indexOf("reportChatMetric('chat.inbox_pulse'");
    assert.ok(at > 0);
    const block = chatSrc.slice(at, at + 1200);
    assert.match(block, /target: result\.handle \|\| ''/);
    assert.match(block, /peer_id: result\.peerId \|\| ''/);
  });
});

describe('窗口恢复必须给渲染进程留一拍', () => {
  it('后台激活在 normal → focused → active 后有 700ms settle 再回包', () => {
    const at = bgSrc.indexOf("request.action === 'sg_activate_tab'");
    assert.ok(at > 0);
    // 4.9.117：sg_activate_tab 处理块加入了「最小化恢复限频」，
    // 契约位置后移；这里按整块取，避免切片长度把断言截断成假红。
    const block = bgSrc.slice(at, at + 12000);
    assert.match(block, /settle_ms: 700/);
    assert.match(block, /setTimeout\(function \(\) \{\s*done\(/);
  });

  it('脉冲事件带 path，白屏能直接定位到是列表还是会话页', () => {
    const at = chatSrc.indexOf("reportChatMetric('chat.inbox_pulse'");
    const block = chatSrc.slice(at, at + 1400);
    assert.match(block, /path: String\(window\.location\.pathname \|\| ''\)/);
  });
});

'use strict';
/**
 * 4.9.4 现场回归：会话“URL 变了但没渲染”不能再被当成已打开。
 * 这些是 DOM 行为，单测用源码契约锁定关键分支，防止又改回 pushState 假打开、
 * 空壳页误报会话头、未证明身份就回写 peerId、硬刷新全局只生效一次。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'content_chat.js'), 'utf8');
const bgSrc = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

describe('打开会话必须真的渲染', () => {
  it('后台标签页必须先激活，再做加载中/白屏判断', () => {
    const activateAt = chatSrc.indexOf('vis = await activateInboxTab();');
    const loadingAt = chatSrc.indexOf("result.reason = loadingAgeMs >= 120000 ? 'page_loading_stuck' : 'page_loading_wait';");
    assert.ok(activateAt > 0, '找不到激活标签页调用');
    assert.ok(loadingAt > 0, '找不到加载中判断');
    assert.ok(activateAt < loadingAt, '激活必须排在加载中判断之前，否则后台标签页会永远 page_loading_wait');
  });

  it('有渲染判定函数，且以气泡/会话头/输入框为证据', () => {
    assert.match(chatSrc, /function isDmConversationRendered\(\)/);
    assert.match(chatSrc, /message-text-/);
    assert.match(chatSrc, /readDmConversationHeaderHandle\(\)\) return true/);
    assert.match(chatSrc, /findBottomAwakeningTarget\(\)\) return true/);
  });

  it('URL 变化不再作为打开成功的判据', () => {
    const openLoop = chatSrc.slice(
      chatSrc.indexOf('var rendered = isDmConversationRendered();'),
      chatSrc.indexOf('var rendered = isDmConversationRendered();') + 2200
    );
    assert.match(openLoop, /while \(!rendered && Date\.now\(\) < deadline\)/);
    assert.doesNotMatch(openLoop, /if \(isDmConversationPage\(\) \|\| isDmConversationView\(\)\) break;/);
  });

  it('有行先走 SPA，点击失败才按地址直开并留下明确原因', () => {
    assert.match(chatSrc, /function buildInboxConversationUrl\(peerId\)/);
    assert.match(chatSrc, /inboxHardNavigate\(navUrl, 'open_direct'/);
    assert.match(chatSrc, /inboxHardNavigate\(retryUrl, 'open_after_click'/);
    assert.match(chatSrc, /reason: 'open_direct_nav'/);
    assert.match(chatSrc, /reason: 'open_nav_failed'/);
    assert.match(chatSrc, /reason: 'open_unreachable'/);
    assert.match(chatSrc, /open_nav_failed: '点击没能进入会话/);
  });

  it('续跑也要验证会话路由和气泡，不能把列表根当成已打开', () => {
    const at = chatSrc.indexOf('async function runInboxWatchTick(opts)');
    assert.ok(at > 0);
    const fn = chatSrc.slice(at, at + 5000);
    assert.match(fn, /opts\.alreadyOpen && opts\.item && pathHasConversationId\(\)/);
    assert.match(fn, /resumeRenderDeadline/);
    assert.match(fn, /var alreadyOpen = !!\(opts\.alreadyOpen && opts\.item/);
    assert.match(fn, /&& isDmConversationRendered\(\)\)/);
  });
});

describe('身份证明不能被空壳页伪造', () => {
  it('会话头只能在输入框或气泡存在时读取', () => {
    const headFn = chatSrc.slice(
      chatSrc.indexOf('function readDmConversationHeaderInfo()'),
      chatSrc.indexOf('function readDmConversationHeaderInfo()') + 5200
    );
    // 新版先认 role=log 会话面板（消息区上方链接），拿不到才走 main 兜底；
    // main 兜底仍要求输入框或气泡已挂载，不能拿列表页导航当会话头。
    assert.match(headFn, /getDmConversationLogRoot\(\)/);
    assert.match(headFn, /source = 'panel_header'/);
    assert.match(headFn, /convMounted = !!findBottomAwakeningTarget\(\)/);
    assert.match(headFn, /if \(!convMounted\) return out;/);
  });

  it('未证明身份时不允许把 URL peerId 回写到台账', () => {
    assert.match(chatSrc, /rowPeerForCapture/);
    assert.match(chatSrc, /rowPeerForCapture === urlPeerForCapture\) \|\| headerProvesCapture/);
    assert.doesNotMatch(chatSrc, /try \{ captureDmPeerId\(targetHandle\); \} catch \(eCapPeer\) \{\}/);
  });
});

describe('渲染失败隔离与进度心跳', () => {
  it('不再用整页刷新恢复空壳，改为记录结论并冷却', () => {
    assert.doesNotMatch(chatSrc, /dan_inbox_hard_reload_/);
    assert.doesNotMatch(chatSrc, /会话未渲染（leaves=0, 无会话头）→ 硬刷新当前会话/);
    assert.match(chatSrc, /reason: 'reply_read_failed'/);
    assert.match(chatSrc, /renderFailPreview/);
    assert.match(chatSrc, /render_failed_cooling/);
  });

  it('长等待期间会持续打进度，避免被当假活回收', () => {
    assert.match(chatSrc, /noteChatProgress\('inbox_wait_render'\)/);
    assert.match(chatSrc, /noteChatProgress\('inbox_wait_composer'\)/);
  });

  it('拉新扫描被打断后要退避，不能 90 秒重进一次', () => {
    assert.match(chatSrc, /lastAttemptAt/);
    assert.match(chatSrc, /Date\.now\(\) - lastAttemptAt\) < 3 \* 60 \* 1000/);
    assert.match(chatSrc, /noteChatProgress\('roster_scan_active'\)/);
  });
});

describe('战报上报参数', () => {
  it('background 兼容 payload 形式，不再永远回 success', () => {
    assert.match(bgSrc, /request\.payload && typeof request\.payload === 'object'/);
    assert.match(bgSrc, /lg\.bot_id \|\| request\.bot_id/);
    assert.match(bgSrc, /status: \(r && r\.ok\) \? 'success' : 'failed'/);
  });
});

describe('测试副本的 OPS 必须锁在独立实例', () => {
  it('默认 OPS 是本机 15681，且锁定开关打开', () => {
    assert.match(bgSrc, /const DEFAULT_OPS_SERVER = 'http:\/\/127\.0\.0\.1:15681';/);
    assert.match(bgSrc, /const TEST_OPS_LOCKED = true;/);
  });

  it('读/写服务器地址都不能把测试副本改回生产', () => {
    const getBlock = bgSrc.slice(
      bgSrc.indexOf("if (request.action === 'get_servers')"),
      bgSrc.indexOf("if (request.action === 'set_servers')")
    );
    assert.match(getBlock, /TEST_OPS_LOCKED \? DEFAULT_OPS_SERVER/);
    const setBlock = bgSrc.slice(
      bgSrc.indexOf("if (request.action === 'set_servers')"),
      bgSrc.indexOf("// ----- 调度控制")
    );
    assert.match(setBlock, /TEST_OPS_LOCKED \? DEFAULT_OPS_SERVER/);
  });

  it('回环地址必须被当作局域网地址，不能被改写成生产地址', () => {
    assert.match(bgSrc, /127\\\.0\\\.0\\\.1/);
    assert.match(bgSrc, /localhost/);
    assert.match(bgSrc, /::1/);
  });
});

describe('测试副本不允许 OPS 反向生成破冰任务', () => {
  it('OPS 只续跑已破冰后的 probe/ad/kick，不再入队 ice', () => {
    assert.doesNotMatch(chatSrc, /'ledger_ops_ice'/);
    assert.match(chatSrc, /skippedIce\+\+/);
    assert.match(chatSrc, /破冰只能由粉丝列表扫描产生/);
  });

  it('扩展重载后自动刷新已打开的 X 页面，避免旧内容脚本继续跑', () => {
    assert.match(bgSrc, /function reloadStaleTabsOnTestBuildChange\(\)/);
    assert.match(bgSrc, /sg_test_build_seen/);
    assert.match(bgSrc, /chrome\.tabs\.reload\(t\.id\)/);
    assert.match(bgSrc, /build changed/);
  });
});

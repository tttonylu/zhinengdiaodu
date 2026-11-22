'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'content_chat.js'), 'utf8');
const watchdogSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'engine-watchdog.js'), 'utf8');
const coreSrc = fs.readFileSync(path.join(__dirname, '..', 'scheduler-core.js'), 'utf8');
const bgSrc = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const stageSrc = fs.readFileSync(path.join(__dirname, '..', 'scheduler', 'stage-detector.js'), 'utf8');

function block(src, marker, length) {
  const at = src.indexOf(marker);
  assert.ok(at >= 0, '找不到代码块: ' + marker);
  return src.slice(at, at + (length || 2400));
}

function loadTimeUtil(store) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'shared', 'time-util.js'), 'utf8');
  const sandbox = {
    window: {},
    console,
    Math,
    Number,
    parseInt,
    isFinite,
    Date,
    Intl,
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.TimeUtil;
}

function loadBackgroundWindowHelper() {
  const marker = 'function isShanghaiChatWindowOpen(';
  const at = bgSrc.indexOf(marker);
  assert.ok(at >= 0);
  const end = bgSrc.indexOf('\nfunction shouldRespawnXTab', at);
  assert.ok(end > at);
  const sandbox = { Date, Number, parseInt, Math };
  vm.createContext(sandbox);
  vm.runInContext(
    bgSrc.slice(at, end)
      + '\nthis.isOpen = isShanghaiChatWindowOpen;'
      + '\nthis.tabUrlForChatHours = tabUrlForChatHours;',
    sandbox
  );
  return sandbox;
}

describe('夜间私信硬停', () => {
  it('显式 sg_test_24h=true 时进入全天模式', () => {
    const T = loadTimeUtil({ sg_test_24h: 'true' });
    assert.equal(T.isTest24h(), true);
    const h = T.readChatHours();
    assert.equal(h.startH, 0);
    assert.equal(h.endH, 24);
    const stageFn = block(stageSrc, 'function isTest24h()', 400);
    assert.match(stageFn, /sg_test_24h/);
  });

  it('显式关闭 24h 后，残留的 00:00–24:00 chatHours 不得重开夜间私信窗', () => {
    const T = loadTimeUtil({
      sg_test_24h: 'false',
      sg_stage_policy: JSON.stringify({
        chatHours: { start: [0, 0], end: [24, 0] }
      })
    });
    const h = T.readChatHours();
    assert.equal(h.startH, 9);
    assert.equal(h.endH, 18);
    assert.match(stageSrc, /function isFullDayChatWindow/);
    assert.match(coreSrc, /ch = \{ start: \[8, 0\], end: \[18, 0\] \};/);
    const reversed = loadTimeUtil({
      sg_test_24h: 'false',
      sg_stage_policy: JSON.stringify({
        chatHours: { start: [18, 0], end: [9, 0] }
      })
    }).readChatHours();
    assert.equal(reversed.startH, 9);
    assert.equal(reversed.endH, 18);
  });

  it('清理定时器不得在非私信时段重新挂守箱主循环', () => {
    const fn = block(chatSrc, 'function clearAllTimers()', 1500);
    assert.match(fn, /getRunMode\(\) === 'inbox'/);
    assert.match(fn, /isChatWorkWindowNow\(\)/);
  });

  it('夜间暂停会清掉待续跑目标和发送锁，次日不会接着旧任务', () => {
    const fn = block(chatSrc, 'function pauseInboxForOffHours()', 1300);
    assert.match(fn, /st\.pending = null/);
    assert.match(fn, /dan_inbox_opening/);
    assert.match(fn, /dan_dm_inflight/);
  });

  it('主引擎、保活和启动恢复都有同一时段闸', () => {
    const main = block(chatSrc, 'window.__sgChatMainEngineTick = function ()', 900);
    assert.match(main, /if \(!isChatWorkWindowNow\(\)\)/);
    assert.match(main, /pauseInboxForOffHours\(\)/);
    const engine = block(chatSrc, 'function ensureChatMainEngine()', 2200);
    assert.match(engine, /if \(!isChatWorkWindowNow\(\)\)/);
    assert.match(engine, /pauseInboxForOffHours\(\)/);
  });

  it('页面看门狗只在私信窗内探测、补引擎和拉回列表', () => {
    const fn = block(chatSrc, 'function startInboxSurfaceWatchdog()', 5200);
    assert.match(fn, /api\.inboxAllowedNow\(\)/);
    assert.ok(fn.indexOf('api.inboxAllowedNow()') < fn.indexOf('api.autoProbe()'));
    assert.ok(fn.indexOf('api.inboxAllowedNow()') < fn.indexOf('api.goSurface'));
  });

  it('独立引擎看门狗在窗外直接判定守箱关闭', () => {
    const fn = block(watchdogSrc, 'function inboxWindowOpen()', 900);
    assert.match(fn, /TimeUtil\.isWithinChatHours/);
    const inboxOn = block(watchdogSrc, 'function inboxOn()', 500);
    assert.match(inboxOn, /if \(!inboxWindowOpen\(\)\) return false/);
  });

  it('调度启动私信必须先通过私信时段', () => {
    assert.match(coreSrc, /function chatHoursOpenCo\(\)/);
    const afterLease = block(coreSrc, 'function startChatAfterLease(', 2500);
    assert.match(afterLease, /if \(!chatHoursOpen\)/);
    assert.match(afterLease, /'outside_chat_hours'/);
    const start = block(coreSrc, 'function startChat(', 1300);
    assert.match(start, /if \(!chatHoursOpen\)/);
  });

  it('后台没有 X 标签时只在私信窗内补守箱页', () => {
    const respawn = block(bgSrc, 'function shouldRespawnXTab(', 900);
    assert.match(respawn, /sg_chat_window/);
    assert.match(respawn, /isShanghaiChatWindowOpen/);
    assert.match(respawn, /done\(inChatWindow\)/);
  });

  it('后台时段计算使用北京时间且结束点立即关闭', () => {
    const bg = loadBackgroundWindowHelper();
    const isOpen = bg.isOpen;
    const win = { start: [9, 0], end: [18, 0] };
    assert.equal(isOpen(win, Date.UTC(2026, 10, 13, 0, 59)), false);
    assert.equal(isOpen(win, Date.UTC(2026, 10, 13, 1, 0)), true);
    assert.equal(isOpen(win, Date.UTC(2026, 10, 13, 9, 59)), true);
    assert.equal(isOpen(win, Date.UTC(2026, 10, 13, 10, 0)), false);
    assert.equal(isOpen({ start: [18, 0], end: [9, 0] }, Date.UTC(2026, 10, 13, 14, 0)), false);
  });

  it('24h 关闭时残留全天窗不得放行；24h 开启时全天放行', () => {
    const { isOpen, tabUrlForChatHours } = loadBackgroundWindowHelper();
    const fullDay = { start: [0, 0], end: [24, 0] };
    const night = Date.UTC(2026, 10, 13, 12, 0);
    assert.equal(isOpen(fullDay, night, false), false);
    assert.equal(
      tabUrlForChatHours('https://x.com/i/chat/123', fullDay, night, false),
      'https://x.com/home'
    );
    assert.equal(isOpen(fullDay, night, true), true);
    assert.equal(
      tabUrlForChatHours('https://x.com/i/chat/123', fullDay, night, true),
      'https://x.com/i/chat/123'
    );
  });

  it('夜间 DM 软导航、整页导航和遗留会话恢复都必须被拦截', () => {
    const soft = block(chatSrc, 'function inboxSoftGo(url)', 900);
    assert.match(soft, /pauseInboxForOffHours/);
    const hard = block(chatSrc, 'function inboxHardNavigate(url, reason, opts)', 900);
    assert.match(hard, /isChatWorkWindowNow/);
    assert.match(hard, /pauseInboxForOffHours/);
    const trace = block(chatSrc, 'function debugNavigateForTrace(url)', 900);
    assert.match(trace, /isChatWorkWindowNow/);
    assert.doesNotMatch(chatSrc, /ignoreChatHours/);
  });

  it('跨 18:00 的已启动脉冲在打开会话前再次校验时段', () => {
    const pulseStart = chatSrc.indexOf('async function runInboxPulse(opts)');
    const crossAt = chatSrc.indexOf('本拍处理中已跨出私信时段');
    const budgetAt = chatSrc.indexOf('var tickBudgetMs =', pulseStart);
    assert.ok(pulseStart >= 0 && crossAt > pulseStart && budgetAt > crossAt);

    const tickStart = chatSrc.indexOf('async function runInboxWatchTick(opts)');
    const clickHoursAt = chatSrc.indexOf('打开会话前已跨出私信时段');
    const rowClickAt = chatSrc.indexOf('row.click()', tickStart);
    assert.ok(tickStart >= 0 && clickHoursAt > tickStart && rowClickAt > clickHoursAt);
  });

  it('后台重建标签时不得在夜间重新打开 DM 页', () => {
    const recreate = block(bgSrc, 'function recreateXTab(tabId)', 2600);
    assert.match(recreate, /tabUrlForChatHours/);
  });

  it('手动私信测试入口同样必须先通过私信时段', () => {
    const manual = block(coreSrc, 'function manualChatTest()', 900);
    assert.match(manual, /chatHoursOpenCo\(\)/);
    const first = block(coreSrc, "if (msg.action === 'sg_test_chat_first')", 700);
    assert.match(first, /chatHoursOpenCo\(\)/);
  });
});

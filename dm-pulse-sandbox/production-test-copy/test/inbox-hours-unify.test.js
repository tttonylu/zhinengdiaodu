'use strict';
/**
 * 4.9.13：私信时段必须只有一个真相源。
 *
 * 现场问题：夜间点“私信测试”，守箱没有扫描，OPS 只看到
 * chat.fan_roster_seed_db { skipped_outside_chat_hours: true }。
 * 原因是测试入口没有打开 24h 测试标记，而且灌债用的是 TimeUtil/StageDetector，
 * 守箱用的是 isChatWorkWindowNow()，两套时钟可能给出相反结论。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'content_chat.js'), 'utf8');
const coreSrc = fs.readFileSync(path.join(__dirname, '..', 'scheduler-core.js'), 'utf8');
const catalogSrc = fs.readFileSync(path.join(__dirname, '..', 'obs', 'event-catalog.json'), 'utf8');

function block(src, marker, length) {
  const at = src.indexOf(marker);
  assert.ok(at >= 0, '找不到代码块: ' + marker);
  return src.slice(at, at + (length || 2000));
}

describe('私信时段判断必须统一', () => {
  it('灌破冰债只认 isChatWorkWindowNow，不再分叉 TimeUtil / StageDetector', () => {
    const fn = block(chatSrc, 'function seedUnfinishedFanDebtToQueue(why)', 2600);
    assert.match(fn, /isChatWorkWindowNow\(\)/);
    assert.doesNotMatch(fn, /TimeUtil\.isWithinChatHours/);
    assert.doesNotMatch(fn, /StageDetector\.isChatTime/);
  });

  it('跳过灌债的 OPS 带 build 与 test_24h，能区分时段导致还是技术失败', () => {
    const fn = block(chatSrc, 'function seedUnfinishedFanDebtToQueue(why)', 2600);
    assert.match(fn, /skipped_outside_chat_hours: true/);
    assert.match(fn, /test_24h: isTest24hMode\(\)/);
    assert.match(fn, /build: extensionVersion\(\)/);
  });

  it('面板“私信测试”遵循正常私信时段，不打开 24h 覆盖', () => {
    const listener = block(chatSrc, "window.addEventListener('sg-chat-test-command'", 2600);
    assert.doesNotMatch(listener, /sg_test_24h', 'true/);
    assert.match(listener, /test_24h: api\.isTest24hMode\(\)/);
  });

  it('强制进入守箱测试不会打开 24h 覆盖', () => {
    const fn = block(chatSrc, 'forceEnterInboxWatch: function', 4200);
    assert.doesNotMatch(fn, /sg_test_24h', 'true/);
    assert.match(fn, /out\.test24h = isTest24hMode\(\)/);
  });

  it('调度“私信测试”走守箱分支时遵循正常私信时段', () => {
    const fn = block(coreSrc, 'function manualChatTest()', 1800);
    const inboxBranch = fn.slice(fn.indexOf('if (inboxWatchOn)'));
    assert.doesNotMatch(inboxBranch, /sg_test_24h', 'true/);
  });

  it('时段暂停事件带 build，能在 OPS 里核对版本', () => {
    const fn = block(chatSrc, 'function reportInboxPausedOnce()', 900);
    assert.match(fn, /build: extensionVersion\(\)/);
    assert.match(catalogSrc, /"id": "chat\.inbox_paused"/);
  });
});

describe('守箱主循环必须能自愈', () => {
  it('DM 页面看门狗会补挂主循环（跳转后 timer 丢失也能恢复）', () => {
    const fn = block(chatSrc, 'function startInboxSurfaceWatchdog()', 3800);
    // 4.9.27：看门狗在第二个 IIFE，必须通过作用域桥调用，不能再直接引用私有函数
    assert.match(fn, /api\.ensureEngine\(\)/);
    assert.match(fn, /window\.__sgInboxApi/);
  });

  it('会话页残留 busy 超过 60s 且本页无脉冲 → 自动释放并排下一拍', () => {
    const fn = block(chatSrc, 'function startInboxSurfaceWatchdog()', 3800);
    assert.match(fn, /conv_page_stale_busy/);
    assert.match(fn, /busyAgeWd > 60000/);
    assert.match(fn, /pulseWd\.nextPulseAt = Date\.now\(\)/);
    assert.match(catalogSrc, /"id": "chat\.inbox_busy_reset"/);
  });
});

function loadTimeUtil(store) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'shared', 'time-util.js'), 'utf8');
  const sandbox = {
    window: {}, console, Math, Number, parseInt, isFinite, Date, Intl,
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.TimeUtil;
}

describe('4.9.121 测试副本遵循正常工作时段', () => {
  it('显式关闭 24h 后，旧手动覆盖也不能重新打开全天模式', () => {
    const T = loadTimeUtil({
      sg_test_24h: 'false',
      sg_manual_test_24h_until: String(Date.now() + 60 * 60 * 1000)
    });
    assert.equal(T.isTest24h(), false);
  });

  it('手动覆盖过期后回到真实时段（不会永久吃全天窗）', () => {
    const T = loadTimeUtil({
      sg_test_24h: 'false',
      sg_manual_test_24h_until: String(Date.now() - 1000)
    });
    assert.equal(T.isTest24h(), false);
  });

  it('“私信测试”和强制守箱都不再写全天覆盖', () => {
    const listener = block(chatSrc, "window.addEventListener('sg-chat-test-command'", 2600);
    assert.doesNotMatch(listener, /sg_manual_test_24h_until/);
    const force = block(chatSrc, 'forceEnterInboxWatch: function', 4200);
    assert.doesNotMatch(force, /sg_manual_test_24h_until/);
    const core = block(coreSrc, 'function manualChatTest()', 2600);
    assert.doesNotMatch(core, /sg_manual_test_24h_until/);
  });

  it('24h 按钮可开启/关闭全天覆盖', () => {
    const panelSrc = fs.readFileSync(path.join(__dirname, '..', 'ui', 'panel.js'), 'utf8');
    assert.doesNotMatch(panelSrc, /btn\.disabled = true;\s*\n\s*btn\.title = '测试副本按正常时段运行/);
    const fn = block(panelSrc, "bindElClick('btn-24h-test'", 900);
    assert.match(fn, /setItem\('sg_test_24h', next \? 'true' : 'false'\)/);
    assert.match(fn, /start: \[0, 0\], end: \[24, 0\]/);
  });

  it('心跳必须先于时段早退上报，夜间也能看到引擎活着', () => {
    const start = chatSrc.indexOf('function runInboxModeTick()');
    const end = chatSrc.indexOf('window.__sgChatMainEngineTick', start);
    assert.ok(start > 0 && end > start);
    const fn = chatSrc.slice(start, end);
    const hb = fn.indexOf("inboxLoopHeartbeat('watch')");
    const gate = fn.indexOf('if (!workWindowNow)');
    assert.ok(hb > 0, '缺少 inbox_loop 心跳');
    assert.ok(gate > 0, '缺少时段闸门');
    assert.ok(hb < gate, '心跳必须在时段闸门之前');
    assert.match(chatSrc, /paused_reason: isChatWorkWindowNow\(\) \? '' : 'outside_chat_hours'/);
  });

  it('夜间停在会话页要主动回列表，不能挂着 pending 假装在跑', () => {
    const start = chatSrc.indexOf('function runInboxModeTick()');
    const gate = chatSrc.indexOf('if (!workWindowNow)', start);
    const night = chatSrc.slice(gate, gate + 1400);
    assert.match(night, /nightPath/);
    assert.match(night, /inboxSoftGo\('\/i\/chat'\)/);
  });
});

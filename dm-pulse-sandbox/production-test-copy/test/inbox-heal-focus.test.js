'use strict';
/**
 * 4.9.38 现场回归：插件把 Chrome 窗口反复弹到前台。
 * 根因：后台标签页不渲染被当成白屏 → heal 升级 recreate → tabs.create(active) 顶起窗口。
 * 运行：node --test --test-force-exit test/inbox-heal-focus.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const chatSrc = fs.readFileSync(path.join(root, 'chat', 'content_chat.js'), 'utf8');
const bgSrc = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const coreSrc = fs.readFileSync(path.join(root, 'scheduler-core.js'), 'utf8');

function sliceFn(src, name, nextName) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start > 0, '找不到函数 ' + name);
  const end = nextName ? src.indexOf('function ' + nextName + '(', start + 10) : -1;
  return src.slice(start, end > 0 ? end : start + 6000);
}

describe('后台标签页不得触发白屏自愈', () => {
  it('白屏探针先判 hidden，再判健康', () => {
    const fn = sliceFn(coreSrc, 'coProbeWhiteScreen', 'stopAllEnginesForChallenge');
    const hiddenAt = fn.indexOf("document.visibilityState === 'hidden'");
    const healthyAt = fn.indexOf('isPageHealthyDom()');
    assert.ok(hiddenAt > 0, '缺少 hidden 判定');
    assert.ok(healthyAt > 0, '缺少健康判定');
    assert.ok(hiddenAt < healthyAt, 'hidden 判定必须在健康判定之前');
    assert.match(fn, /跳过白屏自愈/);
    // 隐藏期间必须重新起算健康计时，否则一回到前台立刻又超 45s
    assert.match(fn, /_healLastHealthyAt = Date\.now\(\)/);
  });

  it('私信心跳的白屏提示不再覆盖后台状态', () => {
    assert.match(chatSrc, /pageHiddenNow = document\.visibilityState === 'hidden'/);
    assert.match(chatSrc, /标签页 hidden，暂停白屏判定/);
    assert.match(chatSrc, /hidden: false/);
  });

  it('后台拒绝 hidden 的 white_screen 自愈请求', () => {
    assert.match(bgSrc, /request\.hidden === true && reason\.indexOf\('white_screen'\) === 0/);
    assert.match(bgSrc, /hidden_no_heal/);
  });
});

describe('自愈不许抢窗口焦点', () => {
  it('recreate 一律 active:false，绝不把窗口顶到前台', () => {
    const fn = sliceFn(bgSrc, 'recreateXTab', 'sweepSiblingXTabs');
    assert.match(fn, /chrome\.windows\.get\(tab\.windowId/);
    // 4.9.110：即使窗口本来在前台，tabs.create({active:true}) 在 Windows 上
    // 也会把窗口提到最前。现场用户正在别的应用里工作，Chrome 每隔几十秒弹一次。
    // 守箱不需要新标签可见，重建必须一律不激活。
    assert.match(fn, /active: false/);
    assert.doesNotMatch(fn, /active: winFocused && tab\.active !== false/);
    assert.doesNotMatch(fn, /active: tab\.active !== false,/);
    assert.doesNotMatch(fn, /chrome\.windows\.update\([^)]*focused/);
  });

  it('守箱激活标签时不带 focusWindow', () => {
    const fn = sliceFn(chatSrc, 'activateInboxTab', 'readDmConversationHeaderHandle');
    assert.match(fn, /send\(\{ action: 'sg_activate_tab' \}/);
    assert.doesNotMatch(fn, /allowWindowFocus/);
    assert.doesNotMatch(fn, /focusWindow:\s*true\s*,/, '激活请求不得再带 focusWindow:true');
  });
});

describe('白屏恢复不能永久卡死', () => {
  it('刷新预算用尽后按 overflowEveryMs 允许保底重试', () => {
    const fn = sliceFn(chatSrc, 'inboxHardNavGuard', 'inboxHardNavigate');
    assert.match(fn, /overflowEveryMs/);
    assert.match(fn, /overflow: true/);
    assert.match(fn, /reason: 'budget_exhausted'/);
  });

  it('空白页先软重挂，再整页刷新', () => {
    const blankAt = chatSrc.indexOf("'blank_soft_remount'");
    const guardAt = chatSrc.indexOf("inboxHardNavGuard('blank_page'");
    assert.ok(blankAt > 0 && guardAt > 0);
    assert.ok(blankAt < guardAt, '软重挂必须发生在整页刷新之前');
    assert.match(chatSrc, /function tryInboxSoftRemount\(\)/);
    assert.match(chatSrc, /inboxSoftGo\('\/home'\)/);
    assert.match(chatSrc, /inboxSoftGo\('\/i\/chat'\)/);
  });

  it('软重挂连续失败后整页换首页重置路由，不反复刷同一个坏地址', () => {
    assert.match(chatSrc, /remount_exhausted/);
    assert.match(chatSrc, /blank_go_home/);
    assert.match(chatSrc, /window\.location\.href = 'https:\/\/x\.com\/home'/);
  });

  it('页面恢复健康后清空重挂与白屏计数', () => {
    assert.match(chatSrc, /resetInboxSoftRemount\(false\)/);
    assert.match(chatSrc, /sessionStorage\.setItem\('sg_inbox_blank_count', '0'\)/);
  });
});

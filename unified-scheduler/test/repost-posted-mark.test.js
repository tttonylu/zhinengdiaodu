/**
 * E2 · 发帖标记认号纯逻辑 QA（4.6.3）
 * 场景：转帖跳来源号主页时 matrix_my_handle 被改写成来源号，
 *       旧逻辑把 sg_repost_posted_ok_<handle> 写到来源号 → 面板/阶段检测读不到 → 「缺发帖」。
 * 规则：认号优先导航栏个人资料链接（始终是本号），并对每个候选 handle 都写标记。
 * 运行：node unified-scheduler/test/repost-posted-mark.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

function makeLocalStorage(seed) {
  const obj = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(obj, k) && typeof obj[k] === 'string' ? obj[k] : null; },
    setItem(k, v) { obj[k] = String(v); },
    removeItem(k) { delete obj[k]; }
  };
  Object.assign(obj, seed || {});
  return obj;
}

/** 最小沙箱加载真实 repost-tracker.js，返回 { T, localStorage } */
function loadTracker(opts) {
  opts = opts || {};
  const src = fs.readFileSync(path.join(__dirname, '..', 'repost', 'repost-tracker.js'), 'utf8');
  const localStorage = makeLocalStorage(opts.store || {});
  const navLink = opts.navHref ? { getAttribute: () => opts.navHref, href: opts.navHref } : null;
  const document = {
    querySelector(sel) { return String(sel).indexOf('AppTabBar_Profile_Link') >= 0 ? navLink : null; }
  };
  const window = {};
  const sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const chrome = {
    storage: { local: { get: () => {}, set: () => {} } },
    runtime: { sendMessage: () => {}, lastError: null }
  };
  const names = ['window', 'document', 'localStorage', 'sessionStorage', 'chrome',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Intl', 'Date', 'JSON'];
  const vals = [window, document, localStorage, sessionStorage, chrome,
    setTimeout, clearTimeout, setInterval, clearInterval, Intl, Date, JSON];
  const factory = new Function(names.join(','), src + '\n;return window.RepostTracker;');
  return { T: factory.apply(null, vals), localStorage };
}

(function () {
  // ---- 1) 导航栏本号 + matrix 同号：两个 key 都写 ----
  {
    const { T, localStorage } = loadTracker({
      navHref: '/myaccount',
      store: { matrix_my_handle: '@myaccount#guard' }
    });
    const hs = T.markOwnPosted();
    assert.ok(hs.indexOf('myaccount') >= 0, '候选应含导航栏本号');
    assert.equal(localStorage.getItem('sg_repost_posted_ok_myaccount'), '1');
    assert.equal(T.hasPostedOk(), true, '同号场景应判定已发帖');
  }

  // ---- 2) 核心回归：matrix_my_handle 被来源页改写成来源号 ----
  {
    const { T, localStorage } = loadTracker({
      navHref: '/myaccount',
      store: { matrix_my_handle: '@sourceguy#guard' }
    });
    const hs = T.markOwnPosted();
    // 本号 key 必须被写（旧逻辑只写 sourceguy → 读取方读本号查不到）
    assert.equal(localStorage.getItem('sg_repost_posted_ok_myaccount'), '1', '必须写本号 key');
    assert.equal(localStorage.getItem('sg_repost_posted_ok_sourceguy'), '1', '来源号 key 也写，保证读取方任一命中');
    assert.ok(hs.indexOf('myaccount') >= 0 && hs.indexOf('sourceguy') >= 0);
    assert.equal(T.hasPostedOk(), true, '被改写场景仍应判定已发帖');
  }

  // ---- 3) markPosted(id) 同时落 ID 去重 + 本号发帖标记 ----
  {
    const { T, localStorage } = loadTracker({
      navHref: '/myaccount',
      store: { matrix_my_handle: '@sourceguy#guard' }
    });
    T.markPosted('1234567890');
    assert.equal(localStorage.getItem('sg_repost_posted_ok_myaccount'), '1', 'markPosted 必须落本号标记');
    assert.equal(T.isPosted('1234567890'), true, 'markPosted 仍要落已发 ID');
  }

  // ---- 4) 无导航栏（未登录/慢加载）：回退 matrix_my_handle ----
  {
    const { T, localStorage } = loadTracker({ store: { matrix_my_handle: '@myaccount#guard' } });
    T.markOwnPosted();
    assert.equal(localStorage.getItem('sg_repost_posted_ok_myaccount'), '1');
    assert.equal(T.hasPostedOk(), true);
  }

  // ---- 5) 无任何 handle：不写 key，hasPostedOk=false ----
  {
    const { T, localStorage } = loadTracker({});
    const hs = T.markOwnPosted();
    assert.equal(hs.length, 0, '无 handle 时不应产生候选');
    assert.equal(T.hasPostedOk(), false);
    assert.equal(localStorage.getItem('sg_repost_posted_ok_unknown'), null, '禁止写 unknown key');
  }

  console.log('ALL PASS repost-posted-mark');
})();
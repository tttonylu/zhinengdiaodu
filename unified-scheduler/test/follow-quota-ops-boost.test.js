'use strict';
/**
 * 跨日清零后禁止 OPS 昨日 followed_today 回灌本地
 * 运行：node --test --test-force-exit unified-scheduler/test/follow-quota-ops-boost.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadApplyRemote() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'shared', 'config-sync.js'), 'utf8');
  const store = {};
  const mem = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
  };
  const sandbox = {
    console,
    localStorage: mem,
    sessionStorage: mem,
    chrome: { storage: { local: { get() {}, set() {} } }, runtime: { sendMessage() {} } },
    window: { addEventListener() {}, dispatchEvent() {}, ConfigSync: null },
    document: { hidden: false, addEventListener() {} },
    RemoteSettings: {
      followDayRange(dc) {
        const table = {
          1: { min: 80, max: 90 },
          2: { min: 135, max: 155 },
          3: { min: 190, max: 215 },
          4: { min: 240, max: 270 },
          5: { min: 285, max: 300 },
        };
        return table[dc >= 5 ? 5 : dc] || table[1];
      },
    },
    Date, Math, JSON, String, parseInt, isNaN, Object, Array,
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'config-sync.js' });
  const api = sandbox.window.ConfigSync || sandbox.ConfigSync;
  return { api, store, mem };
}

describe('F1 · OPS 关注日计数按上海日历日校正', () => {
  it('跨日清零后只接受 OPS 今日读数，昨日/无日期残值不得抬回', () => {
    const { api, store } = loadApplyRemote();
    assert.ok(api && api.applyRemoteDayCount, 'ConfigSync.applyRemoteDayCount 应导出');

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const y = new Date(Date.now() - 24 * 3600 * 1000)
      .toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    // 若测试日与「昨天」撞车（跨日边界极短窗），用固定旧日
    const yesterday = y === today ? '2026-11-03' : y;

    store['matrix_stats_demo'] = JSON.stringify({
      date: yesterday,
      follows_today: 161,
      daily_limit: 145,
      day_count: 2,
    });

    api.applyRemoteDayCount(3, 'demo', 161);
    let st = JSON.parse(store['matrix_stats_demo']);
    assert.equal(st.follows_today, 0, '无日期的 OPS 昨日残值不得回灌');
    assert.equal(toShanghaiDayKey(st.follows_reset_day), today, '应打跨日闩');
    assert.ok(parseInt(st.daily_limit, 10) > 0, '应重抽日限');

    // OPS 明确给出今日日期：允许用今日真实读数纠正
    api.applyRemoteDayCount(3, 'demo', 3, today);
    st = JSON.parse(store['matrix_stats_demo']);
    assert.equal(st.follows_today, 3, 'OPS 今日读数应可纠正跨日后本地 0');

    // 同一次同步里 OPS 又带回昨日 161：不能覆盖今日 3
    api.applyRemoteDayCount(3, 'demo', 161, yesterday);
    st = JSON.parse(store['matrix_stats_demo']);
    assert.equal(st.follows_today, 3, 'OPS 昨日日期不得覆盖今日读数');
  });

  it('同日已用>0 且无闩：不得因“无闩”误判污染清零', () => {
    const { api, store } = loadApplyRemote();
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    store['matrix_stats_same_day'] = JSON.stringify({
      date: today,
      follows_today: 20,
      daily_limit: 145,
      day_count: 3,
    });
    api.applyRemoteDayCount(3, 'same_day', 30, today);
    const st = JSON.parse(store['matrix_stats_same_day']);
    assert.equal(st.follows_today, 30, '同日本地已有 20，应按 OPS 今日 30 抬到 30');
    assert.ok(!st.follows_reset_day, '正常同日同步不应凭空写闩');
  });

  it('同日有跨日闩但 OPS 日期=今日：允许服务端纠正，不再永久锁死', () => {
    const { api, store } = loadApplyRemote();
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    store['matrix_stats_latched'] = JSON.stringify({
      date: today,
      follows_today: 0,
      daily_limit: 145,
      day_count: 3,
      follows_reset_day: today,
    });
    api.applyRemoteDayCount(3, 'latched', 12, today);
    const st = JSON.parse(store['matrix_stats_latched']);
    assert.equal(st.follows_today, 12, '闩不应压掉同日可信的 OPS 读数');
  });
});

function toShanghaiDayKey(raw) {
  const s = String(raw || '');
  const m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!m) return s;
  return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
}

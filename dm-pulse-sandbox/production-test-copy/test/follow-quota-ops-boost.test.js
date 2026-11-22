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

function loadApplyRemote(opts) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'shared', 'config-sync.js'), 'utf8');
  const store = {};
  const mem = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
  };
  const mathStub = Object.create(Math);
  if (opts && typeof opts.random === 'number') mathStub.random = function () { return opts.random; };
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
    Date, Math: mathStub, JSON, String, parseInt, isNaN, Object, Array,
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'config-sync.js' });
  const api = sandbox.window.ConfigSync || sandbox.ConfigSync;
  return { api, store, mem };
}

describe('F1 · 跨日清零后挡 OPS 回灌', () => {
  it('跨日清零会写 follows_reset_day，次日同日同步不得把昨日计数抬回', () => {
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
    assert.equal(st.follows_today, 0, '跨日应清零已用');
    assert.equal(toShanghaiDayKey(st.follows_reset_day), today, '应打跨日闩');
    assert.ok(parseInt(st.daily_limit, 10) > 0, '应重抽日限');

    // 同日再次同步：OPS 仍回灌 161
    api.applyRemoteDayCount(3, 'demo', 161);
    st = JSON.parse(store['matrix_stats_demo']);
    assert.equal(st.follows_today, 0, '同日不得被 OPS 昨日数抬回');
  });

  it('无闩污染态（date已是今日、已用>0）：同步应自愈清零并打闩', () => {
    const { api, store } = loadApplyRemote();
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    store['matrix_stats_polluted'] = JSON.stringify({
      date: today,
      follows_today: 161,
      daily_limit: 191,
      day_count: 3,
      // 故意无 follows_reset_day
    });
    api.applyRemoteDayCount(3, 'polluted', 161);
    const st = JSON.parse(store['matrix_stats_polluted']);
    assert.equal(st.follows_today, 0, '无闩污染应自愈清零');
    assert.equal(toShanghaiDayKey(st.follows_reset_day), today, '自愈后应打闩');
  });

  it('注册兜底镜像：跨日打闩后同日 remote 不得抬数', () => {
    // 镜像 scheduler-core 注册兜底（ConfigSync 缺失时）应与 F1 同语义
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const y = new Date(Date.now() - 24 * 3600 * 1000)
      .toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const yesterday = y === today ? '2026-11-03' : y;
    let stats = {
      date: yesterday,
      follows_today: 161,
      daily_limit: 145,
      day_count: 2,
    };
    const todayKey = today;
    const prevKey = yesterday;
    const rolledLocal = !prevKey || prevKey !== todayKey;
    if (rolledLocal) {
      stats.follows_today = 0;
      delete stats.daily_limit;
      stats.follows_reset_day = todayKey;
    }
    const ft = 161;
    const localF = parseInt(stats.follows_today, 10) || 0;
    const resetDayHb = toShanghaiDayKey(stats.follows_reset_day);
    const skipBoostHb = !!(resetDayHb && todayKey && resetDayHb === todayKey);
    const remoteF = parseInt(ft, 10) || 0;
    if (!rolledLocal && remoteF > localF && !skipBoostHb) {
      stats.follows_today = remoteF;
    }
    stats.date = todayKey;
    assert.equal(stats.follows_today, 0);
    assert.equal(stats.follows_reset_day, todayKey);
    // 同日再抬
    const localF2 = parseInt(stats.follows_today, 10) || 0;
    const skip2 = toShanghaiDayKey(stats.follows_reset_day) === todayKey;
    if (remoteF > localF2 && !skip2) stats.follows_today = remoteF;
    assert.equal(stats.follows_today, 0, '有闩不得抬');
  });

  it('Day 校正重抽配额时不得低于今日已用数', () => {
    const { api, store } = loadApplyRemote({ random: 0 });
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    store['matrix_stats_over'] = JSON.stringify({
      date: today,
      follows_today: 193,
      daily_limit: 200,
      day_count: 1,
      follows_reset_day: today,
    });

    api.applyRemoteDayCount(3, 'over', 193);
    const st = JSON.parse(store['matrix_stats_over']);
    assert.equal(st.follows_today, 193);
    assert.ok(Number(st.daily_limit) >= 193, '重抽后的日限不能小于已用 193');

    // 已有旧锁 191 < 已用 193 时，同日同步也要自愈为 193
    const raw = JSON.parse(store['matrix_stats_over']);
    raw.daily_limit = 191;
    store['matrix_stats_over'] = JSON.stringify(raw);
    api.applyRemoteDayCount(3, 'over', 193);
    const healed = JSON.parse(store['matrix_stats_over']);
    assert.equal(Number(healed.daily_limit), 193, '旧的低配额锁应抬到已用数，避免显示 193/191');
  });
});

function toShanghaiDayKey(raw) {
  const s = String(raw || '');
  const m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!m) return s;
  return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
}

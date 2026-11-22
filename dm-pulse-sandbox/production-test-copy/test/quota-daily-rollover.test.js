/**
 * 配额跨日重置测试
 * 验证：
 *  1. nurture-tracker maybeReset 使用上海日期比较（而非 24h 滚动）
 *  2. scheduler-core 新增 ensureFollowDailyRollover / ensureNurtureDailyRollover
 * 运行：node --test unified-scheduler/test/quota-daily-rollover.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

describe('配额跨日重置 · 代码级验证', () => {

  describe('nurture-tracker · maybeReset 改日期比较', () => {
    var code;

    it('文件存在且包含 maybeReset 函数', () => {
      code = fs.readFileSync(
        path.join(__dirname, '..', 'nurture', 'nurture-tracker.js'),
        'utf8'
      );
      assert.ok(code.includes('function maybeReset()'), '应包含 maybeReset 函数');
    });

    it('maybeReset 使用 shanghaiDateKey 进行日期比较', () => {
      assert.ok(code.includes('shanghaiDateKey()'), '应调用 shanghaiDateKey 获取今日日期');
      assert.ok(code.includes('toShanghaiDateKey(dailyStart)'), '应将 dailyStart 转为日期 key 进行比较');
    });

    it('maybeReset 不再使用 24 小时滚动窗口（> 86400000）', () => {
      // 提取 maybeReset 函数体
      var match = code.match(/function maybeReset\(\)\s*\{[\s\S]*?\n  \}/);
      assert.ok(match, '应能找到 maybeReset 函数');
      var body = match[0];
      assert.ok(
        !body.includes('> 86400000'),
        'maybeReset 中不应使用 > 86400000（24h 滚动窗口）判断跨天'
      );
      assert.ok(
        body.includes('today !== lastDate'),
        'maybeReset 应使用日期不等判断跨天（today !== lastDate）'
      );
    });

    it('文件包含 shanghaiDateKey 工具函数', () => {
      assert.ok(code.includes('function shanghaiDateKey()'), '应定义 shanghaiDateKey');
      assert.ok(code.includes("timeZone: 'Asia/Shanghai'"), '应使用上海时区');
      assert.ok(code.includes("'en-CA'"), '应使用 en-CA 格式（YYYY-MM-DD）');
    });

    it('文件包含 toShanghaiDateKey 工具函数', () => {
      assert.ok(code.includes('function toShanghaiDateKey('), '应定义 toShanghaiDateKey');
    });
  });

  describe('scheduler-core · 新增本地跨日兜底', () => {
    var code;

    it('文件存在且包含 coTick 函数', () => {
      code = fs.readFileSync(
        path.join(__dirname, '..', 'scheduler-core.js'),
        'utf8'
      );
      assert.ok(code.includes('function coTick()'), '应包含 coTick 函数');
    });

    it('新增 ensureFollowDailyRollover 函数', () => {
      assert.ok(code.includes('function ensureFollowDailyRollover()'),
        '应定义 ensureFollowDailyRollover（关注本地跨日兜底）');
    });

    it('ensureFollowDailyRollover 使用上海日期比较', () => {
      assert.ok(code.includes('function shanghaiDayKey()'),
        '应定义 shanghaiDayKey 工具函数');
      assert.ok(code.includes('function toShanghaiDayKey('),
        '应定义 toShanghaiDayKey 工具函数');
      assert.ok(code.includes("timeZone: 'Asia/Shanghai'"),
        '应使用上海时区');
    });

    it('ensureFollowDailyRollover 清零 follows_today 和 daily_limit', () => {
      var idx = code.indexOf('function ensureFollowDailyRollover');
      var idxEnd = code.indexOf('function ensureNurtureDailyRollover', idx);
      var body = code.slice(idx, idxEnd);
      assert.ok(body.includes("follows_today = 0"), '应清零 follows_today');
      assert.ok(body.includes("delete st.daily_limit"), '应删除旧 daily_limit 锁');
      assert.ok(body.includes("st.date = today"), '应更新 date 为今日');
    });

    it('ensureFollowDailyRollover 清 quota_exhausted 终止态', () => {
      var idx = code.indexOf('function ensureFollowDailyRollover');
      var idxEnd = code.indexOf('function ensureNurtureDailyRollover', idx);
      var body = code.slice(idx, idxEnd);
      assert.ok(body.includes("quota_exhausted"), '应处理 quota_exhausted 相位');
      assert.ok(body.includes("ms.phase = 'idle'"), '应把相位重置为 idle');
    });

    it('新增 ensureNurtureDailyRollover 函数', () => {
      assert.ok(code.includes('function ensureNurtureDailyRollover()'),
        '应定义 ensureNurtureDailyRollover（养号本地跨日重置）');
    });

    it('ensureNurtureDailyRollover 调用 NurtureTracker.maybeReset', () => {
      assert.ok(code.includes('ensureNurtureDailyRollover'),
        '应定义 ensureNurtureDailyRollover');
      assert.ok(code.includes('NurtureTracker.maybeReset()'),
        '应调用 NurtureTracker.maybeReset() 触发重置');
      // quota_exhausted 在函数体内
      var idx = code.indexOf('function ensureNurtureDailyRollover');
      var idxEnd = code.indexOf('function isAutoMode', idx);
      var body = code.slice(idx, idxEnd);
      assert.ok(body.includes("quota_exhausted"), '应处理 quota_exhausted 终止态');
    });

    it('coTick 中调用了两个跨日兜底函数', () => {
      var match = code.match(/function coTick\(\)\s*\{[\s\S]*?var stage = 'S0'/);
      assert.ok(match, '应能找到 coTick 开头部分');
      var body = match[0];
      assert.ok(body.includes('ensureFollowDailyRollover()'),
        'coTick 中应调用 ensureFollowDailyRollover');
      assert.ok(body.includes('ensureNurtureDailyRollover()'),
        'coTick 中应调用 ensureNurtureDailyRollover');
    });
  });

  describe('repost-tracker · 参照组（已正确实现）', () => {
    var code;

    it('使用日期比较进行日重置（验证参照模式正确）', () => {
      code = fs.readFileSync(
        path.join(__dirname, '..', 'repost', 'repost-tracker.js'),
        'utf8'
      );
      assert.ok(code.includes('function shanghaiDate()'), '应定义 shanghaiDate');
      assert.ok(code.includes('d.date !== today'), '应使用日期比较判断跨日');
    });

    it('getDaily 懒加载时自动重置跨日数据', () => {
      assert.ok(code.includes('function getDaily()'), '应定义 getDaily');
      assert.ok(code.includes("d.date !== today"), '应比较日期判断跨日');
      assert.ok(code.includes("return { date: today, count: 0 }"),
        '跨日应返回 count=0');
    });
  });
});

describe('配额跨日重置 · 逻辑正确性验证', () => {

  it('上海日期 key 格式一致（YYYY-MM-DD）', () => {
    // 模拟 shanghaiDateKey / shanghaiDayKey 的核心逻辑
    function shanghaiDateKey() {
      try {
        return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
      } catch (e) {
        var d = new Date(Date.now() + 8 * 3600 * 1000);
        return d.toISOString().slice(0, 10);
      }
    }
    var today = shanghaiDateKey();
    // 验证格式：YYYY-MM-DD
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(today), '日期格式应为 YYYY-MM-DD，实际: ' + today);
  });

  it('toShanghaiDayKey 兼容多种日期格式', () => {
    function toShanghaiDayKey(raw) {
      if (!raw) return '';
      var s = String(raw).trim();
      var m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
      if (m) {
        return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
      }
      return s;
    }

    // en-CA 格式（已补零）
    assert.equal(toShanghaiDayKey('2024-01-15'), '2024-01-15');
    // zh-CN 格式（可能缺零）
    assert.equal(toShanghaiDayKey('2024/1/15'), '2024-01-15');
    assert.equal(toShanghaiDayKey('2024/01/05'), '2024-01-05');
    // 带斜杠的缺零格式
    assert.equal(toShanghaiDayKey('2024/12/1'), '2024-12-01');
    // 空值
    assert.equal(toShanghaiDayKey(''), '');
    assert.equal(toShanghaiDayKey(null), '');
  });

  it('关键场景：23:00 启动 → 00:30 跨天（<24h 但日期变了）应重置', () => {
    // 模拟：昨天 23:00 的时间戳
    var yesterday23 = new Date();
    yesterday23.setDate(yesterday23.getDate() - 1);
    yesterday23.setHours(23, 0, 0, 0);
    var yesterdayTs = yesterday23.getTime();

    // 模拟：今天 00:30 的时间戳
    var today0030 = new Date(yesterdayTs + 1.5 * 3600 * 1000); // +1.5h

    // 计算两个时间戳的上海日期 key
    function toShanghaiDateKey(ts) {
      try {
        return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
      } catch (e) {
        var d = new Date(ts + 8 * 3600 * 1000);
        return d.toISOString().slice(0, 10);
      }
    }

    var dateYesterday = toShanghaiDateKey(yesterdayTs);
    var dateToday = toShanghaiDateKey(today0030.getTime());

    // 核心断言：两个时间相差仅 1.5 小时，但日期不同（跨零点）
    // 旧逻辑（24h滚动）：1.5h < 24h → 不重置 ❌
    // 新逻辑（日期比较）：dateYesterday !== dateToday → 重置 ✅
    assert.notEqual(dateYesterday, dateToday,
      '昨天 23:00 与今天 00:30 的日期 key 应不同（跨天）');

    // 时间差 < 24h
    var diffHours = (today0030.getTime() - yesterdayTs) / 3600000;
    assert.ok(diffHours < 24, '时间差应 < 24 小时（验证这是 24h 滚动的盲区）');
    assert.ok(diffHours > 0, '时间差应为正');
  });
});

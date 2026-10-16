/**
 * 幽灵号/待确认账号判定测试（isGhostAccount + confirmed_at 机制）
 * 纯函数测试，不依赖数据库
 * 运行：node --test test/ghost-account-detect.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// 从 accounts.js 里提取 isGhostAccount 的逻辑（拷贝一份，因为 require 会触发 better-sqlite3）
const RESERVED = new Set([
  'system', 'admin', 'administrator', 'root', 'test', 'testing',
  'example', 'demo', 'support', 'help', 'info', 'bot',
]);

function isGhostAccount(account) {
  const h = String((account && account.x_handle) || '').toLowerCase().trim();
  if (!h) return true;
  if (RESERVED.has(h) || /^\d{4,5}$/.test(h)) return true;
  // 已手动确认为真实账号 → 不算幽灵
  if (account.confirmed_at) return false;
  const seen = account.rt_last_seen_at || account.last_seen_at;
  const acts = Number(account.activity_count || 0);
  const leads = Number(account.lead_count || 0);
  const todayF = Number(account.today_follow_count || 0);
  const todayD = Number(account.today_dm_count || 0);
  if (!seen && acts === 0 && leads === 0 && todayF === 0 && todayD === 0) return true;
  return false;
}

describe('isGhostAccount · 基础判定（保留字/空号）', () => {
  it('空 handle → 幽灵', () => {
    assert.equal(isGhostAccount({ x_handle: '' }), true);
    assert.equal(isGhostAccount(null), true);
    assert.equal(isGhostAccount({}), true);
  });

  it('保留字 → 幽灵', () => {
    assert.equal(isGhostAccount({ x_handle: 'admin' }), true);
    assert.equal(isGhostAccount({ x_handle: 'test' }), true);
    assert.equal(isGhostAccount({ x_handle: 'Admin' }), true); // 大小写不敏感
  });

  it('纯数字 → 幽灵', () => {
    assert.equal(isGhostAccount({ x_handle: '1234' }), true);
    assert.equal(isGhostAccount({ x_handle: '12345' }), true);
  });
});

describe('isGhostAccount · confirmed_at 豁免（新机制）', () => {
  it('已确认 + 无上线 + 零数据 → 不算幽灵', () => {
    assert.equal(
      isGhostAccount({
        x_handle: 'realuser',
        confirmed_at: '2026-10-02 12:00:00',
        last_seen_at: null,
        activity_count: 0,
        lead_count: 0,
        today_follow_count: 0,
        today_dm_count: 0,
      }),
      false,
      '手动确认后，即使零产出也不算幽灵'
    );
  });

  it('已确认 + 有机位 + 零产出 → 不算幽灵', () => {
    assert.equal(
      isGhostAccount({
        x_handle: 'realuser',
        confirmed_at: '2026-10-02 12:00:00',
        sort_order: 1,
        last_seen_at: null,
        activity_count: 0,
      }),
      false
    );
  });
});

describe('isGhostAccount · sort_order 不再豁免（新机制）', () => {
  it('有机位 + 无上线 + 零产出 + 未确认 → 仍算幽灵（占坑死号）', () => {
    assert.equal(
      isGhostAccount({
        x_handle: 'dead_account',
        sort_order: 1,
        last_seen_at: null,
        activity_count: 0,
        lead_count: 0,
        today_follow_count: 0,
        today_dm_count: 0,
      }),
      true,
      '有机位但从未上线且未确认，应判为待确认/幽灵'
    );
  });

  it('有机位 + 有上线 → 不算幽灵', () => {
    assert.equal(
      isGhostAccount({
        x_handle: 'active_user',
        sort_order: 5,
        last_seen_at: '2026-10-02 10:00:00',
      }),
      false
    );
  });
});

describe('isGhostAccount · 正常业务账号', () => {
  it('有 last_seen_at → 不算幽灵', () => {
    assert.equal(
      isGhostAccount({ x_handle: 'activeuser', last_seen_at: '2026-10-02 10:00:00' }),
      false
    );
  });

  it('有 rt_last_seen_at（运行态心跳）→ 不算幽灵', () => {
    assert.equal(
      isGhostAccount({ x_handle: 'activeuser', rt_last_seen_at: '2026-10-02 10:00:00' }),
      false
    );
  });

  it('有 activity_count → 不算幽灵', () => {
    assert.equal(
      isGhostAccount({ x_handle: 'user1', activity_count: 5 }),
      false
    );
  });

  it('有 lead_count → 不算幽灵', () => {
    assert.equal(
      isGhostAccount({ x_handle: 'user1', lead_count: 10 }),
      false
    );
  });

  it('今日关注 > 0 → 不算幽灵', () => {
    assert.equal(
      isGhostAccount({ x_handle: 'user1', today_follow_count: 3 }),
      false
    );
  });

  it('今日私信 > 0 → 不算幽灵', () => {
    assert.equal(
      isGhostAccount({ x_handle: 'user1', today_dm_count: 2 }),
      false
    );
  });
});

describe('isGhostAccount · 典型场景对照', () => {
  it('截图场景1：9/18 注册、离线、零数据、未确认 → 幽灵（待确认）', () => {
    // 对应你截图里那三个 9/18 的号
    assert.equal(
      isGhostAccount({
        x_handle: '77_aasll',
        sort_order: 1,
        status: 'active',
        last_seen_at: null,
        activity_count: 0,
        lead_count: 0,
        today_follow_count: 0,
        today_dm_count: 0,
      }),
      true,
      '占机位但从未上线未确认 → 待确认'
    );
  });

  it('截图场景2：被封禁但从未上线 → 幽灵（待确认）', () => {
    assert.equal(
      isGhostAccount({
        x_handle: 'yvonneb22696',
        sort_order: 3,
        status: 'banned',
        last_seen_at: null,
        activity_count: 0,
        lead_count: 0,
      }),
      true,
      '被封禁+零上线+未确认 → 待确认'
    );
  });

  it('正常干活的号：有上线+有数据+未确认 → 不算幽灵', () => {
    assert.equal(
      isGhostAccount({
        x_handle: 'working_bot',
        sort_order: 2,
        last_seen_at: '2026-10-02 23:00:00',
        activity_count: 150,
        lead_count: 80,
        today_follow_count: 45,
        today_dm_count: 12,
      }),
      false,
      '正常干活的号，即使未手动确认也不算幽灵'
    );
  });
});

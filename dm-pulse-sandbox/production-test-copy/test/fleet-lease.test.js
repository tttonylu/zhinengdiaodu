/**
 * A2 · 舰队重活槽客户端 + OPS repo（4.6.173）
 * 运行：node unified-scheduler/test/fleet-lease.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const Module = require('module');

// 沙箱内没有独立 test-env 时回落到仓库共享的 OPS 测试环境（只读依赖）
const localOpsRoot = path.join(__dirname, '..', '..', 'test-env', 'x-ops-console');
const sharedOpsRoot = path.join(__dirname, '..', '..', '..', 'test-env', 'x-ops-console');
const opsRoot = fs.existsSync(localOpsRoot) ? localOpsRoot : sharedOpsRoot;
const opsNodeModules = path.join(opsRoot, 'node_modules');
const prevNodePath = process.env.NODE_PATH || '';
process.env.NODE_PATH = prevNodePath
  ? `${opsNodeModules}${path.delimiter}${prevNodePath}`
  : opsNodeModules;
Module._initPaths();

const Database = require('better-sqlite3');
const SgFleetLease = require(path.join(__dirname, '..', 'scheduler', 'fleet-lease.js'));
const { createFleetLeaseRepo } = require(path.join(
  opsRoot,
  'src',
  'repositories',
  'fleet-lease-repo.js'
));

describe('SgFleetLease client', () => {
  it('默认 8 槽', () => {
    assert.equal(SgFleetLease.readSlots({}), 8);
  });
  it('0 表示关闭 needLease', () => {
    const c = SgFleetLease.configFromThresholds({ fleet_heavy_slots: '0' });
    assert.equal(c.slots, 0);
    assert.equal(c.needLease, false);
  });
  it('显式槽数', () => {
    assert.equal(SgFleetLease.readSlots({ fleet_heavy_slots: 12 }), 12);
  });
});

describe('fleet-lease-repo', () => {
  it('槽满拒绝、同号续约、释放后可再占', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE fleet_leases (
        handle TEXT NOT NULL COLLATE NOCASE,
        kind TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at TEXT,
        PRIMARY KEY (handle, kind)
      );
    `);
    const repo = createFleetLeaseRepo(db);
    const now = Date.now();
    const a = repo.acquire('alice', 'chat', 2, 60000, now, 't');
    assert.equal(a.granted, true);
    const b = repo.acquire('bob', 'follow', 2, 60000, now, 't');
    assert.equal(b.granted, true);
    const c = repo.acquire('carol', 'chat', 2, 60000, now, 't');
    assert.equal(c.granted, false);
    assert.equal(c.reason, 'slots_full');
    const renew = repo.acquire('alice', 'chat', 2, 60000, now + 1000, 't2');
    assert.equal(renew.granted, true);
    assert.equal(renew.reason, 'renew');
    repo.release('bob', 'follow');
    const d = repo.acquire('carol', 'chat', 2, 60000, now + 2000, 't3');
    assert.equal(d.granted, true);
  });

  it('超员后续约留下最早的槽，其余拒绝并删行', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE fleet_leases (
        handle TEXT NOT NULL COLLATE NOCASE,
        kind TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at TEXT,
        PRIMARY KEY (handle, kind)
      );
    `);
    const repo = createFleetLeaseRepo(db);
    const now = Date.now();
    const exp = now + 120000;
    const ins = db.prepare(
      'INSERT INTO fleet_leases (handle, kind, expires_at, updated_at) VALUES (?, ?, ?, ?)'
    );
    ins.run('a', 'follow', exp, '2026-01-01');
    ins.run('b', 'follow', exp, '2026-01-02');
    ins.run('c', 'follow', exp, '2026-01-03');
    assert.equal(repo.acquire('a', 'follow', 2, 60000, now, 't').granted, true);
    assert.equal(repo.acquire('b', 'follow', 2, 60000, now, 't').granted, true);
    const shed = repo.acquire('c', 'follow', 2, 60000, now, 't');
    assert.equal(shed.granted, false);
    assert.equal(shed.reason, 'slots_full');
    const left = db.prepare('SELECT handle FROM fleet_leases ORDER BY handle').all().map((r) => r.handle);
    assert.deepEqual(left, ['a', 'b']);
  });

  it('slots<=0 直接放行', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE fleet_leases (
        handle TEXT NOT NULL, kind TEXT NOT NULL,
        expires_at INTEGER NOT NULL, updated_at TEXT,
        PRIMARY KEY (handle, kind)
      );
    `);
    const repo = createFleetLeaseRepo(db);
    const r = repo.acquire('x', 'chat', 0, 60000, Date.now(), 't');
    assert.equal(r.granted, true);
    assert.equal(r.reason, 'lease_off');
  });
});

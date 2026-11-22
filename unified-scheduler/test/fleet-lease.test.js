/**
 * A2 · 舰队重活槽客户端 + OPS repo（4.6.173）
 * 运行：node unified-scheduler/test/fleet-lease.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const opsRoot = path.join(__dirname, '..', '..', 'test-env', 'x-ops-console');
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
  it('租约申请期只写 leasing，grant 后 token 匹配才 running', () => {
    const module = { _state: 'stopped' };
    const pending = SgFleetLease.markStartPending(module, 'https://x.com/a/followers', 1000);
    assert.equal(pending.state.running, false);
    assert.equal(pending.state.phase, 'leasing');
    assert.equal(module._state, 'starting');
    assert.equal(SgFleetLease.isStartPending(module, pending.token), true);

    const started = SgFleetLease.beginStart(module, 'https://x.com/a/followers', pending.token, 2000);
    assert.equal(started.running, true);
    assert.equal(started.phase, 'starting');
    assert.equal(module._state, 'running');
    assert.equal(SgFleetLease.isStartPending(module, pending.token), false);
    assert.equal(SgFleetLease.isCurrentRun(module, pending.token), true);
  });
  it('停止会作废旧 token，晚到 grant 不得再拉起', () => {
    const module = { _state: 'stopped' };
    const pending = SgFleetLease.markStartPending(module, 'https://x.com/i/chat', 1000);
    SgFleetLease.resetStart(module);
    assert.equal(SgFleetLease.isStartPending(module, pending.token), false);
    assert.equal(SgFleetLease.beginStart(module, 'https://x.com/i/chat', pending.token, 2000), null);
    assert.equal(module._state, 'stopped');
  });
  it('槽满取消进入短期退避，超时申请会失效', () => {
    const module = { _state: 'stopped' };
    const pending = SgFleetLease.markStartPending(module, 'https://x.com/home', 1000);
    const denied = SgFleetLease.cancelStart(module, pending.token, 1000, 15000);
    assert.equal(denied.running, false);
    assert.equal(denied.phase, 'idle');
    assert.equal(SgFleetLease.isStartDenied(module, 2000), true);
    assert.equal(SgFleetLease.isStartDenied(module, 17000), false);

    const module2 = { _state: 'stopped' };
    SgFleetLease.markStartPending(module2, 'https://x.com/home', 1000);
    assert.equal(SgFleetLease.expireStart(module2, 5000, 20000, 15000), null);
    const expired = SgFleetLease.expireStart(module2, 22001, 20000, 15000);
    assert.equal(expired.phase, 'idle');
    assert.equal(module2._leasePending, false);
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

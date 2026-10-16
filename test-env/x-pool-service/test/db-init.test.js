const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { runMigrations } = require('../src/db/migrate');

test('runMigrations creates pool tasks and settings tables', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-pool-db-'));
  const dbPath = path.join(tempDir, 'test.sqlite');

  runMigrations(dbPath);

  const db = new Database(dbPath);
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('pool_tasks', 'pool_settings') ORDER BY name"
    )
    .all()
    .map((row) => row.name);

  assert.deepEqual(tables, ['pool_settings', 'pool_tasks']);

  db.prepare(
    "INSERT INTO pool_tasks (handle, source, status, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))"
  ).run('@alpha', 'test', 'pending');

  assert.throws(() => {
    db.prepare(
      "INSERT INTO pool_tasks (handle, source, status, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))"
    ).run('@alpha', 'test', 'pending');
  });

  db.close();
});

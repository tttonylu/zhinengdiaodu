const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { runMigrations } = require('../src/db/migrate');

test('runMigrations creates the three core tables and unique lead handle', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-ops-console-'));
  const dbPath = path.join(tempDir, 'test.sqlite');

  runMigrations(dbPath);

  const db = new Database(dbPath);
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('accounts', 'leads', 'activity_logs') ORDER BY name"
    )
    .all()
    .map((row) => row.name);

  assert.deepEqual(tables, ['accounts', 'activity_logs', 'leads']);

  db.prepare(
    "INSERT INTO leads (platform, target_handle, source, current_stage, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))"
  ).run('x', '@alpha', 'plugin', 'discovered');

  assert.throws(() => {
    db.prepare(
      "INSERT INTO leads (platform, target_handle, source, current_stage, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))"
    ).run('x', '@alpha', 'plugin', 'discovered');
  });

  db.close();
});

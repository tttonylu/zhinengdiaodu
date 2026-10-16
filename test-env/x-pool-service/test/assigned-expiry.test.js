const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { runMigrations } = require('../src/db/migrate');
const { buildApp } = require('../src/app');

function createFixtureApp() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-pool-expiry-'));
  const dbPath = path.join(tempDir, 'pool.sqlite');
  runMigrations(dbPath);
  return buildApp({ dbPath, dataDir: tempDir });
}

test('expire preview counts stale assigned tasks and expiry returns them to pending', async () => {
  const app = createFixtureApp();

  await app.inject({ method: 'POST', url: '/pool/push_batch', payload: { handles: ['@stale', '@fresh'], source: 'test' } });
  await app.inject({ method: 'GET', url: '/pool/pop?worker_id=worker-a' });
  await app.inject({ method: 'GET', url: '/pool/pop?worker_id=worker-b' });

  const beforeStatus = await app.inject({ method: 'GET', url: '/pool/status' });
  assert.equal(beforeStatus.json().assigned, 2);

  const staleTask = app.db.prepare("SELECT id FROM pool_tasks WHERE handle = '@stale'").get();
  app.db.prepare("UPDATE pool_tasks SET assigned_at = datetime('now', '-120 minutes') WHERE id = ?").run(staleTask.id);

  const preview = await app.inject({ method: 'GET', url: '/pool/expire_preview?minutes=60' });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.json().ok, true);
  assert.equal(preview.json().count, 1);
  assert.equal(preview.json().minutes, 60);

  const expire = await app.inject({ method: 'POST', url: '/pool/expire_assigned', payload: { minutes: 60 } });
  assert.equal(expire.statusCode, 200);
  assert.equal(expire.json().ok, true);
  assert.equal(expire.json().expired, 1);
  assert.equal(expire.json().minutes, 60);

  const afterStatus = await app.inject({ method: 'GET', url: '/pool/status' });
  assert.equal(afterStatus.json().assigned, 1);
  assert.equal(afterStatus.json().pending, 1);

  await app.close();
});

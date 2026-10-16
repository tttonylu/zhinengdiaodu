const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runMigrations } = require('../src/db/migrate');
const { buildApp } = require('../src/app');

function createFixtureApp() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-pool-dashboard-'));
  const dbPath = path.join(tempDir, 'pool.sqlite');
  runMigrations(dbPath);
  return buildApp({ dbPath, dataDir: tempDir });
}

test('GET / renders the standalone pool dashboard shell', async () => {
  const app = createFixtureApp();

  const response = await app.inject({ method: 'GET', url: '/' });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /text\/html/);
  assert.match(response.body, /号池管理面板/);
  assert.match(response.body, /task-table/);
  assert.match(response.body, /export-csv/);
  assert.match(response.body, /Push 接入/);
  assert.match(response.body, /\/pool\/push_batch/);

  await app.close();
});

test('management API lists tasks with status filters', async () => {
  const app = createFixtureApp();

  await app.inject({
    method: 'POST',
    url: '/pool/push_batch',
    payload: { handles: ['@alpha', '@beta'], source: 'test' },
  });
  await app.inject({ method: 'GET', url: '/pool/pop?worker_id=worker-a' });

  const all = await app.inject({ method: 'GET', url: '/api/tasks' });
  assert.equal(all.statusCode, 200);
  assert.equal(all.json().ok, true);
  assert.equal(all.json().tasks.length, 2);
  assert.equal(all.json().stats.pending, 1);
  assert.equal(all.json().stats.assigned, 1);

  const pending = await app.inject({ method: 'GET', url: '/api/tasks?status=pending' });
  assert.equal(pending.json().tasks.length, 1);
  assert.equal(pending.json().tasks[0].status, 'pending');

  await app.close();
});

test('management API adds pasted handles and deletes one task', async () => {
  const app = createFixtureApp();

  const added = await app.inject({
    method: 'POST',
    url: '/api/tasks',
    payload: { handles: '@alpha\nbeta\n@alpha', source: 'manual-dashboard' },
  });

  assert.equal(added.statusCode, 200);
  assert.deepEqual(added.json(), { ok: true, count: 2, inserted: 2, skipped: 1 });

  const list = await app.inject({ method: 'GET', url: '/api/tasks' });
  const targetId = list.json().tasks.find((task) => task.handle === '@alpha').id;

  const deleted = await app.inject({ method: 'DELETE', url: `/api/tasks/${targetId}` });
  assert.deepEqual(deleted.json(), { ok: true });

  const afterDelete = await app.inject({ method: 'GET', url: '/api/tasks' });
  assert.equal(afterDelete.json().tasks.length, 1);
  assert.equal(afterDelete.json().tasks[0].handle, '@beta');

  await app.close();
});

test('CSV export includes task headers and handles', async () => {
  const app = createFixtureApp();

  await app.inject({
    method: 'POST',
    url: '/pool/push',
    payload: { handle: '@alpha', source: 'export-test' },
  });

  const response = await app.inject({ method: 'GET', url: '/api/export/tasks.csv' });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /text\/csv/);
  assert.match(response.headers['content-disposition'], /attachment; filename="pool-tasks.csv"/);
  assert.match(response.body, /id,handle,status,source,worker_id,attempts,created_at,updated_at,assigned_at,completed_at/);
  assert.match(response.body, /@alpha/);

  await app.close();
});

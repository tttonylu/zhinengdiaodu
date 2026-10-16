const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runMigrations } = require('../src/db/migrate');
const { buildApp } = require('../src/app');

function createFixtureApp() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-pool-service-'));
  const dbPath = path.join(tempDir, 'pool.sqlite');
  runMigrations(dbPath);
  return buildApp({ dbPath, dataDir: tempDir });
}

test('push stores one handle and pop assigns it to a worker', async () => {
  const app = createFixtureApp();

  const pushResponse = await app.inject({
    method: 'POST',
    url: '/pool/push',
    payload: { handle: 'alpha', source: 'profile' },
  });

  assert.equal(pushResponse.statusCode, 200);
  assert.equal(pushResponse.json().ok, true);
  assert.equal(pushResponse.json().handle, '@alpha');

  const popResponse = await app.inject({
    method: 'GET',
    url: '/pool/pop?worker_id=worker-a',
  });

  assert.equal(popResponse.statusCode, 200);
  assert.equal(popResponse.json().ok, true);
  assert.equal(popResponse.json().handle, '@alpha');
  assert.equal(typeof popResponse.json().id, 'number');

  await app.close();
});

test('push batch deduplicates handles and status reports queue counts', async () => {
  const app = createFixtureApp();

  const response = await app.inject({
    method: 'POST',
    url: '/pool/push_batch',
    payload: { handles: ['@alpha', 'beta', '@alpha'], source: 'batch' },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true, count: 2, inserted: 2, skipped: 1 });

  const status = await app.inject({ method: 'GET', url: '/pool/status' });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().ok, true);
  assert.equal(status.json().pending, 2);
  assert.equal(status.json().assigned, 0);
  assert.equal(status.json().completed, 0);

  await app.close();
});

test('done completes a task and fail returns a task to pending', async () => {
  const app = createFixtureApp();

  await app.inject({
    method: 'POST',
    url: '/pool/push_batch',
    payload: { handles: ['@done-target', '@retry-target'], source: 'batch' },
  });

  const first = await app.inject({ method: 'GET', url: '/pool/pop?worker_id=worker-a' });
  const second = await app.inject({ method: 'GET', url: '/pool/pop?worker_id=worker-b' });

  const doneResponse = await app.inject({
    method: 'POST',
    url: '/pool/done',
    payload: { id: first.json().id },
  });
  assert.deepEqual(doneResponse.json(), { ok: true });

  const failResponse = await app.inject({
    method: 'POST',
    url: '/pool/fail',
    payload: { id: second.json().id },
  });
  assert.deepEqual(failResponse.json(), { ok: true });

  const status = await app.inject({ method: 'GET', url: '/pool/status' });
  assert.equal(status.json().pending, 1);
  assert.equal(status.json().assigned, 0);
  assert.equal(status.json().completed, 1);

  const retry = await app.inject({ method: 'GET', url: '/pool/pop?worker_id=worker-c' });
  assert.equal(retry.json().ok, true);
  assert.equal(retry.json().handle, '@retry-target');

  await app.close();
});

test('links can be read and replaced for chat resources', async () => {
  const app = createFixtureApp();

  const initial = await app.inject({ method: 'GET', url: '/pool/links' });
  assert.equal(initial.statusCode, 200);
  assert.deepEqual(initial.json(), { ok: true, links: [] });

  const saved = await app.inject({
    method: 'POST',
    url: '/pool/links',
    payload: { links: ['https://example.com/a', 'https://example.com/b'] },
  });
  assert.deepEqual(saved.json(), { ok: true, count: 2 });

  const loaded = await app.inject({ method: 'GET', url: '/pool/links' });
  assert.deepEqual(loaded.json(), {
    ok: true,
    links: ['https://example.com/a', 'https://example.com/b'],
  });

  await app.close();
});

test('health reports the standalone pool service', async () => {
  const app = createFixtureApp();

  const response = await app.inject({ method: 'GET', url: '/health' });

  assert.deepEqual(response.json(), { ok: true, service: 'x-pool-service' });

  await app.close();
});

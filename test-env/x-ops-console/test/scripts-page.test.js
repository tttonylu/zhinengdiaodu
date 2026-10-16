const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildApp } = require('../src/app');
const { runMigrations } = require('../src/db/migrate');

function createApp() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-ops-scripts-'));
  const dbPath = path.join(tempDir, 'ops.sqlite');
  const rulesPath = path.join(tempDir, 'rules.json');
  runMigrations(dbPath);
  return buildApp({ dbPath, rulesPath, dataDir: tempDir });
}

test('GET /scripts renders the scripts page with default sets', async () => {
  const app = createApp();

  await app.ready();

  const response = await app.inject({ method: 'GET', url: '/scripts' });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /话术中心/);
  assert.match(response.body, /v1/);
  assert.match(response.body, /v2/);
  assert.match(response.body, /v3/);

  await app.close();
});

test('GET /api/scripts/pool returns the extension-ready payload', async () => {
  const app = createApp();
  await app.ready();

  const response = await app.inject({ method: 'GET', url: '/api/scripts/pool' });

  assert.equal(response.statusCode, 200);
  const data = response.json();
  assert.equal(data.version, '2.0');
  assert.ok(Array.isArray(data.random_pool));
  assert.ok(data.random_pool.length >= 3);
  assert.ok(data.scripts.v1);
  assert.ok(data.scripts.v1.icebreaker);
  assert.ok(data.scripts.v1.ad_template.includes('{LINK}'));

  await app.close();
});

test('POST /api/scripts creates a new set and templates can be saved', async () => {
  const app = createApp();
  await app.ready();

  const createResponse = await app.inject({
    method: 'POST',
    url: '/api/scripts',
    payload: {
      set_id: 'custom_v1',
      name: 'Custom',
      description: 'test',
      templates: {
        icebreaker: 'hello',
        ad_template: 'click {LINK}',
      },
    },
  });

  assert.equal(createResponse.json().ok, true);

  const poolResponse = await app.inject({ method: 'GET', url: '/api/scripts/pool' });
  const pool = poolResponse.json();
  assert.ok(pool.scripts.custom_v1);
  assert.equal(pool.scripts.custom_v1.icebreaker, 'hello');
  assert.ok(pool.random_pool.includes('custom_v1'));

  await app.close();
});

test('POST /api/scripts/:setId/enable toggles enabled state', async () => {
  const app = createApp();
  await app.ready();

  await app.inject({
    method: 'POST',
    url: '/api/scripts/v1/enable',
    payload: { enabled: false },
  });

  const pool = (await app.inject({ method: 'GET', url: '/api/scripts/pool' })).json();
  assert.ok(!pool.random_pool.includes('v1'));

  await app.inject({
    method: 'POST',
    url: '/api/scripts/v1/enable',
    payload: { enabled: true },
  });

  const pool2 = (await app.inject({ method: 'GET', url: '/api/scripts/pool' })).json();
  assert.ok(pool2.random_pool.includes('v1'));

  await app.close();
});

test('POST /api/scripts/settings/shuffle changes the shuffle mode', async () => {
  const app = createApp();
  await app.ready();

  await app.inject({
    method: 'POST',
    url: '/api/scripts/settings/shuffle',
    payload: { mode: 'round_robin' },
  });

  const pool = (await app.inject({ method: 'GET', url: '/api/scripts/pool' })).json();
  assert.equal(pool.mode, 'round_robin');

  await app.close();
});

test('DELETE /api/scripts/:setId removes a set', async () => {
  const app = createApp();
  await app.ready();

  const del = await app.inject({ method: 'DELETE', url: '/api/scripts/v3' });
  assert.equal(del.json().ok, true);

  const pool = (await app.inject({ method: 'GET', url: '/api/scripts/pool' })).json();
  assert.ok(!pool.scripts.v3);

  await app.close();
});

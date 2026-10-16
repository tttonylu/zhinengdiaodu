const test = require('node:test');
const assert = require('node:assert/strict');
const { buildApp } = require('../src/app');

test('GET /health returns ok payload', async () => {
  const app = buildApp({
    dbPath: ':memory:',
    rulesPath: null,
    dataDir: process.cwd(),
  });

  const response = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true, service: 'x-ops-console' });

  await app.close();
});

test('GET / redirects to dashboard', async () => {
  const app = buildApp({
    dbPath: ':memory:',
    rulesPath: null,
    dataDir: process.cwd(),
  });

  const response = await app.inject({ method: 'GET', url: '/' });
  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, '/dashboard');

  await app.close();
});

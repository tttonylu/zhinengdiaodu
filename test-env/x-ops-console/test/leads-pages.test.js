const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildApp } = require('../src/app');
const { runMigrations } = require('../src/db/migrate');

function createApp() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-ops-leads-'));
  const dbPath = path.join(tempDir, 'ops.sqlite');
  const rulesPath = path.join(tempDir, 'rules.json');
  runMigrations(dbPath);
  return buildApp({ dbPath, rulesPath, dataDir: tempDir });
}

async function sendLog(app, targetHandle, actionType = 'ICEBREAKER') {
  await app.inject({
    method: 'POST',
    url: '/api/plugin/log',
    payload: {
      bot_id: '@workerA#guard',
      target: targetHandle,
      action_type: actionType,
      detail: 'test',
      message: 'test',
    },
  });
}

test('GET /leads renders the lead list with reported leads', async () => {
  const app = createApp();
  await sendLog(app, '@leadA', 'ICEBREAKER');

  const response = await app.inject({ method: 'GET', url: '/leads' });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /目标池/);
  assert.match(response.body, /leada/);

  await app.close();
});

test('GET /leads/:id renders lead detail and manual action buttons', async () => {
  const app = createApp();
  await sendLog(app, '@leadB', 'ICEBREAKER');
  const listResponse = await app.inject({ method: 'GET', url: '/leads' });
  const match = listResponse.body.match(/href="(\/leads\/\d+)"/);
  assert.ok(match, 'should find lead detail link');
  const detailUrl = match[1];

  const detailResponse = await app.inject({ method: 'GET', url: detailUrl });

  assert.equal(detailResponse.statusCode, 200);
  assert.match(detailResponse.body, /leadb/);
  assert.match(detailResponse.body, /标记完成/);
  assert.match(detailResponse.body, /标记跳过/);

  await app.close();
});

test('POST /leads/:id/skip marks a lead skipped', async () => {
  const app = createApp();
  await sendLog(app, '@leadC', 'ICEBREAKER');
  const listResponse = await app.inject({ method: 'GET', url: '/leads' });
  const match = listResponse.body.match(/href="(\/leads\/\d+)"/);
  assert.ok(match, 'should find lead detail link');
  const detailUrl = match[1];

  const skipResponse = await app.inject({
    method: 'POST',
    url: `${detailUrl}/skip`,
  });
  assert.equal(skipResponse.statusCode, 302);

  // Verify lead is now skipped by marking as CORPSE via log (which maps to skip)
  const detailResponse = await app.inject({ method: 'GET', url: detailUrl });
  assert.match(detailResponse.body, /已跳过/);

  await app.close();
});

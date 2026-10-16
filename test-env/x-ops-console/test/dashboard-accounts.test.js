const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildApp } = require('../src/app');
const { runMigrations } = require('../src/db/migrate');

function createApp() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-ops-dashboard-'));
  const dbPath = path.join(tempDir, 'ops.sqlite');
  const rulesPath = path.join(tempDir, 'rules.json');
  runMigrations(dbPath);
  return buildApp({ dbPath, rulesPath, dataDir: tempDir });
}

async function sendLog(app, target, actionType, botId = '@workerA#guard') {
  await app.inject({
    method: 'POST',
    url: '/api/plugin/log',
    payload: {
      bot_id: botId,
      target,
      action_type: actionType,
      detail: 'test detail',
      message: 'test message',
    },
  });
}

test('GET /dashboard renders funnel counts and leads', async () => {
  const app = createApp();
  await sendLog(app, '@lead-ice', 'ICEBREAKER');
  await sendLog(app, '@lead-ad', 'AD');

  const response = await app.inject({ method: 'GET', url: '/dashboard' });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /私信漏斗/);
  assert.match(response.body, /@lead-ice/);
  assert.match(response.body, /@lead-ad/);

  await app.close();
});

test('GET /dashboard shows today action counts', async () => {
  const app = createApp();
  await sendLog(app, '@lead-ice2', 'ICEBREAKER');

  const response = await app.inject({ method: 'GET', url: '/dashboard' });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /@lead-ice2/);

  await app.close();
});

test('GET /accounts renders accounts created by plugin logs', async () => {
  const app = createApp();
  await sendLog(app, '@lead-a', 'ICEBREAKER', '@workerA#guard');
  await sendLog(app, '@lead-b', 'AD', '@workerB#guard');

  const response = await app.inject({ method: 'GET', url: '/accounts' });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /账号中心/);
  assert.match(response.body, /workerA/);
  assert.match(response.body, /workerB/);

  await app.close();
});

test('GET /accounts/:id renders an account detail page', async () => {
  const app = createApp();
  await sendLog(app, '@lead-a', 'ICEBREAKER', '@workerA#guard');
  const listResponse = await app.inject({ method: 'GET', url: '/accounts' });
  const match = listResponse.body.match(/href="(\/accounts\/\d+)"/);
  assert.ok(match, 'should find account detail link');
  const detailUrl = match[1];

  const detailResponse = await app.inject({ method: 'GET', url: detailUrl });

  assert.equal(detailResponse.statusCode, 200);
  assert.match(detailResponse.body, /workerA/);
  assert.match(detailResponse.body, /最近操作/);

  await app.close();
});

test('DELETE /api/accounts/:id cascade removes account and related rows', async () => {
  const app = createApp();
  await sendLog(app, '@lead-del', 'ICEBREAKER', '@workerDel#guard');

  const list = await app.inject({ method: 'GET', url: '/accounts' });
  // x_handle 在落库时被 normalizeHandle 归一化为小写，匹配小写 workerdel
  const match = list.body.match(/data-id="(\d+)"[^>]*data-handle="workerdel"|data-handle="workerdel"[^>]*data-id="(\d+)"/);
  assert.ok(match, 'should find workerDel row');
  const id = match[1] || match[2];

  const del = await app.inject({ method: 'DELETE', url: `/api/accounts/${id}` });
  assert.equal(del.statusCode, 200);
  const body = del.json();
  assert.equal(body.ok, true);
  assert.equal(body.deleted, 'workerDel');
  assert.ok(body.counts.leads >= 1);

  const list2 = await app.inject({ method: 'GET', url: '/accounts' });
  assert.doesNotMatch(list2.body, /workerDel/);

  const gone = await app.inject({ method: 'DELETE', url: `/api/accounts/${id}` });
  assert.equal(gone.statusCode, 404);

  await app.close();
});

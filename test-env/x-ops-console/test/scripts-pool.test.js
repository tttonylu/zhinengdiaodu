const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildApp } = require('../src/app');
const { runMigrations } = require('../src/db/migrate');
const { createDb } = require('../src/db/client');
const { createScriptsRepo } = require('../src/repositories/scripts-repo');

function createApp() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-ops-scripts-pool-'));
  const dbPath = path.join(tempDir, 'ops.sqlite');
  const rulesPath = path.join(tempDir, 'rules.json');
  runMigrations(dbPath);
  return buildApp({ dbPath, rulesPath, dataDir: tempDir });
}

test('migration adds pool column to script_sets with dating default', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-ops-mig-'));
  const dbPath = path.join(tempDir, 'ops.sqlite');
  runMigrations(dbPath);
  const db = createDb(dbPath);

  const cols = db.prepare('PRAGMA table_info(script_sets)').all().map((c) => c.name);
  assert.ok(cols.includes('pool'));

  db.prepare(
    "INSERT INTO script_sets (set_id, name, description, enabled, sort_order, created_at, updated_at) VALUES ('legacy1', 'Legacy', '', 1, 0, datetime('now'), datetime('now'))"
  ).run();
  const row = db.prepare("SELECT pool FROM script_sets WHERE set_id = 'legacy1'").get();
  assert.equal(row.pool, 'dating');

  db.close();
});

test('repo listSets isolates dating and job pools', async () => {
  const app = createApp();
  await app.ready();
  const repo = createScriptsRepo(app.db);

  const datingSets = repo.listSets('dating');
  const jobSets = repo.listSets('job');
  assert.ok(datingSets.length >= 3);
  assert.ok(datingSets.every((s) => s.pool === 'dating'));
  assert.ok(jobSets.length >= 1);
  assert.ok(jobSets.every((s) => s.pool === 'job'));

  repo.upsertSet('job_custom', { name: 'Job Custom', pool: 'job' });
  assert.ok(repo.listSets('job').some((s) => s.set_id === 'job_custom'));
  assert.ok(!repo.listSets('dating').some((s) => s.set_id === 'job_custom'));

  await app.close();
});

test('repo bumpPoolVersion increments per pool and payload version changes after edit', async () => {
  const app = createApp();
  await app.ready();
  const repo = createScriptsRepo(app.db);

  const v0 = repo.getPoolVersion('job');
  const payload0 = repo.getPoolPayload('job');
  assert.equal(payload0.version, String(v0));

  repo.upsertSet('job_vtest', { name: 'VT', pool: 'job', enabled: true });
  const v1 = repo.getPoolVersion('job');
  assert.ok(v1 > v0);

  const payload1 = repo.getPoolPayload('job');
  assert.equal(payload1.version, String(v1));
  assert.notEqual(payload1.version, payload0.version);
  assert.ok(payload1.scripts.job_vtest);

  // dating 池版本不受 job 编辑影响之外的初始校验：再次 bump dating 只动 dating
  const dv0 = repo.getPoolVersion('dating');
  repo.setEnabled('v1', false);
  repo.setEnabled('v1', true);
  assert.ok(repo.getPoolVersion('dating') > dv0);

  await app.close();
});

test('GET /api/scripts/pool?pool=job returns only job pool; no pool param returns dating', async () => {
  const app = createApp();
  await app.ready();

  const jobRes = await app.inject({ method: 'GET', url: '/api/scripts/pool?pool=job' });
  assert.equal(jobRes.statusCode, 200);
  const jobPayload = jobRes.json();
  assert.ok(jobPayload.random_pool.length >= 1);
  assert.ok(jobPayload.random_pool.every((id) => id.startsWith('job_')));
  assert.ok(jobPayload.scripts[jobPayload.random_pool[0]]);
  const firstJob = jobPayload.scripts[jobPayload.random_pool[0]];
  assert.ok('final_kick_message' in firstJob);

  const defaultRes = await app.inject({ method: 'GET', url: '/api/scripts/pool' });
  const defaultPayload = defaultRes.json();
  assert.ok(defaultPayload.random_pool.length >= 3);
  assert.ok(defaultPayload.random_pool.every((id) => !id.startsWith('job_')));
  assert.ok(defaultPayload.scripts.v1);

  await app.close();
});

test('POST /api/scripts with pool=job appears in job payload only', async () => {
  const app = createApp();
  await app.ready();

  const createRes = await app.inject({
    method: 'POST',
    url: '/api/scripts',
    payload: {
      set_id: 'job_extra1',
      name: '兼职扩展',
      description: 'test',
      pool: 'job',
      templates: {
        icebreaker: 'hi',
        final_kick_message: 'last one',
      },
    },
  });
  assert.equal(createRes.json().ok, true);

  const jobPayload = (await app.inject({ method: 'GET', url: '/api/scripts/pool?pool=job' })).json();
  assert.ok(jobPayload.scripts.job_extra1);
  assert.equal(jobPayload.scripts.job_extra1.final_kick_message, 'last one');
  assert.ok(jobPayload.random_pool.includes('job_extra1'));

  const datingPayload = (await app.inject({ method: 'GET', url: '/api/scripts/pool?pool=dating' })).json();
  assert.ok(!datingPayload.scripts.job_extra1);

  const listRes = (await app.inject({ method: 'GET', url: '/api/scripts?pool=job' })).json();
  assert.ok(listRes.sets.some((s) => s.set_id === 'job_extra1'));

  await app.close();
});

test('GET /scripts defaults to job pool tab and renders job sets', async () => {
  const app = createApp();
  await app.ready();

  const res = await app.inject({ method: 'GET', url: '/scripts' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /兼职话术/);
  assert.match(res.body, /约会话术/);
  assert.match(res.body, /job_v1/);
  assert.match(res.body, /版本 v\d+/);

  const datingRes = await app.inject({ method: 'GET', url: '/scripts?pool=dating' });
  assert.equal(datingRes.statusCode, 200);
  assert.match(datingRes.body, /约会话术/);
  assert.match(datingRes.body, />v1</);

  await app.close();
});

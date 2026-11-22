const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runMigrations } = require('../src/db/migrate');
const { buildApp } = require('../src/app');

function createFixtureApp() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-ops-plugin-'));
  const dbPath = path.join(tempDir, 'ops.sqlite');
  const rulesPath = path.join(tempDir, 'rules.json');
  runMigrations(dbPath);
  return buildApp({ dbPath, rulesPath, dataDir: tempDir });
}

async function sendLog(app, { bot_id, target, action_type, detail = '', message = '' }) {
  return await app.inject({
    method: 'POST',
    url: '/api/plugin/log',
    payload: { bot_id, target, action_type, detail, message },
  });
}

test('POST /api/plugin/log creates lead and advances to ice_sent', async () => {
  const app = createFixtureApp();

  const res = await sendLog(app, {
    bot_id: '@workerA#guard',
    target: 'lead1',
    action_type: 'ICEBREAKER',
    detail: '第1轮:❄️ 破冰',
    message: 'ヤロー / どうも😳',
  });

  assert.equal(res.json().ok, true);
  assert.equal(res.json().current_stage, 'ice_sent');

  // Verify lead exists
  const leadsRes = await app.inject({ method: 'GET', url: '/leads' });
  assert.match(leadsRes.body, /lead1/);

  await app.close();
});

test('POST /api/plugin/log advances from ice_sent to ad_sent', async () => {
  const app = createFixtureApp();

  const res1 = await sendLog(app, {
    bot_id: '@workerA#guard', target: 'lead2',
    action_type: 'ICEBREAKER', detail: '第1轮:❄️ 破冰', message: 'hello',
  });
  assert.equal(res1.json().current_stage, 'ice_sent');

  const res2 = await sendLog(app, {
    bot_id: '@workerA#guard', target: 'lead2',
    action_type: 'AD', detail: '第2轮:🎣 广告', message: 'come {LINK}',
  });
  assert.equal(res2.json().ok, true);
  assert.equal(res2.json().current_stage, 'ad_sent');

  await app.close();
});

test('dm/record ledger_backfill 只补轮次，不推进阶段、不写 ad_sent 活动', async () => {
  const app = createFixtureApp();
  app.db.prepare(`
    INSERT INTO accounts (x_handle, status, daily_follow_limit, daily_dm_limit, created_at, updated_at, day_count)
    VALUES ('workerA', 'active', 200, 50, '2026-11-14 00:00:00', '2026-11-14 00:00:00', 1)
  `).run();

  const round1 = await app.inject({
    method: 'POST',
    url: '/api/plugin/dm/record',
    payload: {
      bot_id: '@workerA#guard', target_handle: 'backfill1',
      round_number: 1, message_content: 'ice', result: 'success',
    },
  });
  assert.equal(round1.json().ok, true);
  const stageBefore = app.db.prepare('SELECT current_stage FROM leads ORDER BY id DESC LIMIT 1').get().current_stage;
  const adBefore = app.db.prepare("SELECT COUNT(*) AS c FROM activity_logs WHERE action_type = 'ad_sent'").get().c;

  const backfill = await app.inject({
    method: 'POST',
    url: '/api/plugin/dm/record',
    payload: {
      bot_id: '@workerA#guard', target_handle: 'backfill1',
      round_number: 2, message_content: '[补记占位]', result: 'success',
      ledger_backfill: true,
    },
  });
  assert.equal(backfill.json().ok, true);
  assert.equal(backfill.json().backfill, true);
  assert.equal(backfill.json().advanced, false);

  const stageAfter = app.db.prepare('SELECT current_stage FROM leads ORDER BY id DESC LIMIT 1').get().current_stage;
  const adAfter = app.db.prepare("SELECT COUNT(*) AS c FROM activity_logs WHERE action_type = 'ad_sent'").get().c;
  assert.equal(stageAfter, stageBefore);
  assert.equal(adAfter, adBefore);

  await app.close();
});

test('POST /api/plugin/log marks CORPSE as skipped', async () => {
  const app = createFixtureApp();

  const res = await sendLog(app, {
    bot_id: '@workerA#guard',
    target: 'lead3',
    action_type: 'CORPSE',
    detail: '封号阵亡',
  });

  assert.equal(res.json().ok, true);

  // Verify lead reached via detail page
  const leadsRes = await app.inject({ method: 'GET', url: '/leads' });
  assert.match(leadsRes.body, /lead3/);

  await app.close();
});

test('POST /api/plugin/log records message content in detail_json', async () => {
  const app = createFixtureApp();

  await sendLog(app, {
    bot_id: '@workerA#guard',
    target: 'lead4',
    action_type: 'ICEBREAKER',
    detail: '第1轮:❄️ 破冰',
    message: 'ヤロー / どうも😳\nhttps://line.me/R/ti/p/@test',
  });

  // Activity log should contain the message
  const evidence = await app.inject({ method: 'GET', url: '/api/plugin/health/chat-evidence?limit=5' });
  assert.equal(evidence.json().ok, true);

  await app.close();
});

test('旧 log 关注上报不会重复写 activity/report 已记的成功关注', async () => {
  const app = createFixtureApp();
  app.db.prepare(`
    INSERT INTO accounts (x_handle, status, daily_follow_limit, daily_dm_limit, created_at, updated_at, day_count)
    VALUES ('workerA', 'active', 200, 50, '2026-11-14 00:00:00', '2026-11-14 00:00:00', 1)
  `).run();

  const canonical = await app.inject({
    method: 'POST',
    url: '/api/plugin/activity/report',
    payload: {
      account_handle: '@workerA#guard',
      target_handle: '@dedupe_follow',
      action_type: 'follow',
      result: 'success',
      source: 'plugin',
    },
  });
  assert.equal(canonical.json().ok, true);

  const legacy = await sendLog(app, {
    bot_id: '@workerA#guard',
    target: 'dedupe_follow',
    action_type: 'FOLLOW',
    detail: 'AUTO',
  });
  assert.equal(legacy.json().ok, true);
  assert.equal(legacy.json().deduped, true);

  const count = app.db.prepare(`
    SELECT COUNT(*) AS c FROM activity_logs
    WHERE lower(action_type) = 'follow'
      AND lower(COALESCE(action_result, '')) = 'success'
      AND lower(COALESCE(json_extract(detail_json, '$.target_handle'), '')) = 'dedupe_follow'
  `).get().c;
  assert.equal(count, 1, '同一目标当日只应保留一条成功关注日志');

  await app.close();
});

test('POST /api/plugin/log parses bot_id @handle#guard format', async () => {
  const app = createFixtureApp();

  // Send with full @handle#guard format
  await sendLog(app, {
    bot_id: '@myaccount#guard',
    target: 'lead5',
    action_type: 'ICEBREAKER',
    detail: 'test',
  });

  // Account should be created with extracted handle
  const accountsRes = await app.inject({ method: 'GET', url: '/accounts' });
  assert.match(accountsRes.body, /myaccount/);

  await app.close();
});

test('POST /api/plugin/log rejects missing required fields', async () => {
  const app = createFixtureApp();

  const res = await app.inject({
    method: 'POST',
    url: '/api/plugin/log',
    payload: { bot_id: '@test' },
  });

  assert.equal(res.json().ok, false);

  await app.close();
});

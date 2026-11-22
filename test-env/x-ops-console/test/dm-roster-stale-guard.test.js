const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runMigrations } = require('../src/db/migrate');
const { buildApp } = require('../src/app');

function createFixtureApp() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-ops-roster-stale-'));
  const dbPath = path.join(tempDir, 'ops.sqlite');
  const rulesPath = path.join(tempDir, 'rules.json');
  runMigrations(dbPath);
  return { app: buildApp({ dbPath, rulesPath, dataDir: tempDir }), dbPath };
}

function rosterItem(handle, extra) {
  return Object.assign({
    handle,
    display_name: handle,
    round: 0,
    queue_status: 'pending',
    queue_kind: 'ice',
    queue_reason: 'inventory',
  }, extra || {});
}

async function postRoster(app, payload) {
  return await app.inject({
    method: 'POST',
    url: '/api/plugin/dm/roster',
    payload,
  });
}

async function fetchRoster(app, bot) {
  const res = await app.inject({ method: 'GET', url: `/api/plugin/dm/roster/${bot}` });
  return res.json();
}

test('浅扫（主页 59 粉只滚出 50 格）不得把没滚到的人标成 stale', async () => {
  const { app } = createFixtureApp();
  const bot = 'jakelu133969';

  // 先建立 5 条老 pending（模拟历史台账）
  const first = await postRoster(app, {
    botHandle: bot,
    bot_id: bot,
    profileFollowers: 5,
    cellsSeen: 5,
    itemCount: 5,
    finalize_stale: true,
    allHandles: ['a1', 'a2', 'a3', 'a4', 'a5'],
    items: ['a1', 'a2', 'a3', 'a4', 'a5'].map((h) => rosterItem(h)),
  });
  assert.equal(first.json().ok, true);

  // 再上传一次浅扫：主页 59 粉，只滚出 50 格，且本次只带 2 条新人
  const shallow = await postRoster(app, {
    botHandle: bot,
    bot_id: bot,
    profileFollowers: 59,
    cellsSeen: 50,
    itemCount: 2,
    finalize_stale: true,
    truncated: true,
    allHandles: ['a1', 'a2', 'new1', 'new2'],
    items: ['new1', 'new2'].map((h) => rosterItem(h)),
  });
  const body = shallow.json();
  assert.equal(body.ok, true);
  assert.equal(body.marked_stale, 0);
  assert.equal(body.stale_skipped, 'truncated');

  // 老 pending 必须原样保留，不能被改成 stale_not_in_seal
  const roster = await fetchRoster(app, bot);
  const items = Array.isArray(roster.items) ? roster.items : [];
  for (const h of ['a1', 'a2', 'a3', 'a4', 'a5']) {
    const row = items.find((it) => String(it.handle).toLowerCase() === h);
    assert.ok(row, `老 pending ${h} 不能消失`);
    assert.equal(String(row.queue_reason || '').startsWith('stale_not_in_seal'), false,
      `浅扫时 ${h} 不能被标 stale_not_in_seal`);
    assert.equal(Number(row.stale) || 0, 0, `浅扫时 ${h} 的 stale 标记必须为 0`);
  }
});

test('真正全量扫完才允许标 stale', async () => {
  const { app } = createFixtureApp();
  const bot = 'botfull';

  await postRoster(app, {
    botHandle: bot,
    bot_id: bot,
    profileFollowers: 3,
    cellsSeen: 3,
    itemCount: 3,
    finalize_stale: true,
    allHandles: ['b1', 'b2', 'b3'],
    items: ['b1', 'b2', 'b3'].map((h) => rosterItem(h)),
  });

  // 全量：主页 3 粉，滚出 3 格，本次只剩 b1 → b2/b3 确实不在名单
  const full = await postRoster(app, {
    botHandle: bot,
    bot_id: bot,
    profileFollowers: 3,
    cellsSeen: 3,
    itemCount: 1,
    finalize_stale: true,
    truncated: false,
    allHandles: ['b1'],
    items: [rosterItem('b1')],
  });
  const body = full.json();
  assert.equal(body.ok, true);
  assert.ok(body.marked_stale >= 2, `全量扫完应标 stale，实际 ${body.marked_stale}`);
});

test('主页粉丝数读不到（cellsSeen=0）时也不得标 stale', async () => {
  const { app } = createFixtureApp();
  const bot = 'botzero';

  await postRoster(app, {
    botHandle: bot,
    bot_id: bot,
    profileFollowers: 4,
    cellsSeen: 4,
    itemCount: 4,
    finalize_stale: true,
    allHandles: ['c1', 'c2', 'c3', 'c4'],
    items: ['c1', 'c2', 'c3', 'c4'].map((h) => rosterItem(h)),
  });

  const empty = await postRoster(app, {
    botHandle: bot,
    bot_id: bot,
    profileFollowers: 4,
    cellsSeen: 0,
    itemCount: 1,
    finalize_stale: true,
    allHandles: ['c1'],
    items: [rosterItem('c1')],
  });
  assert.equal(empty.json().ok, true);
  assert.equal(empty.json().marked_stale, 0);
});

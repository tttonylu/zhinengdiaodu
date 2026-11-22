const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runMigrations } = require('../src/db/migrate');
const { buildApp } = require('../src/app');

function createFixtureApp() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-ops-roster-left-'));
  const dbPath = path.join(tempDir, 'ops.sqlite');
  const rulesPath = path.join(tempDir, 'rules.json');
  runMigrations(dbPath);
  return { app: buildApp({ dbPath, rulesPath, dataDir: tempDir }), dbPath };
}

function rosterItem(handle, extra) {
  return Object.assign({
    handle,
    display_name: handle,
    round: 1,
    queue_status: 'deferred',
    queue_kind: 'ad',
    queue_reason: 'need_ad',
  }, extra || {});
}

async function postRoster(app, payload) {
  return await app.inject({
    method: 'POST',
    url: '/api/plugin/dm/roster',
    payload,
  });
}

async function fetchRoster(app, bot, query) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/plugin/dm/roster/${bot}${query || ''}`,
  });
  return res.json();
}

test('全量封口按真实粉丝列表标取关：没再出现的行保留历史但退出台账', async () => {
  const { app } = createFixtureApp();
  const bot = 'botleft';

  await postRoster(app, {
    botHandle: bot,
    bot_id: bot,
    profileFollowers: 4,
    cellsSeen: 4,
    itemCount: 4,
    finalize_stale: true,
    allHandles: ['l1', 'l2', 'l3', 'l4'],
    items: ['l1', 'l2', 'l3', 'l4'].map((h) => rosterItem(h)),
  });

  // 全量：主页 4 粉，滚出 4 格，l2 已取关
  const full = await postRoster(app, {
    botHandle: bot,
    bot_id: bot,
    profileFollowers: 4,
    cellsSeen: 4,
    itemCount: 3,
    finalize_stale: true,
    truncated: false,
    allHandles: ['l1', 'l3', 'l4'],
    items: ['l1', 'l3', 'l4'].map((h) => rosterItem(h)),
  });
  const body = full.json();
  assert.equal(body.ok, true);
  assert.ok(body.marked_left >= 1, `应标记取关，实际 ${body.marked_left}`);

  const live = await fetchRoster(app, bot);
  const liveHandles = live.items.map((it) => String(it.handle).toLowerCase());
  assert.equal(liveHandles.includes('l2'), false, '取关的人不能再回灌给插件');
  assert.equal(live.left_count, 1);

  const all = await fetchRoster(app, bot, '?include_left=1');
  const leftRow = all.items.find((it) => String(it.handle).toLowerCase() === 'l2');
  assert.ok(leftRow, '审计视图必须还能看到历史');
  assert.equal(Number(leftRow.left_followers), 1);
  assert.equal(leftRow.queue_status, 'deferred', '历史状态不能被对账抹掉');
});

test('浅扫（cells 明显少于主页 F）不得标取关', async () => {
  const { app } = createFixtureApp();
  const bot = 'botshallowleft';

  await postRoster(app, {
    botHandle: bot,
    bot_id: bot,
    profileFollowers: 40,
    cellsSeen: 40,
    itemCount: 3,
    finalize_stale: true,
    allHandles: ['s1', 's2', 's3'],
    items: ['s1', 's2', 's3'].map((h) => rosterItem(h)),
  });

  const shallow = await postRoster(app, {
    botHandle: bot,
    bot_id: bot,
    profileFollowers: 40,
    cellsSeen: 12,
    itemCount: 1,
    finalize_stale: true,
    truncated: true,
    allHandles: ['s1'],
    items: [rosterItem('s1')],
  });
  const body = shallow.json();
  assert.equal(body.marked_left, 0);

  const live = await fetchRoster(app, bot);
  assert.equal(live.items.length, 3, '浅扫不能把没滚到的人当取关');
});

test('回关后重新上传会撤销取关标记', async () => {
  const { app } = createFixtureApp();
  const bot = 'botrefollow';

  await postRoster(app, {
    botHandle: bot,
    bot_id: bot,
    profileFollowers: 2,
    cellsSeen: 2,
    itemCount: 2,
    finalize_stale: true,
    allHandles: ['r1', 'r2'],
    items: ['r1', 'r2'].map((h) => rosterItem(h)),
  });
  await postRoster(app, {
    botHandle: bot,
    bot_id: bot,
    profileFollowers: 2,
    cellsSeen: 2,
    itemCount: 1,
    finalize_stale: true,
    allHandles: ['r1'],
    items: [rosterItem('r1')],
  });
  let roster = await fetchRoster(app, bot);
  assert.equal(roster.items.length, 1);

  // 回关：又出现在全量粉丝列表里
  await postRoster(app, {
    botHandle: bot,
    bot_id: bot,
    profileFollowers: 2,
    cellsSeen: 2,
    itemCount: 2,
    finalize_stale: true,
    allHandles: ['r1', 'r2'],
    items: ['r1', 'r2'].map((h) => rosterItem(h)),
  });
  roster = await fetchRoster(app, bot);
  assert.equal(roster.items.length, 2, '回关后要重新出现在台账里');
  const backRow = roster.items.find((it) => String(it.handle).toLowerCase() === 'r2');
  assert.equal(Number(backRow.left_followers) || 0, 0, '回关要清掉取关标记');
});

test('台账页默认只显示真实粉丝，?show=left 才展示已取关历史', async () => {
  const { app } = createFixtureApp();
  const bot = 'botpage';

  await postRoster(app, {
    botHandle: bot,
    bot_id: bot,
    profileFollowers: 2,
    cellsSeen: 2,
    itemCount: 2,
    finalize_stale: true,
    allHandles: ['p1', 'p2'],
    items: ['p1', 'p2'].map((h) => rosterItem(h)),
  });
  await postRoster(app, {
    botHandle: bot,
    bot_id: bot,
    profileFollowers: 2,
    cellsSeen: 2,
    itemCount: 1,
    finalize_stale: true,
    allHandles: ['p1'],
    items: [rosterItem('p1')],
  });

  const live = await app.inject({ method: 'GET', url: `/dm-roster/${bot}` });
  assert.equal(live.statusCode, 200);
  assert.match(live.body, /真实粉丝台账/);
  assert.match(live.body, /已取关历史/);
  assert.match(live.body, /@p1/);
  assert.doesNotMatch(live.body, /@p2/, '默认视图不能出现已取关的人');

  const audit = await app.inject({ method: 'GET', url: `/dm-roster/${bot}?show=left` });
  assert.equal(audit.statusCode, 200);
  assert.match(audit.body, /@p2/, '审计视图要能看到已取关历史');

  await app.close();
});

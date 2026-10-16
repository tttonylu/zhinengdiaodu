'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { runMigrations } = require('../src/db/migrate');
const { createContentPoolRepo } = require('../src/repositories/content-pool-repo');

// createDb 不跑迁移（迁移由 src/db/migrate.js runMigrations 扫描 migrations 目录执行），
// 与现有测试一致：临时文件库跑全量迁移后重开
function createTestDb() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-ops-console-content-pool-'));
  const dbPath = path.join(tempDir, 'test.sqlite');
  runMigrations(dbPath);
  return new Database(dbPath);
}

function jstNow() {
  const d = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' });
  const t = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Tokyo', hour12: false }).slice(0, 5);
  return d + 'T' + t;
}

test('repo: pending→approve→claim→posted 全流程', () => {
  const db = createTestDb();
  const repo = createContentPoolRepo(db);
  const id = repo.insert({ accountHandle: 'mai_test', persona: 'mai', text: 'テスト投稿 #メルレ', mediaUrls: [], scheduledJstAt: '2026-10-15T12:10', source: 'ai_daily' });
  assert.ok(id > 0);

  let due = repo.claimDue('mai_test', '2026-10-15T12:00');
  assert.equal(due, null, 'pending 不可 claim');

  repo.setStatus([id], 'approved');
  assert.equal(repo.claimDue('mai_test', '2026-10-15T12:00'), null, '未到点不可 claim');

  const got = repo.claimDue('mai_test', '2026-10-15T12:10');
  assert.ok(got && got.id === id);
  assert.equal(got.status, 'claimed');
  assert.equal(repo.claimDue('mai_test', '2026-10-15T13:00'), null, 'claimed 不重复领');

  repo.report(id, 'posted', { externalPostId: '123' });
  const row = db.prepare('SELECT status, external_post_id, posted_at FROM content_pool_items WHERE id=?').get(id);
  assert.equal(row.status, 'posted');
  assert.equal(row.external_post_id, '123');
  assert.ok(row.posted_at);
  db.close();
});

test('repo: retry 回 approved 可重新 claim；failed 不重发', () => {
  const db = createTestDb();
  const repo = createContentPoolRepo(db);
  const id = repo.insert({ accountHandle: 'akari_test', persona: 'akari', text: 'x', mediaUrls: ['/content-media/a.jpg'], scheduledJstAt: '2026-10-15T21:20' });
  repo.setStatus([id], 'approved');
  assert.ok(repo.claimDue('akari_test', '2026-10-15T22:00'));
  repo.report(id, 'retry', { failReason: 'media_download_fail' });
  assert.equal(db.prepare('SELECT status FROM content_pool_items WHERE id=?').get(id).status, 'approved');
  assert.ok(repo.claimDue('akari_test', '2026-10-15T22:05'));

  repo.report(id, 'failed', { failReason: 'mention_blocked' });
  assert.equal(repo.claimDue('akari_test', '2026-10-15T22:10'), null);
  db.close();
});

test('repo: listForReview 按状态/日期/hook 过滤 + 批量 setStatus + edit + stats', () => {
  const db = createTestDb();
  const repo = createContentPoolRepo(db);
  repo.insert({ accountHandle: 'mai_test', persona: 'mai', text: 'a', mediaUrls: [], scheduledJstAt: '2026-10-15T12:00' });
  const bid = repo.insert({ accountHandle: 'mai_test', persona: 'mai', text: 'b', mediaUrls: [], scheduledJstAt: '2026-10-16T12:00' });
  assert.equal(repo.listForReview({}).length, 2);
  assert.equal(repo.listForReview({ status: 'pending' }).length, 2);
  assert.equal(repo.listForReview({ date: '2026-10-15' }).length, 1);
  repo.setStatus([bid], 'rejected');
  assert.equal(repo.listForReview({ accountHandle: 'mai_test' }).length, 2);
  repo.edit(bid, { text: 'b2', scheduledJstAt: '2026-10-16T18:00' });
  const r = db.prepare('SELECT text, scheduled_jst_at FROM content_pool_items WHERE id=?').get(bid);
  assert.equal(r.text, 'b2');
  assert.equal(r.scheduled_jst_at, '2026-10-16T18:00');
  db.close();
});

const { saveContentMedia, MEDIA_CONTENT_TYPES } = require('../src/services/content-media');

test('media: dataURL 落盘返回 /content-media 路径并可读回；非法类型拒绝', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpm-'));
  // 8x8 噪声 PNG（127B）：saveContentMedia 要求 ≥100B，计划的 1x1 PNG 解码仅 70B 会被拒
  const png8x8 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAARklEQVR4nFVOwREAIAhijxaxH2P1bLRG66wo4qGIyImCDfZxCF6nxmo7AoFwI1WatNzLQDRL7H4lIb4naPajrZ4k7uHFSpjpoREdmujDPgAAAABJRU5ErkJggg==';
  const rel = saveContentMedia(png8x8, dir);
  assert.match(rel, /^\/content-media\/[a-f0-9-]{36}\.png$/);
  const full = path.join(dir, path.basename(rel));
  assert.ok(fs.existsSync(full));
  assert.ok(MEDIA_CONTENT_TYPES['.png']);
  assert.throws(() => saveContentMedia('data:image/gif;base64,R0lGODlhAQABAAAAACw=', dir), /unsupported media type/);
  assert.throws(() => saveContentMedia('not a dataurl', dir), /bad dataUrl/);
});

// ---------- Task 4：API 路由 + app 注册 + 最小页面（HTTP 链路） ----------
const { buildApp } = require('../src/app');
const { jstNowWall } = require('../src/routes/api/content-pool');

// buildApp 内 createDb 不跑迁移，先用 runMigrations 建表（与上方 createTestDb 同模式）
async function mkApp() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-ops-console-content-pool-api-'));
  const dbPath = path.join(tempDir, 'test.sqlite');
  runMigrations(dbPath);
  const app = buildApp({
    dbPath,
    contentMediaDir: path.join(tempDir, 'media'),
  });
  await app.ready();
  return { app, tempDir };
}

// H11：内容池绑定台账发帖号——测试里给 accounts 表插一行发帖号（tags 为 JSON 字符串）
function insertPoster(db, handle, tags = '["post_only"]', status = 'active') {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO accounts (x_handle, status, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(handle, status, tags, now, now);
}

// 8x8 噪声 PNG（127B）：saveContentMedia 要求 ≥100B，计划的 1x1 PNG 解码仅 70B 会被拒
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAARklEQVR4nFVOwREAIAhijxaxH2P1bLRG66wo4qGIyImCDfZxCF6nxmo7AoFwI1WatNzLQDRL7H4lIb4naPajrZ4k7uHFSpjpoREdmujDPgAAAABJRU5ErkJggg==';

test('api: ingest(pending)→批量approve→claim(未到期空)→到期领到→取图200→posted', async () => {
  const { app } = await mkApp();
  insertPoster(app.db, 'Mai_Demo');
  const ing = await app.inject({
    method: 'POST', url: '/api/content/ingest',
    headers: { 'Content-Type': 'application/json' },
    payload: {
      // 只给 account_handle（persona 线路入库走 lines: ingest 专项测试）
      account_handle: 'Mai_Demo', source: 'ai_daily',
      text: '今日はコンビニ夜勤前にちょこっと😊 #メルレ',
      media: [{ data_url: PNG }],
      scheduled_jst_at: '2026-10-15T12:10',
    },
  });
  assert.equal(ing.statusCode, 200);
  const id = ing.json().id;
  assert.ok(id > 0);

  // claim 未批准 → 空
  const empty = await app.inject({ method: 'GET', url: '/api/plugin/content-pool/claim?bot_id=Mai_Demo&now=2026-10-15T12:00' });
  assert.equal(empty.json().item, null);

  const appr = await app.inject({
    method: 'POST', url: '/api/content/approve',
    headers: { 'Content-Type': 'application/json' }, payload: { ids: [id] },
  });
  assert.equal(appr.json().changed, 1);

  const early = await app.inject({ method: 'GET', url: '/api/plugin/content-pool/claim?bot_id=Mai_Demo&now=2026-10-15T12:09' });
  assert.equal(early.json().item, null);

  const got = await app.inject({ method: 'GET', url: '/api/plugin/content-pool/claim?bot_id=mai_demo&now=2026-10-15T12:10' });
  const item = got.json().item;
  assert.ok(item && item.id === id);
  assert.equal(item.media_urls.length, 1);
  assert.match(item.media_urls[0], /^\/content-media\//);

  const img = await app.inject({ method: 'GET', url: item.media_urls[0] });
  assert.equal(img.statusCode, 200);
  assert.equal(img.headers['content-type'], 'image/png');
  assert.ok(img.rawPayload.length > 100);

  const rep = await app.inject({
    method: 'POST', url: '/api/plugin/content-pool/report',
    headers: { 'Content-Type': 'application/json' },
    payload: { bot_id: 'mai_demo', id, result: 'posted', external_post_id: '999' },
  });
  assert.equal(rep.json().ok, true);

  const page = await app.inject({ method: 'GET', url: '/content?status=posted' });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /今日はコンビニ夜勤前にちょこっと/);
  await app.close();
});

test('api: ingest 非法时间/空文案/超大标签拒绝', async () => {
  const { app } = await mkApp();
  insertPoster(app.db, 'a');
  const ask = async (payload) => (await app.inject({
    method: 'POST', url: '/api/content/ingest',
    headers: { 'Content-Type': 'application/json' }, payload,
  })).statusCode;
  assert.equal(await ask({ account_handle: 'a', text: 'x', scheduled_jst_at: 'bad' }), 400);
  assert.equal(await ask({ account_handle: 'a', text: '', scheduled_jst_at: '2026-10-15T12:00' }), 400);
  assert.equal(await ask({ account_handle: 'a', text: 'x #a #b #c #d', scheduled_jst_at: '2026-10-15T12:00' }), 400, '标签>3 拒绝');
  assert.equal(await ask({ account_handle: '', text: 'x', scheduled_jst_at: '2026-10-15T12:00' }), 400);
  assert.equal(await ask({ account_handle: 'a', text: 'x', scheduled_jst_at: '2026-10-15T12:00' }), 200);
  await app.close();
});

test('api: reject/delete/edit 动作 + 人工 retry', async () => {
  const { app } = await mkApp();
  insertPoster(app.db, 'a');
  const ing = await app.inject({
    method: 'POST', url: '/api/content/ingest',
    headers: { 'Content-Type': 'application/json' },
    payload: { account_handle: 'a', text: 'old', scheduled_jst_at: '2026-10-15T12:00' },
  });
  const id = ing.json().id;
  const edit = await app.inject({
    method: 'POST', url: '/api/content/' + id + '/edit',
    headers: { 'Content-Type': 'application/json' },
    payload: { text: 'new #メルレ', scheduled_jst_at: '2026-10-15T18:00' },
  });
  assert.equal(edit.json().ok, true);
  const rej = await app.inject({
    method: 'POST', url: '/api/content/reject',
    headers: { 'Content-Type': 'application/json' }, payload: { ids: [id] },
  });
  assert.equal(rej.json().changed, 1);
  const del = await app.inject({
    method: 'POST', url: '/api/content/delete',
    headers: { 'Content-Type': 'application/json' }, payload: { ids: [id] },
  });
  assert.equal(del.json().changed, 1);
  await app.close();
});

test('api: claim 空池/缺 bot_id + report failed/retry 三态 + 取图404 + jstNowWall', async () => {
  assert.match(jstNowWall(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  const { app } = await mkApp();

  // 未注册 bot → 403 unbound_poster（H11 领单白名单）；缺 bot_id → ok:false
  const nobody = await app.inject({ method: 'GET', url: '/api/plugin/content-pool/claim?bot_id=nobody&now=2026-10-15T12:00' });
  assert.equal(nobody.statusCode, 403);
  assert.equal(nobody.json().ok, false);
  assert.equal(nobody.json().error, 'unbound_poster');
  // 已注册发帖号但无 approved 内容 → 空（H11 ④）
  insertPoster(app.db, 'idle_poster');
  const idle = await app.inject({ method: 'GET', url: '/api/plugin/content-pool/claim?bot_id=idle_poster&now=2026-10-15T12:00' });
  assert.equal(idle.statusCode, 200);
  assert.equal(idle.json().ok, true);
  assert.equal(idle.json().item, null);
  const noBot = await app.inject({ method: 'GET', url: '/api/plugin/content-pool/claim' });
  assert.equal(noBot.json().ok, false);

  insertPoster(app.db, 'Aoi_Demo');
  const ing = await app.inject({
    method: 'POST', url: '/api/content/ingest',
    headers: { 'Content-Type': 'application/json' },
    payload: { account_handle: 'Aoi_Demo', text: 'テスト投稿', scheduled_jst_at: '2026-10-15T09:00' },
  });
  const id = ing.json().id;
  await app.inject({
    method: 'POST', url: '/api/content/approve',
    headers: { 'Content-Type': 'application/json' }, payload: { ids: [id] },
  });

  // 到期领到 → report failed → 不重发
  const got = await app.inject({ method: 'GET', url: '/api/plugin/content-pool/claim?bot_id=aoi_demo&now=2026-10-15T09:05' });
  assert.ok(got.json().item && got.json().item.id === id);
  const failed = await app.inject({
    method: 'POST', url: '/api/plugin/content-pool/report',
    headers: { 'Content-Type': 'application/json' },
    payload: { bot_id: 'aoi_demo', id, result: 'failed', fail_reason: 'media_download_fail' },
  });
  assert.equal(failed.json().ok, true);
  const afterFail = await app.inject({ method: 'GET', url: '/api/plugin/content-pool/claim?bot_id=aoi_demo&now=2026-10-15T09:10' });
  assert.equal(afterFail.json().item, null, 'failed 不重发');

  // 人工 retry 拉回 approved → 可再领
  const retryAct = await app.inject({ method: 'POST', url: '/api/content/' + id + '/retry', headers: { 'Content-Type': 'application/json' }, payload: {} });
  assert.equal(retryAct.json().ok, true);
  const got2 = await app.inject({ method: 'GET', url: '/api/plugin/content-pool/claim?bot_id=aoi_demo&now=2026-10-15T09:15' });
  assert.ok(got2.json().item && got2.json().item.id === id);

  // 插件回报 retry（claimed→approved）→ 可再领
  const repRetry = await app.inject({
    method: 'POST', url: '/api/plugin/content-pool/report',
    headers: { 'Content-Type': 'application/json' },
    payload: { bot_id: 'aoi_demo', id, result: 'retry', fail_reason: 'x_block' },
  });
  assert.equal(repRetry.json().ok, true);
  const got3 = await app.inject({ method: 'GET', url: '/api/plugin/content-pool/claim?bot_id=aoi_demo&now=2026-10-15T09:20' });
  assert.ok(got3.json().item && got3.json().item.id === id);

  // report 非法 result → 400
  const badRep = await app.inject({
    method: 'POST', url: '/api/plugin/content-pool/report',
    headers: { 'Content-Type': 'application/json' },
    payload: { bot_id: 'aoi_demo', id, result: 'bogus' },
  });
  assert.equal(badRep.statusCode, 400);

  // 取图 404：不存在但格式合法 / 非法文件名 / 目录穿越
  assert.equal((await app.inject({ method: 'GET', url: '/content-media/00000000-0000-0000-0000-000000000000.png' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/content-media/not-a-valid-name.png' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/content-media/..%2F..%2Fapp.js' })).statusCode, 404);

  await app.close();
});

// ---------- Task 5：/content 审核页（表单动作 + redirect msg） ----------
test('page: GET /content 200 + 表单批量批准/拒绝/删除/重试/编辑后重定向回列表', async () => {
  const { app } = await mkApp();
  insertPoster(app.db, 'mai_x');
  const ing = await app.inject({
    method: 'POST', url: '/api/content/ingest',
    headers: { 'Content-Type': 'application/json' },
    payload: { account_handle: 'mai_x', text: 'page-test #メルレ', scheduled_jst_at: '2026-10-15T12:00' },
  });
  const id = ing.json().id;

  // 列表页 200 且渲染正文
  const page0 = await app.inject({ method: 'GET', url: '/content' });
  assert.equal(page0.statusCode, 200);
  assert.match(page0.body, /page-test/);

  const form = async (url, payload) => app.inject({
    method: 'POST', url,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(Object.entries(payload).map(([k, v]) => [k, String(v)])).toString(),
  });

  let r = await form('/content/approve', { ids: id, back: '/content?status=pending' });
  assert.equal(r.statusCode, 302);
  assert.equal(r.headers.location, '/content?status=pending&msg=' + encodeURIComponent('已批准 1 条'));
  assert.equal(app.db.prepare('SELECT status FROM content_pool_items WHERE id=?').get(id).status, 'approved');

  r = await form('/content/' + id + '/reject', { back: '/content' });
  assert.equal(r.statusCode, 302);
  r = await form('/content/' + id + '/retry', { back: '/content' });
  assert.equal(r.statusCode, 302);
  r = await form('/content/' + id + '/edit', { text: 'edited', scheduled_jst_at: '2026-10-15T19:00', back: '/content' });
  assert.equal(r.statusCode, 302);
  r = await form('/content/' + id + '/delete', { back: '/content' });
  assert.equal(r.statusCode, 302);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM content_pool_items WHERE id=?').get(id).n, 0);
  await app.close();
});

// ---------- H11：内容池绑定台账发帖号（ingest 校验 + claim 白名单 + 未绑定警示） ----------
const ING = (app, payload) => app.inject({
  method: 'POST', url: '/api/content/ingest',
  headers: { 'Content-Type': 'application/json' }, payload,
});

test('h11: ingest 未注册/无post_only标签/封禁 handle → 400 unbound_poster', async () => {
  const { app } = await mkApp();
  const res = await ING(app, { account_handle: 'test_nobody', text: 'x', scheduled_jst_at: '2026-10-15T12:00' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'unbound_poster');
  assert.match(res.json().message, /test_nobody/);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM content_pool_items').get().n, 0, '未入库');

  insertPoster(app.db, 'no_tag', '[]');
  const noTag = await ING(app, { account_handle: 'no_tag', text: 'x', scheduled_jst_at: '2026-10-15T12:00' });
  assert.equal(noTag.statusCode, 400);
  assert.equal(noTag.json().error, 'unbound_poster');

  insertPoster(app.db, 'frozen_one', '["post_only"]', 'frozen');
  const frozen = await ING(app, { account_handle: 'frozen_one', text: 'x', scheduled_jst_at: '2026-10-15T12:00' });
  assert.equal(frozen.statusCode, 400);
  assert.equal(frozen.json().error, 'unbound_poster');
  await app.close();
});

test('h11: ingest 注册 post_only 发帖号 → 200（大小写/@ 前缀不敏感）', async () => {
  const { app } = await mkApp();
  insertPoster(app.db, 'mai_ok', '["post_only"]');
  insertPoster(app.db, 'mute_one', '["mute_chat"]');
  const res = await ING(app, { account_handle: '@Mai_Ok', text: 'x #メルレ', scheduled_jst_at: '2026-10-15T12:00' });
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().id > 0);
  // 有台账但无 post_only 标签 → 仍拒（禁言号不能发帖）
  const mute = await ING(app, { account_handle: 'mute_one', text: 'x', scheduled_jst_at: '2026-10-15T12:00' });
  assert.equal(mute.statusCode, 400);
  await app.close();
});

test('h11: claim 未注册 bot_id → 403 unbound_poster；注册后可正常领单', async () => {
  const { app } = await mkApp();
  const no = await app.inject({ method: 'GET', url: '/api/plugin/content-pool/claim?bot_id=test_nobody&now=2026-10-15T12:00' });
  assert.equal(no.statusCode, 403);
  assert.equal(no.json().ok, false);
  assert.equal(no.json().error, 'unbound_poster');

  insertPoster(app.db, 'mai_ok');
  const id = (await ING(app, { account_handle: 'mai_ok', text: 'x', scheduled_jst_at: '2026-10-15T12:00' })).json().id;
  await app.inject({ method: 'POST', url: '/api/content/approve', headers: { 'Content-Type': 'application/json' }, payload: { ids: [id] } });
  const got = await app.inject({ method: 'GET', url: '/api/plugin/content-pool/claim?bot_id=mai_ok&now=2026-10-15T12:00' });
  assert.equal(got.statusCode, 200);
  assert.ok(got.json().item && got.json().item.id === id);
  await app.close();
});

test('h11: /content 页面未绑定 handle 卡片显示「未绑定发帖号」徽标，已绑定不显示', async () => {
  const { app } = await mkApp();
  insertPoster(app.db, 'mai_ok');
  const repo = createContentPoolRepo(app.db);
  repo.insert({ accountHandle: 'mai_ok', text: 'boundpost-a', mediaUrls: [], scheduledJstAt: '2026-10-15T12:00' });
  // 模拟已入库但账号未注册的历史数据（直接走 repo，绕过 API 校验）
  repo.insert({ accountHandle: 'legacy_mai', text: 'legacypost-b', mediaUrls: [], scheduledJstAt: '2026-10-15T13:00' });
  const page = await app.inject({ method: 'GET', url: '/content' });
  assert.equal(page.statusCode, 200);
  const badges = page.body.match(/未绑定发帖号/g) || [];
  assert.equal(badges.length, 1, '仅未绑定的 legacy_mai 卡片有警示徽标');
  const segOf = (text) => page.body.split('cp-card').find((seg) => seg.includes(text)) || '';
  assert.match(segOf('legacypost-b'), /未绑定发帖号/, '未绑定卡片有徽标');
  assert.doesNotMatch(segOf('boundpost-a'), /未绑定发帖号/, '已绑定卡片无徽标');
  await app.close();
});

test('h11: repo.isRegisteredPoster / registeredPosterSet 批量判定', async () => {
  const db = createTestDb();
  const repo = createContentPoolRepo(db);
  insertPoster(db, 'Mai_Ok', '["post_only"]');
  insertPoster(db, 'NoTag', '[]');
  insertPoster(db, 'FrozenOne', '["post_only"]', 'frozen');
  assert.equal(repo.isRegisteredPoster('mai_ok'), true);
  assert.equal(repo.isRegisteredPoster('@Mai_Ok'), true);
  assert.equal(repo.isRegisteredPoster('no_tag'), false);
  assert.equal(repo.isRegisteredPoster('frozenone'), false);
  assert.equal(repo.isRegisteredPoster('ghost'), false);
  assert.equal(repo.isRegisteredPoster(''), false);
  const set = repo.registeredPosterSet(['Mai_Ok', '@no_tag', 'frozenone', 'ghost', '', 'mai_ok']);
  assert.equal(set.size, 1);
  assert.ok(set.has('mai_ok'));
  db.close();
});

// ---------- H11 线路绑定台账发帖号（071 迁移 + lines API + persona 入库 + 页面面板） ----------
test('lines: 071 迁移种子 2 条线路，repo.listLines/getLine/setLineBinding', () => {
  const db = createTestDb();
  const rows = db.prepare('SELECT persona, account_handle, label FROM content_pool_lines ORDER BY rowid').all();
  assert.equal(rows.length, 2, '071 种子 2 条线路');
  assert.deepEqual(rows.map((r) => r.persona), ['mai', 'akari']);
  assert.ok(rows[0].label.includes('まい'));
  assert.ok(rows[1].label.includes('あかり'));

  insertPoster(db, 'Mai_Line');
  const repo = createContentPoolRepo(db);
  const lines = repo.listLines();
  const mai = lines.find((l) => l.persona === 'mai');
  const akari = lines.find((l) => l.persona === 'akari');
  assert.equal(mai.bound, false, '种子 handle 未注册 → bound=false');
  assert.equal(mai.account_exists, false);
  assert.equal(akari.bound, false);

  assert.equal(repo.setLineBinding('mai', 'ghost').error, 'unbound_poster', '未注册 handle 拒绝');
  const ok = repo.setLineBinding('mai', '@Mai_Line');
  assert.equal(ok.ok, true);
  assert.equal(ok.account_handle, 'mai_line');
  assert.equal(repo.getLine('mai').account_handle, 'mai_line');
  assert.equal(repo.listLines().find((l) => l.persona === 'mai').bound, true);
  assert.equal(repo.listLines().find((l) => l.persona === 'mai').account_exists, true);
  assert.equal(repo.setLineBinding('no_such_line', 'Mai_Line').error, 'line_not_found');
  db.close();
});

test('lines: 绑定变更级联改挂存量内容 handle（posted/rejected 不动）', () => {
  const db = createTestDb();
  insertPoster(db, 'Mai_Line');
  const repo = createContentPoolRepo(db);
  const ins = db.prepare(`INSERT INTO content_pool_items
    (account_handle, persona, text, scheduled_jst_at, status, source) VALUES (?, ?, ?, ?, ?, ?)`);
  ins.run('mai', 'mai', 't1', '2026-10-15T12:10', 'approved', 'ai_daily');
  ins.run('mai', 'mai', 't2', '2026-10-15T18:40', 'pending', 'ai_daily');
  ins.run('mai', 'mai', 't3', '2026-10-14T12:10', 'posted', 'ai_daily');
  ins.run('akari', 'akari', 't4', '2026-10-15T12:10', 'approved', 'ai_daily');

  const ok = repo.setLineBinding('mai', 'Mai_Line');
  assert.equal(ok.migrated, 2, '仅 mai 线路未发出的 2 条被级联');
  const rows = db.prepare('SELECT persona, status, account_handle FROM content_pool_items ORDER BY rowid').all();
  assert.equal(rows[0].account_handle, 'mai_line');
  assert.equal(rows[1].account_handle, 'mai_line');
  assert.equal(rows[2].account_handle, 'mai', 'posted 历史不动');
  assert.equal(rows[3].account_handle, 'akari', '其他线路不动');
  db.close();
});

test('lines: GET /api/content/lines 绑定状态；bind 未注册 400 / 注册后 200', async () => {
  const { app } = await mkApp();
  let lines = (await app.inject({ method: 'GET', url: '/api/content/lines' })).json();
  assert.equal(lines.length, 2);
  assert.equal(lines.find((l) => l.persona === 'mai').bound, false);

  const bad = await app.inject({
    method: 'POST', url: '/api/content/lines/bind',
    headers: { 'Content-Type': 'application/json' },
    payload: { persona: 'mai', account_handle: 'ghost_handle' },
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'unbound_poster');

  insertPoster(app.db, 'Mai_Line');
  const ok = await app.inject({
    method: 'POST', url: '/api/content/lines/bind',
    headers: { 'Content-Type': 'application/json' },
    payload: { persona: 'mai', account_handle: '@Mai_Line' },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().ok, true);
  assert.equal(ok.json().account_handle, 'mai_line');

  lines = (await app.inject({ method: 'GET', url: '/api/content/lines' })).json();
  const mai = lines.find((l) => l.persona === 'mai');
  assert.equal(mai.bound, true);
  assert.equal(mai.account_handle, 'mai_line');
  await app.close();
});

test('lines: ingest 只给 persona → 按线路绑定发帖号入库；未绑/不一致 400', async () => {
  const { app } = await mkApp();
  // 种子 handle 'mai' 未在台账注册 → 线路未生效
  const unbound = await ING(app, { persona: 'mai', text: 'x', scheduled_jst_at: '2026-10-15T12:00' });
  assert.equal(unbound.statusCode, 400);
  assert.equal(unbound.json().error, 'line_unbound');
  const unknown = await ING(app, { persona: 'yuki', text: 'x', scheduled_jst_at: '2026-10-15T12:00' });
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.json().error, 'line_unbound', '线路不存在');

  insertPoster(app.db, 'Akari_Line');
  const bind = await app.inject({
    method: 'POST', url: '/api/content/lines/bind',
    headers: { 'Content-Type': 'application/json' },
    payload: { persona: 'akari', account_handle: 'Akari_Line' },
  });
  assert.equal(bind.json().ok, true);

  // persona 与 account_handle 不一致 → 400
  const mis = await ING(app, { persona: 'akari', account_handle: 'other_one', text: 'x', scheduled_jst_at: '2026-10-15T12:00' });
  assert.equal(mis.statusCode, 400);
  assert.equal(mis.json().error, 'handle_mismatch');

  // 只给 persona → 入库 account_handle = 线路绑定值
  const ing = await ING(app, { persona: 'akari', text: 'line-ingest #メルレ', scheduled_jst_at: '2026-10-15T12:00', source: 'ai_daily' });
  assert.equal(ing.statusCode, 200);
  const row = app.db.prepare('SELECT account_handle, persona FROM content_pool_items WHERE id=?').get(ing.json().id);
  assert.equal(row.account_handle, 'akari_line');
  assert.equal(row.persona, 'akari');
  await app.close();
});

test('lines: /content 页面渲染线路绑定面板 + 线路 label 徽标 + 表单绑定 redirect', async () => {
  const { app } = await mkApp();
  insertPoster(app.db, 'Mai_Line');
  const repo = createContentPoolRepo(app.db);
  repo.insert({ accountHandle: 'mai_line', persona: 'mai', text: 'linepost-a', mediaUrls: [], scheduledJstAt: '2026-10-15T12:00' });

  const page = await app.inject({ method: 'GET', url: '/content' });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /线路绑定/);
  assert.match(page.body, /まい・21岁夜勤新手（软萌型）/);
  assert.match(page.body, /あかり・27岁OL前辈（复盘型）/);
  assert.match(page.body, /cp-line-badge/, '卡片带线路 label 徽标');

  // 线路筛选 tab（persona 维度）
  const filtered = await app.inject({ method: 'GET', url: '/content?line=mai' });
  assert.equal(filtered.statusCode, 200);
  assert.match(filtered.body, /linepost-a/);
  const filteredAkari = await app.inject({ method: 'GET', url: '/content?line=akari' });
  assert.doesNotMatch(filteredAkari.body, /linepost-a/, 'akari 线路 tab 不含 mai 卡片');

  // 面板表单绑定（urlencoded）→ 302 回 /content
  const bind = await app.inject({
    method: 'POST', url: '/api/content/lines/bind',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ persona: 'mai', account_handle: 'Mai_Line' }).toString(),
  });
  assert.equal(bind.statusCode, 302);
  assert.match(bind.headers.location, /^\/content\?msg=/);
  assert.equal(repo.getLine('mai').account_handle, 'mai_line');
  await app.close();
});

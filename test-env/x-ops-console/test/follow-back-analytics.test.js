const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createFollowBackAnalyticsRepo } = require('../src/repositories/follow-back-analytics-repo');

function memDb() {
  const p = path.join(os.tmpdir(), 'fb-analytics-' + Date.now() + '.sqlite');
  const db = new Database(p);
  db.exec(`
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY, x_handle TEXT, day_count INTEGER, status TEXT, last_seen_at TEXT, sort_order INTEGER
    );
    CREATE TABLE activity_logs (
      id INTEGER PRIMARY KEY, lead_id INTEGER, account_id INTEGER,
      action_type TEXT, action_result TEXT, source TEXT, detail_json TEXT, created_at TEXT
    );
  `);
  db.prepare(`INSERT INTO accounts (id, x_handle, day_count, status) VALUES (1, 'bot_a', 3, 'active')`).run();
  return { db, p };
}

test('accountRates uses logs and 72h attribution', () => {
  const { db, p } = memDb();
  const now = Date.now();
  const tFollow = new Date(now - 2 * 3600 * 1000);
  const tBack = new Date(now - 1 * 3600 * 1000);
  const fmt = (d) => {
    const x = new Date(d.getTime() + 8 * 3600 * 1000);
    return x.toISOString().slice(0, 19).replace('T', ' ');
  };

  db.prepare(`
    INSERT INTO activity_logs (lead_id, account_id, action_type, action_result, source, detail_json, created_at)
    VALUES (1, 1, 'follow', 'success', 'plugin', ?, ?)
  `).run(JSON.stringify({ target_handle: 'fan1' }), fmt(tFollow));

  db.prepare(`
    INSERT INTO activity_logs (lead_id, account_id, action_type, action_result, source, detail_json, created_at)
    VALUES (1, 1, 'follow_back', 'success', 'plugin', ?, ?)
  `).run(JSON.stringify({ target_handle: 'fan1', follow_back_accepted: true }), fmt(tBack));

  // 自然粉回关被拒绝，不计
  db.prepare(`
    INSERT INTO activity_logs (lead_id, account_id, action_type, action_result, source, detail_json, created_at)
    VALUES (2, 1, 'follow_back', 'success', 'plugin', ?, ?)
  `).run(JSON.stringify({ target_handle: 'stranger', follow_back_accepted: false }), fmt(tBack));

  const repo = createFollowBackAnalyticsRepo(db);
  const r = repo.accountRates({ days: 7 });
  assert.equal(r.accounts[0].follows, 1);
  assert.equal(r.accounts[0].follow_backs, 1);
  assert.equal(r.accounts[0].sample_ok, false); // < min sample
  db.close();
  try { fs.unlinkSync(p); } catch (e) {}
});

test('bloggerRates attributes follow_back to source blogger', () => {
  const { db, p } = memDb();
  db.exec(`
    CREATE TABLE dm_records (
      id INTEGER PRIMARY KEY, bot_handle TEXT, target_handle TEXT,
      round_number INTEGER, message_content TEXT, result TEXT, created_at TEXT
    );
  `);
  const now = Date.now();
  const tFollow = new Date(now - 3 * 3600 * 1000);
  const tBack = new Date(now - 2 * 3600 * 1000);
  const tIce = new Date(now - 1 * 3600 * 1000);
  const fmt = (d) => {
    const x = new Date(d.getTime() + 8 * 3600 * 1000);
    return x.toISOString().slice(0, 19).replace('T', ' ');
  };

  db.prepare(`
    INSERT INTO activity_logs (lead_id, account_id, action_type, action_result, source, detail_json, created_at)
    VALUES (1, 1, 'follow', 'success', 'plugin', ?, ?)
  `).run(JSON.stringify({
    target_handle: 'fan1',
    meta: { blogger_handle: 'good_blogger', sourceUrl: 'https://x.com/good_blogger/followers' },
  }), fmt(tFollow));

  db.prepare(`
    INSERT INTO activity_logs (lead_id, account_id, action_type, action_result, source, detail_json, created_at)
    VALUES (1, 1, 'follow_back', 'success', 'plugin', ?, ?)
  `).run(JSON.stringify({ target_handle: 'fan1', follow_back_accepted: true }), fmt(tBack));

  db.prepare(`
    INSERT INTO dm_records (bot_handle, target_handle, round_number, message_content, result, created_at)
    VALUES ('bot_a', 'fan1', 1, 'hi', 'success', ?)
  `).run(fmt(tIce));

  const repo = createFollowBackAnalyticsRepo(db);
  const r = repo.bloggerRates({ days: 7 });
  assert.equal(r.bloggers.length, 1);
  assert.equal(r.bloggers[0].blogger, 'good_blogger');
  assert.equal(r.bloggers[0].follows, 1);
  assert.equal(r.bloggers[0].follow_backs, 1);
  assert.equal(r.bloggers[0].ice, 1);
  db.close();
  try { fs.unlinkSync(p); } catch (e) {}
});

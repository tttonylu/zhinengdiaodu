#!/usr/bin/env node
/**
 * Merge accounts that differ only by x_handle case (SQLite UNIQUE is case-sensitive).
 * Keep: newest last_seen_at → higher day_count → smaller id.
 * Usage: node scripts/merge-case-duplicate-accounts.js [dbPath]
 */
const path = require('node:path');
const { createDb } = require('../src/db/client');
const { readConfig } = require('../src/config');

function parseSeenMs(s) {
  if (!s) return 0;
  const d = new Date(String(s).replace(/\//g, '-'));
  const t = d.getTime();
  return Number.isNaN(t) ? 0 : t;
}

function pickKeeper(rows) {
  return rows.slice().sort((a, b) => {
    const ta = parseSeenMs(a.last_seen_at);
    const tb = parseSeenMs(b.last_seen_at);
    if (tb !== ta) return tb - ta;
    const da = Number(a.day_count || 1);
    const db = Number(b.day_count || 1);
    if (db !== da) return db - da;
    return Number(a.id) - Number(b.id);
  })[0];
}

function mergeDailyStats(db, keepId, dupId) {
  const dupRows = db
    .prepare('SELECT * FROM account_daily_stats WHERE account_id = ?')
    .all(dupId);
  const getKeep = db.prepare(
    'SELECT * FROM account_daily_stats WHERE account_id = ? AND stat_date = ?'
  );
  const upd = db.prepare(`
    UPDATE account_daily_stats SET
      follow_count = follow_count + @follow_count,
      follow_duration_sec = follow_duration_sec + @follow_duration_sec,
      chat_rounds = chat_rounds + @chat_rounds,
      chat_duration_sec = chat_duration_sec + @chat_duration_sec,
      nurture_likes = nurture_likes + @nurture_likes,
      nurture_comments = nurture_comments + @nurture_comments,
      nurture_duration_sec = nurture_duration_sec + @nurture_duration_sec,
      updated_at = datetime('now', '+8 hours')
    WHERE account_id = @aid AND stat_date = @sd
  `);
  const move = db.prepare(
    'UPDATE account_daily_stats SET account_id = ? WHERE id = ?'
  );
  const del = db.prepare('DELETE FROM account_daily_stats WHERE id = ?');

  for (const row of dupRows) {
    const existing = getKeep.get(keepId, row.stat_date);
    if (!existing) {
      move.run(keepId, row.id);
      continue;
    }
    upd.run({
      aid: keepId,
      sd: row.stat_date,
      follow_count: Number(row.follow_count || 0),
      follow_duration_sec: Number(row.follow_duration_sec || 0),
      chat_rounds: Number(row.chat_rounds || 0),
      chat_duration_sec: Number(row.chat_duration_sec || 0),
      nurture_likes: Number(row.nurture_likes || 0),
      nurture_comments: Number(row.nurture_comments || 0),
      nurture_duration_sec: Number(row.nurture_duration_sec || 0),
    });
    del.run(row.id);
  }
}

function mergeOverrides(db, keepHandle, dupHandle) {
  const dupRows = db
    .prepare('SELECT key, value FROM config_account_overrides WHERE x_handle = ?')
    .all(dupHandle);
  const has = db.prepare(
    'SELECT 1 AS ok FROM config_account_overrides WHERE x_handle = ? AND key = ?'
  );
  const ins = db.prepare(`
    INSERT INTO config_account_overrides (x_handle, key, value, updated_at)
    VALUES (?, ?, ?, datetime('now', '+8 hours'))
  `);
  for (const row of dupRows) {
    if (!has.get(keepHandle, row.key)) {
      ins.run(keepHandle, row.key, row.value);
    }
  }
  db.prepare('DELETE FROM config_account_overrides WHERE x_handle = ?').run(dupHandle);
}

function mergeCommands(db, keepHandle, dupHandle) {
  const keepCmd = db
    .prepare('SELECT command FROM account_commands WHERE x_handle = ?')
    .get(keepHandle);
  const dupCmd = db
    .prepare('SELECT command FROM account_commands WHERE x_handle = ?')
    .get(dupHandle);
  if (!keepCmd && dupCmd) {
    db.prepare(`
      INSERT INTO account_commands (x_handle, command, created_at, updated_at)
      VALUES (?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
      ON CONFLICT(x_handle) DO UPDATE SET
        command = excluded.command,
        updated_at = datetime('now', '+8 hours')
    `).run(keepHandle, dupCmd.command);
  }
  db.prepare('DELETE FROM account_commands WHERE x_handle = ?').run(dupHandle);
}

function main() {
  const config = readConfig();
  const dbPath = process.argv[2] || config.dbPath;
  const db = createDb(dbPath);
  console.log('[merge] db =', dbPath);

  const all = db.prepare('SELECT * FROM accounts').all();
  const groups = new Map();
  for (const row of all) {
    const key = String(row.x_handle || '').toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const dupGroups = [...groups.entries()].filter(([, rows]) => rows.length > 1);
  console.log(`[merge] accounts=${all.length} case-dup-groups=${dupGroups.length}`);

  const report = [];

  const run = db.transaction(() => {
    for (const [norm, rows] of dupGroups) {
      const keep = pickKeeper(rows);
      const dups = rows.filter((r) => r.id !== keep.id);

      for (const dup of dups) {
        db.prepare('UPDATE leads SET bound_account_id = ? WHERE bound_account_id = ?')
          .run(keep.id, dup.id);
        db.prepare('UPDATE activity_logs SET account_id = ? WHERE account_id = ?')
          .run(keep.id, dup.id);
        mergeDailyStats(db, keep.id, dup.id);
        db.prepare(
          'UPDATE dm_records SET bot_handle = ? WHERE LOWER(bot_handle) = LOWER(?)'
        ).run(keep.x_handle, dup.x_handle);
        mergeOverrides(db, keep.x_handle, dup.x_handle);
        mergeCommands(db, keep.x_handle, dup.x_handle);

        const day = Math.max(Number(keep.day_count || 1), Number(dup.day_count || 1));
        if (day !== Number(keep.day_count || 1)) {
          db.prepare('UPDATE accounts SET day_count = ? WHERE id = ?').run(day, keep.id);
          keep.day_count = day;
        }
        if (parseSeenMs(dup.last_seen_at) > parseSeenMs(keep.last_seen_at)) {
          db.prepare('UPDATE accounts SET last_seen_at = ? WHERE id = ?')
            .run(dup.last_seen_at, keep.id);
          keep.last_seen_at = dup.last_seen_at;
        }
        if (dup.sort_order != null && keep.sort_order == null) {
          db.prepare('UPDATE accounts SET sort_order = ? WHERE id = ?')
            .run(dup.sort_order, keep.id);
        }

        db.prepare('DELETE FROM accounts WHERE id = ?').run(dup.id);
        report.push({ kept: keep.id, deleted: dup.id, from: dup.x_handle, to: norm });
      }

      // Now safe: no case-sibling left — normalize keeper + handle-keyed rows
      const oldHandle = keep.x_handle;
      db.prepare(`
        UPDATE accounts SET
          x_handle = ?,
          updated_at = datetime('now', '+8 hours')
        WHERE id = ?
      `).run(norm, keep.id);
      keep.x_handle = norm;

      if (oldHandle !== norm) {
        db.prepare(
          'UPDATE dm_records SET bot_handle = ? WHERE bot_handle = ?'
        ).run(norm, oldHandle);
        db.prepare(
          'UPDATE config_account_overrides SET x_handle = ? WHERE x_handle = ?'
        ).run(norm, oldHandle);
        db.prepare(
          'UPDATE account_commands SET x_handle = ? WHERE x_handle = ?'
        ).run(norm, oldHandle);
      }
    }

    // Normalize remaining unique handles to lowercase
    const singles = db.prepare('SELECT id, x_handle FROM accounts').all();
    for (const row of singles) {
      const lower = String(row.x_handle || '').toLowerCase();
      if (row.x_handle !== lower) {
        const clash = db
          .prepare('SELECT id FROM accounts WHERE LOWER(x_handle) = LOWER(?) AND id != ?')
          .get(lower, row.id);
        if (clash) {
          throw new Error(`cannot normalize ${row.x_handle}: still clashes with id=${clash.id}`);
        }
        db.prepare('UPDATE accounts SET x_handle = ? WHERE id = ?').run(lower, row.id);
        db.prepare('UPDATE dm_records SET bot_handle = ? WHERE bot_handle = ?')
          .run(lower, row.x_handle);
        db.prepare('UPDATE config_account_overrides SET x_handle = ? WHERE x_handle = ?')
          .run(lower, row.x_handle);
        db.prepare('UPDATE account_commands SET x_handle = ? WHERE x_handle = ?')
          .run(lower, row.x_handle);
      }
    }
  });

  run();

  const left = db
    .prepare(`
      SELECT LOWER(x_handle) AS h, COUNT(*) AS c
      FROM accounts
      GROUP BY LOWER(x_handle)
      HAVING c > 1
    `)
    .all();

  console.log('[merge] merged rows:', report.length);
  for (const r of report) {
    console.log(`  deleted id=${r.deleted} (${r.from}) → keep id=${r.kept} (${r.to})`);
  }
  console.log('[merge] remaining case-dups:', left.length);
  if (left.length) {
    console.error(left);
    process.exitCode = 1;
  } else {
    console.log('[merge] ok');
  }
  db.close();
}

main();

/**
 * 粉丝台账 dm_roster_snapshots / dm_roster_items
 * 插件 POST /api/plugin/dm/roster；OPS 早对账页读取。
 */
function createDmRosterRepo(db) {
  // 防御性建表（测试 :memory: / 未跑迁移时）
  try {
    const fs = require('fs');
    const path = require('path');
    const sqlPath = path.join(__dirname, '../db/migrations/065_dm_roster.sql');
    if (fs.existsSync(sqlPath)) {
      db.exec(fs.readFileSync(sqlPath, 'utf8'));
    }
  } catch (eDdl) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS dm_roster_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          bot_id TEXT NOT NULL,
          bot_handle TEXT,
          pulse_id TEXT,
          sealed_at INTEGER,
          profile_followers INTEGER DEFAULT 0,
          cells_seen INTEGER DEFAULT 0,
          queue_total INTEGER DEFAULT 0,
          pending INTEGER DEFAULT 0,
          skipped INTEGER DEFAULT 0,
          payload TEXT NOT NULL DEFAULT '{}',
          created_at TEXT DEFAULT (datetime('now', '+8 hours'))
        );
        CREATE TABLE IF NOT EXISTS dm_roster_items (
          bot_id TEXT NOT NULL,
          handle TEXT NOT NULL,
          display_name TEXT,
          round INTEGER DEFAULT 0,
          queue_status TEXT,
          queue_kind TEXT,
          queue_reason TEXT,
          blocked INTEGER DEFAULT 0,
          block_reason TEXT,
          rejected INTEGER DEFAULT 0,
          done INTEGER DEFAULT 0,
          ice_sent_at INTEGER,
          blocked_at INTEGER,
          dm_verified_at INTEGER,
          updated_at TEXT DEFAULT (datetime('now', '+8 hours')),
          PRIMARY KEY (bot_id, handle)
        );
      `);
    } catch (e2) {}
  }

  // 列自愈：旧库（065 之前内联 DDL 建表）缺 dm_verified_at / stale，
  // CREATE TABLE IF NOT EXISTS 不会给已存在的表补列 → 必须幂等 ALTER，
  // 否则 upsertItems 事务因「no such column: dm_verified_at」整体回滚（2026-10-05 起明细全丢）
  function ensureItemsColumns() {
    ['ALTER TABLE dm_roster_items ADD COLUMN dm_verified_at INTEGER',
     'ALTER TABLE dm_roster_items ADD COLUMN stale INTEGER DEFAULT 0'].forEach((ddl) => {
      try { db.exec(ddl); } catch (eCol) { /* column already exists */ }
    });
  }
  ensureItemsColumns();

  function cleanH(h) {
    return String(h || '').replace(/^@/, '').toLowerCase().trim();
  }

  return {
    insertSnapshot(row) {
      const r = {
        bot_id: cleanH(row.bot_id),
        bot_handle: cleanH(row.bot_handle || row.bot_id),
        pulse_id: String(row.pulse_id || ''),
        sealed_at: parseInt(row.sealed_at, 10) || Date.now(),
        profile_followers: parseInt(row.profile_followers, 10) || 0,
        cells_seen: parseInt(row.cells_seen, 10) || 0,
        queue_total: parseInt(row.queue_total, 10) || 0,
        pending: parseInt(row.pending, 10) || 0,
        skipped: parseInt(row.skipped, 10) || 0,
        payload: typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload || {}),
        created_at: row.created_at || null
      };
      if (!r.bot_id) throw new Error('bot_id required');
      if (r.created_at) {
        return db.prepare(`
          INSERT INTO dm_roster_snapshots
            (bot_id, bot_handle, pulse_id, sealed_at, profile_followers, cells_seen,
             queue_total, pending, skipped, payload, created_at)
          VALUES (@bot_id, @bot_handle, @pulse_id, @sealed_at, @profile_followers, @cells_seen,
                  @queue_total, @pending, @skipped, @payload, @created_at)
        `).run(r);
      }
      return db.prepare(`
        INSERT INTO dm_roster_snapshots
          (bot_id, bot_handle, pulse_id, sealed_at, profile_followers, cells_seen,
           queue_total, pending, skipped, payload)
        VALUES (@bot_id, @bot_handle, @pulse_id, @sealed_at, @profile_followers, @cells_seen,
                @queue_total, @pending, @skipped, @payload)
      `).run(r);
    },

    upsertItems(botId, items, ts) {
      const bot = cleanH(botId);
      if (!bot || !Array.isArray(items)) return 0;
      const stmt = db.prepare(`
        INSERT INTO dm_roster_items
          (bot_id, handle, display_name, round, queue_status, queue_kind, queue_reason,
           blocked, block_reason, rejected, done, ice_sent_at, blocked_at, dm_verified_at, updated_at)
        VALUES
          (@bot_id, @handle, @display_name, @round, @queue_status, @queue_kind, @queue_reason,
           @blocked, @block_reason, @rejected, @done, @ice_sent_at, @blocked_at, @dm_verified_at, @updated_at)
        ON CONFLICT(bot_id, handle) DO UPDATE SET
          display_name=excluded.display_name,
          round=excluded.round,
          queue_status=excluded.queue_status,
          queue_kind=excluded.queue_kind,
          queue_reason=excluded.queue_reason,
          blocked=excluded.blocked,
          block_reason=excluded.block_reason,
          rejected=excluded.rejected,
          done=excluded.done,
          ice_sent_at=excluded.ice_sent_at,
          blocked_at=excluded.blocked_at,
          dm_verified_at=excluded.dm_verified_at,
          updated_at=excluded.updated_at
      `);
      const updatedAt = ts || new Date().toISOString();
      let n = 0;
      const tx = db.transaction((list) => {
        for (const it of list) {
          const h = cleanH(it.handle);
          if (!h) continue;
          stmt.run({
            bot_id: bot,
            handle: h,
            display_name: String(it.displayName || it.display_name || ''),
            round: parseInt(it.round, 10) || 0,
            queue_status: String(it.queueStatus || it.queue_status || ''),
            queue_kind: String(it.queueKind || it.queue_kind || ''),
            queue_reason: String(it.queueReason || it.queue_reason || ''),
            blocked: it.blocked ? 1 : 0,
            block_reason: String(it.blockReason || it.block_reason || ''),
            rejected: it.rejected ? 1 : 0,
            done: it.done ? 1 : 0,
            ice_sent_at: parseInt(it.iceSentAt || it.ice_sent_at, 10) || null,
            blocked_at: parseInt(it.blockedAt || it.blocked_at, 10) || null,
            dm_verified_at: parseInt(it.dmVerifiedAt || it.dm_verified_at, 10) || null,
            updated_at: updatedAt
          });
          n++;
        }
      });
      try {
        tx(items);
      } catch (eTx) {
        // 运行时列自愈重试：台账是最高优先级数据，任何「no such column」类错误
        // （旧库漏迁移/未来加列）先补列再重放一次，事务已回滚不脏写
        if (/no (such )?column/i.test(String(eTx && eTx.message))) {
          ensureItemsColumns();
          n = 0;
          tx(items);
        } else {
          throw eTx;
        }
      }
      return n;
    },

    listByBot(botId) {
      const bot = cleanH(botId);
      if (!bot) return [];
      return db.prepare(`
        SELECT * FROM dm_roster_items WHERE bot_id = ?
        ORDER BY
          CASE queue_status
            WHEN 'doing' THEN 0
            WHEN 'pending' THEN 1
            WHEN 'deferred' THEN 2
            WHEN 'skipped' THEN 3
            ELSE 4
          END,
          handle ASC
      `).all(bot);
    },

    /**
     * 4.6.67：本次 seal 未带回的旧 pending → 标 stale（不删行，便于对账）
     * @returns {number} 更新行数
     */
    markPendingNotInSetStale(botId, keepHandles, ts) {
      const bot = cleanH(botId);
      if (!bot) return 0;
      try {
        db.exec('ALTER TABLE dm_roster_items ADD COLUMN stale INTEGER DEFAULT 0');
      } catch (eCol) { /* already exists */ }
      const keep = new Set((keepHandles || []).map(cleanH).filter(Boolean));
      const rows = db.prepare(`
        SELECT handle FROM dm_roster_items
        WHERE bot_id=? AND LOWER(COALESCE(queue_status,''))='pending'
      `).all(bot);
      const updatedAt = ts || new Date().toISOString();
      const stmt = db.prepare(`
        UPDATE dm_roster_items
        SET stale=1,
            queue_reason=CASE
              WHEN queue_reason LIKE 'stale_not_in_seal%' THEN queue_reason
              ELSE 'stale_not_in_seal'
            END,
            updated_at=@updated_at
        WHERE bot_id=@bot AND LOWER(handle)=LOWER(@handle)
      `);
      let n = 0;
      const tx = db.transaction((list) => {
        for (const row of list) {
          const h = cleanH(row.handle);
          if (!h || keep.has(h)) continue;
          stmt.run({ bot, handle: h, updated_at: updatedAt });
          n++;
        }
      });
      tx(rows);
      return n;
    },

    countPending(botId) {
      const bot = cleanH(botId);
      if (!bot) return 0;
      const row = db.prepare(`
        SELECT COUNT(*) AS c FROM dm_roster_items
        WHERE bot_id=? AND LOWER(COALESCE(queue_status,''))='pending'
      `).get(bot);
      return (row && row.c) || 0;
    },

    latestSnapshotMeta(botId) {
      const bot = cleanH(botId);
      if (!bot) return null;
      // 契约 obs-retention↔H2：bot_id 等值（写入端已小写化），禁 LOWER() 废索引；
      // MAX(id) 子查询走 idx_dm_roster_snap_bot 覆盖索引不回表，外层主键精确定位
      return db.prepare(`
        SELECT id, bot_id, bot_handle, pulse_id, sealed_at, profile_followers, cells_seen,
               queue_total, pending, skipped, created_at, payload
        FROM dm_roster_snapshots
        WHERE id = (SELECT MAX(id) FROM dm_roster_snapshots WHERE bot_id = ?)
      `).get(bot) || null;
    },

    /**
     * 快照保留策略（契约 obs-retention↔H2 · 分层 + 30 天硬上限）：
     * 1) sealed_at 超过 30 天 → 删（30 天与 listDailySnapshots 展示窗口对齐）
     * 2) 同 bot 同日（created_at 前 10 位日串）只留 id 最大一封
     * 3) sealed_at 在 7–30 天 → payload 置 '{}'（仅留趋势元数据列，明细很少回看）
     * 4) ≤7 天保留完整 payload（含 items，供历史粉丝明细回看）
     * sealed_at 为 0/NULL 的脏行保守保留（不删不剥，避免误删历史数据）。
     * 返回 { deleted, stripped }。
     */
    purgeSnapshots(batchSize) {
      const lim = Math.max(1000, parseInt(batchSize, 10) || 20000);
      const now = Date.now();
      const DAY = 86400000;
      const FULL_PAYLOAD_DAYS = 7;          // 近 7 天保留完整明细（一行可调）
      const MAX_RETENTION_DAYS = 30;        // 硬上限，超出即删
      const cutoff7 = now - FULL_PAYLOAD_DAYS * DAY;
      const cutoff30 = now - MAX_RETENTION_DAYS * DAY;
      let deleted = 0, stripped = 0;

      // 1) 删 >30 天（sealed_at 有效）
      const delOld = db.prepare(`
        DELETE FROM dm_roster_snapshots WHERE id IN (
          SELECT id FROM dm_roster_snapshots
          WHERE sealed_at IS NOT NULL AND sealed_at > 0 AND sealed_at < ?
          LIMIT ?
        )
      `);
      for (;;) {
        const r = delOld.run(cutoff30, lim);
        deleted += r.changes || 0;
        if (!r.changes || r.changes < lim) break;
      }

      // 2) 同 bot 同日只留 MAX(id)
      const dedupe = db.prepare(`
        DELETE FROM dm_roster_snapshots WHERE id IN (
          SELECT id FROM dm_roster_snapshots
          WHERE id NOT IN (
            SELECT MAX(id) FROM dm_roster_snapshots
            GROUP BY bot_id, substr(created_at, 1, 10)
          )
          LIMIT ?
        )
      `);
      for (;;) {
        const r = dedupe.run(lim);
        deleted += r.changes || 0;
        if (!r.changes || r.changes < lim) break;
      }

      // 3) 7–30 天剥离 payload（保留元数据列）
      const strip = db.prepare(`
        UPDATE dm_roster_snapshots SET payload = '{}'
        WHERE id IN (
          SELECT id FROM dm_roster_snapshots
          WHERE sealed_at IS NOT NULL AND sealed_at > 0
            AND sealed_at < ? AND payload <> '{}'
          LIMIT ?
        )
      `);
      for (;;) {
        const r = strip.run(cutoff7, lim);
        stripped += r.changes || 0;
        if (!r.changes || r.changes < lim) break;
      }

      return { deleted, stripped };
    },

    /** 历史浏览：最近 N 天、每天取最新一封快照（不含 payload，列表轻量） */
    listDailySnapshots(botId, limitDays) {
      const bot = cleanH(botId);
      if (!bot) return [];
      const lim = parseInt(limitDays, 10) || 30;
      return db.prepare(`
        SELECT s.id, s.created_at, s.sealed_at, s.profile_followers, s.cells_seen,
               s.queue_total, s.pending, s.skipped
        FROM dm_roster_snapshots s
        JOIN (
          SELECT substr(created_at, 1, 10) AS day, MAX(id) AS max_id
          FROM dm_roster_snapshots
          WHERE bot_id = ?
          GROUP BY day
          ORDER BY day DESC
          LIMIT ?
        ) d ON d.max_id = s.id
        ORDER BY s.id DESC
      `).all(bot, lim);
    },

    /** 历史浏览：按 id 取该号单份快照（含 payload） */
    getSnapshot(botId, id) {
      const bot = cleanH(botId);
      const sid = parseInt(id, 10);
      if (!bot || !Number.isFinite(sid) || sid <= 0) return null;
      return db.prepare(`
        SELECT * FROM dm_roster_snapshots
        WHERE bot_id = ? AND id = ?
      `).get(bot, sid) || null;
    }
  };
}

module.exports = { createDmRosterRepo };

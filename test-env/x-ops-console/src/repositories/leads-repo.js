function createLeadsRepo(db) {
  return {
    findById(id) {
      return db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    },
    findByHandle(targetHandle) {
      const raw = String(targetHandle || '').replace(/^@/, '').replace(/#.*$/, '').toLowerCase().trim();
      if (!raw) return null;
      return db.prepare(`SELECT * FROM leads WHERE REPLACE(REPLACE(REPLACE(LOWER(target_handle), '@', ''), '#guard', ''), '#', '') = ?`).get(raw);
    },
    findByUserId(userId) {
      if (!userId) return null;
      return db.prepare(`SELECT * FROM leads WHERE target_user_id = ?`).get(String(userId));
    },
    updateUserId(id, userId) {
      db.prepare(`UPDATE leads SET target_user_id = ?, updated_at = datetime('now', '+8 hours') WHERE id = ?`).run(String(userId), id);
    },
    findAll() {
      return db.prepare(`SELECT * FROM leads ORDER BY updated_at DESC LIMIT 500`).all();
    },
    list(filters = {}) {
      const where = [];
      const params = {};

      if (filters.stage) {
        where.push('l.current_stage = @stage');
        params.stage = filters.stage;
      }

      if (filters.source) {
        where.push('l.source = @source');
        params.source = filters.source;
      }

      if (filters.accountId) {
        where.push('l.bound_account_id = @accountId');
        params.accountId = filters.accountId;
      }

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      return db
        .prepare(`
          SELECT
            l.*,
            a.x_handle AS bound_handle
          FROM leads l
          LEFT JOIN accounts a ON a.id = l.bound_account_id
          ${whereSql}
          ORDER BY COALESCE(l.last_activity_at, l.updated_at, l.created_at) DESC
          LIMIT 200
        `)
        .all(params);
    },
    stageCounts() {
      return db
        .prepare(`
          SELECT current_stage, COUNT(*) AS total
          FROM leads
          GROUP BY current_stage
          ORDER BY current_stage
        `)
        .all();
    },
    listStalled(stalledHoursThreshold) {
      return db
        .prepare(`
          SELECT
            l.*,
            a.x_handle AS bound_handle
          FROM leads l
          LEFT JOIN accounts a ON a.id = l.bound_account_id
          WHERE l.current_stage NOT IN ('completed', 'skipped')
            AND zhdate(COALESCE(l.last_activity_at, l.created_at)) IS NOT NULL
            AND datetime(zhdate(COALESCE(l.last_activity_at, l.created_at))) <= datetime('now', @threshold)
          ORDER BY zhdate(COALESCE(l.last_activity_at, l.created_at)) ASC
          LIMIT 50
        `)
        .all({ threshold: `-${Number(stalledHoursThreshold || 24)} hours` });
    },
    findDetail(id) {
      return db
        .prepare(`
          SELECT
            l.*,
            a.x_handle AS bound_handle
          FROM leads l
          LEFT JOIN accounts a ON a.id = l.bound_account_id
          WHERE l.id = ?
        `)
        .get(id);
    },
    insert(lead) {
      return db
        .prepare(`
          INSERT INTO leads (
            platform,
            target_handle,
            source,
            current_stage,
            discovered_at,
            last_activity_at,
            created_at,
            updated_at
          ) VALUES (
            @platform,
            @target_handle,
            @source,
            @current_stage,
            datetime('now', '+8 hours'),
            datetime('now', '+8 hours'),
            datetime('now', '+8 hours'),
            datetime('now', '+8 hours')
          )
        `)
        .run(lead);
    },
    batchDiscover(handles, accountId) {
      const created = [];
      const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
      const insert = db.prepare(`
        INSERT OR IGNORE INTO leads (
          platform, target_handle, source, current_stage,
          bound_account_id, discovered_at, last_activity_at, created_at, updated_at
        ) VALUES ('x', ?, 'chat_plugin', 'discovered', ?, ?, ?, ?, ?)
      `);
      for (const h of handles) {
        const clean = String(h).replace(/^@/, '').toLowerCase().trim();
        if (!clean) continue;
        const existing = db.prepare(`
          SELECT id FROM leads WHERE REPLACE(REPLACE(REPLACE(LOWER(target_handle), '@', ''), '#guard', ''), '#', '') = ?
        `).get(clean);
        if (existing) continue;
        insert.run(clean, accountId, now, now, now, now);
        created.push(clean);
      }
      return created;
    },
    updateStage({ id, current_stage, bound_account_id, event_time, action_type }) {
      const timestampColumnByAction = {
        follow: 'followed_at',
        follow_back: 'followed_back_at',
        mark_dm_ready: 'dm_ready_at',
        dm: 'dm_sent_at',
        complete: 'closed_at',
        skip: 'closed_at',
      };

      const timestampColumn = timestampColumnByAction[action_type];
      const allowedColumns = new Set([
        'followed_at',
        'followed_back_at',
        'dm_ready_at',
        'dm_sent_at',
        'closed_at',
      ]);

      const extraSetClause = timestampColumn && allowedColumns.has(timestampColumn)
        ? `, ${timestampColumn} = @event_time`
        : '';

      return db
        .prepare(`
          UPDATE leads
          SET current_stage = @current_stage,
              bound_account_id = COALESCE(@bound_account_id, bound_account_id),
              last_activity_at = @event_time,
              updated_at = @event_time
              ${extraSetClause}
          WHERE id = @id
        `)
        .run({ id, current_stage, bound_account_id, event_time });
    },
    markClosed(id, currentStage, closeReason, eventTime) {
      return db
        .prepare(`
          UPDATE leads
          SET current_stage = @current_stage,
              close_reason = @close_reason,
              closed_at = @event_time,
              last_activity_at = @event_time,
              updated_at = @event_time
          WHERE id = @id
        `)
        .run({
          id,
          current_stage: currentStage,
          close_reason: closeReason,
          event_time: eventTime,
        });
    },

    updateDmProgress(id, snapshotCount, lastDmAction, eventTime) {
      return db
        .prepare(`
          UPDATE leads
          SET snapshot_count = @snapshot_count,
              last_dm_action = @last_dm_action,
              last_activity_at = @event_time,
              updated_at = @event_time
          WHERE id = @id
        `)
        .run({
          id,
          snapshot_count: snapshotCount,
          last_dm_action: lastDmAction,
          event_time: eventTime
        });
    },

    /** �� DM Ŀ�꣨����������ֹ���������� */
    // === 仪表盘统计 ===

    /** 各阶段数量 */
    dashboardStageCounts() {
      return db.prepare(`
        SELECT current_stage, COUNT(*) AS total
        FROM leads
        GROUP BY current_stage
        ORDER BY CASE current_stage
          WHEN 'discovered' THEN 1
          WHEN 'followed' THEN 2
          WHEN 'followed_back' THEN 3
          WHEN 'ice_sent' THEN 4
          WHEN 'ad_sent' THEN 5
          WHEN 'kick_sent' THEN 6
          WHEN 'completed' THEN 7
          WHEN 'rejected' THEN 8
          WHEN 'skipped' THEN 9
          ELSE 10
        END
      `).all();
    },

    /** 今日新建线索数 */
    todayNewCount() {
      const { todayCreatedAtLikeParams, TODAY_CREATED_AT_SQL } = require('../utils/shanghai-date');
      const p = todayCreatedAtLikeParams();
      const r = db.prepare(`SELECT COUNT(*) AS c FROM leads WHERE ${TODAY_CREATED_AT_SQL}`).get(p);
      return r ? r.c : 0;
    },

    /** 今日各动作计数（按 activity_logs） */
    todayActionCounts() {
      const { todayCreatedAtLikeParams, TODAY_CREATED_AT_SQL } = require('../utils/shanghai-date');
      const p = todayCreatedAtLikeParams();
      const rows = db.prepare(`
        SELECT action_type, COUNT(*) AS total
        FROM activity_logs
        WHERE ${TODAY_CREATED_AT_SQL}
        GROUP BY action_type
      `).all(p);
      const map = {};
      rows.forEach(r => { map[r.action_type] = r.total; });
      return {
        follow: map.follow || 0,
        follow_back: map.follow_back || 0,
        ice_sent: map.ice_sent || 0,
        ad_sent: map.ad_sent || 0,
        kick_sent: map.kick_sent || 0,
        reject_sent: map.reject_sent || 0,
        total: Object.values(map).reduce((a, b) => a + b, 0)
      };
    },

    /** 等待回复的目标（ice_sent / ad_sent 超过 N 小时未回复） */
    waitingForReply(hoursThreshold) {
      return db.prepare(`
        SELECT l.target_handle, l.current_stage, l.last_dm_action,
               l.snapshot_count, l.last_activity_at,
               a.x_handle AS bound_handle,
               CAST((julianday('now', '+8 hours') - julianday(zhdate(l.last_activity_at))) * 24 AS INTEGER) AS hours_waiting
        FROM leads l
        LEFT JOIN accounts a ON a.id = l.bound_account_id
        WHERE l.current_stage IN ('ice_sent', 'ad_sent')
          AND l.last_activity_at IS NOT NULL
          AND zhdate(l.last_activity_at) IS NOT NULL
          AND datetime(zhdate(l.last_activity_at)) <= datetime('now', '-' || ? || ' hours')
        ORDER BY zhdate(l.last_activity_at) ASC
        LIMIT 30
      `).all(Number(hoursThreshold) || 1);
    },

    /** ������־ */
    recentActivityLogs(limit) {
      return db.prepare(`
        SELECT al.*, l.target_handle, a.x_handle AS account_handle
        FROM activity_logs al
        LEFT JOIN leads l ON l.id = al.lead_id
        LEFT JOIN accounts a ON a.id = al.account_id
        ORDER BY al.created_at DESC
        LIMIT ?
      `).all(Number(limit) || 20);
    },

    /** �����˺��� */
    activeAccountCount() {
      const r = db.prepare(`SELECT COUNT(*) AS c FROM accounts WHERE status = 'active'`).get();
      return r ? r.c : 0;
    },

    /** ���õĻ��������� */
    activeScriptCount() {
      const r = db.prepare(`SELECT COUNT(*) AS c FROM script_sets WHERE enabled = 1`).get();
      return r ? r.c : 0;
    },


  };
}

module.exports = { createLeadsRepo };

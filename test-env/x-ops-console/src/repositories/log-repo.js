/**
 * 专用日志库仓库（x-ops-log.sqlite）
 * - 事件写入按 client_event_id 幂等去重
 * - 保留策略：明细滚入小时汇总后删除、快照/汇总按时间清理
 */
function createLogRepo(db) {
  // 上海时区 "YYYY-MM-DD HH:MM:SS"（与插件 time_zh 同语义，可直接做字符串比较）
  function shanghaiWallTime(ms) {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    });
    const map = {};
    for (const p of fmt.formatToParts(new Date(ms))) map[p.type] = p.value;
    return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
  }

  function shanghaiHourAgo(hours) {
    return shanghaiWallTime(Date.now() - hours * 3600 * 1000).replace(/:\d{2}$/, ':00:00');
  }

  function insertBatch(rows) {
    if (!Array.isArray(rows) || !rows.length) return { inserted: 0, deduped: 0, failed: 0 };
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO log_events (
        account_id, account_handle, client_event_id, event_id, severity,
        category, label_zh, session_id, meta_json, ts_ms, created_at
      ) VALUES (
        @account_id, @account_handle, @client_event_id, @event_id, @severity,
        @category, @label_zh, @session_id, @meta_json, @ts_ms, @created_at
      )
    `);
    let inserted = 0;
    let failed = 0;
    const tx = db.transaction((list) => {
      for (const r of list) {
        try {
          const info = stmt.run(r);
          if (info.changes > 0) inserted += 1;
        } catch (e) {
          failed += 1;
        }
      }
    });
    tx(rows);
    return { inserted, deduped: rows.length - inserted - failed, failed };
  }

  function insertSnapshot(accountId, accountHandle, snapshot, ts) {
    const info = db.prepare(`
      INSERT INTO log_snapshots (account_id, account_handle, session_id, snapshot_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      accountId,
      accountHandle || '',
      (snapshot && snapshot.session_id) || '',
      JSON.stringify(snapshot),
      ts
    );
    return Number(info.lastInsertRowid);
  }

  function listEvents({ accountId, accountHandle, eventId, eventIds, severity, category, board, keyword, since, until, limit = 100, offset = 0 } = {}) {
    const cond = [];
    const params = {};
    if (accountId) {
      cond.push('account_id = @account_id');
      params.account_id = accountId;
    }
    if (accountHandle) {
      cond.push('LOWER(account_handle) = LOWER(@account_handle)');
      params.account_handle = String(accountHandle).replace(/^@/, '');
    }
    if (eventIds && Array.isArray(eventIds) && eventIds.length) {
      const ids = eventIds.map((x) => String(x)).filter(Boolean).slice(0, 20);
      if (ids.length) {
        const keys = ids.map((_, i) => `@eid_${i}`);
        cond.push(`event_id IN (${keys.join(', ')})`);
        ids.forEach((id, i) => { params[`eid_${i}`] = id; });
      }
    } else if (eventId) {
      cond.push('event_id = @event_id');
      params.event_id = eventId;
    }
    if (severity) {
      cond.push('severity = @severity');
      params.severity = severity;
    }
    if (category) {
      cond.push('category = @category');
      params.category = category;
    }
    if (board) {
      cond.push("(meta_json LIKE @board_like OR category = @board)");
      params.board_like = `%"board":"${board}"%`;
      params.board = board;
    }
    if (keyword) {
      cond.push('(meta_json LIKE @kw OR label_zh LIKE @kw OR event_id LIKE @kw OR account_handle LIKE @kw)');
      params.kw = `%${keyword}%`;
    }
    if (since) {
      cond.push('created_at >= @since');
      params.since = since;
    }
    if (until) {
      cond.push('created_at <= @until');
      params.until = until;
    }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    params.limit = Math.min(500, Math.max(1, limit));
    params.offset = Math.max(0, offset);
    const rows = db.prepare(`
      SELECT id, account_handle, client_event_id, event_id, severity, category,
             label_zh, session_id, meta_json, ts_ms, created_at
      FROM log_events
      ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT @limit OFFSET @offset
    `).all(params);
    return rows.map((r) => {
      let meta = {};
      try { meta = JSON.parse(r.meta_json || '{}'); } catch (_) {}
      return { ...r, meta };
    });
  }

  function listSnapshots({ accountId, accountHandle, limit = 10, offset = 0 } = {}) {
    const cond = [];
    const params = {};
    if (accountId) {
      cond.push('account_id = @account_id');
      params.account_id = accountId;
    }
    if (accountHandle) {
      cond.push('LOWER(account_handle) = LOWER(@account_handle)');
      params.account_handle = String(accountHandle).replace(/^@/, '');
    }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    params.limit = Math.min(100, Math.max(1, limit));
    params.offset = Math.max(0, offset);
    return db.prepare(`
      SELECT id, account_handle, session_id, created_at
      FROM log_snapshots
      ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT @limit OFFSET @offset
    `).all(params);
  }

  function getSnapshotById(id) {
    return db.prepare('SELECT * FROM log_snapshots WHERE id = ?').get(id);
  }

  function countEvents({ since, until, severity, eventId, accountId, accountHandle, board } = {}) {
    const cond = [];
    const params = {};
    if (since) { cond.push('created_at >= @since'); params.since = since; }
    if (until) { cond.push('created_at <= @until'); params.until = until; }
    if (severity) { cond.push('severity = @severity'); params.severity = severity; }
    if (eventId) { cond.push('event_id = @event_id'); params.event_id = eventId; }
    if (accountId) { cond.push('account_id = @account_id'); params.account_id = accountId; }
    if (accountHandle) {
      cond.push('LOWER(account_handle) = LOWER(@account_handle)');
      params.account_handle = String(accountHandle).replace(/^@/, '');
    }
    if (board) {
      cond.push("(meta_json LIKE @board_like OR category = @board)");
      params.board_like = `%"board":"${board}"%`;
      params.board = board;
    }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const row = db.prepare(`SELECT COUNT(*) AS c FROM log_events ${where}`).get(params);
    return Number(row && row.c) || 0;
  }

  function boardBreakdown({ since, until, accountHandle } = {}) {
    const BOARDS = [
      ['A', '调度控制面'], ['B', '关注引擎'], ['C', '私信引擎'],
      ['D', '养号'], ['E', '转帖'], ['F', '配置同步'],
      ['G', '面板与观测'], ['H', 'OPS 后台'], ['I', '号池'],
      ['J', 'SCRM'], ['K', '自愈'],
    ];
    const scope = { since, until, accountHandle };
    return BOARDS.map(([b, name]) => {
      const c = countEvents({ ...scope, board: b });
      return { board: b, name, c };
    }).sort((a, b2) => b2.c - a.c);
  }

  function severityBreakdown({ since, until } = {}) {
    const cond = [];
    const params = {};
    if (since) { cond.push('created_at >= @since'); params.since = since; }
    if (until) { cond.push('created_at <= @until'); params.until = until; }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    return db.prepare(`
      SELECT severity, COUNT(*) AS c FROM log_events ${where}
      GROUP BY severity ORDER BY c DESC
    `).all(params);
  }

  function hourlyTrend(hours = 24, { accountId } = {}) {
    const cond = [];
    const params = {};
    cond.push('created_at >= @since_hour');
    params.since_hour = shanghaiHourAgo(hours);
    if (accountId) {
      cond.push('account_id = @account_id');
      params.account_id = accountId;
    }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const rows = db.prepare(`
      SELECT strftime('%Y-%m-%d %H:00', zhdate(created_at)) AS hour_key,
             severity,
             COUNT(*) AS c
      FROM log_events
      ${where}
      GROUP BY hour_key, severity
      ORDER BY hour_key ASC
    `).all(params);
    return rows.map((r) => ({
      hour_key: r.hour_key || '',
      severity: r.severity || 'info',
      c: Number(r.c) || 0,
    }));
  }

  // 把 until 之前的明细按小时汇总进 log_rollups_hourly（保留后滚动聚合）
  function rollupEvents(untilSql, batchSize = 5000) {
    const hourRows = db.prepare(`
      SELECT strftime('%Y-%m-%d %H:00', zhdate(created_at)) AS hour_key,
             account_id, event_id, severity,
             COUNT(*) AS c
      FROM log_events
      WHERE created_at <= @until
      GROUP BY hour_key, account_id, event_id, severity
    `).all({ until: untilSql });

    const upsert = db.prepare(`
      INSERT INTO log_rollups_hourly (account_id, hour_key, event_id, severity, cnt)
      VALUES (@account_id, @hour_key, @event_id, @severity, @cnt)
      ON CONFLICT(account_id, hour_key, event_id, severity)
      DO UPDATE SET cnt = cnt + excluded.cnt
    `);
    const tx = db.transaction((rows) => {
      for (const r of rows) upsert.run(r);
    });
    if (hourRows.length) {
      tx(hourRows.map((r) => ({ ...r, cnt: r.c })));
    }

    let deleted = 0;
    for (;;) {
      const res = db.prepare(`
        DELETE FROM log_events WHERE id IN (
          SELECT id FROM log_events WHERE created_at <= @until LIMIT @limit
        )
      `).run({ until: untilSql, limit: batchSize });
      if (!res.changes) break;
      deleted += res.changes;
    }
    return { rolled: hourRows.length, deleted };
  }

  function purgeSnapshots(untilSql, limit = 5000) {
    let deleted = 0;
    for (;;) {
      const res = db.prepare(`
        DELETE FROM log_snapshots WHERE id IN (
          SELECT id FROM log_snapshots WHERE created_at <= @until LIMIT @limit
        )
      `).run({ until: untilSql, limit });
      if (!res.changes) break;
      deleted += res.changes;
    }
    return deleted;
  }

  function purgeRollups(untilSql, limit = 5000) {
    let deleted = 0;
    for (;;) {
      const res = db.prepare(`
        DELETE FROM log_rollups_hourly WHERE id IN (
          SELECT id FROM log_rollups_hourly WHERE hour_key <= @until LIMIT @limit
        )
      `).run({ until: untilSql, limit });
      if (!res.changes) break;
      deleted += res.changes;
    }
    return deleted;
  }

  function dbSize() {
    try {
      const row = db.prepare('PRAGMA page_count').get();
      const page = db.prepare('PRAGMA page_size').get();
      return Number(row.page_count) * Number(page.page_size);
    } catch (e) {
      return 0;
    }
  }

  /**
   * 指挥闭环健康：按 pulseId 聚合 round_start → plan → progress → result → complete
   */
  function analyzeCommandLoop({ accountHandle, hours = 6, limit = 500 } = {}) {
    const LOOP = new Set([
      'scheduler.round_start',
      'scheduler.round_complete',
      'scheduler.chat_zombie_reclaim',
      'chat.round_plan',
      'chat.round_progress',
      'chat.round_result',
    ]);
    const since = shanghaiWallTime(Date.now() - Math.min(168, Math.max(1, hours)) * 3600 * 1000);
    const rows = listEvents({
      accountHandle: accountHandle || '',
      since,
      limit: Math.min(500, Math.max(50, limit)),
    }).filter((r) => LOOP.has(r.event_id));

    const byPulse = new Map();
    for (const r of rows) {
      const meta = r.meta || {};
      const pid = String(meta.pulseId || meta.pulse_id || '').trim() || `_orphan_${r.id}`;
      if (!byPulse.has(pid)) {
        byPulse.set(pid, {
          pulseId: pid.startsWith('_orphan_') ? '' : pid,
          account_handle: r.account_handle || '',
          intent: '',
          events: [],
          has_start: false,
          has_plan: false,
          has_progress: false,
          has_result: false,
          has_complete: false,
          has_reclaim: false,
          first_at: r.created_at,
          last_at: r.created_at,
        });
      }
      const g = byPulse.get(pid);
      g.events.push({
        event_id: r.event_id,
        created_at: r.created_at,
        label_zh: r.label_zh,
        via: meta.via || '',
        reason: meta.reason || '',
        intent: meta.intent || '',
      });
      if (meta.intent && !g.intent) g.intent = String(meta.intent);
      if (r.event_id === 'scheduler.round_start') {
        g.has_start = true;
        if (meta.intent) g.intent = String(meta.intent);
      }
      if (r.event_id === 'chat.round_plan') g.has_plan = true;
      if (r.event_id === 'chat.round_progress') g.has_progress = true;
      if (r.event_id === 'chat.round_result') g.has_result = true;
      if (r.event_id === 'scheduler.round_complete') {
        g.has_complete = true;
        if (meta.intent && !g.intent) g.intent = String(meta.intent);
      }
      if (r.event_id === 'scheduler.chat_zombie_reclaim') g.has_reclaim = true;
      if (String(r.created_at || '') < String(g.first_at || '')) g.first_at = r.created_at;
      if (String(r.created_at || '') > String(g.last_at || '')) g.last_at = r.created_at;
    }

    const pulses = [];
    let complete = 0;
    let gaps = 0;
    let zombies = 0;
    for (const g of byPulse.values()) {
      let status = 'ok';
      let gap = '';
      const outbound = g.intent === 'outbound';
      if (g.has_reclaim) {
        status = 'zombie_reclaim';
        zombies += 1;
      } else if (outbound) {
        // 破冰不要求 plan/progress；start→complete 即闭环
        if (g.has_start && (g.has_complete || g.has_result)) {
          status = 'ok';
          complete += 1;
        } else if (g.has_start) {
          status = 'gap';
          gap = 'missing_complete';
          gaps += 1;
        } else if (g.has_complete || g.has_result) {
          status = 'gap';
          gap = 'missing_start';
          gaps += 1;
        } else {
          status = 'partial';
        }
      } else if (g.has_start && !g.has_plan) {
        status = 'gap';
        gap = 'missing_plan';
        gaps += 1;
      } else if (g.has_plan && !g.has_progress && !g.has_result) {
        // 空名单 seal 后可无 progress，须等 result；仅 plan 无下文才算断
        status = 'gap';
        gap = 'missing_result_or_progress';
        gaps += 1;
      } else if ((g.has_progress || g.has_plan) && !g.has_result) {
        status = 'gap';
        gap = 'missing_result';
        gaps += 1;
      } else if (g.has_result && !g.has_complete) {
        status = 'gap';
        gap = 'missing_complete';
        gaps += 1;
      } else if (g.has_start && g.has_result) {
        status = 'ok';
        complete += 1;
      } else if (!g.has_start && (g.has_plan || g.has_result)) {
        status = 'gap';
        gap = 'missing_start';
        gaps += 1;
      } else {
        status = 'partial';
      }
      pulses.push({
        pulseId: g.pulseId,
        account_handle: g.account_handle,
        intent: g.intent || (outbound ? 'outbound' : 'inbox'),
        status,
        gap: gap || null,
        has_start: g.has_start,
        has_plan: g.has_plan,
        has_progress: g.has_progress,
        has_result: g.has_result,
        has_complete: g.has_complete,
        has_reclaim: g.has_reclaim,
        first_at: g.first_at,
        last_at: g.last_at,
        event_count: g.events.length,
        chain: g.events.map((e) => e.event_id).join(' → '),
      });
    }
    pulses.sort((a, b) => String(b.last_at || '').localeCompare(String(a.last_at || '')));

    return {
      hours,
      account: accountHandle || '',
      total_pulses: pulses.length,
      complete,
      gaps,
      zombies,
      pulses: pulses.slice(0, 80),
    };
  }

  return {
    insertBatch,
    insertSnapshot,
    listEvents,
    listSnapshots,
    getSnapshotById,
    countEvents,
    boardBreakdown,
    severityBreakdown,
    hourlyTrend,
    analyzeCommandLoop,
    rollupEvents,
    purgeSnapshots,
    purgeRollups,
    dbSize,
  };
}

module.exports = { createLogRepo };
function createTelemetryRepo(db) {
  function insertBatch(accountId, events, ts) {
    if (!accountId || !events || !events.length) return 0;
    const stmt = db.prepare(`
      INSERT INTO plugin_telemetry (account_id, event_id, severity, category, label_zh, meta_json, session_id, created_at)
      VALUES (@account_id, @event_id, @severity, @category, @label_zh, @meta_json, @session_id, @created_at)
    `);
    let n = 0;
    const insertMany = db.transaction((rows) => {
      for (const row of rows) {
        stmt.run(row);
        n += 1;
      }
    });
    const rows = events.map((e) => ({
      account_id: accountId,
      event_id: String(e.event_id || e.id || 'unknown'),
      severity: String(e.severity || 'info'),
      category: String(e.category || 'system'),
      label_zh: String(e.label_zh || e.event_id || ''),
      meta_json: JSON.stringify(e.meta || {}),
      session_id: String(e.session_id || ''),
      created_at: ts,
    }));
    insertMany(rows);
    return n;
  }

  function insertSnapshot(accountId, snapshot, ts) {
    db.prepare(`
      INSERT INTO telemetry_snapshots (account_id, session_id, snapshot_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(
      accountId,
      snapshot.session_id || '',
      JSON.stringify(snapshot),
      ts
    );
    return db.prepare('SELECT last_insert_rowid() AS id').get().id;
  }

  function listEvents({ accountId, category, severity, eventId, limit = 100, offset = 0, since } = {}) {
    const cond = [];
    const params = {};
    if (accountId) {
      cond.push('account_id = @account_id');
      params.account_id = accountId;
    }
    if (category) {
      cond.push('category = @category');
      params.category = category;
    }
    if (severity) {
      cond.push('severity = @severity');
      params.severity = severity;
    }
    if (eventId) {
      cond.push('event_id = @event_id');
      params.event_id = eventId;
    }
    if (since) {
      cond.push('created_at >= @since');
      params.since = since;
    }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    params.limit = Math.min(500, Math.max(1, limit));
    params.offset = Math.max(0, offset);
    const rows = db.prepare(`
      SELECT t.*, a.x_handle AS account_handle
      FROM plugin_telemetry t
      LEFT JOIN accounts a ON a.id = t.account_id
      ${where}
      ORDER BY t.created_at DESC
      LIMIT @limit OFFSET @offset
    `).all(params);
    return rows.map((r) => {
      let meta = {};
      try { meta = JSON.parse(r.meta_json || '{}'); } catch (_) {}
      return { ...r, meta };
    });
  }

  function latestSnapshot(accountId) {
    return db.prepare(`
      SELECT s.*, a.x_handle AS account_handle
      FROM telemetry_snapshots s
      LEFT JOIN accounts a ON a.id = s.account_id
      WHERE s.account_id = ?
      ORDER BY s.created_at DESC
      LIMIT 1
    `).get(accountId);
  }

  function listSnapshots(accountId, limit = 10) {
    return db.prepare(`
      SELECT id, account_id, session_id, created_at
      FROM telemetry_snapshots
      WHERE account_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(accountId, limit);
  }

  function getSnapshotById(id) {
    return db.prepare('SELECT * FROM telemetry_snapshots WHERE id = ?').get(id);
  }

  function countRecentByEvent(accountId, eventId, since) {
    const row = db.prepare(`
      SELECT COUNT(*) AS c FROM plugin_telemetry
      WHERE account_id = ? AND event_id = ? AND created_at >= ?
    `).get(accountId, eventId, since);
    return Number(row && row.c) || 0;
  }

  return {
    insertBatch,
    insertSnapshot,
    listEvents,
    latestSnapshot,
    listSnapshots,
    getSnapshotById,
    countRecentByEvent,
  };
}

module.exports = { createTelemetryRepo };

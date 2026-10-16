const { createLogRepo } = require('../../repositories/log-repo');

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

async function monitorLogApiRoutes(app) {
  const logRepo = createLogRepo(app.logDb);

  // 事件列表：/api/monitor/logs?account=&event_id=&event_ids=&severity=&since=&until=&limit=&offset=
  app.get('/api/monitor/logs', async (request) => {
    const q = request.query || {};
    const eventIds = q.event_ids
      ? String(q.event_ids).split(',').map((s) => s.trim()).filter(Boolean)
      : null;
    const rows = logRepo.listEvents({
      accountHandle: q.account || '',
      eventId: q.event_id || '',
      eventIds,
      severity: q.severity || '',
      category: q.category || '',
      board: q.board || '',
      keyword: q.keyword || '',
      since: q.since || '',
      until: q.until || '',
      limit: num(q.limit, 100),
      offset: num(q.offset, 0),
    });
    return { ok: true, events: rows, count: rows.length };
  });

  // 统计：/api/monitor/logs/stats?hours=24&account=
  app.get('/api/monitor/logs/stats', async (request) => {
    const q = request.query || {};
    const hours = Math.min(168, Math.max(1, num(q.hours, 24)));
    const accountHandle = q.account || '';
    let accountId = 0;
    if (accountHandle) {
      const row = app.db.prepare(
        'SELECT id FROM accounts WHERE LOWER(x_handle) = LOWER(?)'
      ).get(String(accountHandle).replace(/^@/, ''));
      accountId = row && row.id ? row.id : -1; // -1 → 查不到时返回空
    }
    const scope = accountId ? { accountId } : {};
    const sinceMs = Date.now() - hours * 3600 * 1000;
    const sinceSql = new Date(sinceMs).toLocaleString('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    }).replace(/(\d{4}-\d{2}-\d{2}),\s*(\d{2}:\d{2}:\d{2})/, '$1 $2');

    const trend = logRepo.hourlyTrend(hours, scope);
    const severity = logRepo.severityBreakdown({ since: sinceSql, ...scope });
    const accounts = app.logDb.prepare(`
      SELECT DISTINCT account_handle FROM log_events
      WHERE created_at >= @since AND account_handle IS NOT NULL AND TRIM(account_handle) != ''
      ORDER BY account_handle ASC
    `).all({ since: sinceSql }).map((r) => r.account_handle);

    const total = severity.reduce((s, x) => s + Number(x.c || 0), 0);
    return {
      ok: true,
      hours,
      total,
      severity,
      trend,
      accounts,
      generated_at: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
    };
  });

  // 快照列表：/api/monitor/logs/snapshots?account=&limit=
  app.get('/api/monitor/logs/snapshots', async (request) => {
    const q = request.query || {};
    const rows = logRepo.listSnapshots({
      accountHandle: q.account || '',
      limit: num(q.limit, 20),
      offset: num(q.offset, 0),
    });
    return { ok: true, snapshots: rows };
  });

  // 快照详情：/api/monitor/logs/snapshots/:id
  app.get('/api/monitor/logs/snapshots/:id', async (request) => {
    const snap = logRepo.getSnapshotById(num(request.params.id, 0));
    if (!snap) return { ok: false, msg: 'not_found' };
    let data = {};
    try { data = JSON.parse(snap.snapshot_json || '{}'); } catch (e) {}
    return { ok: true, snapshot: { ...snap, data } };
  });

  // 指挥闭环：按 pulseId 聚合 start→plan→progress→result→complete
  app.get('/api/monitor/logs/command-loop', async (request) => {
    const q = request.query || {};
    const hours = Math.min(168, Math.max(1, num(q.hours, 6)));
    const analysis = logRepo.analyzeCommandLoop({
      accountHandle: q.account || '',
      hours,
      limit: num(q.limit, 500),
    });
    return { ok: true, ...analysis };
  });
}

module.exports = { monitorLogApiRoutes };
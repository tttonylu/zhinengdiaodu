const { createLogRepo } = require('../../repositories/log-repo');
const { createAccountsRepo } = require('../../repositories/accounts-repo');

async function runtimeLogsPageRoutes(app) {
  const logRepo = createLogRepo(app.logDb);
  const accountsRepo = createAccountsRepo(app.db);

  app.get('/runtime-logs', async (request, reply) => {
    const limit = Math.min(200, Math.max(20, parseInt(request.query.limit, 10) || 100));
    const offset = Math.max(0, parseInt(request.query.offset, 10) || 0);
    const category = String(request.query.category || '').trim();
    const severity = String(request.query.severity || '').trim();
    const eventId = String(request.query.event_id || '').trim();
    const handle = String(request.query.handle || '').trim().replace(/^@/, '').toLowerCase();

    const logs = logRepo.listEvents({
      accountHandle: handle || '',
      category: category || '',
      severity: severity || '',
      eventId: eventId || '',
      limit,
      offset,
    });

    const accounts = accountsRepo.list ? accountsRepo.list({ limit: 200 }) : [];
    const accountList = Array.isArray(accounts) ? accounts : (accounts.rows || accounts.items || []);

    return reply.view('runtime-logs.njk', {
      title: '运行日志',
      logs,
      limit,
      offset,
      category,
      severity,
      eventId,
      handle,
      accounts: accountList,
    });
  });

  app.get('/runtime-logs/export', async (request, reply) => {
    const handle = String(request.query.handle || '').trim().replace(/^@/, '').toLowerCase();
    const logs = logRepo.listEvents({ accountHandle: handle || '', limit: 500, offset: 0 });
    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="runtime-logs.json"');
    return JSON.stringify({ exported_at: new Date().toISOString(), logs }, null, 2);
  });

  app.get('/runtime-logs/snapshot/:id', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const row = logRepo.getSnapshotById(id);
    if (!row) return reply.code(404).send('Snapshot not found');
    let snap = {};
    try { snap = JSON.parse(row.snapshot_json || '{}'); } catch (_) {}
    const account = row.account_id ? accountsRepo.findDetail(row.account_id) : null;
    return reply.view('runtime-logs-snapshot.njk', {
      title: '诊断包详情',
      snapshotId: id,
      snap,
      meta: row,
      account,
    });
  });

  app.get('/api/telemetry/snapshot/:id', async (request) => {
    const id = parseInt(request.params.id, 10);
    const row = logRepo.getSnapshotById(id);
    if (!row) return { ok: false, msg: 'not_found' };
    let parsed = null;
    try { parsed = JSON.parse(row.snapshot_json || '{}'); } catch (_) {}
    return { ok: true, snapshot: parsed, meta: row };
  });
}

module.exports = { runtimeLogsPageRoutes };
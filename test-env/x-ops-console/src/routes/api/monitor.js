const {
  buildOverview,
  fetchPoolStatus,
} = require('../../services/monitor-overview');
const { buildIssues, buildPipeline, shTime } = require('../../services/dm-chain-health');

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function loadIssueWindow(app, q) {
  const hours = Math.min(168, Math.max(1, num(q.hours, 24)));
  const sinceMs = Date.now() - hours * 3600 * 1000;
  const handle = String(q.account || '').replace(/^@/, '').trim();
  const cond = ['ts_ms >= @since_ms'];
  const params = { since_ms: sinceMs };
  if (handle) {
    cond.push('LOWER(account_handle) = LOWER(@handle)');
    params.handle = handle;
  }
  const events = app.logDb.prepare(`
    SELECT id, account_handle, event_id, severity, label_zh, meta_json, ts_ms, created_at
    FROM log_events
    WHERE ${cond.join(' AND ')}
    ORDER BY ts_ms DESC, id DESC
    LIMIT 8000
  `).all(params).map((r) => {
    let meta = {};
    try { meta = JSON.parse(r.meta_json || '{}') || {}; } catch (e) {}
    return { ...r, created_at: shTime(Number(r.ts_ms) || Date.now()), meta };
  });
  const bot = handle || (function () {
    const row = app.db.prepare('SELECT x_handle FROM accounts ORDER BY id LIMIT 1').get();
    return row ? row.x_handle : '';
  })();
  const roster = bot
    ? app.db.prepare('SELECT * FROM dm_roster_items WHERE bot_id = ?').all(bot)
    : [];
  const runtime = bot
    ? app.db.prepare('SELECT * FROM account_runtime_status WHERE LOWER(x_handle) = LOWER(?)').get(bot)
    : null;
  return { hours, sinceMs, bot, events, roster, runtime };
}

async function monitorApiRoutes(app) {
  app.get('/api/monitor/overview', async () => {
    const poolUrl =
      (app.appConfig && app.appConfig.poolUrl) ||
      process.env.POOL_URL ||
      'http://192.168.0.100:15678';
    const pool = await fetchPoolStatus(poolUrl);
    return buildOverview(app.db, pool, Date.now());
  });

  /**
   * 问题清单：/api/monitor/issues?hours=24&account=&severity=
   * 每条问题都带：代码、严重度、阶段、中文原因、修复建议、次数、首末时间、涉及会话、证据。
   */
  app.get('/api/monitor/issues', async (request) => {
    const q = request.query || {};
    const win = loadIssueWindow(app, q);
    const out = buildIssues({
      events: win.events,
      roster: win.roster,
      account: win.runtime,
      build: process.env.PLUGIN_BUILD || '',
      now: Date.now(),
    });
    const sev = String(q.severity || '').toLowerCase();
    const issues = sev ? out.issues.filter((i) => i.severity === sev) : out.issues;
    return {
      ok: true,
      hours: win.hours,
      account: win.bot,
      generated_at: shTime(Date.now()),
      totals: out.totals,
      builds: out.builds,
      issues,
    };
  });

  /**
   * 链路漏斗：/api/monitor/pipeline?hours=24&account=
   * 回答“扫了多少、开了多少、读出什么、发了什么、卡在哪个闸门”。
   */
  app.get('/api/monitor/pipeline', async (request) => {
    const q = request.query || {};
    const win = loadIssueWindow(app, q);
    return {
      ok: true,
      account: win.bot,
      generated_at: shTime(Date.now()),
      ...buildPipeline({ events: win.events, roster: win.roster, hours: win.hours }),
    };
  });
}

module.exports = { monitorApiRoutes };

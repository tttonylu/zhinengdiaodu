function toShanghai(utcStr) {
  if (!utcStr) return '';
  try {
    var d = new Date(utcStr);
    return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  } catch (_) { return utcStr; }
}

async function activityLogsPageRoutes(app) {
  app.get('/activity-logs', async (request, reply) => {
    var offset = parseInt(request.query.offset || '0') || 0;
    var limit = 50;
    var type = request.query.type || '';

    var sql = 'SELECT al.*, a.x_handle AS account_handle FROM activity_logs al LEFT JOIN accounts a ON a.id = al.account_id';
    var params = {};
    sql += ' ORDER BY al.created_at DESC LIMIT @limit OFFSET @offset';
    params.limit = limit;
    params.offset = offset;

    var rows = app.db.prepare(sql).all(params);
    var total = app.db.prepare('SELECT COUNT(*) AS c FROM activity_logs').get();

    // action types for filter
    var actionTypes = app.db.prepare(
      'SELECT DISTINCT action_type FROM activity_logs WHERE action_type IS NOT NULL ORDER BY action_type'
    ).all().map(r => r.action_type);

    return reply.view('activity-logs.njk', {
      title: '活动日志',
      logs: rows.map(r => ({ ...r, created_at: toShanghai(r.created_at) })),
      offset, limit, total: (total && total.c) || 0,
      actionTypes, selectedType: type,
    });
  });
}

module.exports = { activityLogsPageRoutes };

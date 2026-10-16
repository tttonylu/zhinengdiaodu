const { createLogRepo } = require('../../repositories/log-repo');

function shanghaiSince(hours) {
  return new Date(Date.now() - hours * 3600 * 1000).toLocaleString('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).replace(/(\d{4}-\d{2}-\d{2}),\s*(\d{2}:\d{2}:\d{2})/, '$1 $2');
}

const BOARDS = [
  ['A', '调度控制面'], ['B', '关注引擎'], ['C', '私信引擎'],
  ['D', '养号'], ['E', '转帖'], ['F', '配置同步'],
  ['G', '面板与观测'], ['H', 'OPS 后台'], ['I', '号池'],
  ['J', 'SCRM'], ['K', '自愈'],
];

async function errorsPageRoutes(app) {
  const logRepo = createLogRepo(app.logDb);

  app.get('/errors', async (request, reply) => {
    const q = request.query || {};
    const hours = Math.min(168, Math.max(1, parseInt(q.hours, 10) || 24));
    const board = String(q.board || '').trim().toUpperCase();
    const severity = String(q.severity || '').trim();
    const keyword = String(q.keyword || '').trim();
    const handle = String(q.handle || '').trim().replace(/^@/, '').toLowerCase();
    const since = shanghaiSince(hours);

    const events = logRepo.listEvents({
      accountHandle: handle || '',
      severity: severity || '',
      board: board || '',
      keyword: keyword || '',
      since,
      limit: 200,
      offset: 0,
    });

    const boards = logRepo.boardBreakdown({ since, accountHandle: handle || '' });
    const totalErrors = logRepo.countEvents({
      since,
      accountHandle: handle || '',
      severity: severity || '',
      board: board || '',
    });

    return reply.view('errors.njk', {
      title: '错误中心',
      events,
      boards,
      boardOptions: BOARDS,
      totalErrors,
      hours,
      board,
      severity,
      keyword,
      handle,
    });
  });
}

module.exports = { errorsPageRoutes };
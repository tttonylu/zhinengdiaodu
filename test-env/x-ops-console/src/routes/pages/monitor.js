const {
  buildOverview,
  fetchPoolStatus,
} = require('../../services/monitor-overview');

async function monitorPageRoutes(app) {
  const poolUrl =
    (app.appConfig && app.appConfig.poolUrl) ||
    process.env.POOL_URL ||
    'http://192.168.0.100:15678';
  const cache = app.ttlCache;

  app.get('/monitor', async (request, reply) => {
    const filter = String(request.query.filter || 'all').trim();
    const cacheKey = `monitor:overview:${filter}`;
    const cached = cache.getCached(cacheKey);
    if (cached) {
      return reply.view('monitor.njk', cached);
    }

    // 池不可达时最多阻塞 2s；命中缓存期间不再重复请求池
    let pool = null;
    try {
      pool = await fetchPoolStatus(poolUrl);
    } catch (e) {
      pool = { ok: false, error: e.message || 'unreachable' };
    }
    const overview = buildOverview(app.db, pool, Date.now());
    const viewData = {
      overview,
      generatedAt: overview.generated_at,
      filter,
    };
    // 池失败时缩短缓存，避免长期展示旧在线态
    const ttl = pool && pool.ok ? 20000 : 5000;
    cache.setCached(cacheKey, viewData, ttl);
    return reply.view('monitor.njk', viewData);
  });
}

module.exports = { monitorPageRoutes };

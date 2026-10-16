const {
  buildOverview,
  fetchPoolStatus,
} = require('../../services/monitor-overview');

async function monitorApiRoutes(app) {
  app.get('/api/monitor/overview', async () => {
    const poolUrl =
      (app.appConfig && app.appConfig.poolUrl) ||
      process.env.POOL_URL ||
      'http://192.168.0.100:15678';
    const pool = await fetchPoolStatus(poolUrl);
    return buildOverview(app.db, pool, Date.now());
  });
}

module.exports = { monitorApiRoutes };

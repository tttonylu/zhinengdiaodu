const { readConfig } = require('./config');
const { runMigrations } = require('./db/migrate');
const { runLogMigrations } = require('./db/migrate-log');
const { buildApp } = require('./app');
const { startScrmLinksSyncScheduler } = require('./services/scrm-links-sync');
const { startLogRetentionScheduler } = require('./services/log-retention');

async function start() {
  const config = readConfig();
  runMigrations(config.dbPath);
  runLogMigrations(config.logDbPath);
  const app = buildApp(config);
  const stopRetention = startLogRetentionScheduler({
    logDb: app.logDb,
    businessDb: app.db,
    dataDir: config.dataDir,
  });
  const stopScrmSync = startScrmLinksSyncScheduler(app);
  app.addHook('onClose', async () => {
    stopRetention();
    stopScrmSync();
  });
  await app.listen({ port: config.port, host: '0.0.0.0' });
  // 4.6.171 兜底：listen 后直接设置 http server 参数
  if (app.server) {
    // 注意：不能设 maxConnections，否则 Fastify 会在 accept 后立刻 RST 新连接
    // 限制连接数应该用 TCP backlog 或 nginx 层做
    app.server.keepAliveTimeout = 60000;
    console.log('[x-ops] server.listen OK keepAliveTimeout=60s');
  }
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});

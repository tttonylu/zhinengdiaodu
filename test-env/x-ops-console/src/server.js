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
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});

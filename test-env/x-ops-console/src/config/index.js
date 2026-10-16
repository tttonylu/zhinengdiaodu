const path = require('node:path');

function readConfig() {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  const syncEnabledRaw = process.env.SCRM_SYNC_ENABLED;

  return {
    port: Number(process.env.PORT || 5680),
    dataDir,
    dbPath: process.env.DB_PATH || path.join(dataDir, 'x-ops-console.sqlite'),
    logDbPath: process.env.LOG_DB_PATH || path.join(dataDir, 'x-ops-log.sqlite'),
    rulesPath: process.env.RULES_PATH || path.join(dataDir, 'rules.json'),
    scrmConfigUrl: process.env.SCRM_CONFIG_URL || 'http://192.168.0.100:3211/api/config',
    poolUrl: process.env.POOL_URL || 'http://192.168.0.100:15678',
    scrmSyncIntervalMs: Number(process.env.SCRM_SYNC_INTERVAL_MS || 5 * 60 * 1000),
    scrmSyncEnabled: syncEnabledRaw == null
      ? true
      : !['0', 'false', 'off', 'no'].includes(String(syncEnabledRaw).toLowerCase()),
  };
}

module.exports = { readConfig };

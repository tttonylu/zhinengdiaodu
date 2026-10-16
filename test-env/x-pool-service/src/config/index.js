const path = require('node:path');
const fs = require('node:fs');

function loadXCookies(dataDir, envCookies) {
  var list = Array.isArray(envCookies) ? [...envCookies] : [];
  var filePath = path.join(dataDir, 'accounts.json');
  var fileData = [];
  try {
    if (fs.existsSync(filePath)) {
      fileData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(fileData)) fileData = [];
    }
  } catch (e) {
    fileData = [];
  }

  var existingNames = new Set(list.map(function(c) { return c.name; }));
  fileData.forEach(function(c) {
    if (!existingNames.has(c.name)) {
      list.push(c);
    }
  });

  // Sync env cookies into file if they're not there yet
  var fileChanged = false;
  envCookies.forEach(function(c) {
    if (c.name && c.cookie && !fileData.some(function(f) { return f.name === c.name; })) {
      fileData.push(c);
      fileChanged = true;
    }
  });
  if (fileChanged) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(fileData, null, 2), 'utf8');
    } catch (e) { /* ignore */ }
  }

  return list;
}

function readConfig() {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  const envCookies = (() => {
    try {
      const raw = process.env.X_COOKIES || '[]';
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  })();

  return {
    port: Number(process.env.PORT || 5678),
    dataDir,
    dbPath: process.env.DB_PATH || path.join(dataDir, 'x-pool.sqlite'),
    assignExpireMinutes: Number(process.env.ASSIGN_EXPIRE_MINUTES || 60),
    expireIntervalMs: Math.max(60000, Number(process.env.EXPIRE_INTERVAL_MS || 5 * 60 * 1000)),
    xCookies: loadXCookies(dataDir, envCookies),
    httpProxy: process.env.HTTP_PROXY || process.env.http_proxy || '',
    inactiveHours: Math.max(1, Number(process.env.INACTIVE_HOURS || 72)),
    minFollowers: Math.max(0, Number(process.env.MIN_FOLLOWERS || 0)),
    maxFollowers: Math.max(0, Number(process.env.MAX_FOLLOWERS || 20000)),
    followingLimitBase: Math.max(0, Number(process.env.FOLLOWING_LIMIT_BASE || 50)),
    followingLimitRate: Math.max(0, Number(process.env.FOLLOWING_LIMIT_RATE || 0.01)),
    activityCheckTime: process.env.ACTIVITY_CHECK_TIME || '02:00',
    activityCheckBatchSize: Math.max(1, Number(process.env.ACTIVITY_CHECK_BATCH_SIZE || 200)),
  };
}

module.exports = { readConfig };
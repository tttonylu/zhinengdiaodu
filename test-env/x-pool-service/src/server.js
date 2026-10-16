const { readConfig } = require('./config');
const { runMigrations } = require('./db/migrate');
const { buildApp } = require('./app');
const { createPoolRepo } = require('./repositories/pool-repo');
const { createXClient } = require('./services/x-client');
const { createActivityChecker } = require('./services/activity-checker');

// 清理间隔：每6小时检查一次（单位：毫秒）
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CLEANUP_DAYS = 5;

function msUntilTime(timeStr) {
  const [hour, minute] = (timeStr || '02:00').split(':').map(Number);
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
}

function scheduleActivityCheck(config, repo, logger) {
  if (config.xCookies.length === 0) {
    var dataDir = config.dataDir || '';
    var fileCookies = dataDir ? repo.loadCookies(dataDir) : [];
    if (fileCookies.length === 0) {
      console.log('[ACTIVITY] no cookies configured (env or file), skipping nightly activity check');
      return;
    }
  }

  const ms = msUntilTime(config.activityCheckTime);

  setTimeout(() => {
    console.log('[ACTIVITY] starting nightly activity check...');
    var dataDir = config.dataDir || '';
    var fileCookies = dataDir ? repo.loadCookies(dataDir) : [];
    var allCookies = [];
    var seen = {};
    config.xCookies.forEach(function(c) { if (!seen[c.name]) { allCookies.push(c); seen[c.name] = true; } });
    fileCookies.forEach(function(c) { if (!seen[c.name]) { allCookies.push(c); seen[c.name] = true; } });

    const xClient = createXClient(allCookies, { logger, proxyUrl: config.httpProxy });
    const checker = createActivityChecker(repo, xClient, {
      logger,
      inactiveHours: config.inactiveHours,
      minFollowers: config.minFollowers,
      maxFollowers: config.maxFollowers,
      followingLimitBase: config.followingLimitBase,
      followingLimitRate: config.followingLimitRate,
      batchSize: config.activityCheckBatchSize,
    });
    checker.run()
      .then((result) => {
        console.log(`[ACTIVITY] check complete: ${result.checked} checked, ${result.deleted} deleted`);
      })
      .catch((err) => {
        console.error('[ACTIVITY-ERROR]', err.message);
      })
      .finally(() => {
        scheduleActivityCheck(config, repo, logger);
      });
  }, ms);

  const targetTime = new Date(Date.now() + ms);
  console.log(`[ACTIVITY] next check scheduled at ${targetTime.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
}

async function start() {
  const config = readConfig();
  runMigrations(config.dbPath);
  const app = buildApp(config);
  await app.listen({ port: config.port, host: '0.0.0.0' });

  // 启动定时清理：已完成超过5天的任务自动重置为 pending
  const repo = createPoolRepo(app.db, { logger: app.log, assignExpireMinutes: config.assignExpireMinutes });
  setInterval(() => {
    try {
      const result = repo.cleanupCompleted(CLEANUP_DAYS);
      if (result.cleaned > 0) {
        console.log(`[CLEANUP] 已重置 ${result.cleaned} 个超过${CLEANUP_DAYS}天的已完成任务`);
      }
    } catch (err) {
      console.error('[CLEANUP-ERROR]', err.message);
    }
  }, CLEANUP_INTERVAL_MS);

  // 启动定时回收：超时 assigned 自动回 pending，避免任务浪费
  setInterval(() => {
    try {
      const result = repo.expireStaleAssigned(config.assignExpireMinutes);
      if (result.expired > 0) {
        console.log(`[EXPIRE] 已回收 ${result.expired} 个超过${result.minutes}分钟的 assigned 任务`);
      }
    } catch (err) {
      console.error('[EXPIRE-ERROR]', err.message);
    }
  }, config.expireIntervalMs);

  // 启动时立即执行一次清理与回收
  try {
    const result = repo.cleanupCompleted(CLEANUP_DAYS);
    if (result.cleaned > 0) {
      console.log(`[CLEANUP] 启动时重置了 ${result.cleaned} 个超过${CLEANUP_DAYS}天的已完成任务`);
    }
  } catch (err) {
    console.error('[CLEANUP-ERROR]', err.message);
  }

  try {
    const result = repo.expireStaleAssigned(config.assignExpireMinutes);
    if (result.expired > 0) {
      console.log(`[EXPIRE] 启动时回收了 ${result.expired} 个超过${result.minutes}分钟的 assigned 任务`);
    }
  } catch (err) {
    console.error('[EXPIRE-ERROR]', err.message);
  }

  // 启动每晚定时活跃检测
  scheduleActivityCheck(config, repo, app.log);
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
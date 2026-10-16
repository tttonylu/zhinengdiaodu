const fs = require('node:fs');
const { linksApiRoutes } = require('./routes/api/links');
const { scrmApiRoutes } = require('./routes/api/scrm');
const path = require('node:path');
const Fastify = require('fastify');
const formbody = require('@fastify/formbody');
const fastifyCors = require('@fastify/cors');
const fastifyStatic = require('@fastify/static');
const fastifyView = require('@fastify/view');
const nunjucks = require('nunjucks');
const { createDb } = require('./db/client');
const { createTtlCache } = require('./utils/ttl-cache');
const { loadRules } = require('./services/rules-service');
const { pluginRoutes } = require('./routes/api/plugin');
const { scriptsApiRoutes } = require('./routes/api/scripts');
const { leadsPageRoutes } = require('./routes/pages/leads');
const { dashboardPageRoutes } = require('./routes/pages/dashboard');
const { accountsPageRoutes } = require('./routes/pages/accounts');
const { scriptsPageRoutes } = require('./routes/pages/scripts');
const { dmRecordsPageRoutes } = require('./routes/pages/dm-records');
const { activityLogsPageRoutes } = require('./routes/pages/activity-logs');
const { configApiRoutes } = require('./routes/api/config');
const { configPageRoutes } = require('./routes/pages/config');
const { analyticsPageRoutes } = require('./routes/pages/analytics');
const { monitorApiRoutes } = require('./routes/api/monitor');
const { monitorLogApiRoutes } = require('./routes/api/monitor-logs');
const { monitorPageRoutes } = require('./routes/pages/monitor');
const { poolProxyRoutes } = require('./routes/api/pool-proxy');
const { runtimeLogsPageRoutes } = require('./routes/pages/runtime-logs');
const { errorsPageRoutes } = require('./routes/pages/errors');
const { sourcesPageRoutes } = require('./routes/pages/sources');
const { contentPoolApiRoutes } = require('./routes/api/content-pool');
const { contentPageRoutes } = require('./routes/pages/content');
const { mediaDirFromApp } = require('./services/content-media');

function buildApp(options) {
  const app = Fastify({ logger: false });
  const db = createDb(options.dbPath);
  // H11 内容池配图目录：显式配置 > 环境变量 > services/content-media.js 默认值
  const contentMediaDir = mediaDirFromApp({
    contentMediaDir: options.contentMediaDir || process.env.CONTENT_MEDIA_DIR,
  });
  const logDbPath = options.logDbPath || (
    options.dbPath && options.dbPath !== ':memory:'
      ? path.join(path.dirname(options.dbPath), 'x-ops-log.sqlite')
      : ':memory:'
  );
  const logDb = createDb(logDbPath);
  const ttlCache = createTtlCache();

  app.decorate('appConfig', { ...options, contentMediaDir });
  app.decorate('db', db);
  app.decorate('logDb', logDb);
  app.decorate('ttlCache', ttlCache);
  app.decorate('getRules', () => loadRules(options.rulesPath));

  if (options.rulesPath && !fs.existsSync(options.rulesPath)) {
    fs.mkdirSync(path.dirname(options.rulesPath), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'config', 'rules.json'), options.rulesPath);
  }

  app.addHook('onClose', async () => {
    ttlCache.clear();
    db.close();
    logDb.close();
  });

  app.register(fastifyStatic, {
    root: path.join(__dirname, 'public'),
    prefix: '/public/',
  });

  // H11 内容池配图静态目录（第二次挂载不能再装饰 reply，故 decorateReply:false；
  // 文件名白名单校验由 /content-media/:file 路由兜底）
  fs.mkdirSync(contentMediaDir, { recursive: true });
  app.register(fastifyStatic, {
    root: contentMediaDir,
    prefix: '/content-media/',
    decorateReply: false,
  });

  app.register(fastifyView, {
    engine: { nunjucks },
    root: path.join(__dirname, 'views'),
  });
  app.register(formbody);
  app.register(fastifyCors, { origin: true });

  app.get('/health', async () => ({ ok: true, service: 'x-ops-console' }));

  app.get('/', async (request, reply) => {
    return reply.redirect('/dashboard');
  });

  app.register(pluginRoutes);
  app.register(scriptsApiRoutes);
  app.register(dashboardPageRoutes);
  app.register(accountsPageRoutes);
  app.register(leadsPageRoutes);
  app.register(scriptsPageRoutes);
  app.register(linksApiRoutes);
  app.register(scrmApiRoutes);
  app.register(dmRecordsPageRoutes);
  app.register(activityLogsPageRoutes);
  app.register(configApiRoutes);
  app.register(configPageRoutes);
  app.register(analyticsPageRoutes);
  app.register(monitorApiRoutes);
  app.register(monitorLogApiRoutes);
  app.register(monitorPageRoutes);
  app.register(poolProxyRoutes);
  app.register(runtimeLogsPageRoutes);
  app.register(errorsPageRoutes);
  app.register(sourcesPageRoutes);
  app.register(contentPoolApiRoutes);
  app.register(contentPageRoutes);

  return app;
}

module.exports = { buildApp };

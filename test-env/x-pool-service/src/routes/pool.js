const { createPoolRepo } = require('../repositories/pool-repo');
const { createXClient, parseCookieRaw } = require('../services/x-client');
const { createActivityChecker } = require('../services/activity-checker');
const { renderDashboardPage } = require('../views/dashboard-page');

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function tasksToCsv(tasks) {
  const columns = [
    'id',
    'handle',
    'status',
    'source',
    'worker_id',
    'attempts',
    'created_at',
    'updated_at',
    'assigned_at',
    'completed_at',
  ];
  const rows = tasks.map((task) => columns.map((column) => csvCell(task[column])).join(','));
  return [columns.join(','), ...rows].join('\n') + '\n';
}

async function poolRoutes(app) {
  const compactSecret = app.appConfig?.compactSecret || '';
  const repo = createPoolRepo(app.db, { logger: app.log, assignExpireMinutes: app.appConfig?.assignExpireMinutes });

  function loadCookiesFromAllSources(app) {
    var dataDir = app.appConfig?.dataDir || '';
    var envCookies = app.appConfig?.xCookies || [];
    var fileCookies = dataDir ? repo.loadCookies(dataDir) : [];
    var merged = [];
    var seen = {};
    envCookies.forEach(function(c) { if (!seen[c.name]) { merged.push(c); seen[c.name] = true; } });
    fileCookies.forEach(function(c) { if (!seen[c.name]) { merged.push(c); seen[c.name] = true; } });
    return merged;
  }

  app.get('/', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    return renderDashboardPage();
  });

  app.get('/health', async () => ({ ok: true, service: 'x-pool-service' }));

  app.get('/api/tasks', async (request) => {
    const tasks = repo.listTasks({ status: request.query?.status });
    return {
      ok: true,
      stats: repo.status(),
      tasks,
    };
  });

  app.post('/api/tasks', async (request) => {
    return repo.addHandles(request.body?.handles, request.body?.source);
  });

  app.delete('/api/tasks/:id', async (request, reply) => {
    const result = repo.deleteTask(request.params?.id);
    if (!result.ok) reply.code(404);
    return result;
  });

  app.get('/api/export/tasks.csv', async (request, reply) => {
    const tasks = repo.listTasks({ status: request.query?.status });
    reply
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="pool-tasks.csv"');
    return tasksToCsv(tasks);
  });

  app.post('/pool/push', async (request, reply) => {
    const result = repo.push(request.body?.handle, request.body?.source);
    if (!result.ok) reply.code(400);
    return result;
  });

  app.post('/pool/push_batch', async (request) => {
    return repo.pushBatch(request.body?.handles, request.body?.source);
  });

  app.get('/pool/pop', async (request) => {
    return repo.pop(request.query?.worker_id);
  });

  app.post('/pool/done', async (request, reply) => {
    const result = repo.done(request.body?.id);
    if (!result.ok) reply.code(404);
    return result;
  });

  app.post('/pool/done_by_handle', async (request, reply) => {
    const result = repo.doneByHandle(request.body?.handle);
    if (!result.ok) reply.code(404);
    return result;
  });

  // ---- 号池: 标记博主为死号（不存在/封禁/隐私） ----
  app.post('/pool/dead', async (request, reply) => {
    const result = repo.markDead(request.body?.id);
    if (!result.ok) reply.code(404);
    return result;
  });

  // ---- 号池: 通过 handle 标记死号 ----
  app.post('/pool/dead_by_handle', async (request, reply) => {
    const result = repo.markDeadByHandle(request.body?.handle);
    if (!result.ok) reply.code(404);
    return result;
  });


  // ---- 号池: 重排 ID 为连续编号（需要 secret） ----
  app.post('/pool/compact', async (request, reply) => {
    if (compactSecret && request.body?.secret !== compactSecret) {
      reply.code(403);
      return { ok: false, msg: 'forbidden: invalid secret' };
    }
    return repo.compactIds();
  });

  // ---- 号池: 恢复死号为 pending（手动救活，需要 secret） ----
  app.post('/pool/revive', async (request, reply) => {
    if (compactSecret && request.body?.secret !== compactSecret) {
      reply.code(403);
      return { ok: false, msg: 'forbidden: invalid secret' };
    }
    const result = repo.reviveDead(request.body?.id);
    if (!result.ok) reply.code(404);
    return result;
  });

  app.post('/pool/fail', async (request, reply) => {
    const result = repo.fail(request.body?.id);
    if (!result.ok) reply.code(404);
    return result;
  });

  app.get('/pool/status', async () => repo.status());

  app.get('/pool/links', async () => ({ ok: true, links: repo.getLinks() }));

  app.post('/pool/links', async (request) => {
    const links = repo.setLinks(request.body?.links);
    return { ok: true, count: links.length };
  });

  app.post('/pool/expire_assigned', async (request) => {
    const minutes = Number(request.body?.minutes) || repo.assignExpireMinutes || 60;
    return repo.expireStaleAssigned(minutes);
  });

  app.get('/pool/expire_preview', async (request) => {
    const minutes = Number(request.query?.minutes) || repo.assignExpireMinutes || 60;
    return repo.getAssignedExpiryPreview(minutes);
  });

  // ---- 号池: 清理已完成超过指定天数的任务（默认5天） ----
  app.post('/pool/cleanup', async (request) => {
    const days = Number(request.body?.days) || 5;
    return repo.cleanupCompleted(days);
  });

  // ---- 号池: 预览即将清理的任务数 ----
  app.get('/pool/cleanup_preview', async (request) => {
    const days = Number(request.query?.days) || 5;
    return repo.getCleanupPreview(days);
  });

  // ---- 号池: 活跃检测 ----
  app.post('/pool/activity-check', async (request, reply) => {
    var cookies = loadCookiesFromAllSources(app);
    if (cookies.length === 0) {
      reply.code(400);
      return { ok: false, msg: 'X_COOKIES not configured (need at least one account cookie)' };
    }
    const xClient = createXClient(cookies, { logger: app.log, proxyUrl: app.appConfig?.httpProxy });
    const checker = createActivityChecker(repo, xClient, {
      logger: app.log,
      inactiveHours: Number(request.body?.hours) || app.appConfig?.inactiveHours || 72,
      minFollowers: Number(request.body?.min_followers) || app.appConfig?.minFollowers || 0,
      maxFollowers: Number(request.body?.max_followers ?? app.appConfig?.maxFollowers ?? 20000) || 0,
      followingLimitBase: Number(request.body?.following_limit_base) || app.appConfig?.followingLimitBase || 50,
      followingLimitRate: Number(request.body?.following_limit_rate) || app.appConfig?.followingLimitRate || 0.01,
      batchSize: Number(request.body?.limit) || app.appConfig?.activityCheckBatchSize || 200,
    });
    return checker.run();
  });

  // ---- 号池: 活跃检测预览（不删除） ----
  app.get('/pool/activity-preview', async (request, reply) => {
    var cookies = loadCookiesFromAllSources(app);
    if (cookies.length === 0) {
      reply.code(400);
      return { ok: false, msg: 'X_COOKIES not configured (need at least one account cookie)' };
    }
    const xClient = createXClient(cookies, { logger: app.log, proxyUrl: app.appConfig?.httpProxy });
    const checker = createActivityChecker(repo, xClient, {
      logger: app.log,
      inactiveHours: Number(request.query?.hours) || app.appConfig?.inactiveHours || 72,
      minFollowers: Number(request.query?.min_followers) || app.appConfig?.minFollowers || 0,
      maxFollowers: Number(request.query?.max_followers ?? app.appConfig?.maxFollowers ?? 20000) || 0,
      followingLimitBase: Number(request.query?.following_limit_base) || app.appConfig?.followingLimitBase || 50,
      followingLimitRate: Number(request.query?.following_limit_rate) || app.appConfig?.followingLimitRate || 0.01,
      batchSize: Number(request.query?.limit) || app.appConfig?.activityCheckBatchSize || 200,
    });
    return checker.preview();
  });

  // ---- 号池: 活跃检测 SSE 实时日志流（执行） ----
  app.get('/pool/activity-check/stream', async (request, reply) => {
    var cookies = loadCookiesFromAllSources(app);
    if (cookies.length === 0) {
      reply.code(400);
      return { ok: false, msg: 'X_COOKIES not configured' };
    }
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event, data) => {
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const xClient = createXClient(cookies, { logger: app.log, proxyUrl: app.appConfig?.httpProxy });
    const checker = createActivityChecker(repo, xClient, {
      logger: app.log,
      inactiveHours: Number(request.query?.hours) || app.appConfig?.inactiveHours || 72,
      minFollowers: Number(request.query?.min_followers) || app.appConfig?.minFollowers || 0,
      maxFollowers: Number(request.query?.max_followers ?? app.appConfig?.maxFollowers ?? 20000) || 0,
      followingLimitBase: Number(request.query?.following_limit_base) || app.appConfig?.followingLimitBase || 50,
      followingLimitRate: Number(request.query?.following_limit_rate) || app.appConfig?.followingLimitRate || 0.01,
      batchSize: Number(request.query?.limit) || app.appConfig?.activityCheckBatchSize || 200,
      onProgress: (ev) => {
        send('progress', ev);
      },
    });

    try {
      await checker.run();
    } catch (err) {
      send('error', { message: err.message });
    }
    reply.raw.end();
  });

  // ---- 号池: 活跃检测 SSE 实时日志流（预览） ----
  app.get('/pool/activity-check/preview-stream', async (request, reply) => {
    var cookies = loadCookiesFromAllSources(app);
    if (cookies.length === 0) {
      reply.code(400);
      return { ok: false, msg: 'X_COOKIES not configured' };
    }
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event, data) => {
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const xClient = createXClient(cookies, { logger: app.log, proxyUrl: app.appConfig?.httpProxy });
    const checker = createActivityChecker(repo, xClient, {
      logger: app.log,
      inactiveHours: Number(request.query?.hours) || app.appConfig?.inactiveHours || 72,
      minFollowers: Number(request.query?.min_followers) || app.appConfig?.minFollowers || 0,
      maxFollowers: Number(request.query?.max_followers ?? app.appConfig?.maxFollowers ?? 20000) || 0,
      followingLimitBase: Number(request.query?.following_limit_base) || app.appConfig?.followingLimitBase || 50,
      followingLimitRate: Number(request.query?.following_limit_rate) || app.appConfig?.followingLimitRate || 0.01,
      batchSize: Number(request.query?.limit) || app.appConfig?.activityCheckBatchSize || 200,
      onProgress: (ev) => {
        send('progress', ev);
      },
    });

    try {
      await checker.preview();
    } catch (err) {
      send('error', { message: err.message });
    }
    reply.raw.end();
  });

  // ---- Cookie 管理 ----
  app.get('/pool/cookies', async (request) => {
    var dataDir = app.appConfig?.dataDir || '';
    return { ok: true, cookies: repo.loadCookies(dataDir) };
  });

  app.post('/pool/cookies', async (request) => {
    var dataDir = app.appConfig?.dataDir || '';
    var name = String(request.body?.name || '').trim();
    var cookie = String(request.body?.cookie || '').trim();
    if (!name || !cookie) {
      return { ok: false, msg: 'name and cookie required' };
    }
    // 自动解析 ~~~~ 格式，提取 username/password/cookie
    var parsed = parseCookieRaw(cookie);
    var rawInput = cookie;
    if (parsed) {
      cookie = parsed.cookie;
      if (parsed.username) request.body.username = parsed.username;
      if (parsed.password) request.body.password = parsed.password;
      if (parsed.email) request.body.email = parsed.email;
      if (parsed.email_password) request.body.email_password = parsed.email_password;
    }
    var acct = { name: name, cookie: cookie, _raw: rawInput };
    if (request.body.username) acct.username = request.body.username;
    if (request.body.password) acct.password = request.body.password;
    if (request.body.email) acct.email = request.body.email;
    if (request.body.email_password) acct.email_password = request.body.email_password;

    // Save _raw for future re-login
    var cookies = repo.loadCookies(dataDir);
    var existing = cookies.find(function(c) { return c.name === name; });
    if (existing) {
      // Merge: keep _raw from existing if new one doesn't have it
      if (!acct._raw && existing._raw) acct._raw = existing._raw;
      Object.assign(existing, acct);
    } else {
      cookies.push(acct);
    }
    repo.saveCookies(dataDir, cookies);
    return { ok: true, cookies: cookies, count: cookies.length };
  });

  app.delete('/pool/cookies/:name', async (request) => {
    var dataDir = app.appConfig?.dataDir || '';
    var name = String(request.params?.name || '').trim();
    if (!name) return { ok: false, msg: 'name required' };
    var cookies = repo.deleteCookie(dataDir, name);
    return { ok: true, cookies: cookies, count: cookies.length };
  });

  // ---- Cookie 连通性检测 ----
  app.post('/pool/cookies/test', async (request) => {
    var cookie = String(request.body?.cookie || '').trim();
    if (!cookie) return { ok: false, msg: 'cookie required' };

    var xClient;
    try {
      xClient = createXClient([{ name: '_test_', cookie: cookie }], { proxyUrl: app.appConfig?.httpProxy });
    } catch (e) {
      return { ok: false, msg: e.message };
    }

    try {
      var result = await xClient.lookupUser('Twitter');
      if (result.found) {
        return { ok: true, valid: true, msg: 'Cookie 有效', user: { followersCount: result.followersCount, followingCount: result.followingCount } };
      } else {
        return { ok: true, valid: false, msg: 'Cookie 无效: ' + result.reason };
      }
    } catch (e) {
      return { ok: false, msg: '检测异常: ' + e.message };
    }
  });
}

module.exports = { poolRoutes };
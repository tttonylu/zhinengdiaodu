const { createScrmStatusRepo } = require('../../repositories/scrm-status-repo');
const { sendNotify } = require('../../services/push-notify');
const { shanghaiNowTs } = require('../../utils/shanghai-date');
const { extractAgentIds, getPromoLinks } = require('../../services/scrm-links-sync');

function getScrmToken(db) {
  try {
    const row = db.prepare(
      "SELECT value FROM config_thresholds WHERE key = 'scrm_status_token'"
    ).get();
    return row && row.value ? String(row.value).trim() : '';
  } catch (e) {
    return '';
  }
}

function checkToken(request, db) {
  const expected = getScrmToken(db);
  if (!expected) return true; // 未配置则放开（内网）
  const got = request.headers['x-scrm-token'] || (request.body && request.body.token) || '';
  return String(got) === expected;
}

function resolveExpectedAgentIds(db) {
  return extractAgentIds(getPromoLinks(db));
}

function evaluateGateForDb(db, repo) {
  const r = repo || createScrmStatusRepo(db);
  return r.evaluateGate({ expectedAgentIds: resolveExpectedAgentIds(db) });
}

async function maybePushGateFail(app, gate) {
  const repo = createScrmStatusRepo(app.db);
  // soft 放行但存在「未配置监控号」等警告：仍推一次提醒（不拦私信）
  const softWarn = !!(gate && gate.allow_chat && gate.inherit_reason && /未配置监控号|未找到|状态过期|未上报/.test(String(gate.inherit_reason || gate.warn_reason || '')));
  if (gate && gate.allow_chat && !softWarn) return { pushed: false };
  if (gate && gate.force_allow && !softWarn) return { pushed: false };
  const reasonKey = softWarn
    ? String(gate.inherit_reason || gate.warn_reason || 'soft_warn')
    : (gate && gate.reason) || '未放行';
  if (!repo.shouldPushGateFail(reasonKey)) return { pushed: false, skipped: true };
  const agents = (gate.agents || []).map((a) => {
    if (a.not_found) return `${a.agent_id} 未找到`;
    return `${a.agent_id} ${a.online ? '在线' : '离线'}`;
  }).join('\n');
  const title = softWarn
    ? `SCRM提醒 · ${reasonKey}`
    : `SCRM闸门 · ${gate.reason || '未放行'}`;
  const content = [
    softWarn ? `软放行中但仍需处理: ${reasonKey}` : `原因: ${gate.reason}`,
    `快照: ${gate.snapshot_at || '-'}`,
    `在线: ${gate.online_count}/${gate.total_monitored}`,
    gate.not_found && gate.not_found.length ? `未找到: ${gate.not_found.join(', ')}` : '',
    agents ? `\n${agents}` : '',
    '',
    softWarn
      ? '私信未拦截，但请尽快换链并同步监控号，否则进线统计与客服对齐会失效。'
      : '私信已拦截。请检查换链并同步到 SCRM，确认客服在线。',
  ].filter(Boolean).join('\n');
  const r = await sendNotify(app.db, title, content);
  return { pushed: !!(r && r.ok), result: r, soft_warn: softWarn };
}

async function scrmApiRoutes(app) {
  const repo = createScrmStatusRepo(app.db);

  // 爬虫上报快照
  app.post('/api/scrm/status', async (request) => {
    if (!checkToken(request, app.db)) {
      return { ok: false, msg: 'unauthorized' };
    }
    const body = request.body || {};
    try {
      const saved = repo.upsertSnapshot(body, shanghaiNowTs());
      const gate = evaluateGateForDb(app.db, repo);
      let push = { pushed: false };
      try { push = await maybePushGateFail(app, gate); } catch (eP) {}
      app.ttlCache.invalidateCache('analytics:');
      app.ttlCache.invalidateCache('dashboard:');
      app.ttlCache.invalidateCache('monitor:');
      return { ok: true, ...saved, gate, push };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 只读闸门（页面/调试）
  app.get('/api/scrm/chat-gate', async () => {
    return evaluateGateForDb(app.db, repo);
  });

  // 插件闸门
  app.get('/api/plugin/scrm/chat-gate', async () => {
    return evaluateGateForDb(app.db, repo);
  });

  // 人工强制放行：open / extend / clear
  app.post('/api/scrm/force-allow', async (request) => {
    const body = request.body || {};
    const action = String(body.action || '').toLowerCase();
    const hours = Number(body.hours) || 6;
    let result;
    if (action === 'open') result = repo.openForceAllow(hours);
    else if (action === 'extend') result = repo.extendForceAllow(hours);
    else if (action === 'clear') result = repo.clearForceAllow();
    else return { ok: false, msg: 'action must be open|extend|clear' };
    const gate = evaluateGateForDb(app.db, repo);
    app.ttlCache.invalidateCache('dashboard:');
    app.ttlCache.invalidateCache('monitor:');
    return { ...result, gate };
  });

  // 闸门模式：soft（默认抗墙）| strict | off
  app.post('/api/scrm/gate-mode', async (request) => {
    const body = request.body || {};
    const result = repo.setGateMode(body.mode);
    if (!result.ok) return result;
    const gate = evaluateGateForDb(app.db, repo);
    app.ttlCache.invalidateCache('dashboard:');
    app.ttlCache.invalidateCache('monitor:');
    return { ...result, gate };
  });

  app.get('/api/scrm/summary', async () => {
    const gate = evaluateGateForDb(app.db, repo);
    const sync = repo.getLinkSync();
    let agentIds = [];
    try { agentIds = sync && sync.agent_ids_json ? JSON.parse(sync.agent_ids_json) : []; } catch (e) {}
    if (!agentIds.length) agentIds = gate.expected_agent_ids || [];
    return {
      ok: true,
      gate,
      link_sync: {
        agent_ids: agentIds,
        synced_at: (sync && sync.synced_at) || '',
      },
    };
  });

  // 外网直连 NAS:3211 常被中间网络打成 502；经 OPS 域名反代 cookie 同步
  function scrmMonitorBase() {
    const cfgUrl = (app.appConfig && app.appConfig.scrmConfigUrl)
      || process.env.SCRM_CONFIG_URL
      || 'http://192.168.0.100:3211/api/config';
    return String(cfgUrl).replace(/\/api\/config\/?$/i, '') || 'http://192.168.0.100:3211';
  }

  async function proxyToScrm(request, reply, subPath) {
    const target = `${scrmMonitorBase()}${subPath}`;
    const headers = { Accept: 'application/json' };
    const token = request.headers['x-cookie-token'] || (request.body && request.body.token);
    if (token) headers['X-Cookie-Token'] = String(token);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      headers['Content-Type'] = 'application/json';
    }
    try {
      const init = { method: request.method, headers };
      if (headers['Content-Type']) {
        init.body = JSON.stringify(request.body || {});
      }
      const r = await fetch(target, init);
      const text = await r.text();
      reply.code(r.status);
      try {
        return JSON.parse(text);
      } catch (e) {
        return { ok: false, error: 'bad_upstream', status: r.status, body: text.slice(0, 200) };
      }
    } catch (e) {
      reply.code(502);
      return { ok: false, error: `scrm_proxy_failed: ${e.message}`, target };
    }
  }

  app.options('/api/scrm/cookies/import', async (_req, reply) => {
    reply.code(204).send();
  });
  app.options('/api/scrm/cookies/status', async (_req, reply) => {
    reply.code(204).send();
  });

  app.get('/api/scrm/cookies/status', async (request, reply) => {
    return proxyToScrm(request, reply, '/api/cookies/status');
  });

  app.post('/api/scrm/cookies/import', async (request, reply) => {
    return proxyToScrm(request, reply, '/api/cookies/import');
  });
}

module.exports = { scrmApiRoutes, maybePushGateFail, evaluateGateForDb, resolveExpectedAgentIds };

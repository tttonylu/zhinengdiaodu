/**
 * 号池反代：外网插件把 pool_server 指到 OPS（kongzhi1）时，
 * /pool/* 转发到内网 x-pool-service。
 */
function poolProxyRoutes(app) {
  function poolBase() {
    const cfg = app.appConfig || {};
    return String(cfg.poolUrl || process.env.POOL_URL || 'http://192.168.0.100:15678').replace(
      /\/$/,
      ''
    );
  }

  async function forward(request, reply, pathAndQuery) {
    const target = `${poolBase()}${pathAndQuery}`;
    const headers = { Accept: 'application/json' };
    const method = request.method;
    const init = { method, headers };
    if (method !== 'GET' && method !== 'HEAD') {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(request.body == null ? {} : request.body);
    }
    try {
      const r = await fetch(target, init);
      const text = await r.text();
      reply.code(r.status);
      try {
        return text ? JSON.parse(text) : { ok: true };
      } catch (e) {
        return { ok: false, error: 'bad_upstream', status: r.status, body: text.slice(0, 200) };
      }
    } catch (e) {
      reply.code(502);
      return { ok: false, error: `pool_proxy_failed: ${e.message}`, target };
    }
  }

  // GET /pool/pop?worker_id=
  app.get('/pool/pop', async (request, reply) => {
    const q = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
    return forward(request, reply, `/pool/pop${q}`);
  });

  app.get('/pool/status', async (request, reply) => forward(request, reply, '/pool/status'));

  const posts = ['/pool/done', '/pool/fail', '/pool/dead', '/pool/dead_by_handle', '/pool/push', '/pool/push_batch'];
  for (const p of posts) {
    app.post(p, async (request, reply) => forward(request, reply, p));
  }
}

module.exports = { poolProxyRoutes };

const { syncLinksToScrm, syncLinksToScrmSafe, extractAgentIds } = require('../../services/scrm-links-sync');
const { createScrmStatusRepo } = require('../../repositories/scrm-status-repo');
const { shanghaiNowTs } = require('../../utils/shanghai-date');

async function linksApiRoutes(app) {
  const db = app.db;
  const scrmRepo = createScrmStatusRepo(db);

  function getLinks() {
    const row = db.prepare("SELECT value FROM script_settings WHERE key = 'promo_links'").get();
    if (!row) return [];
    try { return JSON.parse(row.value); } catch (_) { return [row.value]; }
  }

  function saveLinks(links) {
    db.prepare(`
      INSERT INTO script_settings (key, value, updated_at) VALUES ('promo_links', ?, datetime('now', '+8 hours'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', '+8 hours')
    `).run(JSON.stringify(links));
  }

  function pushScrm(links) {
    // 保存后立即推送；失败不阻断 OPS 保存（定时兜底会再补）
    syncLinksToScrmSafe(links, { appConfig: app.appConfig });
  }

  // 获取链接列表
  app.get('/api/links', async () => {
    return { ok: true, links: getLinks() };
  });

  // 保存链接列表
  app.post('/api/links', async (request) => {
    const { links } = request.body || {};
    if (!Array.isArray(links)) return { ok: false, msg: 'links 必须是数组' };
    const clean = links.map(l => String(l).trim()).filter(Boolean);
    saveLinks(clean);
    pushScrm(clean);
    return { ok: true, links: clean, msg: '链接已保存' };
  });

  // 添加单条链接
  app.post('/api/links/add', async (request) => {
    const { link } = request.body || {};
    if (!link) return { ok: false, msg: 'link 不能为空' };
    const links = getLinks();
    if (!links.includes(link.trim())) {
      links.push(link.trim());
      saveLinks(links);
    }
    pushScrm(links);
    return { ok: true, links };
  });

  // 删除单条链接
  app.post('/api/links/remove', async (request) => {
    const { link } = request.body || {};
    if (!link) return { ok: false, msg: 'link 不能为空' };
    const links = getLinks().filter(l => l !== link.trim());
    saveLinks(links);
    pushScrm(links);
    return { ok: true, links };
  });

  /**
   * 换链后手动同步到 SCRM(3211)：非每日打卡。
   * 晚上同步好明天的链接后，次日无需再点；放行只看 SCRM 在线检测。
   */
  app.post('/api/links/sync-scrm', async (request) => {
    const body = request.body || {};
    let links = getLinks();
    if (Array.isArray(body.links)) {
      links = body.links.map((l) => String(l).trim()).filter(Boolean);
      saveLinks(links);
    }
    const agentIds = extractAgentIds(links);
    try {
      const result = await syncLinksToScrm(links, { appConfig: app.appConfig });
      scrmRepo.saveLinkSync(agentIds, shanghaiNowTs());
      return {
        ok: !!result.ok,
        links,
        agentIds: result.agentIds || agentIds,
        skipped: !!result.skipped,
        msg: result.msg || result.error || '',
        synced_at: shanghaiNowTs(),
      };
    } catch (e) {
      return { ok: false, msg: e.message || String(e), agentIds };
    }
  });

  app.get('/api/links/sync-status', async () => {
    const sync = scrmRepo.getLinkSync();
    let agentIds = [];
    try { agentIds = sync && sync.agent_ids_json ? JSON.parse(sync.agent_ids_json) : []; } catch (e) {}
    return {
      ok: true,
      agent_ids: agentIds,
      synced_at: (sync && sync.synced_at) || '',
      gate: scrmRepo.evaluateGate({ expectedAgentIds: extractAgentIds(getLinks()) }),
    };
  });
}

module.exports = { linksApiRoutes };
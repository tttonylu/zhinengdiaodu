'use strict';

const { createSourcesRepo } = require('../../repositories/sources-repo');

/** H9 转帖来源号池页面 + 管理动作 */
async function sourcesPageRoutes(app) {
  const sourcesRepo = createSourcesRepo(app.db);

  app.get('/sources', async (request, reply) => {
    const sources = sourcesRepo.list();
    // 每个来源被哪些账号引用（读 override 反查，供页面展示引用关系）
    const refs = {};
    try {
      app.db.prepare("SELECT x_handle, value FROM config_account_overrides WHERE key = 'repost_targets'").all()
        .forEach((r) => {
          let list = [];
          try { const p = JSON.parse(r.value); if (Array.isArray(p)) list = p; } catch (e) {}
          list.forEach((x) => {
            const h = String(x || '').trim().replace(/^@/, '').toLowerCase();
            if (!h) return;
            (refs[h] = refs[h] || []).push(r.x_handle);
          });
        });
    } catch (e) {}
    return reply.view('sources.njk', {
      title: '转帖来源号池',
      sources,
      refs,
      msg: String((request.query || {}).msg || ''),
    });
  });

  // 新增（支持批量，每行/空格/逗号分隔一个 handle）
  app.post('/sources/add', async (request, reply) => {
    const body = request.body || {};
    const note = String(body.note || '').trim();
    const raw = String(body.handles || '').trim();
    const parts = raw.split(/[\s,，、\n]+/).map((s) => s.trim()).filter(Boolean);
    let n = 0;
    parts.forEach((p) => { if (sourcesRepo.add(p, note).ok) n += 1; });
    return reply.redirect('/sources?msg=' + encodeURIComponent(`已登记 ${n} 个来源号`));
  });

  app.post('/sources/:handle/status', async (request, reply) => {
    const body = request.body || {};
    const r = sourcesRepo.setStatus(request.params.handle, String(body.status || ''));
    return reply.redirect('/sources?msg=' + encodeURIComponent(r.ok ? `已标记 ${request.params.handle} 为 ${body.status}` : (r.msg || '失败')));
  });

  app.post('/sources/:handle/note', async (request, reply) => {
    const body = request.body || {};
    sourcesRepo.setNote(request.params.handle, body.note);
    return reply.redirect('/sources?msg=' + encodeURIComponent('备注已保存'));
  });

  app.post('/sources/:handle/delete', async (request, reply) => {
    sourcesRepo.remove(request.params.handle);
    return reply.redirect('/sources?msg=' + encodeURIComponent('已删除（不影响已勾选它的账号配置，需另行保存）'));
  });

  // 回填：把现有全局/账号配置里的来源号收编进池
  app.post('/sources/backfill', async (request, reply) => {
    const added = sourcesRepo.backfillFromConfig();
    return reply.redirect('/sources?msg=' + encodeURIComponent(`回填完成，新增 ${added} 个`));
  });
}

module.exports = { sourcesPageRoutes };

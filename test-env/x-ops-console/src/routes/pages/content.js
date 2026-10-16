'use strict';

const { createContentPoolRepo } = require('../../repositories/content-pool-repo');

const STATUS_LABEL = {
  pending: '待审', approved: '已批准', claimed: '待发/已领', posted: '已发', failed: '失败', rejected: '已拒',
};

/** /content 审核页：列表筛选 + 表单动作（与 JSON API 共用 repo） */
async function contentPageRoutes(app) {
  const repo = createContentPoolRepo(app.db);

  app.get('/content', async (request, reply) => {
    const q = request.query || {};
    let items = repo.listForReview({ status: q.status, date: q.date, accountHandle: q.handle })
      .map((it) => Object.assign({}, it, { status_label: STATUS_LABEL[it.status] || it.status }));
    // H11 线路筛选（persona 维度 tab）
    const lineFilter = String(q.line || '').trim();
    if (lineFilter) items = items.filter((it) => String(it.persona || '') === lineFilter);
    // H11：批量判定卡片 handle 是否已绑定台账发帖号（单次查询，避免 N+1）
    const bound = repo.registeredPosterSet(items.map((it) => it.account_handle));
    for (const it of items) it.poster_bound = bound.has(String(it.account_handle).toLowerCase());
    const counts = {};
    for (const s of Object.keys(STATUS_LABEL)) {
      counts[s] = repo.listForReview({ status: s }).length;
    }
    // H11 线路绑定面板：线路状态 + 台账全部可选发帖号（下拉框选项）
    const lines = repo.listLines();
    const lineLabelBy = {};
    for (const ln of lines) lineLabelBy[ln.persona] = ln.label;
    const posterOptions = [...repo.registeredPosterSet(
      app.db.prepare('SELECT x_handle FROM accounts').all().map((r) => r.x_handle)
    )].sort();
    return reply.view('content.njk', {
      title: '原创内容池', navActive: 'content',
      items, counts, STATUS: STATUS_LABEL,
      lines, lineLabelBy, posterOptions, lineFilter,
      status: q.status || '', date: q.date || '', handle: q.handle || '',
      msg: String(q.msg || ''),
    });
  });

  function back(request) {
    const b = String((request.body || {}).back || '/content');
    return /^\/content(\?|$)/.test(b) ? b : '/content';
  }

  function withMsg(loc, msg) {
    const sep = loc.includes('?') ? '&' : '?';
    return loc + sep + 'msg=' + encodeURIComponent(msg);
  }

  app.post('/content/approve', async (request, reply) => {
    const ids = [].concat((request.body || {}).ids || []).map(Number).filter(Boolean);
    const changed = repo.setStatus(ids, 'approved');
    return reply.redirect(withMsg(back(request), `已批准 ${changed} 条`));
  });
  app.post('/content/reject', async (request, reply) => {
    const ids = [].concat((request.body || {}).ids || []).map(Number).filter(Boolean);
    const changed = repo.setStatus(ids, 'rejected');
    return reply.redirect(withMsg(back(request), `已拒绝 ${changed} 条`));
  });
  app.post('/content/:id/reject', async (request, reply) => {
    repo.setStatus([Number(request.params.id)], 'rejected');
    return reply.redirect(withMsg(back(request), '已拒绝'));
  });
  app.post('/content/:id/retry', async (request, reply) => {
    repo.report(Number(request.params.id), 'retry', { failReason: 'manual_retry' });
    repo.setStatus([Number(request.params.id)], 'approved');
    return reply.redirect(withMsg(back(request), '已重置为待发'));
  });
  app.post('/content/:id/delete', async (request, reply) => {
    repo.remove([Number(request.params.id)]);
    return reply.redirect(withMsg(back(request), '已删除'));
  });
  app.post('/content/:id/edit', async (request, reply) => {
    const b = request.body || {};
    try {
      repo.edit(Number(request.params.id), { text: b.text, scheduledJstAt: b.scheduled_jst_at });
      return reply.redirect(withMsg(back(request), '已保存'));
    } catch (e) {
      return reply.redirect(withMsg(back(request), '保存失败：' + String(e.message || e)));
    }
  });
}

module.exports = { contentPageRoutes };

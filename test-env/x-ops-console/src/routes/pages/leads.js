const { createLeadsRepo } = require('../../repositories/leads-repo');
const { createLeadsService } = require('../../services/leads-service');

async function leadsPageRoutes(app) {
  const leadsRepo = createLeadsRepo(app.db);
  const leadsService = createLeadsService(leadsRepo);
  const cache = app.ttlCache;

  app.get('/leads', async (request, reply) => {
    const filters = {
      stage: request.query.stage || '',
      source: request.query.source || '',
      accountId: request.query.accountId ? Number(request.query.accountId) : '',
    };

    const cacheKey = `leads:${filters.stage}:${filters.source}:${filters.accountId}`;
    const cached = cache.getCached(cacheKey);
    if (cached) {
      return reply.view('leads.njk', cached);
    }

    const viewData = {
      title: '目标池',
      leads: leadsService.list(filters),
      filters,
    };
    cache.setCached(cacheKey, viewData, 30000);
    return reply.view('leads.njk', viewData);
  });

  app.get('/leads/:id', async (request, reply) => {
    const lead = leadsService.getDetail(Number(request.params.id));

    if (!lead) {
      return reply.code(404).send('Lead not found');
    }

    return reply.view('lead-detail.njk', {
      title: '目标详情',
      lead,
    });
  });

  app.post('/leads/:id/complete', async (request, reply) => {
    leadsService.markCompleted(Number(request.params.id));
    cache.invalidateCache('leads:');
    return reply.redirect(`/leads/${request.params.id}`);
  });

  app.post('/leads/:id/skip', async (request, reply) => {
    leadsService.markSkipped(Number(request.params.id));
    cache.invalidateCache('leads:');
    return reply.redirect(`/leads/${request.params.id}`);
  });
}

module.exports = { leadsPageRoutes };

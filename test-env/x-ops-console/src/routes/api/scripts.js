const { createScriptsRepo } = require('../../repositories/scripts-repo');

const TEMPLATE_TYPES = ['icebreaker', 'ad_template', 'kick_message', 'reject_message', 'foreigner_reject'];

async function scriptsApiRoutes(app) {
  // Extension-facing: get full script pool payload
  app.get('/api/scripts/pool', async () => {
    const repo = createScriptsRepo(app.db);
    return repo.getPoolPayload();
  });

  // List all script sets
  app.get('/api/scripts', async () => {
    const repo = createScriptsRepo(app.db);
    return { ok: true, sets: repo.listFullSets() };
  });

  // Get one script set
  app.get('/api/scripts/:setId', async (request, reply) => {
    const repo = createScriptsRepo(app.db);
    const set = repo.getFullSet(request.params.setId);
    if (!set) { reply.code(404); return { ok: false, msg: 'not found' }; }
    return { ok: true, set };
  });

  // Create or update a script set
  app.post('/api/scripts', async (request) => {
    const repo = createScriptsRepo(app.db);
    const { set_id, name, description, templates, enabled } = request.body || {};
    if (!set_id) return { ok: false, msg: 'set_id required' };

    repo.upsertSet(set_id, { name, description, enabled });
    if (templates) {
      for (const [type, content] of Object.entries(templates)) {
        if (TEMPLATE_TYPES.includes(type)) {
          repo.upsertTemplate(set_id, type, String(content || ''));
        }
      }
    }
    return { ok: true, set_id };
  });

  // Toggle enabled
  app.post('/api/scripts/:setId/enable', async (request) => {
    const repo = createScriptsRepo(app.db);
    const enabled = request.body?.enabled !== false;
    repo.setEnabled(request.params.setId, enabled);
    return { ok: true };
  });

  // Delete
  app.delete('/api/scripts/:setId', async (request, reply) => {
    const repo = createScriptsRepo(app.db);
    const set = repo.findSet(request.params.setId);
    if (!set) { reply.code(404); return { ok: false, msg: 'not found' }; }
    repo.deleteSet(request.params.setId);
    return { ok: true };
  });

  // Update shuffle mode
  app.post('/api/scripts/settings/shuffle', async (request) => {
    const repo = createScriptsRepo(app.db);
    const mode = request.body?.mode || 'random';
    repo.setSetting('shuffle_mode', mode);
    return { ok: true, mode };
  });
}

module.exports = { scriptsApiRoutes };
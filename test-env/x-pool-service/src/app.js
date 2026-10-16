const Fastify = require('fastify');
const { createDb } = require('./db/client');
const { poolRoutes } = require('./routes/pool');

function buildApp(options) {
  const app = Fastify({ logger: true });
  const db = createDb(options.dbPath);

  app.decorate('appConfig', options);
  app.decorate('db', db);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type');
    if (request.method === 'OPTIONS') {
      reply.code(204).send();
    }
  });

  app.addHook('onClose', async () => {
    db.close();
  });

  app.register(poolRoutes);

  return app;
}

module.exports = { buildApp };

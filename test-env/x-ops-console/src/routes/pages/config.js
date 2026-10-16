async function configPageRoutes(app) {
  var db = app.db;

  app.get('/config', async (request, reply) => {
    var thresholds = {};
    try {
      db.prepare('SELECT key, value FROM config_thresholds').all().forEach(function (r) { thresholds[r.key] = tryParse(r.value); });
    } catch (e) {}

    var stagePolicy = {};
    try {
      var spRow = db.prepare('SELECT policy FROM config_stage_policy ORDER BY id DESC LIMIT 1').get();
      if (spRow) stagePolicy = tryParse(spRow.policy);
    } catch (e) {}

    var modules = {};
    try {
      db.prepare('SELECT module, enabled FROM config_module_switches').all().forEach(function (r) { modules[r.module] = !!r.enabled; });
    } catch (e) {}

    // 转帖来源号：DB 可能是 JSON 数组，模板要纯文本
    var repostSelected = [];
    try {
      var rt = thresholds.repost_targets;
      if (Array.isArray(rt)) {
        repostSelected = rt.map(function(h){return String(h||'').trim().replace(/^@/,'').toLowerCase()}).filter(Boolean);
      } else if (typeof rt === 'string' && rt) {
        try {
          var parsed = JSON.parse(rt);
          repostSelected = (Array.isArray(parsed) ? parsed : []).map(function(h){return String(h||'').trim().replace(/^@/,'').toLowerCase()}).filter(Boolean);
        } catch (e2) {}
      }
      thresholds.repost_targets_text = repostSelected.join('\n');
    } catch (e3) {
      thresholds.repost_targets_text = '';
    }

    // H9：来源号池（供全局默认勾选）
    var sourcePool = [];
    try {
      var createSourcesRepo = require('../../repositories/sources-repo').createSourcesRepo;
      sourcePool = createSourcesRepo(db).list();
    } catch (eSrc) {}

    return reply.view('config', {
      title: '系统配置',
      thresholds: thresholds,
      stagePolicy: stagePolicy,
      modules: modules,
      repost_selected: repostSelected,
      source_pool: sourcePool,
      stagePolicyJSON: JSON.stringify(stagePolicy, null, 2),
      thresholdsJSON: JSON.stringify(thresholds, null, 2),
      modulesJSON: JSON.stringify(modules)
    });
  });
}

function tryParse(v) {
  try { return JSON.parse(v); } catch (e) { return v; }
}

module.exports = { configPageRoutes };

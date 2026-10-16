function extractHandle(botId) {
  const { extractHandle: ex } = require('../../utils/handle');
  return ex(botId) || null;
}

const { parseAccountTags, tagDisabledModules } = require('../../utils/account-tags');

function tryParse(v) {
  try { return JSON.parse(v); } catch (e) { return v; }
}

/** H9 来源号池：组装 repost_targets 时剔除 banned（契约 H9↔E1/F1） */
function filterBannedSources(db, raw) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string' && raw.trim()) {
    try { const p = JSON.parse(raw); if (Array.isArray(p)) list = p; } catch (e) { return raw; }
  } else return raw;
  try {
    const banned = new Set(
      db.prepare("SELECT handle FROM repost_sources WHERE status = 'banned'").all()
        .map((r) => String(r.handle).toLowerCase())
    );
    if (!banned.size) return list;
    return list.filter((h) => !banned.has(String(h || '').trim().replace(/^@/, '').toLowerCase()));
  } catch (e) { return list; } // 表不存在等异常 → 放行不过滤
}

function loadGlobalConfig(db) {
  const thresholds = {};
  db.prepare('SELECT key, value FROM config_thresholds').all()
    .forEach(function (r) { thresholds[r.key] = tryParse(r.value); });

  // H9：全局来源列表剔除 banned
  thresholds.repost_targets = filterBannedSources(db, thresholds.repost_targets);

  const spRow = db.prepare('SELECT policy FROM config_stage_policy ORDER BY id DESC LIMIT 1').get();
  const stagePolicy = spRow ? tryParse(spRow.policy) : {};

  const modules = {};
  db.prepare('SELECT module, enabled FROM config_module_switches').all()
    .forEach(function (r) { modules[r.module] = !!r.enabled; });

  return { thresholds, stagePolicy, modules };
}

/** 全局配置 + 账号字段/覆盖项 → 插件下发快照（db 可选：传入时 H9 剔除 banned 来源） */
function mergeAccountConfig(global, account, overrideRows, db) {
  const thresholds = { ...global.thresholds };
  const modules = { ...global.modules };
  const accountMeta = { x_handle: account ? account.x_handle : null };

  if (account) {
    if (account.day_count != null) {
      accountMeta.day_count = account.day_count;
    }
    if (account.daily_follow_limit != null) {
      // 账号日限只作「更高封顶」覆盖，避免库默认 200 把 Day5/6 区间压死
      accountMeta.daily_follow_limit = account.daily_follow_limit;
      var globalCap = parseInt(thresholds.follow_daily_limit, 10);
      var acctCap = parseInt(account.daily_follow_limit, 10);
      if (!isNaN(acctCap) && (isNaN(globalCap) || acctCap > globalCap)) {
        thresholds.follow_daily_limit = acctCap;
      }
    }
    if (account.daily_dm_limit != null) {
      thresholds.dm_daily_limit = account.daily_dm_limit;
      accountMeta.daily_dm_limit = account.daily_dm_limit;
    }
    if (account.daily_repost_limit != null) {
      var rpLimit = parseInt(account.daily_repost_limit, 10);
      if (!isNaN(rpLimit) && rpLimit > 0) {
        // 覆盖 cap + 两个 quota，引擎 getEffectiveDailyLimit = min(quota, cap) = rpLimit
        thresholds.repost_daily_cap = rpLimit;
        thresholds.repost_day14_quota = rpLimit;
        thresholds.repost_day5_quota = rpLimit;
      }
      accountMeta.daily_repost_limit = account.daily_repost_limit;
    }
  }

  const overrides = {};
  (overrideRows || []).forEach(function (row) {
    overrides[row.key] = tryParse(row.value);
    if (row.key.startsWith('module_')) {
      modules[row.key.slice(7)] = row.value === '1' || row.value === 'true' || row.value === true;
    } else {
      thresholds[row.key] = tryParse(row.value);
    }
  });

  // 标签掩码最后套用：标签关闭 > 手动 override（关闭优先，安全侧）；多标签取关闭并集
  accountMeta.tags = parseAccountTags(account);
  accountMeta.tag_disabled = tagDisabledModules(account);
  accountMeta.tag_disabled.forEach(function (m) { modules[m] = false; });

  // H9：override 覆盖后的最终来源列表再剔除 banned
  if (db) thresholds.repost_targets = filterBannedSources(db, thresholds.repost_targets);

  accountMeta.overrides = overrides;
  // 账号级上班/下班（069/H10）：同时覆盖 chatHours（私信窗，下班=私信停止）与 workHours（调度窗/转帖开跑）对应侧；留空=跟随全局
  let stagePolicy = global.stagePolicy;
  if (account && (account.work_start || account.work_end)) {
    const parseHM = (v) => {
      const m = String(v || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
      return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : null;
    };
    try {
      const sp = JSON.parse(JSON.stringify(global.stagePolicy || {}));
      sp.workHours = sp.workHours || { start: [10, 0], end: [19, 0] };
      sp.chatHours = sp.chatHours || { start: [10, 0], end: [19, 0] };
      const ws = parseHM(account.work_start);
      const we = parseHM(account.work_end);
      if (ws) { sp.workHours.start = ws; sp.chatHours.start = ws; }
      if (we) { sp.workHours.end = we; sp.chatHours.end = we; }
      stagePolicy = sp;
      accountMeta.work_hours = { work_start: account.work_start, work_end: account.work_end };
    } catch (eSP) { /* 克隆失败回退全局 */ }
  }

  return {
    thresholds,
    stagePolicy,
    modules,
    account: accountMeta,
  };
}

async function configApiRoutes(app) {
  const db = app.db;
  const { createAccountsRepo } = require('../../repositories/accounts-repo');
  const accountsRepo = createAccountsRepo(db);

  // ============ 阈值 ============
  app.get('/api/config/thresholds', async () => {
    const rows = db.prepare('SELECT key, value FROM config_thresholds').all();
    var out = {};
    rows.forEach(function (r) { out[r.key] = tryParse(r.value); });
    return { ok: true, thresholds: out };
  });

  app.post('/api/config/thresholds', async (request) => {
    var data = request.body || {};
    var stmt = db.prepare("INSERT INTO config_thresholds (key, value, updated_at) VALUES (?, ?, datetime('now', '+8 hours')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', '+8 hours')");
    var batch = db.transaction(function (items) {
      for (var k in items) { stmt.run(k, String(items[k])); }
    });
    batch(data);

    // 2026-10-14 用户定调：保存关注阈值不再清零「今日已关注」。
    // 原实现在此对全部账号下发 reset_follow_daily_limit + clearFollowActivityToday，
    // 导致「一保存关注阈值，当天关注数就归零」（计数被误当成按保存阈值重置）。
    // 现约定：关注日限计数只按北京日期（Asia/Shanghai）跨日归零——
    //   插件 matrix_stats_<handle>.date 上海日串比较（见手册 §A2 / §X H1↔A2/F）；
    //   OPS activity_logs follow/success、account_runtime_status.followed_today 同用上海日。
    // 新 DayN 区间仍由 F1 config-sync 约 1 分钟下发，插件对「区间外旧锁」自动重抽（不清已用数）。
    // 需人工清零时走账号页「重锁今日关注配额」按钮（白名单命令 reset_follow_daily_limit 保留）。
    return { ok: true, msg: '阈值已保存（关注计数不重置）' };
  });

  // ============ 阶段策略 ============
  app.get('/api/config/stage-policy', async () => {
    var row = db.prepare('SELECT policy, version FROM config_stage_policy ORDER BY id DESC LIMIT 1').get();
    return { ok: true, stagePolicy: row ? tryParse(row.policy) : {}, version: row ? row.version : '' };
  });

  app.post('/api/config/stage-policy', async (request) => {
    var policy = request.body || {};
    // 转帖是过渡试验：禁止写入白天阶段 priority，免误配抢主线
    try {
      if (policy.stages) {
        ['S1', 'S2', 'S3', 'S4'].forEach(function (sk) {
          var st = policy.stages[sk];
          if (st && Array.isArray(st.priority)) {
            st.priority = st.priority.filter(function (n) { return n !== 'repost'; });
          }
        });
      }
    } catch (eStrip) {}
    // 非 test24h：禁止 end≥24（永不进 S0）；允许跨夜窗（如 06:00–02:00，end<start）
    // 小时一律 0–23/24（h23），与插件 TimeUtil 一致
    try {
      var t24 = policy.test24h === true || policy.test24h === 1 || policy.test24h === 'true';
      if (policy.workHours && Array.isArray(policy.workHours.start) && Array.isArray(policy.workHours.end)) {
        var shN = parseInt(policy.workHours.start[0], 10);
        var ehN = parseInt(policy.workHours.end[0], 10);
        if (isNaN(shN) || shN < 0 || shN > 23) policy.workHours.start[0] = 10;
        if (isNaN(ehN) || ehN < 0 || ehN > 24) policy.workHours.end[0] = 19;
        if (policy.workHours.start[1] == null) policy.workHours.start[1] = 0;
        if (policy.workHours.end[1] == null) policy.workHours.end[1] = 0;
      }
      if (!t24 && policy.workHours && Array.isArray(policy.workHours.end)) {
        var eh = parseInt(policy.workHours.end[0], 10);
        if (!isFinite(eh) || eh >= 24) {
          policy.workHours.start = [10, 0];
          policy.workHours.end = [19, 0];
        } else {
          var ws = (parseInt(policy.workHours.start[0], 10) || 0) * 60 + (parseInt(policy.workHours.start[1], 10) || 0);
          var we = eh * 60 + (parseInt(policy.workHours.end[1], 10) || 0);
          // 仅拒绝零宽窗；we < ws 视为跨夜合法
          if (we === ws) {
            policy.workHours = { start: [10, 0], end: [19, 0] };
          }
        }
      }
      if (!t24 && policy.chatHours && Array.isArray(policy.chatHours.end)) {
        var ce = parseInt(policy.chatHours.end[0], 10);
        if (!isFinite(ce) || ce >= 24) {
          policy.chatHours.end = [18, policy.chatHours.end[1] || 0];
        } else {
          var cs = (parseInt(policy.chatHours.start[0], 10) || 0) * 60 + (parseInt(policy.chatHours.start[1], 10) || 0);
          var cem = ce * 60 + (parseInt(policy.chatHours.end[1], 10) || 0);
          // 私信保持日窗 08–18；零宽才回默认（跨夜私信不在此需求）
          if (cem === cs) {
            policy.chatHours = { start: [8, 0], end: [18, 0] };
          }
        }
      }
    } catch (eClamp) {}
    var version = '2026-07-' + String(new Date().getDate()).padStart(2, '0') + '-' + String(Date.now() % 100000);
    db.prepare("INSERT INTO config_stage_policy (version, policy, updated_at) VALUES (?, ?, datetime('now', '+8 hours'))")
      .run(version, JSON.stringify(policy));
    return { ok: true, version: version, msg: '阶段策略已保存' };
  });

  // ============ 模块开关 ============
  app.get('/api/config/modules', async () => {
    var rows = db.prepare('SELECT module, enabled FROM config_module_switches').all();
    var out = {};
    rows.forEach(function (r) { out[r.module] = !!r.enabled; });
    return { ok: true, modules: out };
  });

  app.post('/api/config/modules', async (request) => {
    var modules = request.body || {};
    var stmt = db.prepare("INSERT INTO config_module_switches (module, enabled, updated_at) VALUES (?, ?, datetime('now', '+8 hours')) ON CONFLICT(module) DO UPDATE SET enabled = excluded.enabled, updated_at = datetime('now', '+8 hours')");
    var batch = db.transaction(function (items) {
      for (var k in items) { stmt.run(k, items[k] ? 1 : 0); }
    });
    batch(modules);
    return { ok: true, msg: '模块开关已保存' };
  });

  // ============ 按账号配置 ============
  app.get('/api/config/account/:handle', async (request) => {
    const handle = extractHandle(request.params.handle);
    if (!handle) return { ok: false, msg: 'handle required' };

    const account = accountsRepo.findByHandle(handle);
    const global = loadGlobalConfig(db);
    const overrideRows = accountsRepo.listOverrides(handle);
    const merged = mergeAccountConfig(global, account, overrideRows, db);

    return {
      ok: true,
      handle,
      account: account || null,
      global: { thresholds: global.thresholds, modules: global.modules },
      effective: {
        thresholds: merged.thresholds,
        modules: merged.modules,
      },
      overrides: merged.account.overrides,
    };
  });

  app.post('/api/config/account/:handle', async (request) => {
    const handle = extractHandle(request.params.handle);
    if (!handle) return { ok: false, msg: 'handle required' };

    const body = request.body || {};
    let account = accountsRepo.findByHandle(handle);
    // 防幽灵：配置保存不新建账号（须先由插件 register）
    if (!account) {
      return { ok: false, error: 'account_not_registered', handle, msg: '账号未注册，请先用插件登录并注册' };
    }

    if (body.daily_follow_limit != null || body.daily_dm_limit != null || body.daily_repost_limit != null) {
      accountsRepo.updateLimits(handle, {
        daily_follow_limit: body.daily_follow_limit != null ? Number(body.daily_follow_limit) : null,
        daily_dm_limit: body.daily_dm_limit != null ? Number(body.daily_dm_limit) : null,
        daily_repost_limit: body.daily_repost_limit != null ? Number(body.daily_repost_limit) : null,
      });
      account = accountsRepo.findByHandle(handle);
    }

    if (body.day_count != null && body.day_count !== '') {
      var dc = Math.max(1, Math.min(9999, parseInt(body.day_count, 10) || 1));
      accountsRepo.updateDayCount(handle, dc);
      account = accountsRepo.findByHandle(handle);
    }

    // 069：账号级上班/下班；空串/null=清除（回落全局）
    if (body.work_start !== undefined || body.work_end !== undefined) {
      const wh = accountsRepo.updateWorkHours(handle, body.work_start, body.work_end);
      if (!wh.ok) {
        return { ok: false, msg: wh.msg || '上班/下班保存失败' };
      }
      account = accountsRepo.findByHandle(handle);
    }

    if (Array.isArray(body.tags)) {
      const { normalizeTags } = require('../../utils/account-tags');
      const norm = normalizeTags(body.tags);
      if (!norm.ok) {
        return { ok: false, msg: '未知标签：' + norm.unknown.join(', ') };
      }
      accountsRepo.setTags(handle, norm.tags);
      account = accountsRepo.findByHandle(handle);
    }

    if (body.overrides && typeof body.overrides === 'object') {
      const batch = db.transaction(function (items) {
        for (const key in items) {
          const val = items[key];
          if (val === null || val === '' || val === undefined) {
            accountsRepo.deleteOverride(handle, key);
          } else {
            accountsRepo.setOverride(handle, key, val);
          }
        }
      });
      batch(body.overrides);
    }

    if (body.modules && typeof body.modules === 'object') {
      const batch = db.transaction(function (items) {
        for (const mod in items) {
          // null → 删除 override（用于标签关闭的模块：状态跟随标签，移除标签后回落全局）
          if (items[mod] === null) {
            accountsRepo.deleteOverride(handle, 'module_' + mod);
            continue;
          }
          accountsRepo.setOverride(handle, 'module_' + mod, items[mod] ? '1' : '0');
        }
      });
      batch(body.modules);
    }

    app.ttlCache.invalidateCache('accounts:');
    app.ttlCache.invalidateCache('dashboard:');
    app.ttlCache.invalidateCache('monitor:');

    const global = loadGlobalConfig(db);
    const overrideRows = accountsRepo.listOverrides(handle);
    const merged = mergeAccountConfig(global, account, overrideRows, db);

    return {
      ok: true,
      msg: '账号配置已保存',
      effective: {
        thresholds: merged.thresholds,
        modules: merged.modules,
      },
    };
  });

  // ============ 全量拉取（插件用，支持 bot_id 按账号合并） ============
  app.get('/api/config/all', async (request) => {
    const botId = request.query.bot_id || request.query.worker_id || '';
    const handle = extractHandle(botId);
    const global = loadGlobalConfig(db);

    if (!handle) {
      return { ok: true, ...global, account: null };
    }

    // 后端错峰：首次拉取时按号写入固定开跑 override（不改插件）
    try {
      accountsRepo.assignRepostStaggerForHandle(handle, {
        baseHour: parseInt(global.thresholds.repost_start_hour, 10) || 20,
        baseMin: parseInt(global.thresholds.repost_start_min, 10) || 0,
        windowMin: parseInt(global.thresholds.repost_stagger_window_min, 10)
          || parseInt(global.thresholds.repost_start_jitter_max_min, 10)
          || 240,
        force: false
      });
    } catch (eStagger) {}

    const account = accountsRepo.findByHandle(handle);
    const overrideRows = accountsRepo.listOverrides(handle);
    const merged = mergeAccountConfig(global, account, overrideRows, db);
    const cmdRow = accountsRepo.getCommand(handle);
    if (merged.account && account) {
      merged.account.today_follow_count = accountsRepo.countFollowsToday(account.id);
    }

    return {
      ok: true,
      thresholds: merged.thresholds,
      stagePolicy: merged.stagePolicy,
      modules: merged.modules,
      account: merged.account,
      command: cmdRow ? cmdRow.command : null,
    };
  });

  // ============ 批量分配转帖错峰（仅 OPS，插件零改） ============
  app.post('/api/config/repost-stagger-assign', async (request) => {
    var body = request.body || {};
    var global = loadGlobalConfig(db);
    var baseHour = parseInt(body.baseHour != null ? body.baseHour : global.thresholds.repost_start_hour, 10);
    var baseMin = parseInt(body.baseMin != null ? body.baseMin : global.thresholds.repost_start_min, 10);
    var windowMin = parseInt(
      body.windowMin != null
        ? body.windowMin
        : (global.thresholds.repost_stagger_window_min || global.thresholds.repost_start_jitter_max_min || 240),
      10
    );
    var force = body.force === true || body.force === '1' || body.force === 1;
    var result = accountsRepo.assignRepostStaggerAll({
      baseHour: isFinite(baseHour) ? baseHour : 20,
      baseMin: isFinite(baseMin) ? baseMin : 0,
      windowMin: isFinite(windowMin) ? windowMin : 240,
      force: force
    });
    // 全局关掉插件本地抖动，错峰只认账号 override 开跑点
    try {
      db.prepare(
        "INSERT INTO config_thresholds (key, value, updated_at) VALUES ('repost_start_jitter_max_min', '0', datetime('now', '+8 hours')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', '+8 hours')"
      ).run();
    } catch (eJ) {}
    return { ok: true, msg: '已分配转帖错峰', ...result, baseHour: baseHour || 20, baseMin: baseMin || 0, windowMin: windowMin || 240 };
  });

  // ============ 养号评论模板 ============
  var DEFAULT_COMMENTS = {
    categories: [
      { id: 'morning', name: '早晨', templates: ['おはようございます','朝から頑張ってますね','今日も一日頑張りましょう','おはよう☀️','朝活お疲れ様です','素敵な朝ですね','今日もいい日になりますように','早起きですね','清々しい朝です','今日も元気にいきましょう'] },
      { id: 'evening', name: '晚间', templates: ['お疲れ様です','こんばんは','今日もお疲れ様でした','ゆっくり休んでくださいね','充実した一日でしたか','おやすみなさい','夜更かし注意ですよ','いい夢見てください'] },
      { id: 'praise', name: '赞美', templates: ['すごいですね','素敵です✨','感動しました','素晴らしい','最高です','すごすぎる','天才かよ','マジで尊敬します','いつも感心します','レベルが違う','憧れます','さすがです','クオリティ高すぎ','神ってる','めちゃくちゃ上手い'] },
      { id: 'sympathy', name: '共鸣', templates: ['わかります','そう思います','その通りですね','めっちゃわかる','共感しかない','すごく共感しました','同じです','わかる〜','たしかに','それな！','ほんとそれ','マジでそれ'] },
      { id: 'encouragement', name: '鼓励', templates: ['頑張ってください','応援してます','ファイト！','これからも頑張ってください','いつも楽しみにしてます','負けないで','陰ながら応援してます','きっと大丈夫','諦めないで','あなたならできる'] },
      { id: 'cute', name: '可爱', templates: ['かわいい！','癒されました','エモい','最高にかわいい','かわいすぎます','尊い','天使ですか？','癒しをありがとう','めっちゃ癒される','可愛さに震える'] },
      { id: 'cool', name: '帅', templates: ['かっこいい！','スタイルいいですね','センスがいい','オシャレです','かっこよすぎます','イケメン','渋い','かっこよさが溢れてる'] },
      { id: 'food', name: '美食', templates: ['美味しそう！','食べたいです','作り方教えてください','お店教えてほしいです','よだれが出る','絶対美味しいやつ','レシピ知りたいです','また食べに行きたい','贅沢ですね','お腹すいてきた'] },
      { id: 'scenery', name: '风景', templates: ['綺麗ですね','いい景色','どこですか？','行ってみたいです','絶景ですね','空気が綺麗そう','写真が上手いですね','日本の風景って素敵','癒される景色','また行きたい'] },
      { id: 'casual', name: '随意', templates: ['初めまして','フォロー失礼します','いつも参考になります','いいね','ナイス！','いい感じですね','参考になりました','また遊びに来ます','こんにちは','お邪魔します','いい一日を'] }
    ]
  };

  function getNurtureComments() {
    var row = db.prepare("SELECT value FROM script_settings WHERE key = 'nurture_comments'").get();
    if (row) {
      try { return JSON.parse(row.value); } catch (e) {}
    }
    return DEFAULT_COMMENTS;
  }

  app.get('/api/nurture/comments', async () => {
    return { ok: true, categories: getNurtureComments().categories };
  });

  app.post('/api/nurture/comments', async (request) => {
    var data = request.body || {};
    if (!data.categories || !Array.isArray(data.categories)) {
      return { ok: false, msg: 'categories 必须是数组' };
    }
    db.prepare("INSERT INTO script_settings (key, value, updated_at) VALUES ('nurture_comments', ?, datetime('now', '+8 hours')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', '+8 hours')")
      .run(JSON.stringify({ categories: data.categories }));
    return { ok: true, msg: '评论模板已保存' };
  });
}

module.exports = { configApiRoutes, extractHandle, mergeAccountConfig, loadGlobalConfig };

const { createAccountsRepo } = require('../../repositories/accounts-repo');
const { createDmRecordsRepo } = require('../../repositories/dm-records-repo');
const { accountDailyStatsRepo } = require('../../repositories/account-daily-stats-repo');
const { deriveChatState } = require('../../repositories/runtime-status-repo');
const { loadGlobalConfig, mergeAccountConfig } = require('../api/config');
const { createTelemetryRepo } = require('../../repositories/telemetry-repo');
const { listTagPresets, parseAccountTags, tagDisabledModules, tagLabels } = require('../../utils/account-tags');

const ONLINE_MS = 15 * 60 * 1000;
const { RESERVED } = require('../../utils/handle');

/** 幽灵号：保留字/测试名/未确认且从未上线且无业务数据
 *  已手动确认（confirmed_at 有值）→ 不算幽灵
 *  有机位序号但从未上线 → 仍算幽灵/待确认（占坑死号）
 */
function isGhostAccount(account) {
  const h = String((account && account.x_handle) || '').toLowerCase().trim();
  if (!h) return true;
  if (RESERVED.has(h) || /^\d{4,5}$/.test(h)) return true;
  // 已手动确认为真实账号 → 不算幽灵
  if (account.confirmed_at) return false;
  const seen = account.rt_last_seen_at || account.last_seen_at;
  const acts = Number(account.activity_count || 0);
  const leads = Number(account.lead_count || 0);
  const todayF = Number(account.today_follow_count || 0);
  const todayD = Number(account.today_dm_count || 0);
  if (!seen && acts === 0 && leads === 0 && todayF === 0 && todayD === 0) return true;
  return false;
}

/** Parse OPS last_seen strings (zh-CN Shanghai or SQLite datetime) as Asia/Shanghai. */
function parseSeenMs(s) {
  if (!s) return 0;
  const raw = String(s).trim();
  // 2026/7/31 18:52:29 or 2026-07-31 18:52:29
  const m = raw.match(
    /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const hh = Number(m[4] || 0);
    const mm = Number(m[5] || 0);
    const ss = Number(m[6] || 0);
    const t = Date.UTC(y, mo - 1, d, hh - 8, mm, ss);
    return Number.isNaN(t) ? 0 : t;
  }
  const t = new Date(raw).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function withOnlineFlag(account) {
  const seen = parseSeenMs(account && account.last_seen_at);
  const is_online = seen > 0 && Date.now() - seen <= ONLINE_MS;
  return { ...account, is_online };
}

/** 拼运行态：调度 / 模块 / 私信态 / 指令未确认 */
function withRuntimeFlags(account) {
  const base = withOnlineFlag(account);
  // 仅用 runtime 表字段判定调度/私信态；不要把 accounts.last_seen_at 当成已上报运行态
  const hasRuntimeRow = account.rt_last_seen_at != null
    || account.rt_auto_mode != null
    || account.rt_running_module != null
    || account.rt_last_cmd != null
    || account.rt_last_cmd_issued != null;
  const runtime = hasRuntimeRow ? {
    auto_mode: account.rt_auto_mode,
    running_module: account.rt_running_module,
    engine: account.rt_engine,
    stage: account.rt_stage,
    why_idle: account.rt_why_idle,
    last_cmd: account.rt_last_cmd,
    last_cmd_issued: account.rt_last_cmd_issued,
    last_cmd_issued_at: account.rt_last_cmd_issued_at,
    last_cmd_acked_at: account.rt_last_cmd_acked_at,
    last_cmd_ok: account.rt_last_cmd_ok,
    last_seen_at: account.rt_last_seen_at || null,
  } : null;
  const derived = deriveChatState(runtime, { parseSeenMs, now: Date.now() });
  // 心跳可写 accounts.chat_state=pin_blocked；derive 不会产生该态，需保留 DB 值
  if (String(account.chat_state || '') === 'pin_blocked') {
    derived.chat_state = 'pin_blocked';
    derived.chat_state_label = 'PIN 拦截';
  }
  let module_label = '-';
  if (derived.running_module === 'chat') module_label = '私信';
  else if (derived.running_module === 'follow') module_label = '关注';
  else if (derived.running_module === 'nurture') module_label = '养号';
  else if (derived.running_module === 'repost') module_label = '转帖';
  else if (derived.auto_mode) module_label = '空闲';

  let sched_label = '-';
  if (derived.chat_state === 'unknown') sched_label = '-';
  else if (derived.auto_mode) sched_label = '开';
  else sched_label = '关';

  return {
    ...base,
    ...derived,
    module_label,
    sched_label,
  };
}

async function accountsPageRoutes(app) {
  const accountsRepo = createAccountsRepo(app.db);
  const dmRepo = createDmRecordsRepo(app.db);
  const dailyStatsRepo = accountDailyStatsRepo(app.db);
  const cache = app.ttlCache;
  let dmRosterRepo = null;
  try {
    const { createDmRosterRepo } = require('../../repositories/dm-roster-repo');
    dmRosterRepo = createDmRosterRepo(app.db);
  } catch (eRoster) {
    dmRosterRepo = null;
  }

  app.get('/accounts', async (request, reply) => {
    const showGhosts = String(request.query.show || '') === 'ghosts'
      || String(request.query.show || '') === 'all';
    const cacheKey = `accounts:${showGhosts ? 'ghosts' : 'list'}`;
    const cached = cache.getCached(cacheKey);
    if (cached) {
      return reply.view('accounts.njk', cached);
    }

    const rtMap = accountsRepo.mapRepostTargetsText();
    const all = accountsRepo.listSummary().map((a) => {
      const flags = withRuntimeFlags(a);
      const h = String(a.x_handle || '').toLowerCase();
      return {
        ...flags,
        is_ghost: isGhostAccount(a),
        repost_targets_text: rtMap[h] || '',
        tag_labels: tagLabels(a),
      };
    });
    const ghostCount = all.filter((a) => a.is_ghost).length;
    const accounts = showGhosts ? all : all.filter((a) => !a.is_ghost);
    const viewData = {
      title: '账号中心',
      accounts,
      showGhosts: !!showGhosts,
      ghostCount,
      totalCount: all.length,
      tagPresets: listTagPresets(),
    };
    cache.setCached(cacheKey, viewData, 20000);
    return reply.view('accounts.njk', viewData);
  });

  app.get('/accounts/:id', async (request, reply) => {
    const raw = accountsRepo.findDetail(Number(request.params.id));
    if (!raw) return reply.code(404).send('Account not found');
    const account = withOnlineFlag(raw);
    account.tagsParsed = parseAccountTags(account);
    account.tagDisabled = tagDisabledModules(account);

    const dmStats = dmRepo.todayStatsByBot(account.x_handle);
    const todayStats = dailyStatsRepo.getToday(account.id);
    const global = loadGlobalConfig(app.db);
    const overrideRows = accountsRepo.listOverrides(account.x_handle);
    const effective = mergeAccountConfig(global, account, overrideRows);
    const ov = effective.account.overrides || {};
    let repostTargetsText = '';
    let repostSelected = [];
    // H9：勾选态读原始配置（不剔 banned，banned 在页面红标提示，由用户决定是否取消勾选）
    const rtSrc = ov.repost_targets != null ? ov.repost_targets
      : (() => { try { const r = app.db.prepare("SELECT value FROM config_thresholds WHERE key = 'repost_targets'").get(); return r ? JSON.parse(r.value) : []; } catch (e) { return []; } })();
    if (Array.isArray(rtSrc)) {
      repostSelected = rtSrc.map((h) => String(h || '').trim().replace(/^@/, '').toLowerCase()).filter(Boolean);
      repostTargetsText = repostSelected.join('\n');
    } else if (typeof rtSrc === 'string' && rtSrc.trim()) {
      try {
        const parsed = JSON.parse(rtSrc);
        repostSelected = (Array.isArray(parsed) ? parsed : []).map((h) => String(h || '').trim().replace(/^@/, '').toLowerCase()).filter(Boolean);
        repostTargetsText = repostSelected.join('\n');
      } catch (e) {
        repostTargetsText = String(rtSrc);
      }
    }
    // H9：来源号池（供勾选）
    let sourcePool = [];
    try {
      const { createSourcesRepo } = require('../../repositories/sources-repo');
      sourcePool = createSourcesRepo(app.db).list();
    } catch (eSrc) {}

    // 号池来源下拉「跟随全局」的提示文案（路由层预算，模板只输出变量）
    let poolSourceHint = '（主池78）';
    try {
      const gPool = String((global.thresholds && global.thresholds.pool_server) || '');
      if (gPool) poolSourceHint = gPool.indexOf('15679') >= 0 ? '（当前生效：兼职池79）' : '（当前生效：主池78）';
    } catch (ePool) {}

    const telemetryRepo = createTelemetryRepo(app.db);
    const telemetryLogs = telemetryRepo.listEvents({ accountId: account.id, limit: 30, offset: 0 });
    const latestSnapshot = telemetryRepo.latestSnapshot(account.id);
    const telemetrySnapshots = telemetryRepo.listSnapshots(account.id, 5);

    return reply.view('account-detail.njk', {
      title: '账号详情',
      account,
      dmStats,
      todayStats,
      effective,
      globalConfig: global,
      overrides: ov,
      repost_targets_text: repostTargetsText,
      repost_selected: repostSelected,
      source_pool: sourcePool,
      poolSourceHint,
      tagPresets: listTagPresets(),
      tagDisabledJson: JSON.stringify((effective.account && effective.account.tag_disabled) || []),
      telemetryLogs,
      latestSnapshot,
      telemetrySnapshots,
    });
  });

  /** 私信台账早对账页：/dm-roster/:handle（?snap=<id> 回看历史快照，只读） */
  app.get('/dm-roster/:handle', async (request, reply) => {
    const { normalizeHandle } = require('../../utils/handle');
    const handle = normalizeHandle(request.params.handle) || String(request.params.handle || '').replace(/^@/, '').toLowerCase().trim();
    if (!handle) return reply.code(400).send('handle required');
    const statusFilter = String(request.query.status || '').toLowerCase().trim();
    const snapId = parseInt(String((request.query && request.query.snap) || ''), 10);
    let items = [];
    let snap = null;
    let dailySnapshots = [];
    let historyMode = false;
    let historyPayloadEmpty = false;
    if (dmRosterRepo) {
      try {
        dailySnapshots = dmRosterRepo.listDailySnapshots(handle, 30) || [];
        if (Number.isFinite(snapId) && snapId > 0) {
          const sel = dmRosterRepo.getSnapshot(handle, snapId);
          if (sel) {
            historyMode = true;
            snap = sel;
            let payloadItems = [];
            try {
              const p = typeof sel.payload === 'string' ? JSON.parse(sel.payload) : sel.payload;
              payloadItems = (p && Array.isArray(p.items)) ? p.items : [];
            } catch (eP) { payloadItems = []; }
            items = payloadItems.map((it) => ({
              handle: String(it.handle || '').replace(/^@/, '').toLowerCase(),
              display_name: String(it.displayName || it.display_name || ''),
              round: parseInt(it.round, 10) || 0,
              queue_status: String(it.queueStatus || it.queue_status || ''),
              queue_kind: String(it.queueKind || it.queue_kind || ''),
              queue_reason: String(it.queueReason || it.queue_reason || ''),
              blocked: it.blocked ? 1 : 0,
              block_reason: String(it.blockReason || it.block_reason || ''),
              ice_sent_at: parseInt(it.iceSentAt || it.ice_sent_at, 10) || null,
              dm_verified_at: parseInt(it.dmVerifiedAt || it.dm_verified_at, 10) || null,
              stale: it.stale ? 1 : 0,
            }));
          }
        }
        if (!historyMode) {
          items = dmRosterRepo.listByBot(handle) || [];
          snap = dmRosterRepo.latestSnapshotMeta(handle);
        }
      } catch (eList) {
        request.log.warn({ err: eList }, 'dm-roster list failed');
      }
    }
    const filtered = statusFilter
      ? items.filter((it) => String(it.queue_status || '').toLowerCase() === statusFilter)
      : items;
    const verifiedCount = items.filter((it) => it.dm_verified_at).length;
    const pendingInDb = items.filter((it) => String(it.queue_status || '').toLowerCase() === 'pending').length;
    const F = snap ? (parseInt(snap.profile_followers, 10) || 0) : 0;
    const cells = snap ? (parseInt(snap.cells_seen, 10) || 0) : 0;
    const qTotal = snap ? (parseInt(snap.queue_total, 10) || 0) : 0;
    let snapRejectedEmpty = false;
    try {
      if (!historyMode && snap && snap.payload) {
        const p = typeof snap.payload === 'string' ? JSON.parse(snap.payload) : snap.payload;
        snapRejectedEmpty = !!(p && p.rejected_empty);
      }
    } catch (eP) { snapRejectedEmpty = false; }
    // F=0 = 插件未读到主页关注者，禁止显示「对账 OK」
    // 4.6.67：快照空队列/cells=0 但库内仍有大量 pending → 陈旧镜像脱节
    // 历史模式：快照即当时事实，不与当前库内做对账
    let reconcileStatus = 'ok';
    let reconcileLabel = '人数对账 OK';
    if (historyMode) {
      reconcileStatus = 'history';
      reconcileLabel = '历史快照（只读，以当时封口为准）';
    } else if (!snap) {
      reconcileStatus = 'none';
      reconcileLabel = '尚无快照';
    } else if (F <= 0) {
      reconcileStatus = 'no_f';
      reconcileLabel = '主页关注者未读到（F=0）≠ OK';
    } else if (snapRejectedEmpty || (F > 0 && cells === 0 && pendingInDb >= 3)) {
      reconcileStatus = 'stale';
      reconcileLabel = '快照与库内脱节（陈旧镜像）：F=' + F + ' cells=' + cells + ' queue=' + qTotal + ' 库内pending=' + pendingInDb;
    } else if (qTotal + 2 < F || (cells > 0 && cells + 2 < F)) {
      reconcileStatus = 'mismatch';
      reconcileLabel = 'mismatch：F=' + F + ' / cells=' + cells + ' / queue=' + qTotal;
    } else if (items.length > 0 && items.length + 5 < F) {
      // 库内累计行明显少于 F 也告警（历史 upsert 不应远少于主页）
      reconcileStatus = 'mismatch';
      reconcileLabel = 'mismatch：库内 ' + items.length + ' 行 < F=' + F;
    }
    const mismatch = reconcileStatus === 'mismatch' || reconcileStatus === 'no_f' || reconcileStatus === 'stale';
    if (historyMode && items.length === 0) historyPayloadEmpty = true;
    let accountId = null;
    try {
      const acc = accountsRepo.findByHandle(handle);
      if (acc) accountId = acc.id;
    } catch (eA) {}
    return reply.view('dm-roster.njk', {
      title: '私信台账',
      handle,
      accountId,
      snap,
      items,
      filtered,
      statusFilter,
      verifiedCount,
      pendingInDb,
      mismatch,
      reconcileStatus,
      reconcileLabel,
      snapRejectedEmpty,
      dailySnapshots,
      historyMode,
      historyPayloadEmpty,
      viewingSnapId: historyMode ? snap.id : 0
    });
  });

  app.delete('/api/accounts/:id', async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return reply.code(400).send({ ok: false, msg: 'invalid id' });
    }
    try {
      const result = accountsRepo.deleteCascade(id);
      if (!result.ok) return reply.code(404).send(result);
      cache.invalidateCache('accounts:');
      return { ok: true, deleted: result.deleted, counts: result.counts };
    } catch (err) {
      request.log.error({ err }, 'account delete failed');
      return reply.code(500).send({ ok: false, msg: err.message || 'delete failed' });
    }
  });

  /** 一键清理幽灵号（未确认+从未上线+无业务数据 / 保留字）；已确认的跳过 */
  app.post('/api/accounts/purge-ghosts', async (request, reply) => {
    const rows = accountsRepo.listSummary();
    const deleted = [];
    const skipped = [];
    for (const row of rows) {
      if (!isGhostAccount(row)) continue;
      // 已手动确认的不删（双保险：isGhostAccount 已排除 confirmed_at，这里再拦一次）
      if (row.confirmed_at) {
        skipped.push({ id: row.id, handle: row.x_handle, reason: 'confirmed' });
        continue;
      }
      try {
        const result = accountsRepo.deleteCascade(row.id);
        if (result.ok) deleted.push({ id: row.id, handle: row.x_handle });
        else skipped.push({ id: row.id, handle: row.x_handle, reason: result.msg || 'fail' });
      } catch (e) {
        skipped.push({ id: row.id, handle: row.x_handle, reason: e.message });
      }
    }
    cache.invalidateCache('accounts:');
    return { ok: true, deleted_count: deleted.length, deleted, skipped };
  });

  /** 单条：确认为真实账号 */
  app.post('/api/accounts/:id/confirm', async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      request.log.warn({ id: request.params.id }, 'confirm: invalid id');
      return reply.code(400).send({ ok: false, msg: 'invalid id' });
    }
    try {
      const account = accountsRepo.findById(id);
      if (!account) {
        request.log.warn({ id }, 'confirm: account not found');
        return reply.code(404).send({ ok: false, msg: '账号不存在' });
      }
      const result = accountsRepo.confirmById(id);
      cache.invalidateCache('accounts:');
      request.log.info({ id, changes: result.changes, handle: account.x_handle }, 'confirm: ok');
      return { ok: true, changes: result.changes, confirmed_at: result.changes ? 'just now' : (account.confirmed_at || 'already') };
    } catch (err) {
      request.log.error({ err, id }, 'confirm: error');
      return reply.code(500).send({ ok: false, msg: err.message || 'server error' });
    }
  });

  /** 批量：确认为真实账号 */
  app.post('/api/accounts/batch-confirm', async (request, reply) => {
    const body = request.body || {};
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const clean = ids.map(Number).filter(n => Number.isFinite(n) && n > 0);
    if (!clean.length) {
      return reply.code(400).send({ ok: false, msg: '请先勾选账号' });
    }
    const result = accountsRepo.confirmByIds(clean);
    cache.invalidateCache('accounts:');
    return { ok: true, confirmed_count: result.changes, total: clean.length };
  });

  app.post('/api/accounts/:id/command', async (request, reply) => {
    const id = Number(request.params.id);
    const command = String((request.body && request.body.command) || '').trim().toLowerCase();
    if (!Number.isFinite(id) || id <= 0) {
      return reply.code(400).send({ ok: false, msg: 'invalid id' });
    }
    if (command !== 'start' && command !== 'pause' && command !== 'reset_profile_media'
        && command !== 'reset_follow_daily_limit' && command !== 'reset_chat_local'
        && command !== 'clear_dead_handles') {
      return reply.code(400).send({
        ok: false,
        msg: 'command must be start, pause, reset_profile_media, reset_follow_daily_limit, reset_chat_local or clear_dead_handles',
      });
    }
    const account = accountsRepo.findById(id);
    if (!account) return reply.code(404).send({ ok: false, msg: 'account not found' });
    if (command === 'start' && (account.status === 'frozen' || account.status === 'banned')) {
      return reply.code(400).send({ ok: false, msg: '账号已封禁，无法远程启动' });
    }
    accountsRepo.setCommand(account.x_handle, command);
    let cleared = null;
    // 重锁配额时同步清 OPS 今日关注成功日志，否则轻总控仍按 activity_logs 计数拦截
    if (command === 'reset_follow_daily_limit') {
      try { cleared = accountsRepo.clearFollowActivityToday(account.id); } catch (eClr) {
        cleared = { deleted_logs: 0, stats_zeroed: 0, error: (eClr && eClr.message) || 'clear_failed' };
      }
    }
    cache.invalidateCache('accounts:');
    return { ok: true, handle: account.x_handle, command, cleared };
  });

  /** 重置 OPS 私信进度（dm_records + leads 阶段）；可选 wipe_plugin 下发 reset_chat_local */
  app.post('/api/accounts/:id/reset-dm', async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return reply.code(400).send({ ok: false, msg: 'invalid id' });
    }
    const body = request.body || {};
    const wipePlugin = !!(body.wipe_plugin || body.wipePlugin);
    const result = accountsRepo.resetDmProgress(id);
    if (!result || !result.ok) {
      return reply.code(404).send({ ok: false, msg: (result && result.msg) || 'account not found' });
    }
    let plugin_command = null;
    if (wipePlugin) {
      accountsRepo.setCommand(result.handle, 'reset_chat_local');
      plugin_command = 'reset_chat_local';
    }
    cache.invalidateCache('accounts:');
    return {
      ok: true,
      handle: result.handle,
      dm_deleted: result.dm_deleted,
      leads_reverted: result.leads_reverted,
      wipe_plugin: wipePlugin,
      plugin_command,
    };
  });

  app.post('/api/accounts/batch-reset-dm', async (request, reply) => {
    const body = request.body || {};
    const wipePlugin = !!(body.wipe_plugin || body.wipePlugin);
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n) => Number.isFinite(n) && n > 0) : [];
    if (!ids.length) return reply.code(400).send({ ok: false, msg: 'ids required' });

    const results = [];
    for (const id of ids) {
      const result = accountsRepo.resetDmProgress(id);
      if (!result || !result.ok) {
        results.push({ id, ok: false, msg: (result && result.msg) || 'not found' });
        continue;
      }
      if (wipePlugin) {
        accountsRepo.setCommand(result.handle, 'reset_chat_local');
      }
      results.push({
        id,
        ok: true,
        handle: result.handle,
        dm_deleted: result.dm_deleted,
        leads_reverted: result.leads_reverted,
        wipe_plugin: wipePlugin,
      });
    }
    cache.invalidateCache('accounts:');
    return { ok: true, wipe_plugin: wipePlugin, results };
  });

  app.post('/api/accounts/:id/sort', async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return reply.code(400).send({ ok: false, msg: 'invalid id' });
    }
    const account = accountsRepo.findById(id);
    if (!account) return reply.code(404).send({ ok: false, msg: 'account not found' });

    const raw = request.body && request.body.sort_order;
    let sortOrder = null;
    if (raw !== null && raw !== undefined && String(raw).trim() !== '') {
      sortOrder = Number(raw);
      if (!Number.isFinite(sortOrder) || sortOrder < 0) {
        return reply.code(400).send({ ok: false, msg: '序号必须是非负整数或留空' });
      }
      sortOrder = Math.floor(sortOrder);
    }
    const result = accountsRepo.updateSortOrder(id, sortOrder);
    if (!result || !result.ok) {
      return reply.code(409).send({
        ok: false,
        msg: (result && result.msg) || '序号冲突',
        conflict: result && result.conflict ? result.conflict : null,
      });
    }
    cache.invalidateCache('accounts:');
    return { ok: true, id, sort_order: result.sort_order };
  });

  app.post('/api/accounts/batch-command', async (request, reply) => {
    const body = request.body || {};
    const command = String(body.command || '').trim().toLowerCase();
    if (command !== 'start' && command !== 'pause' && command !== 'reset_profile_media'
        && command !== 'reset_follow_daily_limit' && command !== 'reset_chat_local'
        && command !== 'clear_dead_handles') {
      return reply.code(400).send({
        ok: false,
        msg: 'command must be start, pause, reset_profile_media, reset_follow_daily_limit, reset_chat_local or clear_dead_handles',
      });
    }
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n) => Number.isFinite(n) && n > 0) : [];
    if (!ids.length) return reply.code(400).send({ ok: false, msg: 'ids required' });

    const results = [];
    for (const id of ids) {
      const account = accountsRepo.findById(id);
      if (!account) {
        results.push({ id, ok: false, msg: 'not found' });
        continue;
      }
      if (command === 'start' && (account.status === 'frozen' || account.status === 'banned')) {
        results.push({ id, ok: false, handle: account.x_handle, msg: '账号已封禁，无法远程启动' });
        continue;
      }
      accountsRepo.setCommand(account.x_handle, command);
      let cleared = null;
      if (command === 'reset_follow_daily_limit') {
        try { cleared = accountsRepo.clearFollowActivityToday(account.id); } catch (eClr) {
          cleared = { deleted_logs: 0, stats_zeroed: 0, error: (eClr && eClr.message) || 'clear_failed' };
        }
      }
      results.push({ id, ok: true, handle: account.x_handle, command, cleared });
    }
    cache.invalidateCache('accounts:');
    return { ok: true, command, results };
  });
}

module.exports = { accountsPageRoutes };

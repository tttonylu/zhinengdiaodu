const { createAccountsRepo } = require('../../repositories/accounts-repo');
const { createLeadsRepo } = require('../../repositories/leads-repo');
const { createActivityLogsRepo } = require('../../repositories/activity-logs-repo');
const { createDmRecordsRepo } = require('../../repositories/dm-records-repo');
const { createDmRosterRepo } = require('../../repositories/dm-roster-repo');
const { createRuntimeStatusRepo } = require('../../repositories/runtime-status-repo');
const { createAccountsService } = require('../../services/accounts-service');
const { createLeadsService } = require('../../services/leads-service');
const { createActivityService } = require('../../services/activity-service');
const { accountDailyStatsRepo } = require('../../repositories/account-daily-stats-repo');
const { sendNotify } = require('../../services/push-notify');
const { createTelemetryRepo } = require('../../repositories/telemetry-repo');
const { createLogRepo } = require('../../repositories/log-repo');
const { maybeAlertTelemetry } = require('../../services/telemetry-alert');
const { zhDateSql } = require('../../db/client');
const fs = require('node:fs');
const path = require('node:path');
const { todayCreatedAtLikeParams, TODAY_CREATED_AT_SQL } = require('../../utils/shanghai-date');

function shanghaiNow() {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function shanghaiDate() {
  return new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function shanghaiDateKey() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

function cleanHandle(h) {
  const { normalizeHandle } = require('../../utils/handle');
  return normalizeHandle(h);
}

function extractHandle(botId) {
  const { extractHandle: ex } = require('../../utils/handle');
  return ex(botId);
}

async function pluginRoutes(app) {
  const accountsRepo = createAccountsRepo(app.db);
  const leadsRepo = createLeadsRepo(app.db);
  const activityLogsRepo = createActivityLogsRepo(app.db);
  const dmRecordsRepo = createDmRecordsRepo(app.db);
  const dmRosterRepo = createDmRosterRepo(app.db);
  const dailyStatsRepo = accountDailyStatsRepo(app.db);
  const runtimeRepo = createRuntimeStatusRepo(app.db);
  const telemetryRepo = createTelemetryRepo(app.db);
  const logRepo = createLogRepo(app.logDb);

  /** 插件写入后失效页面缓存：dashboard/analytics/monitor/accounts/leads */
  function bustPageCaches() {
    app.ttlCache.invalidateCache('dashboard:');
    app.ttlCache.invalidateCache('analytics:');
    app.ttlCache.invalidateCache('monitor:');
    app.ttlCache.invalidateCache('accounts:');
    app.ttlCache.invalidateCache('leads:');
  }

  // ==================== 账号注册 ====================
  app.post('/api/plugin/account/register', async (request) => {
    const { bot_id } = request.body || {};
    if (!bot_id) return { ok: false, msg: 'bot_id required' };

    const handle = extractHandle(bot_id);
    if (!handle) return { ok: false, msg: 'invalid bot_id / handle' };
    const ts = shanghaiNow();
    const rules = app.getRules();
    const accountsService = createAccountsService(accountsRepo, rules);

    try {
      let account = accountsRepo.findByHandle(handle);
      if (!account) {
        account = accountsService.ensureAccount(handle);
      }

      // 跨日 +1 在 touch 内按 day_count_date 处理（claim 也会 touch，不能只靠 register）
      accountsRepo.touch(handle, ts);
      account = accountsRepo.findByHandle(handle) || account;

      // 今日关注：优先插件心跳 followed_today（与轻总控闸门同源）
      const dmStats = dmRecordsRepo.todayStatsByBot(handle);
      const todayFollow = accountsRepo.resolveTodayFollowCount(account);
      let fleet_handles = [];
      try { fleet_handles = accountsRepo.listFleetHandles(); } catch (eF) {}

      bustPageCaches();

      return {
        ok: true,
        account: {
          id: account.id,
          x_handle: handle,
          day_count: account.day_count || 1,
          status: account.status,
          daily_follow_limit: account.daily_follow_limit,
          daily_dm_limit: account.daily_dm_limit,
          today_follow_count: todayFollow,
        },
        today_dm: dmStats,
        today_follow_count: todayFollow,
        fleet_handles,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ==================== DM 轮次记录 ====================
  app.post('/api/plugin/dm/record', async (request) => {
    const { bot_id, target_handle, round_number, message_content, result } = request.body || {};
    if (!bot_id || !target_handle || !round_number) {
      return { ok: false, msg: 'bot_id, target_handle, round_number are required' };
    }

    const handle = extractHandle(bot_id);
    if (!handle) return { ok: false, msg: 'invalid bot_id / handle' };
    const accountEarly = accountsRepo.findByHandle(handle);
    if (!accountEarly) return { ok: false, error: 'account_not_registered', handle };
    const ts = shanghaiNow();
    const cleanTarget = cleanHandle(target_handle);
    const wantRound = Number(round_number);
    const resultNorm = String(result || 'success').toLowerCase();
    const isSuccess = resultNorm === 'success';

    try {
      // 禁止号池互发
      if (accountsRepo.findByHandle(cleanTarget)) {
        return { ok: false, reason: 'fleet_target', msg: 'target is fleet account' };
      }

      // 失败/未确认：只记审计，不推进漏斗、不占成功轮次序列
      if (!isSuccess) {
        dmRecordsRepo.insert(handle, cleanTarget, wantRound, message_content || '', resultNorm, ts);
        try {
          app.db.prepare(
            "INSERT INTO activity_logs (lead_id, account_id, action_type, action_result, source, detail_json, created_at) VALUES (0, NULL, ?, ?, ?, ?, ?)"
          ).run(
            'dm_send_failed',
            resultNorm,
            'chat_plugin',
            JSON.stringify({ bot_id, target_handle: cleanTarget, round: wantRound, message: message_content || '' }),
            ts
          );
        } catch (eLog) {}
        bustPageCaches();
        return { ok: true, advanced: false, result: resultNorm, round: wantRound };
      }

      // 序列校验：允许跨日续聊，禁止无历史跳轮（仅 success）
      const maxRound = dmRecordsRepo.maxRoundByBotAndTarget(handle, cleanTarget);
      if (wantRound !== maxRound + 1) {
        return {
          ok: false,
          reason: 'round_gap',
          current: maxRound,
          expected: maxRound + 1,
          msg: `round_gap: got ${wantRound}, expected ${maxRound + 1}`,
        };
      }

      try {
        dmRecordsRepo.insert(handle, cleanTarget, wantRound, message_content || '', 'success', ts);
      } catch (eIns) {
        const msg = String((eIns && eIns.message) || eIns || '');
        if (/UNIQUE|constraint/i.test(msg)) {
          return {
            ok: false,
            reason: 'round_duplicate',
            current: maxRound,
            expected: maxRound + 1,
            msg: 'duplicate success round',
          };
        }
        throw eIns;
      }

      // 同时写 activity_log
      const actionMap = { 1: 'ice_sent', 2: 'ad_sent', 3: 'kick_sent' };
      const backendAction = actionMap[wantRound] || 'ice_sent';

      const account = accountEarly;

      const leadsService = createLeadsService(leadsRepo);
      const lead = leadsService.ensureLead(cleanTarget, 'chat_plugin');
      const updatedLead = leadsService.advanceLead(lead, backendAction, 'success', account.id, ts);

      app.db.prepare(`
        INSERT INTO activity_logs (lead_id, account_id, action_type, action_result, from_stage, to_stage, source, detail_json, created_at)
        VALUES (@lid, @aid, @at, @ar, @fs, @ts2, @src, @dj, @ct)
      `).run({
        lid: lead.id, aid: account.id, at: backendAction, ar: 'success',
        fs: lead.current_stage, ts2: updatedLead.current_stage,
        src: 'chat_plugin',
        dj: JSON.stringify({ detail: `第${wantRound}轮`, message: message_content || '', bot_id, target_handle: cleanTarget }),
        ct: ts,
      });

      bustPageCaches();
      return { ok: true, advanced: true, lead_id: updatedLead.id, round: wantRound };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ==================== 粉丝台账 roster（插件封口上传） ====================
  app.post('/api/plugin/dm/roster', async (request) => {
    const body = request.body || {};
    // 4.6.70：优先 botHandle（本号 X handle），避免 worker/串号混桶
    let handle = cleanHandle(body.botHandle || body.bot_handle || '');
    const botRaw = body.bot_id || body.botId || '';
    if (!handle) handle = extractHandle(botRaw) || cleanHandle(botRaw);
    if (!handle) return { ok: false, msg: 'bot_id or botHandle required' };
    // bot_id 与 botHandle 都存在且归一后不同 → 以 botHandle 为准并告警
    const rawAsHandle = extractHandle(botRaw) || cleanHandle(botRaw);
    if (rawAsHandle && handle && rawAsHandle !== handle) {
      request.log.warn({ botHandle: handle, bot_id: rawAsHandle }, 'dm/roster botKey mismatch; prefer botHandle');
    }

    const botKey = handle;
    const ts = shanghaiNow();
    const items = Array.isArray(body.items) ? body.items : [];
    const cellsSeen = parseInt(body.cellsSeen || body.cells_seen, 10) || 0;
    const profileFollowers = parseInt(body.profileFollowers || body.profile_followers, 10) || 0;
    const chunkTotal = Math.max(1, parseInt(body.chunkTotal || body.chunk_total, 10) || 1);
    const chunkIndex = parseInt(body.chunkIndex || body.chunk_index, 10);
    const isFinalChunk = body.finalize_stale === true
      || body.finalize_stale === 1
      || !(chunkTotal > 1)
      || (Number.isFinite(chunkIndex) && chunkIndex === chunkTotal - 1);
    // 4.6.67：F>0 且 cells=0 且无 items → 假封口：只记快照告警，不碰 items（防陈旧 pending 被「刷新」误导）
    const emptyFakeSeal = profileFollowers > 0 && cellsSeen === 0 && items.length === 0
      && !(Array.isArray(body.allHandles) && body.allHandles.length > 0);

    try {
      // 账号未注册也允许落库（审计用），有号则 touch
      try {
        const acc = accountsRepo.findByHandle(handle);
        if (acc) accountsRepo.touch(handle, ts);
      } catch (eTouch) {}

      // 契约 obs-retention↔H2：快照语义=「每封口一封」，分片是传输细节不产生多份；
      // 仅 final chunk 写快照（假封口 chunkTotal=1 必为 final，仍会记录告警快照）
      if (isFinalChunk) {
        dmRosterRepo.insertSnapshot({
          bot_id: botKey,
          bot_handle: cleanHandle(body.botHandle || body.bot_handle || handle),
          pulse_id: String(body.pulseId || body.pulse_id || ''),
          sealed_at: parseInt(body.sealedAt || body.sealed_at, 10) || Date.now(),
          profile_followers: profileFollowers,
          cells_seen: cellsSeen,
          queue_total: parseInt(body.queueTotal || body.queue_total, 10) || parseInt(body.itemCount, 10) || items.length,
          pending: parseInt(body.pending, 10) || 0,
          skipped: parseInt(body.skipped, 10) || 0,
          payload: JSON.stringify(Object.assign({}, body, emptyFakeSeal ? { rejected_empty: true } : {}, {
            chunkIndex: Number.isFinite(chunkIndex) ? chunkIndex : 0,
            chunkTotal
          })),
          created_at: ts
        });
      }

      if (emptyFakeSeal) {
        bustPageCaches();
        return {
          ok: true,
          bot: botKey,
          upserted: 0,
          rejected_empty: true,
          msg: 'empty seal ignored for items (F>0 cells=0)',
          profileFollowers,
          cellsSeen
        };
      }

      const upserted = dmRosterRepo.upsertItems(botKey, items, ts);
      let markedStale = 0;
      // 4.6.70：仅最终分片做 stale 标记；keep 用 allHandles（全量）优先
      if (isFinalChunk && typeof dmRosterRepo.markPendingNotInSetStale === 'function') {
        try {
          let keep = [];
          if (Array.isArray(body.allHandles) && body.allHandles.length > 0) {
            keep = body.allHandles.map((h) => cleanHandle(h)).filter(Boolean);
          } else if (items.length > 0) {
            keep = items.map((it) => cleanHandle(it.handle || it.Handle)).filter(Boolean);
          }
          if (keep.length > 0) {
            markedStale = dmRosterRepo.markPendingNotInSetStale(botKey, keep, ts) || 0;
          }
        } catch (eStale) {}
      }
      bustPageCaches();
      return {
        ok: true,
        bot: botKey,
        upserted: upserted,
        marked_stale: markedStale,
        chunkIndex: Number.isFinite(chunkIndex) ? chunkIndex : 0,
        chunkTotal,
        finalize_stale: !!isFinalChunk,
        truncated: !!body.truncated,
        profileFollowers,
        cellsSeen,
        itemCount: parseInt(body.itemCount, 10) || items.length
      };
    } catch (e) {
      // 台账是最高优先级数据：明细写入失败必须立刻可见，不能静默丢 8 天才被发现
      // 告警按 2 小时去重（同 telemetry-alert 模式，roster 心跳频繁防轰炸）
      try {
        const dedupeKey = 'roster_upsert_fail_alert';
        const row = app.db.prepare('SELECT value FROM config_thresholds WHERE key = ?').get(dedupeKey);
        const last = row && row.value ? Date.parse(row.value) : 0;
        if (!last || Date.now() - last > 2 * 3600 * 1000) {
          const rAlert = await sendNotify(app.db, '台账明细上传失败',
            `私信台账明细写入失败（快照已存但明细丢失，插件下一轮会上报重试）\nbot: ${botKey}\n错误: ${String(e && e.message).slice(0, 300)}`);
          if (rAlert && rAlert.ok) {
            app.db.prepare(
              `INSERT INTO config_thresholds (key, value, updated_at) VALUES (?, ?, datetime('now', '+8 hours'))
               ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', '+8 hours')`
            ).run(dedupeKey, new Date().toISOString());
          }
        }
      } catch (eAlert) {}
      return { ok: false, error: e.message };
    }
  });

  app.get('/api/plugin/dm/roster/:bot', async (request) => {
    const bot = cleanHandle(request.params.bot) || String(request.params.bot || '').trim();
    if (!bot) return { ok: false, msg: 'bot required' };
    try {
      const items = dmRosterRepo.listByBot(bot);
      const snap = dmRosterRepo.latestSnapshotMeta(bot);
      return {
        ok: true,
        bot: bot,
        snapshot: snap,
        count: items.length,
        items: items
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ==================== DM 轮次查询 ====================
  app.get('/api/plugin/dm/rounds/:handle', async (request) => {
    const handle = cleanHandle(request.params.handle);
    if (!handle) return { ok: false, msg: 'handle required' };

    try {
      const stats = dmRecordsRepo.todayStatsByBot(handle);
      const completed = dmRecordsRepo.todayCompletedTargets(handle);
      const target_rounds = dmRecordsRepo.maxRoundsByBot(handle);
      let fleet_handles = [];
      try { fleet_handles = accountsRepo.listFleetHandles(); } catch (eF) {}

      // 从 leads 表找还需处理的 target（排除今日已完成 3 轮）
      const p = todayCreatedAtLikeParams();
      const pendingLeads = app.db.prepare(`
        SELECT target_handle FROM leads
        WHERE bound_account_id = (SELECT id FROM accounts WHERE LOWER(x_handle) = LOWER(@h))
          AND current_stage IN ('followed_back', 'dm_ready', 'ice_sent', 'ad_sent')
          AND LOWER(REPLACE(target_handle, '@', '')) NOT IN (
            SELECT LOWER(REPLACE(target_handle, '@', '')) FROM dm_records
            WHERE LOWER(bot_handle) = LOWER(@h) AND ${TODAY_CREATED_AT_SQL}
            GROUP BY LOWER(REPLACE(target_handle, '@', ''))
            HAVING MAX(round_number) >= 3
          )
        ORDER BY last_activity_at DESC
        LIMIT 50
      `).all({ h: handle, ...p }).map((r) => cleanHandle(r.target_handle));

      return {
        ok: true,
        handle,
        today: stats,
        pending_leads: pendingLeads,
        completed_targets: completed,
        target_rounds,
        fleet_handles,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ==================== 粉丝批量发现（chat 插件扫描上报） ====================
  app.post('/api/plugin/leads/discover', async (request) => {
    const { bot_id, handles } = request.body || {};
    if (!bot_id || !handles || !Array.isArray(handles) || handles.length === 0) {
      return { ok: false, msg: 'bot_id and handles[] required' };
    }
    try {
      const handle = extractHandle(bot_id);
      const account = accountsRepo.findByHandle(handle);
      const accountId = account ? account.id : null;
      let fleet = new Set();
      try { fleet = new Set(accountsRepo.listFleetHandles()); } catch (eF) {}
      const filtered = handles
        .map((h) => cleanHandle(h))
        .filter((h) => h && h !== handle && !fleet.has(h));
      if (!filtered.length) return { ok: true, created: 0, handles: [], skipped_fleet: handles.length };
      const created = leadsRepo.batchDiscover(filtered, accountId);
      bustPageCaches();
      return { ok: true, created: created.length, handles: created, skipped_fleet: handles.length - filtered.length };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ==================== 活动上报（关注/风控/养号等） ====================
  app.post('/api/plugin/activity/report', async (request) => {
    const payload = request.body || {};
    const account_handle = payload.account_handle || payload.bot_id;
    const { target_handle, action_type, result, source, meta } = payload;
    if (!account_handle || !action_type) {
      return { ok: false, msg: 'account_handle and action_type required' };
    }

    const handle = extractHandle(account_handle);
    if (!handle) return { ok: false, msg: 'invalid account_handle / handle' };
    const ts = shanghaiNow();
    const statDate = shanghaiDateKey();
    const cleanTarget = target_handle ? String(target_handle).replace(/^@/, '').toLowerCase().trim() : null;
    const resultNorm = String(result || 'logged').toLowerCase();

    try {
      const account = accountsRepo.findByHandle(handle);
      if (!account) {
        return { ok: false, error: 'account_not_registered', handle };
      }
      accountsRepo.touch(handle, ts);

      const actionType = String(action_type).toLowerCase();
      let leadId = 0;
      let followBackAccepted = false;

      // 同账号+同目标+今日 follow/success 去重：不 INSERT、不 bump
      if (actionType === 'follow' && resultNorm === 'success' && cleanTarget) {
        const pDedup = todayCreatedAtLikeParams();
        const dup = app.db.prepare(`
          SELECT 1 AS ok FROM activity_logs
          WHERE account_id = ?
            AND lower(action_type) = 'follow'
            AND lower(COALESCE(action_result, '')) = 'success'
            AND lower(COALESCE(json_extract(detail_json, '$.target_handle'), '')) = ?
            AND (
              created_at LIKE ? OR created_at LIKE ? OR created_at LIKE ? OR created_at LIKE ?
            )
          LIMIT 1
        `).get(account.id, cleanTarget, pDedup.t1, pDedup.t2, pDedup.t3, pDedup.t4);
        if (dup) {
          return { ok: true, deduped: true, follow_back_accepted: false };
        }
      }

      if (cleanTarget) {
        const leadsService = createLeadsService(leadsRepo);
        const lead = leadsService.ensureLead(cleanTarget, source || 'plugin');
        leadId = lead.id || 0;

        if (actionType === 'follow' && resultNorm === 'success') {
          if (lead.current_stage === 'discovered' || !lead.followed_at) {
            leadsService.advanceLead(lead, 'follow', 'success', account.id, ts);
          } else if (!lead.bound_account_id) {
            leadsService.advanceLead(lead, 'follow', 'success', account.id, ts);
          }
          try { dailyStatsRepo.bump(account.id, statDate, { follow_count: 1 }); } catch (eBump) {}
        }

        // 回关：必须本账号曾关注过该目标（本账号 follow 日志，或 bound+followed_at），避免自然粉/串号
        if (actionType === 'follow_back' && resultNorm === 'success') {
          const followedByUs = !!(lead.bound_account_id === account.id && lead.followed_at) || !!app.db.prepare(`
            SELECT 1 AS ok FROM activity_logs
            WHERE account_id = ? AND action_type = 'follow' AND action_result = 'success'
              AND lower(json_extract(detail_json, '$.target_handle')) = ?
            LIMIT 1
          `).get(account.id, cleanTarget);
          if (followedByUs && !lead.followed_back_at) {
            leadsService.advanceLead(lead, 'follow_back', 'success', account.id, ts);
            followBackAccepted = true;
            try { dailyStatsRepo.bump(account.id, statDate, { follow_back_count: 1 }); } catch (eBump2) {}
          }
        }
      }

      app.db.prepare(`
        INSERT INTO activity_logs (lead_id, account_id, action_type, action_result, source, detail_json, created_at)
        VALUES (@lid, @aid, @at, @ar, @src, @dj, @ct)
      `).run({
        lid: leadId, aid: account.id, at: actionType, ar: result || 'logged',
        src: source || 'plugin',
        dj: JSON.stringify({
          account_handle, target_handle: cleanTarget, meta: meta || {},
          follow_back_accepted: actionType === 'follow_back' ? followBackAccepted : undefined,
        }),
        ct: ts,
      });

      // 无推广链接：广告轮静默跳过会断进线，Push 提醒（2h 去重）
      let push = null;
      if (actionType === 'no_promo_link') {
        const dedupeKey = `no_promo_link_push_${handle}`;
        let skipPush = false;
        try {
          const prev = app.db.prepare('SELECT value FROM config_thresholds WHERE key = ?').get(dedupeKey);
          if (prev && prev.value) {
            const last = Date.parse(prev.value);
            if (!Number.isNaN(last) && Date.now() - last < 2 * 3600 * 1000) skipPush = true;
          }
        } catch (eDed) {}
        if (!skipPush) {
          try {
            const title = `无推广链接 · ${handle}`;
            const msg = [
              `账号 @${handle} 广告轮无可用 Line 链接，已跳过发送`,
              '请到 OPS「话术中心」保存链接并同步 SCRM',
            ].join('\n');
            push = await sendNotify(app.db, title, msg);
            app.db.prepare(
              `INSERT INTO config_thresholds (key, value, updated_at) VALUES (?, ?, datetime('now', '+8 hours'))
               ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', '+8 hours')`
            ).run(dedupeKey, new Date().toISOString());
          } catch (ePush) {
            push = { ok: false, error: ePush.message };
          }
        } else {
          push = { ok: false, skipped: true };
        }
      }

      bustPageCaches();
      return { ok: true, push, follow_back_accepted: followBackAccepted };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 粉丝列表交叉：仅把「我们跟过且尚未记回关」的目标记为 follow_back
  app.post('/api/plugin/follow-back/from-followers', async (request) => {
    const payload = request.body || {};
    const account_handle = payload.account_handle || payload.bot_id;
    const handles = Array.isArray(payload.handles) ? payload.handles : [];
    if (!account_handle) return { ok: false, msg: 'account_handle required' };
    if (!handles.length) return { ok: true, marked: 0, candidates: 0 };

    const handle = extractHandle(account_handle);
    if (!handle) return { ok: false, msg: 'invalid account_handle / handle' };
    const ts = shanghaiNow();
    const statDate = shanghaiDateKey();
    try {
      const account = accountsRepo.findByHandle(handle);
      if (!account) {
        return { ok: false, error: 'account_not_registered', handle };
      }
      accountsRepo.touch(handle, ts);

      const fleet = new Set((accountsRepo.listFleetHandles() || []).map((h) => cleanHandle(h)));
      const leadsService = createLeadsService(leadsRepo);
      let marked = 0;
      let candidates = 0;

      for (const raw of handles) {
        const t = cleanHandle(raw);
        if (!t || fleet.has(t) || t === handle) continue;
        candidates += 1;
        const lead = leadsRepo.findByHandle(t);
        if (!lead || !lead.followed_at || lead.followed_back_at) continue;
        const followedByUs = !!app.db.prepare(`
          SELECT 1 AS ok FROM activity_logs
          WHERE account_id = ? AND action_type = 'follow' AND action_result = 'success'
            AND (
              lower(json_extract(detail_json, '$.target_handle')) = ?
              OR lead_id = ?
            )
          LIMIT 1
        `).get(account.id, t, lead.id) || (lead.bound_account_id === account.id && lead.followed_at);

        if (!followedByUs) continue;

        leadsService.advanceLead(lead, 'follow_back', 'success', account.id, ts);
        app.db.prepare(`
          INSERT INTO activity_logs (lead_id, account_id, action_type, action_result, source, detail_json, created_at)
          VALUES (?, ?, 'follow_back', 'success', 'followers_cross', ?, ?)
        `).run(
          lead.id,
          account.id,
          JSON.stringify({ account_handle: handle, target_handle: t, meta: { via: 'followers_list' } }),
          ts
        );
        try { dailyStatsRepo.bump(account.id, statDate, { follow_back_count: 1 }); } catch (eB) {}
        marked += 1;
      }
      if (marked > 0) bustPageCaches();
      return { ok: true, marked, candidates };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ==================== 活动检查（关注前校验） ====================
  app.post('/api/plugin/activity/check', async (request) => {
    const { account_handle, target_handle, action_type } = request.body || {};
    if (!account_handle || !action_type) {
      return { ok: false, msg: 'account_handle and action_type required' };
    }

    const handle = extractHandle(account_handle);
    const rules = app.getRules();

    try {
      let account = accountsRepo.findByHandle(handle);
      if (!account) return { ok: true, allowed: true }; // 未注册 = 不限制

      // 检查日限额
      if (action_type === 'follow') {
        // 与 Day6 爬坡封顶对齐：取账号限 / 全局阈值 / 默认 260 的较大值，避免默认 200 拦 Day5+
        let globalCap = 260;
        try {
          const row = app.db.prepare(
            "SELECT value FROM config_thresholds WHERE key = 'follow_daily_limit'"
          ).get();
          if (row && row.value != null) globalCap = Math.max(260, parseInt(row.value, 10) || 260);
        } catch (eCap) {}
        const acctCap = Number(account.daily_follow_limit) || 0;
        const limit = Math.max(acctCap, globalCap, rules.defaultDailyFollowLimit || 260);
        const current = accountsRepo.resolveTodayFollowCount(account);
        if (current >= limit) {
          return { ok: true, allowed: false, reason: 'follow_limit_reached', limit, current };
        }
      }

      return { ok: true, allowed: true };
    } catch (e) {
      return { ok: true, allowed: true };
    }
  });

  // ==================== DM 检查（私信前校验） ====================
  app.post('/api/plugin/dm/check', async (request) => {
    const { bot_id, target_handle } = request.body || {};
    if (!bot_id || !target_handle) {
      return { ok: false, msg: 'bot_id and target_handle required' };
    }

    const handle = extractHandle(bot_id);
    if (!handle) return { ok: false, msg: 'invalid bot_id / handle' };
    const cleanTarget = cleanHandle(target_handle);
    const rules = app.getRules();

    try {
      if (accountsRepo.findByHandle(cleanTarget)) {
        return { ok: true, allowed: false, reason: 'fleet_target', current_round: 0, next_round: 0 };
      }

      let account = accountsRepo.findByHandle(handle);
      // 未注册账号禁止发信（否则 current_round 恒为 0 → 换插件后重复破冰）
      if (!account) {
        return { ok: false, allowed: false, reason: 'account_not_registered', current_round: 0, next_round: 0 };
      }

      // 4.1.41：废除每日私信条数上限（旧默认 50）。节流=关注间隔+填窗；daily_dm_limit 字段仅保留展示/兼容
      // （不再用 ice/ad/kick 当日计数挡发）

      let maxRound = dmRecordsRepo.maxRoundByBotAndTarget(handle, cleanTarget);

      // 兜底：dm_records 丢失时，用 leads 阶段推断已发轮次（防换插件重复破冰）
      if (maxRound < 3) {
        try {
          const lead = leadsRepo.findByHandle(cleanTarget);
          if (lead && lead.bound_account_id === account.id) {
            const stage = String(lead.current_stage || '');
            let fromLead = 0;
            if (stage === 'ice_sent') fromLead = 1;
            else if (stage === 'ad_sent') fromLead = 2;
            else if (stage === 'kick_sent' || stage === 'converted' || stage === 'rejected') fromLead = 3;
            if (fromLead > maxRound) maxRound = fromLead;
          }
        } catch (eLead) {}
      }

      if (maxRound >= 3) {
        return { ok: true, allowed: false, reason: 'already_completed', current_round: maxRound, next_round: maxRound };
      }

      return { ok: true, allowed: true, current_round: maxRound, next_round: maxRound + 1 };
    } catch (e) {
      // 失败关闭：异常时禁止发送，避免本地轮次丢失导致同轮重发到 X
      return { ok: false, allowed: false, reason: 'check_error', msg: e.message || 'dm_check_failed' };
    }
  });

  // ==================== 通用日志（兼容旧扩展上报） ====================
  app.post('/api/plugin/log', async (request) => {
    const { bot_id, target, action_type, detail, message } = request.body || {};
    if (!bot_id || !target || !action_type) {
      return { ok: false, msg: 'bot_id, target, action_type are required' };
    }

    const accountHandle = extractHandle(bot_id);
    if (!accountHandle) return { ok: false, msg: 'invalid bot_id / handle' };
    const actionMap = {
      ICEBREAKER: 'ice_sent', AD: 'ad_sent',
      CORPSE: 'skip', REJECT: 'reject_sent', COMPETITOR: 'skip', LINK_SENDER: 'skip',
    };
    const backendAction = actionMap[action_type] || action_type.toLowerCase();
    const isSkip = ['skip'].includes(backendAction);
    const rules = app.getRules();
    const accountsService = createAccountsService(accountsRepo, rules);
    const leadsService = createLeadsService(leadsRepo);
    const activityService = createActivityService(activityLogsRepo);
    const ts = shanghaiNow();

    try {
      let account = accountsRepo.findByHandle(accountHandle);
      if (!account) {
        account = accountsService.ensureAccount(bot_id);
      }
      const lead = leadsService.ensureLead(String(target).toLowerCase(), 'chat_plugin');
      let updatedLead = lead;
      let result = 'success';

      if (isSkip) {
        leadsRepo.markSkipped(lead.id, action_type);
        updatedLead = leadsRepo.findById(lead.id);
        result = 'skipped';
      } else {
        updatedLead = leadsService.advanceLead(lead, backendAction, 'success', account.id, ts);
      }

      activityService.record({
        lead_id: updatedLead.id, account_id: account.id,
        action_type: backendAction, action_result: result,
        from_stage: lead.current_stage, to_stage: updatedLead.current_stage,
        source: 'chat_plugin',
        detail_json: JSON.stringify({ detail: detail || '', message: message || '', raw_action: action_type, bot_id }),
        created_at: ts,
      });

      bustPageCaches();
      return { ok: true, lead_id: updatedLead.id, current_stage: updatedLead.current_stage };
    } catch (e) {
      try {
        activityService.record({
          lead_id: 0, account_id: null,
          action_type: backendAction, action_result: 'logged',
          source: 'chat_plugin',
          detail_json: JSON.stringify({ detail, message, raw_action: action_type, bot_id, target, error: e.message }),
          created_at: ts,
        });
      } catch (_) {}
      return { ok: true, logged: true, warning: e.message };
    }
  });

  // ==================== 健康检测 ====================
  app.get('/api/plugin/health/chat-evidence', async (request) => {
    const limit = Math.min(Number(request.query.limit || 20), 100);
    try {
      const rows = app.db.prepare(
        "SELECT * FROM activity_logs WHERE action_type = 'CHAT_EVIDENCE' ORDER BY created_at DESC LIMIT ?"
      ).all(limit);
      const latest = rows.length > 0 ? rows[0] : null;
      let parsed = null;
      if (latest && latest.detail_json) {
        try { parsed = JSON.parse(latest.detail_json); } catch (_) {}
      }
      return { ok: true, latest, parsed, events: rows };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  app.post('/api/plugin/health/event', async (request) => {
    const evt = request.body || {};
    const ts = shanghaiNow();
    try {
      app.db.prepare(
        "INSERT INTO activity_logs (lead_id, account_id, action_type, action_result, source, detail_json, created_at) VALUES (0, NULL, ?, ?, ?, ?, ?)"
      ).run(evt.event_type || 'UNKNOWN', evt.severity || 'info', 'health_monitor', JSON.stringify(evt), ts);
    } catch (e) {
      console.log('[HEALTH-EVENT]', JSON.stringify(evt));
    }
    return { ok: true, received: ts };
  });
  // ==================== 账号心跳（支持 full/lite/edge 运行态字段级 merge） ====================
  // 防幽灵：心跳绝不建号；未注册账号直接拒绝（建号只走 /account/register）
  app.post('/api/plugin/account/heartbeat', async (request) => {
    const body = request.body || {};
    const { bot_id } = body;
    if (!bot_id) return { ok: false, msg: 'bot_id required' };
    const handle = extractHandle(bot_id);
    if (!handle) return { ok: false, msg: 'invalid bot_id / handle' };
    const ts = shanghaiNow();
    try {
      let account = accountsRepo.findByHandle(handle);
      if (!account) {
        return { ok: false, error: 'account_not_registered', handle };
      }
      accountsRepo.touch(handle, ts);
      account = accountsRepo.findByHandle(handle) || account;
      try {
        runtimeRepo.upsertHeartbeat(handle, body, ts);
      } catch (eRt) {
        console.warn('[heartbeat] runtime upsert failed', handle, eRt && eRt.message);
      }
      // 已取消：心跳回写 repost_targets（改由 OPS 账号页配置为准）
      const cmdRow = accountsRepo.getCommand(handle);
      // 插件上报 passcode 门禁状态，控制台可据此标记"PIN 拦截"
      const dmPinBlocked = body.dm_pin_blocked === true || body.dm_pin_blocked === 'true';
      if (dmPinBlocked) {
        try {
          app.db.prepare(
            "UPDATE accounts SET chat_state = 'pin_blocked', updated_at = ? WHERE LOWER(x_handle) = LOWER(?)"
          ).run(ts, handle);
        } catch (ePin) {}
      }
      return {
        ok: true,
        day_count: account.day_count || 1,
        command: cmdRow ? cmdRow.command : null,
        dm_pin_blocked: dmPinBlocked,
        today_follow_count: accountsRepo.resolveTodayFollowCount(account),
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ==================== 本机转帖来源号 → 绑定账号 overrides ====================
  app.post('/api/plugin/account/repost-targets', async (request) => {
    const body = request.body || {};
    const { bot_id } = body;
    if (!bot_id) return { ok: false, msg: 'bot_id required' };
    const handle = extractHandle(bot_id);
    if (!handle) return { ok: false, msg: 'invalid bot_id / handle' };
    const raw = body.targets != null ? body.targets : body.repost_targets;
    let list = [];
    if (Array.isArray(raw)) {
      list = raw.map(cleanHandle).filter(Boolean);
    } else if (typeof raw === 'string' && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        list = (Array.isArray(parsed) ? parsed : String(raw).split(/[\n,，\s]+/))
          .map(cleanHandle).filter(Boolean);
      } catch (e) {
        list = String(raw).split(/[\n,，\s]+/).map(cleanHandle).filter(Boolean);
      }
    }
    // 去重保序
    const seen = new Set();
    list = list.filter((h) => (seen.has(h) ? false : (seen.add(h), true)));
    try {
      if (!accountsRepo.findByHandle(handle)) {
        return { ok: false, error: 'account_not_registered', handle };
      }
      accountsRepo.setOverride(handle, 'repost_targets', JSON.stringify(list));
      accountsRepo.touch(handle, shanghaiNow());
      return { ok: true, handle, count: list.length, targets: list };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ==================== H9 来源号被动检测上报（E1 抓取遇冻结/不存在页） ====================
  app.post('/api/plugin/repost-source-status', async (request) => {
    const body = request.body || {};
    const srcHandle = cleanHandle(body.source || body.source_handle || '');
    const status = String(body.status || '').trim();
    if (!srcHandle) return { ok: false, msg: 'source required' };
    if (!['alive', 'banned'].includes(status)) return { ok: false, msg: 'bad status' };
    try {
      const { createSourcesRepo } = require('../../repositories/sources-repo');
      const sourcesRepo = createSourcesRepo(app.db);
      // 不在池里则先登记，再标状态（池是来源号的唯一目录）
      sourcesRepo.add(srcHandle, body.note ? String(body.note).slice(0, 120) : '');
      const r = sourcesRepo.setStatus(srcHandle, status);
      return { ok: r.ok, handle: srcHandle, status };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ==================== 账号冻结告警（关注时检测到横幅） ====================
  app.post('/api/plugin/account/frozen', async (request) => {
    const { bot_id, reason } = request.body || {};
    if (!bot_id) return { ok: false, msg: 'bot_id required' };
    const handle = extractHandle(bot_id);
    if (!handle) return { ok: false, msg: 'invalid bot_id / handle' };
    const ts = shanghaiNow();

    try {
      let account = accountsRepo.findByHandle(handle);
      if (!account) {
        const accountsService = createAccountsService(accountsRepo, app.getRules());
        account = accountsService.ensureAccount(bot_id);
      }
      accountsRepo.touch(handle, ts);

      // 标记状态；序号用 sort_order（失败则整单失败，避免 Push 成功但 UI 仍显示在线）
      if (!account || account.id == null) {
        return { ok: false, msg: 'account resolve failed' };
      }
      try {
        app.db.prepare(
          `UPDATE accounts SET status = 'frozen', updated_at = datetime('now', '+8 hours') WHERE id = ?`
        ).run(account.id);
      } catch (eSt) {
        return { ok: false, msg: 'status update failed', error: eSt.message };
      }
      const verify = accountsRepo.findById(account.id);
      if (!verify || verify.status !== 'frozen') {
        return { ok: false, msg: 'status verify failed' };
      }

      const seq = account.sort_order != null ? String(account.sort_order) : '-';
      const msg = `账号${handle} 序号${seq} 账号已经被冻结，已停止所有模块`;
      const title = `账号冻结 · ${handle}`;

      // 24h 去重，避免连环 toast 刷屏
      const dedupeKey = `frozen_push_${handle}`;
      let skipPush = false;
      try {
        const prev = app.db.prepare(
          'SELECT value FROM config_thresholds WHERE key = ?'
        ).get(dedupeKey);
        if (prev && prev.value) {
          const last = Date.parse(prev.value);
          if (!Number.isNaN(last) && Date.now() - last < 24 * 3600 * 1000) skipPush = true;
        }
      } catch (eDed) {}

      let pushResult = { ok: false, skipped: skipPush };
      if (!skipPush) {
        pushResult = await sendNotify(app.db, title, msg + (reason ? `\n原因: ${reason}` : ''));
        try {
          app.db.prepare(
            `INSERT INTO config_thresholds (key, value, updated_at) VALUES (?, ?, datetime('now', '+8 hours'))
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', '+8 hours')`
          ).run(dedupeKey, new Date().toISOString());
        } catch (eSave) {}
      }

      // 远程下发 pause，其它标签/下次 claim 也会停
      try { accountsRepo.setCommand(handle, 'pause'); } catch (eCmd) {}

      bustPageCaches();
      return {
        ok: true,
        handle,
        sort_order: account.sort_order != null ? account.sort_order : null,
        message: msg,
        push: pushResult,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ==================== 远程指令轮询 / ACK ====================
  app.get('/api/plugin/account/command', async (request) => {
    const botId = request.query.bot_id || request.query.worker_id || '';
    if (!botId) return { ok: false, msg: 'bot_id required' };
    const handle = extractHandle(botId);
    const cmdRow = accountsRepo.getCommand(handle);
    return { ok: true, handle, command: cmdRow ? cmdRow.command : null };
  });

  // 原子领取：返回并清除，避免多标签重复执行；顺带刷新在线心跳
  app.post('/api/plugin/account/command-claim', async (request) => {
    const { bot_id } = request.body || {};
    if (!bot_id) return { ok: false, msg: 'bot_id required' };
    const handle = extractHandle(bot_id);
    try {
      if (accountsRepo.findByHandle(handle)) {
        accountsRepo.touch(handle, shanghaiNow());
      }
    } catch (e) {
      // claim 仍应继续，避免 touch 失败阻断远程启停
    }
    const command = accountsRepo.claimCommand(handle);
    return { ok: true, handle, command: command || null };
  });

  app.post('/api/plugin/account/command-ack', async (request) => {
    const body = request.body || {};
    const { bot_id, command } = body;
    if (!bot_id) return { ok: false, msg: 'bot_id required' };
    const handle = extractHandle(bot_id);
    const cmd = String(command || '').trim().toLowerCase();
    if (cmd !== 'start' && cmd !== 'pause' && cmd !== 'reset_profile_media'
        && cmd !== 'reset_follow_daily_limit' && cmd !== 'reset_chat_local'
        && cmd !== 'clear_dead_handles') {
      return { ok: false, msg: 'command must be start, pause, reset_profile_media, reset_follow_daily_limit, reset_chat_local or clear_dead_handles' };
    }
    const ts = shanghaiNow();
    try { accountsRepo.touch(handle, ts); } catch (eT) {}
    // claim 可能已清掉 pending；ACK 仍写回执（幂等）
    try { accountsRepo.clearCommand(handle, cmd); } catch (eC) {}
    try {
      runtimeRepo.markCommandAcked(handle, cmd, {
        bot_id,
        ts,
        ok: body.ok !== false,
        auto_mode: body.auto_mode,
        running_module: body.running_module,
      });
    } catch (eAck) {
      return { ok: false, handle, error: eAck.message };
    }
    return { ok: true, handle, cleared: cmd, acked: cmd };
  });

  // ==================== 每日工作统计上报 ====================
  app.post('/api/plugin/account/daily-stats', async (request) => {
    try {
      const { worker_id, follow_count, follow_duration_sec, chat_rounds, chat_duration_sec, nurture_likes, nurture_comments, nurture_duration_sec } = request.body || {};
      const handle = extractHandle(worker_id);
      if (!handle) return { ok: false, error: 'invalid worker_id' };
      const accountsRepo = createAccountsRepo(app.db);
      const account = accountsRepo.findByHandle(handle);
      if (!account) {
        return { ok: false, error: 'account_not_registered', handle };
      }
      const today = shanghaiDateKey();
      dailyStatsRepo.upsertAbsolute(account.id, today, {
        follow_count: Number(follow_count) || 0,
        follow_duration_sec: Number(follow_duration_sec) || 0,
        chat_rounds: Number(chat_rounds) || 0,
        chat_duration_sec: Number(chat_duration_sec) || 0,
        nurture_likes: Number(nurture_likes) || 0,
        nurture_comments: Number(nurture_comments) || 0,
        nurture_duration_sec: Number(nurture_duration_sec) || 0
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ==================== 运行观测 telemetry ====================
  app.get('/api/plugin/telemetry/catalog', async () => {
    try {
      const catalogPath = path.join(__dirname, '..', '..', '..', '..', 'unified-scheduler', 'obs', 'event-catalog.json');
      if (fs.existsSync(catalogPath)) {
        return JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
      }
    } catch (eCat) {}
    return { version: '1.0', events: [] };
  });

  app.post('/api/plugin/telemetry/batch', async (request) => {
    const body = request.body || {};
    const events = Array.isArray(body.events) ? body.events : [];
    if (!events.length) return { ok: true, count: 0 };
    const handle = extractHandle(body.account_handle || events[0].account_handle);
    if (!handle) return { ok: false, msg: 'invalid handle' };
    const rules = app.getRules();
    const accountsService = createAccountsService(accountsRepo, rules);
    let account = accountsRepo.findByHandle(handle);
    if (!account) {
      try {
        account = accountsService.ensureAccount(handle);
      } catch (eEns) {
        return { ok: false, error: 'account_create_failed', handle, msg: eEns.message };
      }
    }
    const ts = shanghaiNow();
    accountsRepo.touch(handle, ts);
    const count = telemetryRepo.insertBatch(account.id, events, ts);
    const pushCandidates = events.filter((e) => e && (e.push || e.severity === 'error'));
    for (const ev of pushCandidates.slice(-8)) {
      try {
        await maybeAlertTelemetry(app, telemetryRepo, {
          account_id: account.id,
          event_id: ev.event_id,
          label_zh: ev.label_zh,
          meta: ev.meta || {},
          push: ev.push,
          created_at: ts,
        }, handle);
      } catch (eAl) {}
    }
    return { ok: true, count };
  });

  app.post('/api/plugin/telemetry/snapshot', async (request) => {
    const snap = request.body || {};
    const handle = extractHandle(snap.account_handle);
    if (!handle) return { ok: false, msg: 'invalid account_handle', detail: snap.account_handle || '' };
    const ts = shanghaiNow();
    const rules = app.getRules();
    const accountsService = createAccountsService(accountsRepo, rules);

    let account = accountsRepo.findByHandle(handle);
    if (!account) {
      try {
        account = accountsService.ensureAccount(handle);
      } catch (eEns) {
        return { ok: false, error: 'account_create_failed', handle, msg: eEns.message };
      }
    }
    accountsRepo.touch(handle, ts);

    const snapshotId = telemetryRepo.insertSnapshot(account.id, snap, ts);

    let eventsIngested = 0;
    const recentEvents = Array.isArray(snap.recent_events) ? snap.recent_events : [];
    if (recentEvents.length) {
      eventsIngested += telemetryRepo.insertBatch(account.id, recentEvents, ts);
    }

    const consoleLines = Array.isArray(snap.console_lines) ? snap.console_lines : [];
    if (consoleLines.length) {
      const consoleEvents = consoleLines.map((line) => ({
        event_id: 'system.console_line',
        label_zh: 'Console日志',
        category: 'system',
        severity: line.level || 'info',
        meta: {
          source: line.source || 'chat',
          message: line.message || '',
          ...(line.meta || {}),
        },
        session_id: snap.session_id || '',
        account_handle: snap.account_handle || handle,
      }));
      eventsIngested += telemetryRepo.insertBatch(account.id, consoleEvents, ts);
    }

    return { ok: true, snapshot_id: snapshotId, handle, events_ingested: eventsIngested };
  });

  // ==================== 专用日志库入库（日志常态） ====================
  // 幂等：按 client_event_id 去重；返回精确计数供插件做 ack
  app.post('/api/plugin/log/batch', async (request) => {
    const body = request.body || {};
    const events = Array.isArray(body.events) ? body.events : [];
    if (!events.length) return { ok: true, ingested: 0, deduped: 0, failed: 0 };
    const handle = extractHandle(body.account_handle || events[0].account_handle);
    if (!handle) return { ok: false, msg: 'invalid handle' };
    const rules = app.getRules();
    const accountsService = createAccountsService(accountsRepo, rules);
    let account = accountsRepo.findByHandle(handle);
    if (!account) {
      try {
        account = accountsService.ensureAccount(handle);
      } catch (eEns) {
        return { ok: false, error: 'account_create_failed', handle, msg: eEns.message };
      }
    }
    const ts = shanghaiNow();
    accountsRepo.touch(handle, ts);

    const nowMs = Date.now();
    const rows = events.map((e) => ({
      account_id: account.id,
      account_handle: handle,
      client_event_id: String(e.client_event_id || e._id || (e.ts || nowMs) + '_' + Math.random().toString(36).slice(2, 8)),
      event_id: String(e.event_id || 'unknown'),
      severity: String(e.severity || 'info'),
      category: String(e.category || 'system'),
      label_zh: String(e.label_zh || e.event_id || ''),
      session_id: String(e.session_id || ''),
      meta_json: JSON.stringify(e.meta || {}),
      ts_ms: Number(e.ts) || nowMs,
      created_at: zhDateSql(e.time_zh) || ts,
    }));

    const res = logRepo.insertBatch(rows);

    // 错误/推送事件 → PushPlus 告警（沿用 telemetry-alert 规则，用日志库计数）
    const pushCandidates = events.filter((e) => e && (e.push || e.severity === 'error'));
    if (pushCandidates.length) {
      const countAdapter = {
        countRecentByEvent: (accountId, eventId, since) => logRepo.countEvents({ accountId, eventId, since }),
      };
      for (const ev of pushCandidates.slice(-8)) {
        try {
          await maybeAlertTelemetry(app, countAdapter, {
            account_id: account.id,
            event_id: ev.event_id,
            label_zh: ev.label_zh,
            meta: ev.meta || {},
            push: ev.push,
            created_at: ts,
          }, handle);
        } catch (eAl) {}
      }
    }

    return { ok: true, ingested: res.inserted, deduped: res.deduped, failed: res.failed };
  });

  // 诊断快照 → 专用日志库
  app.post('/api/plugin/log/snapshot', async (request) => {
    const snap = request.body || {};
    const handle = extractHandle(snap.account_handle);
    if (!handle) return { ok: false, msg: 'invalid account_handle', detail: snap.account_handle || '' };
    const ts = shanghaiNow();
    const rules = app.getRules();
    const accountsService = createAccountsService(accountsRepo, rules);

    let account = accountsRepo.findByHandle(handle);
    if (!account) {
      try {
        account = accountsService.ensureAccount(handle);
      } catch (eEns) {
        return { ok: false, error: 'account_create_failed', handle, msg: eEns.message };
      }
    }
    accountsRepo.touch(handle, ts);

    const snapshotId = logRepo.insertSnapshot(account.id, handle, snap, ts);

    let eventsIngested = 0;
    const recentEvents = Array.isArray(snap.recent_events) ? snap.recent_events : [];
    const consoleLines = Array.isArray(snap.console_lines) ? snap.console_lines : [];
    if (recentEvents.length || consoleLines.length) {
      const nowMs = Date.now();
      const evRows = [];
      for (const ev of recentEvents.slice(-300)) {
        if (!ev) continue;
        const eid = String(ev.client_event_id || ev._id || (ev.ts || nowMs) + '_' + Math.random().toString(36).slice(2, 8));
        evRows.push({
          account_id: account.id,
          account_handle: handle,
          client_event_id: 'snap:' + eid,
          event_id: String(ev.event_id || 'unknown'),
          severity: String(ev.severity || 'info'),
          category: String(ev.category || 'system'),
          label_zh: String(ev.label_zh || ev.event_id || ''),
          session_id: String(snap.session_id || ''),
          meta_json: JSON.stringify(ev.meta || {}),
          ts_ms: Number(ev.ts) || nowMs,
          created_at: zhDateSql(ev.time_zh) || ts,
        });
      }
      for (const line of consoleLines.slice(-200)) {
        if (!line) continue;
        evRows.push({
          account_id: account.id,
          account_handle: handle,
          client_event_id: 'line:' + (line.client_event_id || (nowMs + '_' + Math.random().toString(36).slice(2, 8))),
          event_id: 'system.console_line',
          severity: String(line.level || 'info'),
          category: 'system',
          label_zh: 'Console日志',
          session_id: String(snap.session_id || ''),
          meta_json: JSON.stringify({ source: line.source || 'chat', message: String(line.message || '').slice(0, 400), ...(line.meta || {}) }),
          ts_ms: nowMs,
          created_at: ts,
        });
      }
      eventsIngested = logRepo.insertBatch(evRows).inserted;
    }

    return { ok: true, snapshot_id: snapshotId, handle, events_ingested: eventsIngested };
  });
}

module.exports = { pluginRoutes };

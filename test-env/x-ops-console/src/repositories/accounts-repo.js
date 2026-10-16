const {
  shanghaiDateKey,
  shanghaiNowTs,
  toShanghaiDateKey,
  todayCreatedAtLikeParams: buildTodayCreatedAtLikeParams,
} = require('../utils/shanghai-date');
const { createRuntimeStatusRepo } = require('./runtime-status-repo');

function createAccountsRepo(db) {
  const runtimeRepo = createRuntimeStatusRepo(db);
  return {
    findByHandle(xHandle) {
      const { normalizeHandle } = require('../utils/handle');
      const h = normalizeHandle(xHandle);
      if (!h) return null;
      return db.prepare('SELECT * FROM accounts WHERE LOWER(x_handle) = LOWER(?)').get(h);
    },
    findById(id) {
      return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    },
    insert(account) {
      const { normalizeHandle } = require('../utils/handle');
      const row = {
        ...account,
        x_handle: normalizeHandle(account.x_handle),
        day_count: account.day_count != null ? account.day_count : 1,
        day_count_date: account.day_count_date || shanghaiDateKey(),
      };
      if (!row.x_handle) throw new Error('invalid x_handle');
      return db
        .prepare(`
          INSERT INTO accounts (
            x_handle,
            display_name,
            status,
            daily_follow_limit,
            daily_dm_limit,
            day_count,
            day_count_date,
            created_at,
            updated_at
          ) VALUES (
            @x_handle,
            @display_name,
            @status,
            @daily_follow_limit,
            @daily_dm_limit,
            @day_count,
            @day_count_date,
            datetime('now', '+8 hours'),
            datetime('now', '+8 hours')
          )
        `)
        .run(row);
    },
    todayCreatedAtLikeParams() {
      return buildTodayCreatedAtLikeParams();
    },

    /** 号池全部 handle（小写），供私信互刷过滤 */
    listFleetHandles() {
      return db
        .prepare('SELECT LOWER(x_handle) AS h FROM accounts WHERE x_handle IS NOT NULL AND TRIM(x_handle) != \'\'')
        .all()
        .map((r) => String(r.h || '').toLowerCase())
        .filter(Boolean);
    },

    countFollowsToday(accountId) {
      const p = this.todayCreatedAtLikeParams();
      const row = db.prepare(`
        SELECT COUNT(*) AS c FROM activity_logs
        WHERE account_id = @aid
          AND lower(action_type) = 'follow'
          AND lower(COALESCE(action_result, '')) = 'success'
          AND (
            created_at LIKE @t1 OR created_at LIKE @t2 OR created_at LIKE @t3 OR created_at LIKE @t4
          )
      `).get({ aid: accountId, t1: p.t1, t2: p.t2, t3: p.t3, t4: p.t4 });
      return row ? Number(row.c) || 0 : 0;
    },

    /**
     * 今日关注闸门读数：优先插件心跳写入的 account_runtime_status.followed_today；
     * 无 runtime 行时回退 activity_logs 计数（老号未心跳）。
     */
    resolveTodayFollowCount(account) {
      if (!account || !account.id) return 0;
      const handle = account.x_handle;
      if (handle) {
        try {
          const rt = runtimeRepo.findByHandle(handle);
          if (rt) {
            const n = parseInt(rt.followed_today, 10);
            return Number.isFinite(n) ? Math.max(0, n) : 0;
          }
        } catch (eRt) {}
      }
      return this.countFollowsToday(account.id);
    },

    /**
     * 清今日关注成功日志 + 日统计 + runtime.followed_today。
     * 轻总控 activity/check 优先读 runtime；不清 runtime 则重锁后仍可能拦截。
     * @returns {{ deleted_logs: number, stats_zeroed: number, runtime_zeroed: number }}
     */
    clearFollowActivityToday(accountId) {
      const aid = Number(accountId);
      if (!Number.isFinite(aid) || aid <= 0) {
        return { deleted_logs: 0, stats_zeroed: 0, runtime_zeroed: 0 };
      }
      const p = this.todayCreatedAtLikeParams();
      const del = db.prepare(`
        DELETE FROM activity_logs
        WHERE account_id = @aid
          AND lower(action_type) = 'follow'
          AND lower(COALESCE(action_result, '')) = 'success'
          AND (
            created_at LIKE @t1 OR created_at LIKE @t2 OR created_at LIKE @t3 OR created_at LIKE @t4
          )
      `).run({ aid, t1: p.t1, t2: p.t2, t3: p.t3, t4: p.t4 });
      let statsZeroed = 0;
      try {
        const day = shanghaiDateKey();
        const st = db.prepare(`
          UPDATE account_daily_stats
          SET follow_count = 0, updated_at = datetime('now', '+8 hours')
          WHERE account_id = ? AND stat_date = ?
        `).run(aid, day);
        statsZeroed = st && st.changes ? st.changes : 0;
      } catch (eSt) {}
      let runtimeZeroed = 0;
      try {
        const acc = this.findById(aid);
        if (acc && acc.x_handle) {
          const h = String(acc.x_handle).replace(/^@/, '').toLowerCase().trim();
          if (h) {
            const rt = db.prepare(`
              UPDATE account_runtime_status
              SET followed_today = 0, updated_at = datetime('now', '+8 hours')
              WHERE LOWER(x_handle) = LOWER(?)
            `).run(h);
            runtimeZeroed = rt && rt.changes ? rt.changes : 0;
          }
        }
      } catch (eRt) {}
      return {
        deleted_logs: (del && del.changes) || 0,
        stats_zeroed: statsZeroed,
        runtime_zeroed: runtimeZeroed,
      };
    },

    listSummary() {
      const p = this.todayCreatedAtLikeParams();
      return db
        .prepare(`
          WITH today_stats AS (
            SELECT
              account_id,
              SUM(CASE WHEN action_type = 'follow' AND lower(COALESCE(action_result, '')) = 'success' THEN 1 ELSE 0 END) AS today_follow_count,
              SUM(CASE WHEN action_type IN ('dm','ice_sent','ad_sent','kick_sent') THEN 1 ELSE 0 END) AS today_dm_count
            FROM activity_logs
            WHERE account_id IS NOT NULL AND account_id > 0
              AND (
                created_at LIKE @t1 OR created_at LIKE @t2
                OR created_at LIKE @t3 OR created_at LIKE @t4
              )
            GROUP BY account_id
          ),
          lead_counts AS (
            SELECT bound_account_id AS account_id, COUNT(*) AS lead_count
            FROM leads
            WHERE bound_account_id IS NOT NULL
            GROUP BY bound_account_id
          ),
          activity_counts AS (
            SELECT account_id, COUNT(*) AS activity_count
            FROM activity_logs
            WHERE account_id IS NOT NULL AND account_id > 0
            GROUP BY account_id
          )
          SELECT
            a.*,
            COALESCE(lc.lead_count, 0) AS lead_count,
            CASE
              WHEN rs.x_handle IS NOT NULL THEN COALESCE(rs.followed_today, 0)
              ELSE COALESCE(ts.today_follow_count, 0)
            END AS today_follow_count,
            COALESCE(ts.today_dm_count, 0) AS today_dm_count,
            COALESCE(ac.activity_count, 0) AS activity_count,
            rs.auto_mode AS rt_auto_mode,
            rs.running_module AS rt_running_module,
            rs.engine AS rt_engine,
            rs.stage AS rt_stage,
            rs.why_idle AS rt_why_idle,
            rs.followed_today AS rt_followed_today,
            rs.last_cmd AS rt_last_cmd,
            rs.last_cmd_issued AS rt_last_cmd_issued,
            rs.last_cmd_issued_at AS rt_last_cmd_issued_at,
            rs.last_cmd_acked_at AS rt_last_cmd_acked_at,
            rs.last_cmd_ok AS rt_last_cmd_ok,
            rs.last_seen_at AS rt_last_seen_at
          FROM accounts a
          LEFT JOIN today_stats ts ON ts.account_id = a.id
          LEFT JOIN lead_counts lc ON lc.account_id = a.id
          LEFT JOIN activity_counts ac ON ac.account_id = a.id
          LEFT JOIN account_runtime_status rs ON LOWER(rs.x_handle) = LOWER(a.x_handle)
          ORDER BY
            CASE WHEN a.sort_order IS NULL THEN 1 ELSE 0 END ASC,
            a.sort_order ASC,
            COALESCE(a.last_seen_at, a.updated_at, a.created_at) DESC
        `)
        .all({ t1: p.t1, t2: p.t2, t3: p.t3, t4: p.t4 });
    },
    findDetail(id) {
      const account = this.findById(id);
      if (!account) return null;

      const recentActivities = db
        .prepare(`
          SELECT
            al.*,
            l.target_handle
          FROM activity_logs al
          JOIN leads l ON l.id = al.lead_id
          WHERE al.account_id = ?
          ORDER BY al.created_at DESC
          LIMIT 30
        `)
        .all(id);

      return { ...account, recentActivities };
    },

    updateDayCount(handle, dayCount) {
      const today = shanghaiDateKey();
      return db.prepare(`
        UPDATE accounts SET
          day_count = @dc,
          day_count_date = @dd,
          updated_at = datetime('now', '+8 hours')
        WHERE LOWER(x_handle) = LOWER(@h)
      `).run({ h: String(handle || '').toLowerCase(), dc: dayCount, dd: today });
    },

    /** 查占用该序号的账号（排除自身）；null/空不查 */
    findBySortOrder(sortOrder, excludeId) {
      if (sortOrder == null || sortOrder === '') return null;
      const n = Number(sortOrder);
      if (!Number.isFinite(n)) return null;
      if (excludeId != null) {
        return db.prepare(
          'SELECT id, x_handle, sort_order, status FROM accounts WHERE sort_order = ? AND id != ? LIMIT 1'
        ).get(n, excludeId);
      }
      return db.prepare(
        'SELECT id, x_handle, sort_order, status FROM accounts WHERE sort_order = ? LIMIT 1'
      ).get(n);
    },

    /**
     * 更新机位序号；非空时必须全局唯一。
     * @returns {{ ok:true, sort_order } | { ok:false, msg, conflict? }}
     */
    updateSortOrder(id, sortOrder) {
      if (sortOrder != null && sortOrder !== '') {
        const n = Math.floor(Number(sortOrder));
        if (!Number.isFinite(n) || n < 0) {
          return { ok: false, msg: '序号必须是非负整数或留空' };
        }
        const conflict = this.findBySortOrder(n, id);
        if (conflict) {
          return {
            ok: false,
            msg: `序号 ${n} 已被 @${conflict.x_handle} 占用`,
            conflict: { id: conflict.id, x_handle: conflict.x_handle, sort_order: n },
          };
        }
        db.prepare(`
          UPDATE accounts SET
            sort_order = @sort_order,
            updated_at = datetime('now', '+8 hours')
          WHERE id = @id
        `).run({ id, sort_order: n });
        return { ok: true, sort_order: n };
      }

      db.prepare(`
        UPDATE accounts SET
          sort_order = NULL,
          updated_at = datetime('now', '+8 hours')
        WHERE id = @id
      `).run({ id });
      return { ok: true, sort_order: null };
    },

    /**
     * 刷新 last_seen，并按 day_count_date 跨上海自然日 +1。
     * 必须在 claim 心跳路径调用，不能只靠 register（claim 会先盖掉 last_seen）。
     */
    touch(handle, ts) {
      const h = String(handle || '').toLowerCase();
      const stamp = ts || shanghaiNowTs();
      const today = shanghaiDateKey();
      const account = this.findByHandle(h);
      if (!account) {
        return db.prepare(
          `UPDATE accounts SET last_seen_at = @ts, updated_at = datetime('now', '+8 hours') WHERE LOWER(x_handle) = LOWER(@h)`
        ).run({ h, ts: stamp });
      }

      let dayCount = Number(account.day_count) || 1;
      let anchor = String(account.day_count_date || '').trim();
      if (!anchor) {
        // 首次写入锚点：优先用 last_seen 跨日；若 claim 已把 last_seen 刷成今天，老号仍补 +1
        const lastDay = toShanghaiDateKey(account.last_seen_at);
        const createdDay = toShanghaiDateKey(account.created_at);
        if (lastDay && lastDay < today) {
          dayCount += 1;
        } else if (createdDay && createdDay < today) {
          dayCount += 1;
        }
        anchor = today;
      } else if (anchor !== today) {
        dayCount += 1;
        anchor = today;
      }

      return db.prepare(`
        UPDATE accounts SET
          last_seen_at = @ts,
          day_count = @dc,
          day_count_date = @dd,
          updated_at = datetime('now', '+8 hours')
        WHERE id = @id
      `).run({ id: account.id, ts: stamp, dc: dayCount, dd: anchor });
    },

    updateLimits(handle, limits) {
      return db.prepare(`
        UPDATE accounts SET
          daily_follow_limit = COALESCE(@daily_follow_limit, daily_follow_limit),
          daily_dm_limit = COALESCE(@daily_dm_limit, daily_dm_limit),
          daily_repost_limit = @daily_repost_limit,
          updated_at = datetime('now', '+8 hours')
        WHERE LOWER(x_handle) = LOWER(@handle)
      `).run({
        handle: String(handle || '').toLowerCase(),
        daily_follow_limit: limits.daily_follow_limit ?? null,
        daily_dm_limit: limits.daily_dm_limit ?? null,
        daily_repost_limit: limits.daily_repost_limit ?? null,
      });
    },

    /** 账号级上班/下班（工作窗覆盖）；参数 undefined=保留现值，null/空串=清除回落全局 */
    updateWorkHours(handle, workStart, workEnd) {
      const cur = db.prepare('SELECT work_start, work_end FROM accounts WHERE LOWER(x_handle) = LOWER(?)').get(String(handle || '').toLowerCase());
      if (!cur) return { ok: false, msg: 'account not found' };
      const norm = (v) => {
        if (v === undefined) return undefined; // 未传=保留现值
        const s = String(v || '').trim();
        if (!s) return null; // 传了空=清除
        const m = s.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
        return m ? `${m[1].padStart(2, '0')}:${m[2]}` : undefined; // undefined=格式错，不写
      };
      let ws = norm(workStart);
      let we = norm(workEnd);
      if (ws === undefined && workStart !== undefined) return { ok: false, msg: '时间格式需 HH:MM（00:00-23:59）' };
      if (we === undefined && workEnd !== undefined) return { ok: false, msg: '时间格式需 HH:MM（00:00-23:59）' };
      if (ws === undefined) ws = cur.work_start || null;
      if (we === undefined) we = cur.work_end || null;
      db.prepare(`
        UPDATE accounts SET
          work_start = @ws,
          work_end = @we,
          updated_at = datetime('now', '+8 hours')
        WHERE LOWER(x_handle) = LOWER(@handle)
      `).run({ handle: String(handle || '').toLowerCase(), ws, we });
      return { ok: true, work_start: ws, work_end: we };
    },

    /** 写入账号管理标签（JSON 数组字符串；预设校验在调用方 utils/account-tags） */
    setTags(handle, tags) {
      const arr = Array.isArray(tags) ? tags : [];
      return db.prepare(`
        UPDATE accounts SET
          tags = @tags,
          updated_at = datetime('now', '+8 hours')
        WHERE LOWER(x_handle) = LOWER(@h)
      `).run({ h: String(handle || '').toLowerCase(), tags: JSON.stringify(arr) });
    },

    /** 手动确认为真实账号（填 confirmed_at，幽灵号判定豁免） */
    confirmById(id) {
      return db.prepare(`
        UPDATE accounts SET
          confirmed_at = datetime('now', '+8 hours'),
          updated_at = datetime('now', '+8 hours')
        WHERE id = @id AND confirmed_at IS NULL
      `).run({ id: Number(id) });
    },

    /** 批量确认；返回成功条数 */
    confirmByIds(ids) {
      const clean = ids.map(Number).filter(n => n > 0);
      if (!clean.length) return { changes: 0 };
      const placeholders = clean.map(() => '?').join(',');
      return db.prepare(`
        UPDATE accounts SET
          confirmed_at = datetime('now', '+8 hours'),
          updated_at = datetime('now', '+8 hours')
        WHERE id IN (${placeholders}) AND confirmed_at IS NULL
      `).run(...clean);
    },

    /** 取消确认（调试用） */
    unconfirmById(id) {
      return db.prepare(`
        UPDATE accounts SET confirmed_at = NULL, updated_at = datetime('now', '+8 hours')
        WHERE id = @id
      `).run({ id: Number(id) });
    },

    listOverrides(handle) {
      return db.prepare('SELECT key, value FROM config_account_overrides WHERE LOWER(x_handle) = LOWER(?) ORDER BY key')
        .all(String(handle || '').toLowerCase());
    },

    /** 全表：handle → repost_targets 文本（空格分隔，供列表页直绑） */
    mapRepostTargetsText() {
      const rows = db.prepare(
        "SELECT LOWER(x_handle) AS h, value FROM config_account_overrides WHERE key = 'repost_targets'"
      ).all();
      const out = {};
      rows.forEach(function (r) {
        let text = '';
        const raw = r.value;
        if (!raw) {
          out[r.h] = '';
          return;
        }
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) text = parsed.join(' ');
          else text = String(raw);
        } catch (e) {
          text = String(raw).replace(/[,，\n]+/g, ' ').trim();
        }
        out[r.h] = text;
      });
      return out;
    },

    setOverride(handle, key, value) {
      const { normalizeHandle } = require('../utils/handle');
      const h = normalizeHandle(handle) || String(handle || '').toLowerCase().trim();
      if (!h) return null;
      return db.prepare(`
        INSERT INTO config_account_overrides (x_handle, key, value, updated_at)
        VALUES (@handle, @key, @value, datetime('now', '+8 hours'))
        ON CONFLICT(x_handle, key) DO UPDATE SET
          value = excluded.value,
          updated_at = datetime('now', '+8 hours')
      `).run({ handle: h, key, value: String(value) });
    },

    /**
     * 转帖开跑错峰（仅 OPS）：按 handle 哈希分到 [base, base+windowMin] 的固定开跑点，
     * 写入账号 override。插件只读 startHour/startMin，无需改前端抖动。
     * @returns {{ hour:number, min:number, offsetMin:number }}
     */
    computeRepostStaggerSlot(handle, opts) {
      opts = opts || {};
      var baseH = parseInt(opts.baseHour, 10);
      var baseM = parseInt(opts.baseMin, 10);
      var win = parseInt(opts.windowMin, 10);
      if (!isFinite(baseH) || baseH < 0 || baseH > 23) baseH = 20;
      if (!isFinite(baseM) || baseM < 0 || baseM > 59) baseM = 0;
      if (!isFinite(win) || win < 0) win = 240;
      if (win > 360) win = 360;
      var seed = String(handle || '').toLowerCase().trim() || 'x';
      var h = 2166136261;
      for (var i = 0; i < seed.length; i++) {
        h ^= seed.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      var offset = win <= 0 ? 0 : ((h >>> 0) % (win + 1));
      var total = baseH * 60 + baseM + offset;
      total = ((total % (24 * 60)) + (24 * 60)) % (24 * 60);
      return {
        hour: Math.floor(total / 60),
        min: total % 60,
        offsetMin: offset,
        baseHour: baseH,
        baseMin: baseM,
        windowMin: win
      };
    },

    /** 给单号写转帖错峰 override；force=false 时已有 repost_start_hour 则跳过 */
    assignRepostStaggerForHandle(handle, opts) {
      opts = opts || {};
      const { normalizeHandle } = require('../utils/handle');
      const h = normalizeHandle(handle) || String(handle || '').toLowerCase().trim();
      if (!h) return null;
      if (!opts.force) {
        const rows = this.listOverrides(h);
        const has = rows.some(function (r) { return r.key === 'repost_start_hour'; });
        if (has) {
          const hourRow = rows.find(function (r) { return r.key === 'repost_start_hour'; });
          const minRow = rows.find(function (r) { return r.key === 'repost_start_min'; });
          return {
            skipped: true,
            handle: h,
            hour: parseInt(hourRow && hourRow.value, 10),
            min: parseInt(minRow && minRow.value, 10) || 0
          };
        }
      }
      const slot = this.computeRepostStaggerSlot(h, opts);
      this.setOverride(h, 'repost_follow_work_end', 'false');
      this.setOverride(h, 'repost_start_hour', String(slot.hour));
      this.setOverride(h, 'repost_start_min', String(slot.min));
      // 账号级关掉插件本地抖动，避免与后端槽位叠加/齐跑
      this.setOverride(h, 'repost_start_jitter_max_min', '0');
      return { skipped: false, handle: h, hour: slot.hour, min: slot.min, offsetMin: slot.offsetMin };
    },

    /** 全舰队分配错峰；返回 { assigned, skipped, samples } */
    assignRepostStaggerAll(opts) {
      opts = opts || {};
      const force = !!opts.force;
      const handles = this.listFleetHandles();
      let assigned = 0;
      let skipped = 0;
      const samples = [];
      for (let i = 0; i < handles.length; i++) {
        const r = this.assignRepostStaggerForHandle(handles[i], Object.assign({}, opts, { force: force }));
        if (!r) continue;
        if (r.skipped) skipped += 1;
        else assigned += 1;
        if (samples.length < 8) {
          samples.push({
            handle: r.handle,
            start: String(r.hour).padStart(2, '0') + ':' + String(r.min || 0).padStart(2, '0')
          });
        }
      }
      return { assigned: assigned, skipped: skipped, total: handles.length, samples: samples };
    },

    deleteOverride(handle, key) {
      return db.prepare('DELETE FROM config_account_overrides WHERE LOWER(x_handle) = LOWER(?) AND key = ?')
        .run(String(handle || '').toLowerCase(), key);
    },

    setCommand(handle, command) {
      const h = String(handle || '').toLowerCase();
      const cmd = String(command || '').toLowerCase().trim();
      const ALLOWED = [
        'start', 'pause', 'reset_profile_media', 'reset_follow_daily_limit',
        'reset_chat_local', 'clear_dead_handles'
      ];
      if (!ALLOWED.includes(cmd)) {
        const err = new Error('command not allowed: ' + cmd);
        err.code = 'COMMAND_NOT_ALLOWED';
        throw err;
      }
      const result = db.prepare(`
        INSERT INTO account_commands (x_handle, command, created_at, updated_at)
        VALUES (@handle, @command, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
        ON CONFLICT(x_handle) DO UPDATE SET
          command = excluded.command,
          updated_at = datetime('now', '+8 hours')
      `).run({ handle: h, command: cmd });
      try { runtimeRepo.markCommandIssued(h, cmd); } catch (eIss) {}
      return result;
    },

    /**
     * 重置私信进度：删该 bot 的 dm_records，并把绑定 leads 的私信阶段回退到 followed_back（可再破冰）。
     * 不删账号/leads 行，不动关注配额。
     * @returns {{ ok: boolean, handle?: string, dm_deleted?: number, leads_reverted?: number, msg?: string }}
     */
    resetDmProgress(idOrHandle) {
      let account = null;
      if (typeof idOrHandle === 'number' || /^\d+$/.test(String(idOrHandle || ''))) {
        account = this.findById(Number(idOrHandle));
      } else {
        account = this.findByHandle(idOrHandle);
      }
      if (!account) return { ok: false, msg: 'account not found' };

      const { normalizeHandle } = require('../utils/handle');
      const h = normalizeHandle(account.x_handle) || String(account.x_handle || '').toLowerCase().trim();
      const run = db.transaction(() => {
        const dmDel = db.prepare(`
          DELETE FROM dm_records
          WHERE LOWER(REPLACE(REPLACE(COALESCE(bot_handle,''), '@', ''), '#guard', '')) = LOWER(?)
             OR LOWER(REPLACE(COALESCE(bot_handle,''), '@', '')) = LOWER(?)
        `).run(h, h);

        const leadUp = db.prepare(`
          UPDATE leads
          SET current_stage = 'followed_back',
              close_reason = NULL,
              updated_at = datetime('now', '+8 hours'),
              last_activity_at = datetime('now', '+8 hours')
          WHERE bound_account_id = ?
            AND current_stage IN ('ice_sent', 'ad_sent', 'kick_sent', 'rejected', 'converted')
        `).run(account.id);

        return {
          dm_deleted: dmDel.changes || 0,
          leads_reverted: leadUp.changes || 0,
        };
      });

      const counts = run();
      return {
        ok: true,
        handle: account.x_handle,
        account_id: account.id,
        dm_deleted: counts.dm_deleted,
        leads_reverted: counts.leads_reverted,
      };
    },

    getCommand(handle) {
      return db.prepare('SELECT command, created_at, updated_at FROM account_commands WHERE LOWER(x_handle) = LOWER(?)')
        .get(String(handle || '').toLowerCase()) || null;
    },

    clearCommand(handle, command) {
      const h = String(handle || '').toLowerCase();
      if (command) {
        return db.prepare('DELETE FROM account_commands WHERE LOWER(x_handle) = LOWER(?) AND command = ?')
          .run(h, command);
      }
      return db.prepare('DELETE FROM account_commands WHERE LOWER(x_handle) = LOWER(?)').run(h);
    },

    /** Atomic claim: return command and delete in one transaction */
    claimCommand(handle) {
      const h = String(handle || '').toLowerCase();
      return db.transaction(() => {
        const row = db.prepare('SELECT command FROM account_commands WHERE LOWER(x_handle) = LOWER(?)').get(h);
        if (!row) return null;
        db.prepare('DELETE FROM account_commands WHERE LOWER(x_handle) = LOWER(?)').run(h);
        return row.command;
      })();
    },

    /**
     * Hard-delete account and related data (fresh start for replacement handle).
     * Returns { ok, deleted, counts } or { ok:false, msg }.
     */
    deleteCascade(id) {
      const account = this.findById(id);
      if (!account) return { ok: false, msg: 'account not found' };

      const run = db.transaction(() => {
        const leadIds = db
          .prepare('SELECT id FROM leads WHERE bound_account_id = ?')
          .all(id)
          .map((r) => r.id);

        let logsByAccount = db
          .prepare('DELETE FROM activity_logs WHERE account_id = ?')
          .run(id).changes;

        let logsByLeads = 0;
        if (leadIds.length) {
          const placeholders = leadIds.map(() => '?').join(',');
          logsByLeads = db
            .prepare(`DELETE FROM activity_logs WHERE lead_id IN (${placeholders})`)
            .run(...leadIds).changes;
        }

        const stats = db
          .prepare('DELETE FROM account_daily_stats WHERE account_id = ?')
          .run(id).changes;

        const dms = db
          .prepare('DELETE FROM dm_records WHERE bot_handle = ?')
          .run(account.x_handle).changes;

        const overrides = db
          .prepare('DELETE FROM config_account_overrides WHERE x_handle = ?')
          .run(account.x_handle).changes;

        const commands = db
          .prepare('DELETE FROM account_commands WHERE x_handle = ?')
          .run(account.x_handle).changes;

        let runtime = 0;
        try {
          runtime = db
            .prepare('DELETE FROM account_runtime_status WHERE LOWER(x_handle) = LOWER(?)')
            .run(account.x_handle).changes;
        } catch (eRt) { runtime = 0; }

        const leads = db
          .prepare('DELETE FROM leads WHERE bound_account_id = ?')
          .run(id).changes;

        const accounts = db.prepare('DELETE FROM accounts WHERE id = ?').run(id).changes;
        if (accounts !== 1) throw new Error('account delete failed');

        return {
          handle: account.x_handle,
          activity_logs: logsByAccount + logsByLeads,
          account_daily_stats: stats,
          dm_records: dms,
          overrides,
          commands,
          runtime,
          leads,
          accounts,
        };
      });

      return { ok: true, deleted: account.display_name || account.x_handle, counts: run() };
    },
  };
}

module.exports = { createAccountsRepo };

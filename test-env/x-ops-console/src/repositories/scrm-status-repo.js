const { shanghaiNowTs, shanghaiDateKey, shanghaiMinutes } = require('../utils/shanghai-date');
const { todayCreatedAtLikeParams, TODAY_CREATED_AT_SQL } = require('../utils/shanghai-date');
const { parseHmToMinutes } = require('../utils/shanghai-date');

const STALE_MS = 45 * 60 * 1000;
/** 非工作时段 / 早间宽限：最多继承多久之前的「曾在线」快照 */
const INHERIT_MAX_MS = 18 * 60 * 60 * 1000;
/** 上班后等待首次抓取的宽限（与 scrapeInterval≈12min + 抖动对齐） */
const MORNING_GRACE_MS = 50 * 60 * 1000;
const PUSH_DEDUP_MS = 2 * 60 * 60 * 1000;

function parseSnapMs(s) {
  if (!s) return 0;
  const raw = String(s).trim();
  // ISO-ish: 2026-08-02T09:00:00+08:00
  const iso = Date.parse(raw);
  if (!Number.isNaN(iso)) return iso;
  const m = raw.match(
    /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0) - 8, +(m[5] || 0), +(m[6] || 0));
}

function createScrmStatusRepo(db) {
  return {
    upsertSnapshot(body, ts) {
      const stamp = ts || shanghaiNowTs();
      const agents = (body && body.agents) || {};
      const notFound = Array.isArray(body && body.notFound) ? body.notFound : [];
      const snapshotAt = (body && body.timestamp) || stamp;
      const summary = (body && body.summary) || {};

      const upsert = db.prepare(`
        INSERT INTO scrm_agent_status (
          agent_id, nickname, online, status_text, remark,
          today_done, today_target, not_found, snapshot_at, raw_json, updated_at
        ) VALUES (
          @agent_id, @nickname, @online, @status_text, @remark,
          @today_done, @today_target, @not_found, @snapshot_at, @raw_json, @updated_at
        )
        ON CONFLICT(agent_id) DO UPDATE SET
          nickname = excluded.nickname,
          online = excluded.online,
          status_text = excluded.status_text,
          remark = excluded.remark,
          today_done = excluded.today_done,
          today_target = excluded.today_target,
          not_found = excluded.not_found,
          snapshot_at = excluded.snapshot_at,
          raw_json = excluded.raw_json,
          updated_at = excluded.updated_at
      `);

      const seen = new Set();
      const tx = db.transaction(() => {
        // 每次快照全量替换监控名单，避免旧客服号残留导致误放行
        db.prepare('DELETE FROM scrm_agent_status').run();
        for (const [aid, data] of Object.entries(agents)) {
          const id = String(aid || '').trim();
          if (!id) continue;
          seen.add(id.toLowerCase());
          upsert.run({
            agent_id: id.startsWith('@') ? id : `@${id.replace(/^@/, '')}`,
            nickname: (data && data.nickname) || '',
            online: data && data.online ? 1 : 0,
            status_text: (data && data.statusText) || (data && data.online ? '在线' : '离线'),
            remark: (data && data.remark) || '',
            today_done: Number(data && data.todayDone) || 0,
            today_target: Number(data && data.todayTarget) || 0,
            not_found: 0,
            snapshot_at: snapshotAt,
            raw_json: JSON.stringify(data || {}),
            updated_at: stamp,
          });
        }
        for (const raw of notFound) {
          let id = String(raw || '').trim();
          if (!id) continue;
          if (!id.startsWith('@')) id = `@${id}`;
          seen.add(id.toLowerCase());
          upsert.run({
            agent_id: id,
            nickname: '',
            online: 0,
            status_text: '未找到',
            remark: '',
            today_done: 0,
            today_target: 0,
            not_found: 1,
            snapshot_at: snapshotAt,
            raw_json: JSON.stringify({ notFound: true }),
            updated_at: stamp,
          });
        }

        db.prepare(`
          INSERT INTO scrm_status_meta (key, value, updated_at) VALUES ('last_snapshot_at', ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(snapshotAt, stamp);
        db.prepare(`
          INSERT INTO scrm_status_meta (key, value, updated_at) VALUES ('summary_json', ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(JSON.stringify(summary), stamp);
        db.prepare(`
          INSERT INTO scrm_status_meta (key, value, updated_at) VALUES ('not_found_json', ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(JSON.stringify(notFound), stamp);

        // 每日进线存档：取当日峰值（SCRM today_done 日中只增），日切后仍可查历史
        try {
          this._recordInboundDaily(stamp, snapshotAt, agents, summary);
        } catch (eDaily) {}
      });
      tx();
      return { ok: true, agents: Object.keys(agents).length, notFound: notFound.length, snapshotAt };
    },

    /** 写入 scrm_inbound_daily（按日 MAX today_done） */
    _recordInboundDaily(stamp, snapshotAt, agents, summary) {
      const day = shanghaiDateKey();
      let ice = 0;
      let adLink = 0;
      try {
        const p = todayCreatedAtLikeParams();
        const rows = db.prepare(`
          SELECT round_number, result, message_content FROM dm_records
          WHERE ${TODAY_CREATED_AT_SQL}
        `).all(p);
        for (const r of rows) {
          if (String(r.result || 'success').toLowerCase() !== 'success') continue;
          const rn = Number(r.round_number) || 0;
          if (rn === 1) ice += 1;
          else if (rn === 2 && /line\.me|https?:\/\//i.test(String(r.message_content || ''))) adLink += 1;
        }
      } catch (eDm) {}

      const upsertDaily = db.prepare(`
        INSERT INTO scrm_inbound_daily (
          stat_date, agent_id, today_done, today_target, online, ice, ad_link, snapshot_at, updated_at
        ) VALUES (
          @stat_date, @agent_id, @today_done, @today_target, @online, @ice, @ad_link, @snapshot_at, @updated_at
        )
        ON CONFLICT(stat_date, agent_id) DO UPDATE SET
          today_done = CASE WHEN excluded.today_done > scrm_inbound_daily.today_done THEN excluded.today_done ELSE scrm_inbound_daily.today_done END,
          today_target = CASE WHEN excluded.today_target > scrm_inbound_daily.today_target THEN excluded.today_target ELSE scrm_inbound_daily.today_target END,
          online = excluded.online,
          ice = CASE WHEN excluded.ice > scrm_inbound_daily.ice THEN excluded.ice ELSE scrm_inbound_daily.ice END,
          ad_link = CASE WHEN excluded.ad_link > scrm_inbound_daily.ad_link THEN excluded.ad_link ELSE scrm_inbound_daily.ad_link END,
          snapshot_at = excluded.snapshot_at,
          updated_at = excluded.updated_at
      `);

      for (const [aid, data] of Object.entries(agents || {})) {
        let id = String(aid || '').trim();
        if (!id) continue;
        if (!id.startsWith('@')) id = `@${id.replace(/^@/, '')}`;
        upsertDaily.run({
          stat_date: day,
          agent_id: id,
          today_done: Number(data && data.todayDone) || 0,
          today_target: Number(data && data.todayTarget) || 0,
          online: data && data.online ? 1 : 0,
          ice: 0,
          ad_link: 0,
          snapshot_at: snapshotAt,
          updated_at: stamp,
        });
      }

      const sumDone = Number(summary && (summary.todayValidLeads != null ? summary.todayValidLeads : summary.todayLeads)) || 0;
      let agentSum = 0;
      for (const data of Object.values(agents || {})) {
        agentSum += Number(data && data.todayDone) || 0;
      }
      const fleetDone = Math.max(sumDone, agentSum);
      upsertDaily.run({
        stat_date: day,
        agent_id: '__summary__',
        today_done: fleetDone,
        today_target: 0,
        online: 0,
        ice,
        ad_link: adLink,
        snapshot_at: snapshotAt,
        updated_at: stamp,
      });
    },

    /** 近 N 日进线曲线（含破冰/带链，便于粗转化） */
    listInboundDaily({ days = 14 } = {}) {
      const n = Math.min(60, Math.max(1, Number(days) || 14));
      try {
        const rows = db.prepare(`
          SELECT stat_date, today_done, ice, ad_link, snapshot_at, updated_at
          FROM scrm_inbound_daily
          WHERE agent_id = '__summary__'
          ORDER BY stat_date DESC
          LIMIT ?
        `).all(n);
        return rows.reverse();
      } catch (e) {
        return [];
      }
    },

    /** 页面打开时也可落当日峰值（不依赖爬虫刚好上报） */
    ensureTodayInboundRecorded() {
      try {
        const agentsRows = this.listAgents() || [];
        const agents = {};
        for (const a of agentsRows) {
          const id = String(a.agent_id || '').replace(/^@/, '');
          if (!id || a.not_found) continue;
          agents[id] = {
            todayDone: a.today_done,
            todayTarget: a.today_target,
            online: !!a.online,
          };
        }
        let summary = {};
        try { summary = JSON.parse(this.getMeta('summary_json') || '{}') || {}; } catch (e) {}
        const stamp = shanghaiNowTs();
        const snapshotAt = this.getMeta('last_snapshot_at') || stamp;
        this._recordInboundDaily(stamp, snapshotAt, agents, summary);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    getMeta(key) {
      const row = db.prepare('SELECT value FROM scrm_status_meta WHERE key = ?').get(key);
      return row ? row.value : null;
    },

    setMeta(key, value, ts) {
      const stamp = ts || shanghaiNowTs();
      db.prepare(`
        INSERT INTO scrm_status_meta (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(key, String(value), stamp);
    },

    listAgents() {
      return db.prepare('SELECT * FROM scrm_agent_status ORDER BY agent_id').all();
    },

    saveLinkSync(agentIds, ts) {
      const stamp = ts || shanghaiNowTs();
      db.prepare(`
        INSERT INTO scrm_link_sync (id, agent_ids_json, synced_at, updated_at)
        VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          agent_ids_json = excluded.agent_ids_json,
          synced_at = excluded.synced_at,
          updated_at = excluded.updated_at
      `).run(JSON.stringify(agentIds || []), stamp, stamp);
    },

    getLinkSync() {
      return db.prepare('SELECT * FROM scrm_link_sync WHERE id = 1').get() || null;
    },

    clearAllAgents() {
      return db.prepare('DELETE FROM scrm_agent_status').run().changes;
    },

    getScrmWorkWindow() {
      const startMin = parseHmToMinutes(this.getThreshold('scrm_work_start') || '08:00', 8 * 60);
      const endMin = parseHmToMinutes(this.getThreshold('scrm_work_end') || '19:00', 19 * 60);
      return { startMin, endMin };
    },

    /**
     * strict | soft | off
     * soft（默认）：被墙/过期/未找到时不拦私信；仅「新鲜快照且确认离线」才拦。
     */
    getGateMode() {
      const m = String(this.getThreshold('scrm_gate_mode') || 'soft').toLowerCase().trim();
      if (m === 'strict' || m === 'off' || m === 'soft') return m;
      return 'soft';
    },

    setGateMode(mode) {
      const m = String(mode || '').toLowerCase().trim();
      if (!['strict', 'soft', 'off'].includes(m)) {
        return { ok: false, msg: 'mode must be strict|soft|off' };
      }
      this.setThreshold('scrm_gate_mode', m);
      return { ok: true, mode: m };
    },

    /**
     * 只认 expectedAgentIds 白名单（来自 promo_links）。
     * 内容判定：白名单非空 && 至少一个白名单号 online。
     * 新鲜度：工作时段严格 45min stale；非工作时段 / 早间宽限可继承「曾在线」快照（≤18h）。
     * soft 模式：检测失败（墙/过期/未找到）软放行，避免 SCRM 被墙导致全天不能私信。
     * 人工强制放行：scrm_gate_force_allow=1 且 until 未过期 → allow_chat=true，附带 warn_reason。
     */
    evaluateGate(opts) {
      opts = opts || {};
      const now = opts.now || Date.now();
      const snapshotAt = this.getMeta('last_snapshot_at');
      const snapMs = parseSnapMs(snapshotAt);
      const snapAge = snapMs ? (now - snapMs) : Infinity;
      const stale = !snapMs || snapAge > STALE_MS;

      let expected = Array.isArray(opts.expectedAgentIds) ? opts.expectedAgentIds.slice() : [];
      if (!expected.length) {
        try {
          const sync = this.getLinkSync();
          expected = sync && sync.agent_ids_json ? JSON.parse(sync.agent_ids_json) : [];
        } catch (e) { expected = []; }
      }
      expected = expected.map((id) => {
        let s = String(id || '').trim();
        if (!s) return '';
        if (!s.startsWith('@')) s = `@${s}`;
        return s.toLowerCase();
      }).filter(Boolean);
      const expectedSet = new Set(expected);

      const byId = new Map();
      for (const a of this.listAgents()) {
        const id = String(a.agent_id || '').toLowerCase();
        if (id) byId.set(id, a);
      }

      const viewAgents = [];
      if (expectedSet.size) {
        for (const id of expected) {
          const row = byId.get(id);
          if (!row) {
            viewAgents.push({
              agent_id: id,
              nickname: '',
              online: false,
              status_text: '未找到',
              not_found: true,
              today_done: 0,
              today_target: 0,
              remark: '',
            });
          } else {
            viewAgents.push({
              agent_id: row.agent_id,
              nickname: row.nickname || '',
              online: row.online === 1 && row.not_found !== 1,
              status_text: row.not_found === 1 ? '未找到' : (row.status_text || ''),
              not_found: row.not_found === 1,
              today_done: row.today_done || 0,
              today_target: row.today_target || 0,
              remark: row.remark || '',
            });
          }
        }
      }

      const notFoundList = viewAgents.filter((a) => a.not_found).map((a) => a.agent_id);
      const found = viewAgents.filter((a) => !a.not_found);
      const online = found.filter((a) => a.online);

      const { startMin, endMin } = this.getScrmWorkWindow();
      const minsNow = shanghaiMinutes(now);
      const inWork = minsNow >= startMin && minsNow < endMin;
      const morningGrace = minsNow >= startMin && minsNow < startMin + Math.round(MORNING_GRACE_MS / 60000);
      const gateMode = this.getGateMode();

      let allow_chat = false;
      let reason = '';
      let inherited = false;
      let inherit_reason = '';

      if (gateMode === 'off') {
        allow_chat = true;
        inherited = true;
        inherit_reason = '闸门关闭(仅展示)';
      } else if (!expectedSet.size) {
        reason = 'SCRM未配置监控号';
      } else if (!found.length) {
        reason = 'SCRM客服号未找到';
      } else if (!online.length) {
        reason = 'SCRM客服离线';
      } else if (stale) {
        const canInherit = snapAge <= INHERIT_MAX_MS && (!inWork || morningGrace);
        if (canInherit) {
          allow_chat = true;
          inherited = true;
          inherit_reason = inWork ? '早间等待SCRM刷新' : '非工作时段继承';
          reason = '';
        } else {
          reason = snapMs ? 'SCRM状态过期' : 'SCRM未上报';
        }
      } else {
        allow_chat = true;
        reason = '';
      }

      // soft：被墙/过期/未找到/未配置监控号 → 软放行；仅「新鲜快照 + 确认离线」硬拦
      // （未配置监控号旧逻辑硬拦会导致全天 0 私信，与 soft 文案不一致）
      if (gateMode === 'soft' && !allow_chat && reason) {
        const hardOffline = !stale && found.length > 0 && online.length === 0 && reason === 'SCRM客服离线';
        if (!hardOffline) {
          inherit_reason = `SCRM软放行:${reason}`;
          allow_chat = true;
          inherited = true;
          // 保留 warn，页面可见；reason 清空以便 allow_chat
          reason = '';
        }
      }

      let summary = {};
      try { summary = JSON.parse(this.getMeta('summary_json') || '{}') || {}; } catch (e) {}

      const forceState = this.getForceAllowState(now);
      let force_allow = false;
      let warn_reason = inherit_reason;
      let force_until = forceState.until || '';
      if (forceState.active) {
        force_allow = true;
        if (!allow_chat) {
          warn_reason = reason || 'SCRM未放行';
          allow_chat = true;
          reason = '';
        } else if (!warn_reason) {
          warn_reason = '';
        }
      } else if (forceState.expired) {
        // 到期自动清标志，避免残留 1 误导配置页
        try { this.clearForceAllow(); } catch (eClr) {}
        force_until = '';
      }

      return {
        ok: true,
        allow_chat,
        reason,
        force_allow,
        warn_reason,
        force_until,
        inherited,
        inherit_reason,
        gate_mode: gateMode,
        stale: !!stale,
        in_scrm_work: inWork,
        morning_grace: !!morningGrace,
        online_count: online.length,
        found_count: found.length,
        total_monitored: viewAgents.length,
        expected_agent_ids: expected,
        not_found: notFoundList,
        snapshot_at: snapshotAt || '',
        summary,
        agents: viewAgents,
      };
    },

    getThreshold(key) {
      try {
        const row = db.prepare('SELECT value FROM config_thresholds WHERE key = ?').get(key);
        return row && row.value != null ? String(row.value) : '';
      } catch (e) {
        return '';
      }
    },

    setThreshold(key, value) {
      db.prepare(`
        INSERT INTO config_thresholds (key, value, updated_at)
        VALUES (?, ?, datetime('now', '+8 hours'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', '+8 hours')
      `).run(String(key), String(value == null ? '' : value));
    },

    /** 解析强制放行截止时间（上海墙钟串 → ms） */
    parseForceUntilMs(raw) {
      const s = String(raw || '').trim();
      if (!s) return 0;
      const m = s.match(
        /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/
      );
      if (m) {
        const t = Date.UTC(
          Number(m[1]), Number(m[2]) - 1, Number(m[3]),
          Number(m[4] || 0) - 8, Number(m[5] || 0), Number(m[6] || 0)
        );
        return Number.isNaN(t) ? 0 : t;
      }
      const t = Date.parse(s);
      return Number.isNaN(t) ? 0 : t;
    },

    formatForceUntil(ms) {
      return new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    },

    getForceAllowState(now) {
      now = now || Date.now();
      const flag = this.getThreshold('scrm_gate_force_allow');
      const until = this.getThreshold('scrm_gate_force_allow_until');
      const untilMs = this.parseForceUntilMs(until);
      if (flag !== '1' || !untilMs) {
        return { active: false, expired: flag === '1' && !!until && !untilMs, until, untilMs: 0 };
      }
      if (now >= untilMs) {
        return { active: false, expired: true, until, untilMs };
      }
      return { active: true, expired: false, until, untilMs };
    },

    openForceAllow(hours) {
      const h = Math.min(48, Math.max(1, Number(hours) || 6));
      const untilMs = Date.now() + h * 3600 * 1000;
      const until = this.formatForceUntil(untilMs);
      this.setThreshold('scrm_gate_force_allow', '1');
      this.setThreshold('scrm_gate_force_allow_until', until);
      return { ok: true, action: 'open', hours: h, until };
    },

    extendForceAllow(hours) {
      const h = Math.min(48, Math.max(1, Number(hours) || 6));
      const now = Date.now();
      const st = this.getForceAllowState(now);
      const base = st.untilMs && st.untilMs > now ? st.untilMs : now;
      const untilMs = base + h * 3600 * 1000;
      const until = this.formatForceUntil(untilMs);
      this.setThreshold('scrm_gate_force_allow', '1');
      this.setThreshold('scrm_gate_force_allow_until', until);
      return { ok: true, action: 'extend', hours: h, until };
    },

    clearForceAllow() {
      this.setThreshold('scrm_gate_force_allow', '0');
      this.setThreshold('scrm_gate_force_allow_until', '');
      return { ok: true, action: 'clear' };
    },

    /** 闸门失败时是否该 Push（2h 去重，按 reason） */
    shouldPushGateFail(reason, now) {
      now = now || Date.now();
      if (!reason) return false;
      const key = `last_gate_push_${reason}`;
      const prev = this.getMeta(key);
      const prevMs = parseSnapMs(prev) || (prev ? Date.parse(prev) : 0);
      if (prevMs && now - prevMs < PUSH_DEDUP_MS) return false;
      this.setMeta(key, new Date(now).toISOString());
      return true;
    },
  };
}

module.exports = {
  createScrmStatusRepo,
  parseSnapMs,
  shanghaiMinutes,
  parseHmToMinutes,
  STALE_MS,
  INHERIT_MAX_MS,
  MORNING_GRACE_MS,
  PUSH_DEDUP_MS,
};

const { shanghaiNowTs } = require('../utils/shanghai-date');

const EXT_KEYS = [
  'engine',
  'stage',
  'running_module',
  'why_idle',
  'followed_today',
  'follow_limit',
  'auto_mode',
  'detail_json',
  'heartbeat_kind',
];

function hasExtFields(body) {
  if (!body || typeof body !== 'object') return false;
  return EXT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined);
}

function normalizeModule(v) {
  if (v == null || v === '') return '';
  const s = String(v).toLowerCase().trim();
  if (s === 'null' || s === 'none' || s === 'idle') return '';
  if (s === 'chat' || s === 'follow' || s === 'nurture') return s;
  return s.slice(0, 32);
}

function toInt01(v) {
  if (v === true || v === 1 || v === '1' || v === 'true') return 1;
  return 0;
}

function createRuntimeStatusRepo(db) {
  return {
    findByHandle(handle) {
      const h = String(handle || '').replace(/^@/, '').toLowerCase().trim();
      if (!h) return null;
      return db.prepare('SELECT * FROM account_runtime_status WHERE LOWER(x_handle) = LOWER(?)').get(h) || null;
    },

    /** 远程下发 start/pause 时打 issued 戳，供「指令未确认」判定 */
    markCommandIssued(handle, command, ts) {
      const h = String(handle || '').replace(/^@/, '').toLowerCase().trim();
      if (!h) return;
      const stamp = ts || shanghaiNowTs();
      const cmd = String(command || '').toLowerCase();
      db.prepare(`
        INSERT INTO account_runtime_status (
          x_handle, last_cmd_issued, last_cmd_issued_at, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(x_handle) DO UPDATE SET
          last_cmd_issued = excluded.last_cmd_issued,
          last_cmd_issued_at = excluded.last_cmd_issued_at,
          updated_at = excluded.updated_at
      `).run(h, cmd, stamp, stamp);
    },

    /** 插件 ACK：写回执，可选同步 auto_mode / running_module 快照 */
    markCommandAcked(handle, command, opts) {
      const h = String(handle || '').replace(/^@/, '').toLowerCase().trim();
      if (!h) return { ok: false, msg: 'handle required' };
      const stamp = (opts && opts.ts) || shanghaiNowTs();
      const cmd = String(command || '').toLowerCase();
      const ok = opts && opts.ok === false ? 0 : 1;
      const botId = (opts && opts.bot_id) || null;

      const existing = this.findByHandle(h);
      let autoMode = existing ? existing.auto_mode : 0;
      let runningModule = existing ? (existing.running_module || '') : '';
      if (opts && Object.prototype.hasOwnProperty.call(opts, 'auto_mode')) {
        autoMode = toInt01(opts.auto_mode);
      }
      if (opts && Object.prototype.hasOwnProperty.call(opts, 'running_module')) {
        runningModule = normalizeModule(opts.running_module);
      }

      db.prepare(`
        INSERT INTO account_runtime_status (
          x_handle, bot_id, auto_mode, running_module,
          last_cmd, last_cmd_acked_at, last_cmd_ok,
          last_seen_at, updated_at
        ) VALUES (
          @h, @bot_id, @auto_mode, @running_module,
          @last_cmd, @acked_at, @last_cmd_ok,
          @seen, @seen
        )
        ON CONFLICT(x_handle) DO UPDATE SET
          bot_id = COALESCE(excluded.bot_id, account_runtime_status.bot_id),
          auto_mode = excluded.auto_mode,
          running_module = excluded.running_module,
          last_cmd = excluded.last_cmd,
          last_cmd_acked_at = excluded.last_cmd_acked_at,
          last_cmd_ok = excluded.last_cmd_ok,
          last_seen_at = excluded.last_seen_at,
          updated_at = excluded.updated_at
      `).run({
        h,
        bot_id: botId,
        auto_mode: autoMode,
        running_module: runningModule,
        last_cmd: cmd,
        acked_at: stamp,
        last_cmd_ok: ok,
        seen: stamp,
      });
      return { ok: true, handle: h, command: cmd };
    },

    /**
     * 字段级 merge upsert。
     * - 仅 bot_id：只 touch last_seen_at（不覆盖业务列；无行则可插空壳）
     * - lite / 部分字段：只更新显式出现的键
     * - full / edge：写入出现的键；running_module null/缺省空串=空闲；why_idle 允许 ""
     */
    upsertHeartbeat(handle, body, ts) {
      const h = String(handle || '').replace(/^@/, '').toLowerCase().trim();
      if (!h) return { ok: false, msg: 'handle required' };
      const stamp = ts || shanghaiNowTs();
      const botId = (body && body.bot_id) || null;
      const existing = this.findByHandle(h);

      if (!hasExtFields(body)) {
        if (!existing) {
          db.prepare(`
            INSERT INTO account_runtime_status (x_handle, bot_id, last_seen_at, updated_at)
            VALUES (?, ?, ?, ?)
          `).run(h, botId, stamp, stamp);
        } else {
          db.prepare(`
            UPDATE account_runtime_status
            SET bot_id = COALESCE(?, bot_id), last_seen_at = ?, updated_at = ?
            WHERE LOWER(x_handle) = LOWER(?)
          `).run(botId, stamp, stamp, h);
        }
        return { ok: true, handle: h, merged: false };
      }

      const kind = String((body && body.heartbeat_kind) || '').toLowerCase();
      const isLite = kind === 'lite';

      const next = {
        bot_id: botId != null ? botId : (existing && existing.bot_id) || null,
        engine: existing ? existing.engine : null,
        stage: existing ? existing.stage : null,
        running_module: existing ? (existing.running_module || '') : '',
        why_idle: existing ? (existing.why_idle || '') : '',
        followed_today: existing ? (existing.followed_today || 0) : 0,
        follow_limit: existing ? (existing.follow_limit || 0) : 0,
        auto_mode: existing ? (existing.auto_mode || 0) : 0,
        detail_json: existing ? existing.detail_json : null,
      };

      const setIf = (key, transform) => {
        if (!Object.prototype.hasOwnProperty.call(body, key)) return;
        let v = body[key];
        if (isLite && (v === '' || v === null || v === undefined)) return;
        if (transform) v = transform(v);
        next[key] = v;
      };

      setIf('engine', (v) => (v == null ? null : String(v).slice(0, 32)));
      setIf('stage', (v) => (v == null ? null : String(v).slice(0, 8)));
      if (Object.prototype.hasOwnProperty.call(body, 'running_module')) {
        next.running_module = normalizeModule(body.running_module);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'why_idle')) {
        const w = body.why_idle;
        if (!(isLite && (w === null || w === undefined))) {
          next.why_idle = w == null ? '' : String(w).slice(0, 200);
        }
      }
      setIf('followed_today', (v) => {
        const n = parseInt(v, 10);
        return Number.isFinite(n) ? n : 0;
      });
      setIf('follow_limit', (v) => {
        const n = parseInt(v, 10);
        return Number.isFinite(n) ? n : 0;
      });
      if (Object.prototype.hasOwnProperty.call(body, 'auto_mode')) {
        next.auto_mode = toInt01(body.auto_mode);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'detail_json')
        || Object.prototype.hasOwnProperty.call(body, 'url')
        || Object.prototype.hasOwnProperty.call(body, 'chat_rounds_today')) {
        let detail = {};
        try {
          if (next.detail_json) detail = JSON.parse(next.detail_json) || {};
        } catch (e) { detail = {}; }
        if (Object.prototype.hasOwnProperty.call(body, 'url')) detail.url = body.url;
        if (Object.prototype.hasOwnProperty.call(body, 'chat_rounds_today')) {
          detail.chat_rounds_today = body.chat_rounds_today;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'detail_json')) {
          try {
            const incoming = typeof body.detail_json === 'string'
              ? JSON.parse(body.detail_json)
              : body.detail_json;
            if (incoming && typeof incoming === 'object') Object.assign(detail, incoming);
          } catch (e2) {}
        }
        next.detail_json = JSON.stringify(detail);
      }

      db.prepare(`
        INSERT INTO account_runtime_status (
          x_handle, bot_id, engine, stage, running_module, why_idle,
          followed_today, follow_limit, auto_mode, detail_json,
          last_seen_at, updated_at
        ) VALUES (
          @h, @bot_id, @engine, @stage, @running_module, @why_idle,
          @followed_today, @follow_limit, @auto_mode, @detail_json,
          @seen, @seen
        )
        ON CONFLICT(x_handle) DO UPDATE SET
          bot_id = excluded.bot_id,
          engine = excluded.engine,
          stage = excluded.stage,
          running_module = excluded.running_module,
          why_idle = excluded.why_idle,
          followed_today = excluded.followed_today,
          follow_limit = excluded.follow_limit,
          auto_mode = excluded.auto_mode,
          detail_json = excluded.detail_json,
          last_seen_at = excluded.last_seen_at,
          updated_at = excluded.updated_at
      `).run({
        h,
        bot_id: next.bot_id,
        engine: next.engine,
        stage: next.stage,
        running_module: next.running_module,
        why_idle: next.why_idle,
        followed_today: next.followed_today,
        follow_limit: next.follow_limit,
        auto_mode: next.auto_mode,
        detail_json: next.detail_json,
        seen: stamp,
      });
      return { ok: true, handle: h, merged: true, kind: kind || 'full' };
    },

    deleteByHandle(handle) {
      const h = String(handle || '').replace(/^@/, '').toLowerCase().trim();
      if (!h) return 0;
      return db.prepare('DELETE FROM account_runtime_status WHERE LOWER(x_handle) = LOWER(?)').run(h).changes;
    },
  };
}

/** 派生私信态 + 指令未确认 */
function deriveChatState(runtime, opts) {
  opts = opts || {};
  const hasAutoFlag = runtime && (
    runtime.auto_mode === 0
    || runtime.auto_mode === 1
    || runtime.auto_mode === true
    || runtime.auto_mode === false
  );
  const auto = !!(runtime && (runtime.auto_mode === 1 || runtime.auto_mode === true));
  const mod = runtime ? normalizeModule(runtime.running_module) : '';
  let chat_state = 'unknown';
  let chat_state_label = '未上报';
  if (!runtime || (!hasRuntimeBusiness(runtime) && !hasAutoFlag && !runtime.last_seen_at)) {
    chat_state = 'unknown';
    chat_state_label = '未上报';
  } else if (!hasAutoFlag && !runtime.engine && !runtime.stage && !mod && !runtime.why_idle) {
    // 仅有指令 issued/ack 戳、尚未收到运行态心跳 → 仍算未上报
    chat_state = 'unknown';
    chat_state_label = '未上报';
  } else if (!auto) {
    chat_state = 'off';
    chat_state_label = '未自动';
  } else if (mod === 'chat') {
    chat_state = 'running';
    chat_state_label = '私信开启';
  } else {
    chat_state = 'idle';
    chat_state_label = '私信歇';
  }

  const issuedAt = runtime && runtime.last_cmd_issued_at;
  const ackedAt = runtime && runtime.last_cmd_acked_at;
  const issuedMs = opts.parseSeenMs ? opts.parseSeenMs(issuedAt) : 0;
  const ackedMs = opts.parseSeenMs ? opts.parseSeenMs(ackedAt) : 0;
  const now = opts.now || Date.now();
  let cmd_unconfirmed = false;
  let cmd_pending = false;
  if (issuedMs > 0 && (!ackedMs || ackedMs < issuedMs)) {
    const age = now - issuedMs;
    if (age > 30000) cmd_unconfirmed = true;
    else cmd_pending = true;
  }

  return {
    chat_state,
    chat_state_label,
    cmd_unconfirmed,
    cmd_pending,
    why_idle: (runtime && runtime.why_idle) || '',
    auto_mode: auto ? 1 : 0,
    running_module: mod || null,
    engine: (runtime && runtime.engine) || '',
    stage: (runtime && runtime.stage) || '',
    last_cmd: (runtime && runtime.last_cmd) || '',
    last_cmd_issued: (runtime && runtime.last_cmd_issued) || '',
    last_cmd_acked_at: ackedAt || '',
  };
}

function hasRuntimeBusiness(runtime) {
  if (!runtime) return false;
  if (runtime.auto_mode === 0 || runtime.auto_mode === 1) return true;
  if (runtime.auto_mode === true || runtime.auto_mode === false) return true;
  return !!(
    runtime.engine
    || runtime.stage
    || runtime.running_module
    || runtime.why_idle
    || runtime.last_cmd
    || runtime.last_cmd_issued
  );
}

module.exports = {
  createRuntimeStatusRepo,
  deriveChatState,
  hasExtFields,
};

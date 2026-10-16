const { shanghaiNowTs } = require('../utils/shanghai-date');

const ONLINE_MS = 90 * 1000;
const STALE_MS = 5 * 60 * 1000;
const ASSIGNED_HIGH = 20;

function parseSnapMs(s) {
  if (!s) return 0;
  const raw = String(s).trim();
  // OPS 常用上海时间："2026/8/11 00:15:20" —— 不能靠 Date.parse（常 NaN → 误判离线）
  const m = raw.match(
    /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (m) {
    const t = Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4] || 0) - 8,
      Number(m[5] || 0),
      Number(m[6] || 0)
    );
    return Number.isFinite(t) ? t : 0;
  }
  const t = Date.parse(raw.replace(' ', 'T'));
  return Number.isFinite(t) ? t : 0;
}

function presenceOf(lastSeenAt, now) {
  if (!lastSeenAt) return 'never';
  const age = now - parseSnapMs(lastSeenAt);
  if (!Number.isFinite(age) || age < 0) return 'never';
  if (age <= ONLINE_MS) return 'online';
  if (age <= STALE_MS) return 'stale';
  return 'offline';
}

function presenceLabel(p) {
  if (p === 'online') return '在线';
  if (p === 'stale') return '陈旧';
  if (p === 'offline') return '离线';
  return '从未上报';
}

async function fetchPoolStatus(poolUrl) {
  const base = String(poolUrl || 'http://192.168.0.100:15678').replace(/\/$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  try {
    const r = await fetch(`${base}/pool/status`, { signal: ctrl.signal });
    const data = await r.json();
    clearTimeout(timer);
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    return {
      ok: true,
      pending: Number(data.pending) || 0,
      assigned: Number(data.assigned) || 0,
      completed: Number(data.completed) || 0,
      dead: Number(data.dead) || 0,
      raw: data,
    };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: e.message || 'unreachable' };
  }
}

function buildOverview(db, pool, nowMs) {
  const now = nowMs || Date.now();
  const rows = db
    .prepare(
      `
      SELECT
        a.x_handle,
        a.status AS account_status,
        a.last_seen_at AS account_last_seen,
        rs.bot_id,
        rs.engine,
        rs.stage,
        rs.running_module,
        rs.why_idle,
        rs.followed_today,
        rs.follow_limit,
        rs.auto_mode,
        rs.last_seen_at AS runtime_last_seen
      FROM accounts a
      LEFT JOIN account_runtime_status rs ON LOWER(rs.x_handle) = LOWER(a.x_handle)
      WHERE a.x_handle IS NOT NULL AND TRIM(a.x_handle) != ''
      ORDER BY a.x_handle COLLATE NOCASE ASC
    `
    )
    .all();

  const alerts = [];
  const accounts = rows.map((row) => {
    const handle = String(row.x_handle || '')
      .replace(/^@/, '')
      .toLowerCase();
    const lastSeen = row.runtime_last_seen || null;
    const presence = presenceOf(lastSeen, now);
    const never = presence === 'never';
    const autoMode = Number(row.auto_mode) === 1;
    // 测试号/幽灵号标记：从未上报且 handle 含 test/diag，或保留字
    const testLike = never && /(^|[_-])(test|diag|demo|smoke)([_-]|$)/i.test(handle);
    const accAlerts = [];
    if (autoMode && (presence === 'stale' || presence === 'offline')) {
      const item = {
        level: 'warn',
        code: 'heartbeat_stale',
        text: `@${handle} 心跳超时`,
        handle,
      };
      accAlerts.push(item);
      alerts.push(item);
    }
    return {
      x_handle: handle,
      bot_id: row.bot_id || '',
      engine: never ? '' : row.engine || '',
      stage: never ? '' : row.stage || '',
      running_module: never ? '' : row.running_module || '',
      why_idle: never ? '' : row.why_idle || '',
      followed_today: never ? null : Number(row.followed_today) || 0,
      follow_limit: never ? null : Number(row.follow_limit) || 0,
      auto_mode: autoMode,
      last_seen_at: lastSeen || '',
      online: presence === 'online',
      presence,
      presence_label: presenceLabel(presence),
      never_reported: never,
      test_like: !!testLike,
      alerts: accAlerts,
    };
  });

  accounts.sort((a, b) => {
    const rank = { online: 0, stale: 1, offline: 2, never: 3 };
    const ra = rank[a.presence] ?? 9;
    const rb = rank[b.presence] ?? 9;
    if (ra !== rb) return ra - rb;
    return String(b.last_seen_at || '').localeCompare(String(a.last_seen_at || ''));
  });

  if (pool && pool.ok && Number(pool.assigned) >= ASSIGNED_HIGH) {
    alerts.push({
      level: 'warn',
      code: 'pool_assigned_high',
      text: `号池 assigned=${pool.assigned} ≥ ${ASSIGNED_HIGH}`,
      handle: '',
    });
  }
  if (pool && !pool.ok) {
    alerts.push({
      level: 'warn',
      code: 'pool_unreachable',
      text: `号池不可达: ${pool.error || 'unknown'}`,
      handle: '',
    });
  }

  const onlineCount = accounts.filter((a) => a.presence === 'online').length;
  const staleCount = accounts.filter((a) => a.presence === 'stale').length;
  const offlineCount = accounts.filter((a) => a.presence === 'offline').length;
  const neverCount = accounts.filter((a) => a.presence === 'never').length;
  const testCount = accounts.filter((a) => a.test_like).length;
  const autoOnline = accounts.filter(
    (a) => a.auto_mode && a.presence !== 'offline' && a.presence !== 'never'
  ).length;
  const autoStaleOrOffline = accounts.filter(
    (a) => a.auto_mode && (a.presence === 'stale' || a.presence === 'offline')
  ).length;

  return {
    ok: true,
    accounts,
    pool: pool || { ok: false },
    alerts,
    kpi: {
      online: onlineCount,
      auto_active: autoOnline,
      auto_stale_or_offline: autoStaleOrOffline,
      total: accounts.length,
      pending: pool && pool.ok ? pool.pending : null,
      assigned: pool && pool.ok ? pool.assigned : null,
    },
    counts: {
      online: onlineCount,
      stale: staleCount,
      offline: offlineCount,
      never: neverCount,
      test: testCount,
    },
    generated_at: shanghaiNowTs(),
  };
}

module.exports = {
  buildOverview,
  fetchPoolStatus,
  presenceOf,
  ONLINE_MS,
  STALE_MS,
  ASSIGNED_HIGH,
};

/** Shanghai calendar helpers — 强制 24h（h23），禁止 en-US 字符串把下午解析成凌晨 */

function shanghaiParts(nowMs) {
  const now = new Date(nowMs != null ? nowMs : Date.now());
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    let h = 0;
    let m = 0;
    for (const p of parts) {
      if (p.type === 'hour') h = parseInt(p.value, 10);
      if (p.type === 'minute') m = parseInt(p.value, 10);
    }
    if (h === 24) h = 0;
    if (!Number.isNaN(h) && !Number.isNaN(m) && h >= 0 && h <= 23) {
      return { h, m, minutes: h * 60 + m };
    }
  } catch (e) {}
  try {
    const utc = now.getTime() + 8 * 3600 * 1000;
    const d = new Date(utc);
    const hh = d.getUTCHours();
    const mm = d.getUTCMinutes();
    return { h: hh, m: mm, minutes: hh * 60 + mm };
  } catch (e2) {
    return { h: 0, m: 0, minutes: 0 };
  }
}

function shanghaiMinutes(nowMs) {
  return shanghaiParts(nowMs).minutes;
}

function shanghaiHour(nowMs) {
  return shanghaiParts(nowMs).h;
}

function shanghaiDateKey() {
  try {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  } catch (e) {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
  }
}

function shanghaiNowTs() {
  const p = shanghaiParts();
  const pad = (n) => String(n).padStart(2, '0');
  try {
    const key = shanghaiDateKey(); // YYYY-MM-DD
    const [y, mo, d] = key.split('-');
    return `${y}/${parseInt(mo, 10)}/${parseInt(d, 10)} ${pad(p.h)}:${pad(p.m)}:00`;
  } catch (e) {
    return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hourCycle: 'h23' });
  }
}

/** Parse last_seen / date strings → YYYY-MM-DD in Shanghai calendar */
function toShanghaiDateKey(s) {
  if (!s) return '';
  const raw = String(s).trim();
  const m = raw.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (m) {
    const y = m[1];
    const mo = String(m[2]).padStart(2, '0');
    const d = String(m[3]).padStart(2, '0');
    return `${y}-${mo}-${d}`;
  }
  const t = new Date(raw.replace(/\//g, '-')).getTime();
  if (Number.isNaN(t)) return '';
  try {
    return new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  } catch (e) {
    return '';
  }
}

/**
 * LIKE params for today's created_at (compatible with 2026/8/1, 2026/08/01, 2026-08-01).
 * Do NOT use SQLite date(created_at) on zh-CN timestamps — it returns NULL.
 */
function todayCreatedAtLikeParams() {
  const key = shanghaiDateKey(); // YYYY-MM-DD
  const [y, mo, d] = key.split('-');
  const bare = `${y}/${parseInt(mo, 10)}/${parseInt(d, 10)}`;
  const padded = `${y}/${mo}/${d}`;
  return {
    key,
    t1: bare + ' %',
    t2: padded + ' %',
    t3: key + '%',
    t4: bare + '%',
  };
}

const TODAY_CREATED_AT_SQL = `(
  created_at LIKE @t1 OR created_at LIKE @t2
  OR created_at LIKE @t3 OR created_at LIKE @t4
)`;

/**
 * 日期区间过滤参数（N 天前 00:00 至今）。
 */
function dateRangeLike(days, col = 'created_at') {
  const nDays = Math.min(30, Math.max(1, Number(days) || 1));
  const nowMs = Date.now();
  const clauses = [];
  const params = [];
  for (let i = nDays - 1; i >= 0; i--) {
    let key;
    try {
      key = new Date(nowMs - i * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    } catch (e) {
      const d = new Date(nowMs - i * 86400000 + 8 * 3600 * 1000);
      key = d.toISOString().slice(0, 10);
    }
    const [y, mo, dd] = key.split('-');
    const m = String(parseInt(mo, 10));
    const d = String(parseInt(dd, 10));
    clauses.push(`${col} LIKE ?`, `${col} LIKE ?`, `${col} LIKE ?`);
    params.push(`${y}/${m}/${d} %`, `${y}/${mo}/${dd} %`, `${y}-${mo}-${dd}%`);
  }
  return { sql: `(${clauses.join(' OR ')})`, params };
}

/** HH:MM → minutes；拒绝 AM/PM 脏值 */
function parseHmToMinutes(raw, fallbackMin) {
  const s = String(raw || '').trim();
  if (!s) return fallbackMin;
  if (/am|pm/i.test(s)) return fallbackMin;
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return fallbackMin;
  const hh = Math.min(23, Math.max(0, Number(m[1]) || 0));
  const mm = Math.min(59, Math.max(0, Number(m[2] || 0) || 0));
  return hh * 60 + mm;
}

module.exports = {
  shanghaiParts,
  shanghaiMinutes,
  shanghaiHour,
  shanghaiDateKey,
  shanghaiNowTs,
  toShanghaiDateKey,
  todayCreatedAtLikeParams,
  TODAY_CREATED_AT_SQL,
  dateRangeLike,
  parseHmToMinutes,
};

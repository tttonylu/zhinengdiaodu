'use strict';

/**
 * H9 转帖来源号池：repost_sources 表 CRUD + 状态
 * status: unknown（未检测）/ alive（正常）/ banned（封禁或不存在）
 */
function createSourcesRepo(db) {
  const cleanHandle = (h) => String(h || '').trim().replace(/^@/, '').toLowerCase();
  const VALID_STATUS = new Set(['unknown', 'alive', 'banned']);

  return {
    list() {
      return db.prepare(
        'SELECT id, handle, status, note, last_checked_at, created_at, updated_at FROM repost_sources ORDER BY handle'
      ).all();
    },

    /** banned 句柄集合（小写），供 H1 组装下发时剔除 */
    bannedSet() {
      const rows = db.prepare("SELECT handle FROM repost_sources WHERE status = 'banned'").all();
      return new Set(rows.map(r => r.handle.toLowerCase()));
    },

    add(handle, note) {
      const h = cleanHandle(handle);
      if (!h) return { ok: false, msg: 'handle 为空' };
      db.prepare(
        "INSERT INTO repost_sources (handle, note) VALUES (?, ?) ON CONFLICT(handle) DO UPDATE SET note = CASE WHEN excluded.note != '' THEN excluded.note ELSE repost_sources.note END, updated_at = datetime('now', '+8 hours')"
      ).run(h, String(note || ''));
      return { ok: true, handle: h };
    },

    setStatus(handle, status) {
      const h = cleanHandle(handle);
      if (!h || !VALID_STATUS.has(status)) return { ok: false, msg: 'bad handle/status' };
      const changes = db.prepare(
        "UPDATE repost_sources SET status = ?, last_checked_at = datetime('now', '+8 hours'), updated_at = datetime('now', '+8 hours') WHERE handle = ?"
      ).run(status, h).changes;
      return { ok: changes > 0, handle: h, status };
    },

    setNote(handle, note) {
      const h = cleanHandle(handle);
      if (!h) return { ok: false };
      db.prepare(
        "UPDATE repost_sources SET note = ?, updated_at = datetime('now', '+8 hours') WHERE handle = ?"
      ).run(String(note || ''), h);
      return { ok: true };
    },

    remove(handle) {
      const h = cleanHandle(handle);
      if (!h) return { ok: false };
      const changes = db.prepare('DELETE FROM repost_sources WHERE handle = ?').run(h).changes;
      return { ok: changes > 0 };
    },

    /** 从现有配置回填：把全局+各账号 override 里的来源号收编进池（幂等） */
    backfillFromConfig() {
      let added = 0;
      const seen = new Set();
      const collect = (raw) => {
        let list = [];
        if (Array.isArray(raw)) list = raw;
        else if (typeof raw === 'string' && raw.trim()) {
          try { const p = JSON.parse(raw); if (Array.isArray(p)) list = p; } catch (e) {
            list = raw.split(/[\s,，、\n]+/);
          }
        }
        list.forEach((x) => {
          const h = cleanHandle(x);
          if (h && !seen.has(h)) {
            seen.add(h);
            db.prepare('INSERT OR IGNORE INTO repost_sources (handle) VALUES (?)').run(h);
            added += 1;
          }
        });
      };
      try {
        const g = db.prepare("SELECT value FROM config_thresholds WHERE key = 'repost_targets'").get();
        if (g) collect(g.value);
      } catch (e) {}
      try {
        db.prepare("SELECT value FROM config_account_overrides WHERE key = 'repost_targets'").all()
          .forEach((r) => collect(r.value));
      } catch (e) {}
      return added;
    },
  };
}

module.exports = { createSourcesRepo };

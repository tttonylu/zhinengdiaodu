'use strict';

/**
 * H11 原创内容池仓储
 * status: pending（待审）/ approved（已批准待发）/ claimed（插件已领）/
 *         posted（已发）/ failed（失败待人工）/ rejected（拒绝）
 * 时间一律日本墙钟字符串 'YYYY-MM-DDTHH:MM'，比较走字典序
 */
const VALID_STATUS = new Set(['pending', 'approved', 'claimed', 'posted', 'failed', 'rejected']);
// H11 内容池绑定台账发帖号：只认 accounts 表里注册过且带 post_only 标签、未封禁的账号
const { parseAccountTags } = require('../utils/account-tags');
const POSTER_BLOCKED_STATUS = new Set(['frozen', 'banned']);

function posterRowOk(row) {
  if (!row) return false;
  if (POSTER_BLOCKED_STATUS.has(String(row.status || '').toLowerCase())) return false;
  return parseAccountTags(row).includes('post_only');
}

function normalizeHandle(handle) {
  return String(handle || '').replace(/^@/, '').toLowerCase().trim();
}

function createContentPoolRepo(db) {
  const now = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }).slice(0, 19);

  function hydrate(row) {
    if (!row) return row;
    let media = [];
    try { media = JSON.parse(row.media_urls || '[]'); } catch (e) { media = []; }
    return Object.assign({}, row, { media_urls: Array.isArray(media) ? media : [] });
  }

  return {
    insert({ accountHandle, persona, text, mediaUrls, scheduledJstAt, source }) {
      const h = String(accountHandle || '').replace(/^@/, '').toLowerCase().trim();
      const body = String(text || '').trim();
      const sched = String(scheduledJstAt || '').trim();
      if (!h) throw new Error('account_handle required');
      if (!body) throw new Error('text required');
      if (body.length > 1000) throw new Error('text too long (max 1000)');
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(sched)) throw new Error('bad scheduled_jst_at');
      const urls = (Array.isArray(mediaUrls) ? mediaUrls : []).filter(Boolean).slice(0, 4);
      const info = db.prepare(`
        INSERT INTO content_pool_items (account_handle, persona, text, media_urls, scheduled_jst_at, source)
        VALUES (@h, @p, @t, @m, @s, @src)
      `).run({
        h, p: String(persona || ''), t: body,
        m: JSON.stringify(urls), s: sched, src: String(source || 'manual'),
      });
      return Number(info.lastInsertRowid);
    },

    listForReview({ status, date, accountHandle } = {}) {
      const where = [];
      const params = {};
      if (status && VALID_STATUS.has(status)) { where.push('status = @status'); params.status = status; }
      if (date && /^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
        where.push("substr(scheduled_jst_at,1,10) = @date"); params.date = date;
      }
      if (accountHandle) {
        where.push('LOWER(account_handle) = LOWER(@handle)');
        params.handle = String(accountHandle).replace(/^@/, '');
      }
      const sql = 'SELECT * FROM content_pool_items '
        + (where.length ? 'WHERE ' + where.join(' AND ') : '')
        + ' ORDER BY scheduled_jst_at ASC, id ASC';
      return db.prepare(sql).all(params).map(hydrate);
    },

    /** 原子领单：approved 且到期的最早一条 → claimed */
    claimDue(handle, nowJst) {
      const h = String(handle || '').replace(/^@/, '').toLowerCase().trim();
      if (!h || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(nowJst)) return null;
      const row = db.prepare(`
        SELECT * FROM content_pool_items
        WHERE LOWER(account_handle) = LOWER(@h) AND status = 'approved' AND scheduled_jst_at <= @now
        ORDER BY scheduled_jst_at ASC, id ASC LIMIT 1
      `).get({ h, now: nowJst });
      if (!row) return null;
      const upd = db.prepare(`
        UPDATE content_pool_items SET status = 'claimed', claimed_at = @ts, updated_at = @ts
        WHERE id = @id AND status = 'approved'
      `).run({ id: row.id, ts: now() });
      if (upd.changes === 0) return null;
      return hydrate(db.prepare('SELECT * FROM content_pool_items WHERE id = ?').get(row.id));
    },

    report(id, result, { externalPostId, failReason } = {}) {
      if (!Number.isInteger(id) || id <= 0) throw new Error('bad id');
      if (result === 'posted') {
        db.prepare(`
          UPDATE content_pool_items
          SET status='posted', external_post_id=@pid, fail_reason='', posted_at=@ts, updated_at=@ts
          WHERE id=@id
        `).run({ id, pid: String(externalPostId || '').slice(0, 64), ts: now() });
      } else if (result === 'retry') {
        db.prepare(`
          UPDATE content_pool_items SET status='approved', claimed_at=NULL,
            fail_reason=@reason, updated_at=@ts WHERE id=@id AND status='claimed'
        `).run({ id, reason: String(failReason || '').slice(0, 200), ts: now() });
      } else if (result === 'failed') {
        db.prepare(`
          UPDATE content_pool_items SET status='failed', fail_reason=@reason, updated_at=@ts
          WHERE id=@id
        `).run({ id, reason: String(failReason || '').slice(0, 200), ts: now() });
      } else {
        throw new Error('bad report result');
      }
    },

    setStatus(ids, status) {
      if (!VALID_STATUS.has(status)) throw new Error('bad status');
      const nums = (Array.isArray(ids) ? ids : [ids]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      if (!nums.length) return 0;
      const stmt = db.prepare(
        "UPDATE content_pool_items SET status = ?, updated_at = datetime('now', '+8 hours') WHERE id = ?"
      );
      let changed = 0;
      const tx = db.transaction((list) => {
        for (const id of list) changed += stmt.run(status, id).changes;
      });
      tx(nums);
      return changed;
    },

    edit(id, { text, scheduledJstAt }) {
      const body = String(text || '').trim();
      const sched = String(scheduledJstAt || '').trim();
      if (!body || body.length > 1000) throw new Error('bad text');
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(sched)) throw new Error('bad scheduled_jst_at');
      db.prepare(`
        UPDATE content_pool_items SET text=@t, scheduled_jst_at=@s, updated_at=@ts
        WHERE id=@id AND status IN ('pending','approved','failed','rejected')
      `).run({ t: body, s: sched, ts: now(), id: Number(id) });
    },

    /** 单个判定：handle 是否为台账注册的可用发帖号（存在 + post_only 标签 + 未 frozen/banned） */
    isRegisteredPoster(handle) {
      const h = normalizeHandle(handle);
      if (!h) return false;
      return posterRowOk(db.prepare(
        'SELECT x_handle, tags, status FROM accounts WHERE LOWER(x_handle) = ?'
      ).get(h));
    },

    /** 批量判定：handles 数组 → 已注册发帖号的小写 Set（单次查询，避免 N+1） */
    registeredPosterSet(handles) {
      const list = [...new Set((Array.isArray(handles) ? handles : [handles])
        .map((h) => String(h || '').replace(/^@/, '').toLowerCase().trim())
        .filter(Boolean))];
      const out = new Set();
      if (!list.length) return out;
      const rows = db.prepare(
        `SELECT x_handle, tags, status FROM accounts WHERE LOWER(x_handle) IN (${list.map(() => '?').join(',')})`
      ).all(...list);
      for (const row of rows) {
        if (posterRowOk(row)) out.add(String(row.x_handle).toLowerCase());
      }
      return out;
    },

    /** H11 线路：persona → 文案模板 + 绑定的台账发帖号 */
    getLine(persona) {
      const p = String(persona || '').trim().toLowerCase();
      if (!p) return null;
      return db.prepare('SELECT * FROM content_pool_lines WHERE LOWER(persona) = ?').get(p) || null;
    },

    /** 全量线路：附 bound（是否可用发帖号）与 account_exists（账号是否存在于台账） */
    listLines() {
      const rows = db.prepare('SELECT * FROM content_pool_lines ORDER BY rowid').all();
      const handles = [...new Set(rows.map((r) => normalizeHandle(r.account_handle)).filter(Boolean))];
      const exists = new Set();
      if (handles.length) {
        for (const row of db.prepare(
          `SELECT x_handle FROM accounts WHERE LOWER(x_handle) IN (${handles.map(() => '?').join(',')})`
        ).all(...handles)) {
          exists.add(normalizeHandle(row.x_handle));
        }
      }
      return rows.map((r) => Object.assign({}, r, {
        bound: this.isRegisteredPoster(r.account_handle),
        account_exists: exists.has(normalizeHandle(r.account_handle)),
      }));
    },

    /** 绑定线路发帖号：只接受台账注册的可用发帖号；成功返回新状态，失败返回 {error} */
    setLineBinding(persona, accountHandle) {
      const line = this.getLine(persona);
      if (!line) return { error: 'line_not_found' };
      const h = normalizeHandle(accountHandle);
      if (!h || !this.isRegisteredPoster(h)) return { error: 'unbound_poster' };
      // 绑定变更级联：该线路名下未发出的内容一并改挂到新发帖号，避免存量内容 handle 与绑定不一致领不到单
      const migrate = db.transaction(() => {
        db.prepare('UPDATE content_pool_lines SET account_handle = @h, updated_at = @ts WHERE persona = @p')
          .run({ h, ts: now(), p: line.persona });
        return db.prepare(`UPDATE content_pool_items SET account_handle = @h, updated_at = @ts
          WHERE persona = @p AND status NOT IN ('posted', 'rejected')`)
          .run({ h, ts: now(), p: line.persona }).changes;
      });
      const migrated = migrate();
      return { ok: true, persona: line.persona, account_handle: h, bound: true, migrated };
    },

    remove(ids) {
      const nums = (Array.isArray(ids) ? ids : [ids]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      if (!nums.length) return 0;
      return db.prepare(`DELETE FROM content_pool_items WHERE id IN (${nums.map(() => '?').join(',')})`).run(...nums).changes;
    },
  };
}

module.exports = { createContentPoolRepo };

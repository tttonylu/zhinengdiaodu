const path = require('node:path');
const fs = require('node:fs');

function normalizeHandle(handle) {
  const raw = String(handle || '').trim();
  if (!raw) return '';
  const withoutUrl = raw
    .replace(/^https?:\/\/(www\.)?(twitter\.com|x\.com)\//i, '')
    .split(/[/?#\s]/)[0]
    .trim();
  const clean = withoutUrl.replace(/^@+/, '');
  return clean ? `@${clean}` : '';
}

function createPoolRepo(db, options = {}) {
  const logger = options.logger || null;
  const assignExpireMinutes = Number(options.assignExpireMinutes) || 60;
  function push(handle, source = 'plugin') {
    const normalized = normalizeHandle(handle);
    if (!normalized) {
      return { ok: false, msg: 'handle required' };
    }

    const result = db
      .prepare(
        `INSERT OR IGNORE INTO pool_tasks (handle, source, status, created_at, updated_at)
         VALUES (?, ?, 'pending', datetime('now', '+8 hours'), datetime('now', '+8 hours'))`
      )
      .run(normalized, source || 'plugin');

    return {
      ok: true,
      handle: normalized,
      inserted: result.changes === 1,
    };
  }

  function pushBatch(handles, source = 'plugin') {
    const seen = new Set();
    let inserted = 0;
    let skipped = 0;

    const insertMany = db.transaction((items) => {
      for (const handle of items) {
        const normalized = normalizeHandle(handle);
        if (!normalized || seen.has(normalized)) {
          skipped += 1;
          continue;
        }
        seen.add(normalized);
        const result = push(normalized, source);
        if (result.inserted) inserted += 1;
        else skipped += 1;
      }
    });

    insertMany(Array.isArray(handles) ? handles : []);
    return { ok: true, count: seen.size, inserted, skipped };
  }

  function pop(workerId = 'unknown', depth) {
    depth = depth || 0;
    const task = db
      .prepare("SELECT id, handle FROM pool_tasks WHERE status = 'pending' ORDER BY created_at, id LIMIT 1")
      .get();

    if (!task) {
      return { ok: true, handle: null, id: null, empty: true };
    }

    const upd = db.prepare(
      `UPDATE pool_tasks
       SET status = 'assigned', worker_id = ?, attempts = attempts + 1, updated_at = datetime('now', '+8 hours'), assigned_at = datetime('now', '+8 hours')
       WHERE id = ? AND status = 'pending'`
    ).run(workerId || 'unknown', task.id);

    if (!upd.changes) {
      if (depth >= 5) return { ok: true, handle: null, id: null, empty: true };
      return pop(workerId, depth + 1);
    }

    return { ok: true, id: task.id, handle: task.handle };
  }

  function done(id) {
    const result = db
      .prepare(
        `UPDATE pool_tasks
         SET status = 'completed', updated_at = datetime('now', '+8 hours'), completed_at = datetime('now', '+8 hours')
         WHERE id = ?`
      )
      .run(id);
    return result.changes === 1 ? { ok: true } : { ok: false, msg: 'task not found' };
  }

  function doneByHandle(handle) {
    const normalized = normalizeHandle(handle);
    if (!normalized) return { ok: false, msg: 'handle required' };
    const result = db
      .prepare(
        `UPDATE pool_tasks
         SET status = 'completed', updated_at = datetime('now', '+8 hours'), completed_at = datetime('now', '+8 hours')
         WHERE handle = ? AND status != 'dead'`
      )
      .run(normalized);
    return result.changes === 1 ? { ok: true } : { ok: false, msg: 'task not found or already dead' };
  }

  function markDead(id) {
    const result = db
      .prepare(
        `UPDATE pool_tasks
         SET status = 'dead', worker_id = NULL, updated_at = datetime('now', '+8 hours')
         WHERE id = ?`
      )
      .run(id);
    return result.changes === 1 ? { ok: true } : { ok: false, msg: 'task not found' };
  }

  function markDeadByHandle(handle) {
    const normalized = normalizeHandle(handle);
    if (!normalized) return { ok: false, msg: 'handle required' };
    const result = db
      .prepare(
        `UPDATE pool_tasks
         SET status = 'dead', worker_id = NULL, updated_at = datetime('now', '+8 hours')
         WHERE handle = ? AND status != 'dead'`
      )
      .run(normalized);
    return result.changes === 1 ? { ok: true } : { ok: false, msg: 'task not found' };
  }

  /** fail 回流：改 created_at 排到队尾，避免队头毒号被全员轮流领；attempts≥3 直接 dead */
  function fail(id) {
    const row = db.prepare('SELECT id, attempts, status FROM pool_tasks WHERE id = ?').get(id);
    if (!row) return { ok: false, msg: 'task not found' };
    const attempts = Number(row.attempts) || 0;
    if (attempts >= 3) {
      const dead = markDead(id);
      return dead.ok ? { ok: true, dead: true, attempts: attempts } : dead;
    }
    const result = db
      .prepare(
        `UPDATE pool_tasks
         SET status = 'pending',
             worker_id = NULL,
             assigned_at = NULL,
             created_at = datetime('now', '+8 hours'),
             updated_at = datetime('now', '+8 hours')
         WHERE id = ?`
      )
      .run(id);
    return result.changes === 1
      ? { ok: true, requeued: true, attempts: attempts }
      : { ok: false, msg: 'task not found' };
  }

  function expireStaleAssigned(minutes = 60) {
    const safeMinutes = Math.max(1, Math.floor(Number(minutes) || 0));
    // 过期回流也排队尾，避免刚过期的毒号立刻又被下一家领走
    const result = db.prepare(
      `UPDATE pool_tasks
       SET status = 'pending',
           worker_id = NULL,
           updated_at = datetime('now', '+8 hours'),
           assigned_at = NULL,
           created_at = datetime('now', '+8 hours')
        WHERE status = 'assigned'
         AND assigned_at IS NOT NULL
         AND assigned_at <= datetime('now', '+8 hours', '-' || ? || ' minutes')`
    ).run(safeMinutes);
    if (logger && result.changes > 0) {
      logger.info({ expired: result.changes, minutes: safeMinutes }, '[POOL] expireStaleAssigned reset tasks');
    }
    return { ok: true, expired: result.changes, minutes: safeMinutes };
  }

  function getAssignedExpiryPreview(minutes = 60) {
    const safeMinutes = Math.max(1, Math.floor(Number(minutes) || 0));
    const row = db.prepare(
      `SELECT COUNT(*) AS count
       FROM pool_tasks
        WHERE status = 'assigned'
         AND assigned_at IS NOT NULL
         AND assigned_at <= datetime('now', '+8 hours', '-' || ? || ' minutes')`
    ).get(safeMinutes);
    return { ok: true, count: row.count, minutes: safeMinutes };
  }

  function status() {
    const rows = db
      .prepare('SELECT status, COUNT(*) AS count FROM pool_tasks GROUP BY status')
      .all();
    const counts = Object.fromEntries(rows.map((row) => [row.status, row.count]));
    return {
      ok: true,
      pending: counts.pending || 0,
      assigned: counts.assigned || 0,
      completed: counts.completed || 0,
      dead: counts.dead || 0,
    };
  }

  function listTasks(filters = {}) {
    const statusFilter = String(filters.status || '').trim();
    const allowedStatuses = new Set(['pending', 'assigned', 'completed', 'dead']);
    const hasStatusFilter = allowedStatuses.has(statusFilter);
    const sql = `
      SELECT id, handle, source, status, worker_id, attempts, created_at, updated_at, assigned_at, completed_at
      FROM pool_tasks
      ${hasStatusFilter ? 'WHERE status = ?' : ''}
      ORDER BY
        CASE status WHEN 'pending' THEN 0 WHEN 'assigned' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,
        updated_at DESC,
        id DESC
      LIMIT 1000
    `;
    return hasStatusFilter ? db.prepare(sql).all(statusFilter) : db.prepare(sql).all();
  }

  function addHandles(input, source = 'manual-dashboard') {
    const handles = Array.isArray(input)
      ? input
      : String(input || '')
          .split(/[\n,\s]+/)
          .map((value) => value.trim())
          .filter(Boolean);
    return pushBatch(handles, source || 'manual-dashboard');
  }

  function deleteTask(id) {
    const result = db.prepare('DELETE FROM pool_tasks WHERE id = ?').run(id);
    return result.changes === 1 ? { ok: true } : { ok: false, msg: 'task not found' };
  }

  function getLinks() {
    const row = db.prepare("SELECT value FROM pool_settings WHERE key = 'links'").get();
    if (!row) return [];
    try {
      const links = JSON.parse(row.value);
      return Array.isArray(links) ? links : [];
    } catch (error) {
      return [];
    }
  }

  function setLinks(links) {
    const cleanLinks = Array.isArray(links)
      ? links.map((link) => String(link || '').trim()).filter(Boolean)
      : [];
    db.prepare(
      `INSERT INTO pool_settings (key, value, updated_at)
       VALUES ('links', ?, datetime('now', '+8 hours'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(JSON.stringify(cleanLinks));
    return cleanLinks;
  }

  function cleanupCompleted(days = 5) {
    const safeDays = Math.max(1, Math.floor(Number(days) || 5));
    const result = db.prepare(
      `UPDATE pool_tasks
       SET status = 'pending',
           worker_id = NULL,
           assigned_at = NULL,
           completed_at = NULL,
           updated_at = datetime('now', '+8 hours')
        WHERE status = 'completed'
         AND completed_at IS NOT NULL
         AND completed_at <= datetime('now', '+8 hours', '-' || ? || ' days')`
    ).run(safeDays);
    if (logger && result.changes > 0) {
      logger.info({ cleaned: result.changes, days: safeDays }, '[POOL] cleanupCompleted reset tasks');
    }
    return { ok: true, cleaned: result.changes, days: safeDays };
  }

  function getCleanupPreview(days = 5) {
    const safeDays = Math.max(1, Math.floor(Number(days) || 5));
    const row = db.prepare(
      `SELECT COUNT(*) AS count
       FROM pool_tasks
        WHERE status = 'completed'
         AND completed_at IS NOT NULL
         AND completed_at <= datetime('now', '+8 hours', '-' || ? || ' days')`
    ).get(safeDays);
    return { ok: true, count: row.count, days: safeDays };
  }

  function reviveDead(id) {
    const result = db.prepare(
      `UPDATE pool_tasks
       SET status = 'pending', worker_id = NULL, assigned_at = NULL, completed_at = NULL, updated_at = datetime('now', '+8 hours')
       WHERE id = ? AND status = 'dead'`
    ).run(id);
    return result.changes === 1 ? { ok: true } : { ok: false, msg: 'task not found or not dead' };
  }

  function getAllHandlesForActivityCheck(limit = 200) {
    return db.prepare(
      `SELECT id, handle, tweet_count, last_checked_at
       FROM pool_tasks
       ORDER BY last_checked_at ASC NULLS FIRST, id ASC
       LIMIT ?`
    ).all(Math.max(1, Math.floor(Number(limit) || 200)));
  }

  function updateActivity(handle, tweetCount) {
    const normalized = normalizeHandle(handle);
    if (!normalized) return 0;
    return db.prepare(
      `UPDATE pool_tasks
       SET tweet_count = ?, last_checked_at = datetime('now', '+8 hours')
       WHERE handle = ?`
    ).run(Number(tweetCount) || 0, normalized).changes;
  }

  function deleteByHandle(handle) {
    const normalized = normalizeHandle(handle);
    if (!normalized) return { ok: false, msg: 'handle required' };
    const result = db.prepare('DELETE FROM pool_tasks WHERE handle = ?').run(normalized);
    return result.changes === 1 ? { ok: true } : { ok: false, msg: 'task not found' };
  }

  function isActivityStale(handle, days) {
    const normalized = normalizeHandle(handle);
    if (!normalized) return false;
    const row = db.prepare(
      `SELECT last_checked_at
       FROM pool_tasks
       WHERE handle = ?
         AND last_checked_at IS NOT NULL
         AND last_checked_at <= datetime('now', '+8 hours', '-' || ? || ' days')`
    ).get(normalized, Math.max(1, Math.floor(Number(days) || 30)));
    return row !== undefined;
  }

  function loadCookies(dataDir) {
    var filePath = path.join(dataDir, 'accounts.json');
    try {
      if (fs.existsSync(filePath)) {
        var data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return Array.isArray(data) ? data : [];
      }
    } catch (e) { /* ignore */ }
    return [];
  }

  function saveCookies(dataDir, cookies) {
    var filePath = path.join(dataDir, 'accounts.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(cookies, null, 2), 'utf8');
  }

  function addCookie(dataDir, name, cookieStr) {
    var cookies = loadCookies(dataDir);
    var existing = cookies.find(function(c) { return c.name === name; });
    if (existing) {
      existing.cookie = cookieStr;
    } else {
      cookies.push({ name: name, cookie: cookieStr });
    }
    saveCookies(dataDir, cookies);
    return cookies;
  }

  function deleteCookie(dataDir, name) {
    var cookies = loadCookies(dataDir).filter(function(c) { return c.name !== name; });
    saveCookies(dataDir, cookies);
    return cookies;
  }

  // 重排 ID 为连续编号（清除删除任务留下的空洞）
  // 整个操作在单个事务中执行，保证原子性
  function compactIds() {
    const countRow = db.prepare('SELECT COUNT(*) AS cnt FROM pool_tasks').get();
    const totalBefore = countRow.cnt;
    const maxRow = db.prepare('SELECT MAX(id) AS maxId FROM pool_tasks').get();
    const maxId = maxRow.maxId || 0;

    if (totalBefore === maxId) {
      return { ok: true, message: 'ID 已经是连续的，无需重排', total: totalBefore };
    }

    const doCompact = db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS pool_tasks_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          handle TEXT NOT NULL UNIQUE,
          source TEXT NOT NULL DEFAULT 'plugin',
          status TEXT NOT NULL DEFAULT 'pending',
          worker_id TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          assigned_at TEXT,
          completed_at TEXT,
          tweet_count INTEGER DEFAULT NULL,
          last_checked_at TEXT DEFAULT NULL
        );

        INSERT INTO pool_tasks_new (handle, source, status, worker_id, attempts, created_at, updated_at, assigned_at, completed_at, tweet_count, last_checked_at)
        SELECT handle, source, status, worker_id, attempts, created_at, updated_at, assigned_at, completed_at, tweet_count, last_checked_at
        FROM pool_tasks
        ORDER BY id ASC;

        DROP TABLE pool_tasks;
        ALTER TABLE pool_tasks_new RENAME TO pool_tasks;

        CREATE INDEX IF NOT EXISTS idx_pool_tasks_status_created
        ON pool_tasks (status, created_at, id);

        DELETE FROM sqlite_sequence WHERE name = 'pool_tasks';
      `);
    });

    doCompact();

    const newCount = db.prepare('SELECT COUNT(*) AS cnt FROM pool_tasks').get();
    const newMax = db.prepare('SELECT MAX(id) AS maxId FROM pool_tasks').get();

    return {
      ok: true,
      total: newCount.cnt,
      oldMaxId: maxId,
      newMaxId: newMax.maxId || 0,
      message: '已重排 ' + newCount.cnt + ' 条记录，ID 从 1 到 ' + (newMax.maxId || 0)
    };
  }

  return {
    push,
    pushBatch,
    pop,
    done,
    doneByHandle,
    markDead,
    markDeadByHandle,
    fail,
    status,
    listTasks,
    addHandles,
    deleteTask,
    getLinks,
    setLinks,
    cleanupCompleted,
    getCleanupPreview,
    reviveDead,
    compactIds,
    expireStaleAssigned,
    getAssignedExpiryPreview,
    assignExpireMinutes,
    getAllHandlesForActivityCheck,
    updateActivity,
    deleteByHandle,
    isActivityStale,
    loadCookies,
    saveCookies,
    addCookie,
    deleteCookie,
  };
}

module.exports = { createPoolRepo, normalizeHandle };

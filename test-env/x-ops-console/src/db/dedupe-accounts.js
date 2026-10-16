/**
 * 账号去重：归一化 x_handle，合并重复行（保留最小 id）。
 * 在 migrate 启动时调用一次。
 */
const { normalizeHandle } = require('../utils/handle');

function remappoint(db, table, col, fromId, toId) {
  try {
    db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`).run(toId, fromId);
  } catch (e) {
    console.warn(`[dedupe] remappoint ${table}.${col}:`, e.message);
  }
}

function remappointHandle(db, table, col, fromH, toH) {
  try {
    db.prepare(`UPDATE ${table} SET ${col} = ? WHERE LOWER(${col}) = LOWER(?)`).run(toH, fromH);
  } catch (e) {
    console.warn(`[dedupe] remappointHandle ${table}.${col}:`, e.message);
  }
}

function dedupeAccounts(db) {
  const rows = db.prepare('SELECT id, x_handle FROM accounts').all();
  const byNorm = new Map();
  const renames = [];

  for (const r of rows) {
    const raw = String(r.x_handle || '');
    const norm = normalizeHandle(raw);
    if (!norm) continue;
    if (raw !== norm) {
      renames.push({ id: r.id, from: raw, to: norm });
    }
    if (!byNorm.has(norm)) byNorm.set(norm, []);
    byNorm.get(norm).push(r);
  }

  // 先把未归一化的改成标准形式（无冲突时）
  for (const item of renames) {
    const clash = db.prepare(
      'SELECT id FROM accounts WHERE LOWER(x_handle) = LOWER(?) AND id != ?'
    ).get(item.to, item.id);
    if (clash) continue; // 交给后面 merge
    try {
      db.prepare('UPDATE accounts SET x_handle = ?, updated_at = datetime(\'now\', \'+8 hours\') WHERE id = ?')
        .run(item.to, item.id);
    } catch (e) {
      console.warn('[dedupe] rename failed', item, e.message);
    }
  }

  // 重新加载后按 norm 合并
  const fresh = db.prepare('SELECT id, x_handle FROM accounts').all();
  const groups = new Map();
  for (const r of fresh) {
    const norm = normalizeHandle(r.x_handle) || String(r.x_handle || '').toLowerCase();
    if (!norm) continue;
    if (!groups.has(norm)) groups.set(norm, []);
    groups.get(norm).push(r);
  }

  let merged = 0;
  const run = db.transaction(() => {
    for (const [norm, list] of groups.entries()) {
      if (list.length < 2) {
        // 确保主行 handle 已归一
        const only = list[0];
        if (only && String(only.x_handle) !== norm) {
          try {
            db.prepare('UPDATE accounts SET x_handle = ? WHERE id = ?').run(norm, only.id);
          } catch (e) {}
        }
        continue;
      }
      list.sort((a, b) => a.id - b.id);
      const keep = list[0];
      // 主行归一化
      try {
        db.prepare('UPDATE accounts SET x_handle = ? WHERE id = ?').run(norm, keep.id);
      } catch (e) {}

      for (let i = 1; i < list.length; i++) {
        const dup = list[i];
        remappoint(db, 'activity_logs', 'account_id', dup.id, keep.id);
        remappoint(db, 'leads', 'bound_account_id', dup.id, keep.id);
        try {
          // 日统计 UNIQUE(account_id,stat_date)：冲突则删重复行
          db.prepare(`
            DELETE FROM account_daily_stats
            WHERE account_id = ?
              AND stat_date IN (SELECT stat_date FROM account_daily_stats WHERE account_id = ?)
          `).run(dup.id, keep.id);
          remappoint(db, 'account_daily_stats', 'account_id', dup.id, keep.id);
        } catch (e) {}
        try {
          remappointHandle(db, 'dm_records', 'bot_handle', dup.x_handle, norm);
        } catch (e) {}

        // handle 主键表：先删与 keep 冲突的键，再改名
        try {
          db.prepare(`
            DELETE FROM config_account_overrides
            WHERE LOWER(x_handle) = LOWER(?)
              AND key IN (SELECT key FROM config_account_overrides WHERE LOWER(x_handle) = LOWER(?))
          `).run(dup.x_handle, norm);
          remappointHandle(db, 'config_account_overrides', 'x_handle', dup.x_handle, norm);
        } catch (e) {}
        try {
          db.prepare('DELETE FROM account_commands WHERE LOWER(x_handle) = LOWER(?)').run(dup.x_handle);
        } catch (e) {}
        try {
          db.prepare('DELETE FROM account_runtime_status WHERE LOWER(x_handle) = LOWER(?)').run(dup.x_handle);
        } catch (e) {}

        db.prepare('DELETE FROM accounts WHERE id = ?').run(dup.id);
        merged++;
      }
    }
  });
  run();

  // 唯一索引：归一化后的 handle（防止再插入大小写变体）
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_x_handle_nocase ON accounts(x_handle COLLATE NOCASE)');
  } catch (e) {
    console.warn('[dedupe] unique index:', e.message);
  }

  if (merged > 0) console.log(`[dedupe] merged ${merged} duplicate account row(s)`);
  return merged;
}

module.exports = { dedupeAccounts };

const fs = require('node:fs');
const path = require('node:path');
const { createDb } = require('./client');

function runMigrations(dbPath) {
  const db = createDb(dbPath);

  // 创建迁移追踪表
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
  )`);

  const applied = new Set(
    db.prepare('SELECT name FROM _migrations').all().map(r => r.name)
  );

  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

  const insertMigration = db.prepare('INSERT INTO _migrations (name) VALUES (?)');

  for (const file of files) {
    if (applied.has(file)) {
      continue; // 已执行，跳过
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    // 逐条执行（跳过失败的 ALTER TABLE 语句，兼容列已存在的情况）
    const statements = sql.split(';').map(s => s.trim()).filter(s => {
      if (!s.length) return false;
      // 去掉开头的整行注释后再判断是否为空
      const cleaned = s.replace(/^--[^\n]*\n?/gm, '').trim();
      return cleaned.length > 0;
    }).map(s => s.replace(/^--[^\n]*\n?/gm, '').trim());
    for (const stmt of statements) {
      try {
        db.exec(stmt + ';');
      } catch (e) {
        // 如果是 "duplicate column" 错误，忽略
        if (e.message && e.message.includes('duplicate column')) {
          console.log(`[migrate] 跳过已存在的列: ${e.message}`);
        } else {
          console.warn(`[migrate] 执行失败 (${file}): ${stmt.slice(0, 60)}... → ${e.message}`);
        }
      }
    }
    insertMigration.run(file);
    console.log(`[migrate] ✅ ${file}`);
  }

  // 每次启动：归一化 + 合并重复账号（幂等）
  try {
    const { dedupeAccounts } = require('./dedupe-accounts');
    dedupeAccounts(db);
  } catch (eDedup) {
    console.warn('[migrate] dedupeAccounts failed:', eDedup && eDedup.message);
  }

  db.close();
}

if (require.main === module) {
  const targetPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'x-ops-console.sqlite');
  runMigrations(targetPath);
}

module.exports = { runMigrations };
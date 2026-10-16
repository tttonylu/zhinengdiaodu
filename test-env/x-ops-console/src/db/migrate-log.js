const fs = require('node:fs');
const path = require('node:path');
const { createDb } = require('./client');

function runLogMigrations(dbPath) {
  const db = createDb(dbPath);

  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
  )`);

  const applied = new Set(
    db.prepare('SELECT name FROM _migrations').all().map(r => r.name)
  );

  const migrationsDir = path.join(__dirname, 'migrations-log');
  if (!fs.existsSync(migrationsDir)) {
    db.close();
    return;
  }

  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  const insertMigration = db.prepare('INSERT INTO _migrations (name) VALUES (?)');

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const statements = sql.split(';').map(s => s.trim()).filter(s => {
      const cleaned = s.replace(/^--[^\n]*\n?/gm, '').trim();
      return cleaned.length > 0;
    }).map(s => s.replace(/^--[^\n]*\n?/gm, '').trim());
    for (const stmt of statements) {
      try {
        db.exec(stmt + ';');
      } catch (e) {
        if (e.message && e.message.includes('duplicate column')) {
          console.log(`[migrate-log] 跳过已存在的列: ${e.message}`);
        } else {
          console.warn(`[migrate-log] 执行失败 (${file}): ${stmt.slice(0, 60)}... → ${e.message}`);
        }
      }
    }
    insertMigration.run(file);
    console.log(`[migrate-log] ✅ ${file}`);
  }

  db.close();
}

module.exports = { runLogMigrations };
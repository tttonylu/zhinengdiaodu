const fs = require('node:fs');
const path = require('node:path');
const { createDb } = require('./client');

function runMigrations(dbPath) {
  const db = createDb(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
    )
  `);

  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const applied = db.prepare('SELECT name FROM _migrations WHERE name = ?').get(file);
    if (applied) continue;

    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
  }

  db.close();
}

if (require.main === module) {
  const targetPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'x-pool.sqlite');
  runMigrations(targetPath);
}

module.exports = { runMigrations };

CREATE TABLE IF NOT EXISTS pool_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'plugin',
  status TEXT NOT NULL DEFAULT 'pending',
  worker_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  assigned_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_pool_tasks_status_created
ON pool_tasks (status, created_at, id);

CREATE TABLE IF NOT EXISTS pool_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

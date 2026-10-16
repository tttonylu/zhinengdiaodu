CREATE TABLE IF NOT EXISTS script_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS script_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id TEXT NOT NULL,
  template_type TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(set_id, template_type),
  FOREIGN KEY(set_id) REFERENCES script_sets(set_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS script_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_script_sets_enabled ON script_sets(enabled);
CREATE INDEX IF NOT EXISTS idx_script_templates_set ON script_templates(set_id);
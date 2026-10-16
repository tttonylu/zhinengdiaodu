-- 插件运行观测事件 + 诊断快照
CREATE TABLE IF NOT EXISTS plugin_telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  category TEXT NOT NULL DEFAULT 'system',
  label_zh TEXT,
  meta_json TEXT,
  session_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plugin_telemetry_account_time ON plugin_telemetry(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_plugin_telemetry_event_time ON plugin_telemetry(event_id, created_at);

CREATE TABLE IF NOT EXISTS telemetry_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  session_id TEXT,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telemetry_snapshots_account ON telemetry_snapshots(account_id, created_at);

INSERT OR IGNORE INTO config_thresholds (key, value) VALUES ('telemetry_upload_min_level', 'info');
INSERT OR IGNORE INTO config_thresholds (key, value) VALUES ('telemetry_push_enabled', 'true');
INSERT OR IGNORE INTO config_thresholds (key, value) VALUES ('telemetry_push_dedupe_hours', '2');
INSERT OR IGNORE INTO config_thresholds (key, value) VALUES ('telemetry_disabled_events', '');

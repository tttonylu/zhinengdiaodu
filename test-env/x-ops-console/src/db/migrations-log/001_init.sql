-- 专用日志库初始化：遥测事件 / 诊断快照 / 小时汇总
-- 与业务库分离：高频日志写入不影响运营控制台查询
CREATE TABLE IF NOT EXISTS log_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL DEFAULT 0,
  account_handle TEXT,
  client_event_id TEXT NOT NULL UNIQUE,
  event_id TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  category TEXT NOT NULL DEFAULT 'system',
  label_zh TEXT,
  session_id TEXT,
  meta_json TEXT,
  ts_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_events_account_time ON log_events(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_log_events_event_time ON log_events(event_id, created_at);
CREATE INDEX IF NOT EXISTS idx_log_events_severity_time ON log_events(severity, created_at);
CREATE INDEX IF NOT EXISTS idx_log_events_created_at ON log_events(created_at);

CREATE TABLE IF NOT EXISTS log_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL DEFAULT 0,
  account_handle TEXT,
  session_id TEXT,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_snapshots_account ON log_snapshots(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_log_snapshots_created_at ON log_snapshots(created_at);

CREATE TABLE IF NOT EXISTS log_rollups_hourly (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL DEFAULT 0,
  hour_key TEXT NOT NULL,
  event_id TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  cnt INTEGER NOT NULL DEFAULT 0,
  UNIQUE(account_id, hour_key, event_id, severity)
);
CREATE INDEX IF NOT EXISTS idx_log_rollups_hour ON log_rollups_hourly(hour_key);
CREATE INDEX IF NOT EXISTS idx_log_rollups_account_hour ON log_rollups_hourly(account_id, hour_key);

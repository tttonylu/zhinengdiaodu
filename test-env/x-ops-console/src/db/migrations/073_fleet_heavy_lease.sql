-- 4.6.173：舰队重活并发租约（跨壳协调雏形）
CREATE TABLE IF NOT EXISTS fleet_leases (
  handle TEXT NOT NULL COLLATE NOCASE,
  kind TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at TEXT,
  PRIMARY KEY (handle, kind)
);
CREATE INDEX IF NOT EXISTS idx_fleet_leases_expires ON fleet_leases(expires_at);
INSERT OR IGNORE INTO config_thresholds (key, value) VALUES ('fleet_heavy_slots', '8');

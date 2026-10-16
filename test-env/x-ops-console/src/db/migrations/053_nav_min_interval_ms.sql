-- 053: 慢网跳页最小间隔（Gate / coStart 共用）
INSERT OR IGNORE INTO config_thresholds (key, value) VALUES ('nav_min_interval_ms', '10000');
UPDATE config_thresholds SET value = '10000', updated_at = datetime('now', '+8 hours') WHERE key = 'nav_min_interval_ms';

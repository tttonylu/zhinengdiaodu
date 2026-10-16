-- 044: 加速关注间隔（5–8s → 3–5s）
UPDATE config_thresholds SET value = '3', updated_at = datetime('now', '+8 hours') WHERE key = 'follow_interval_min_sec';
UPDATE config_thresholds SET value = '5', updated_at = datetime('now', '+8 hours') WHERE key = 'follow_interval_max_sec';
INSERT OR IGNORE INTO config_thresholds (key, value) VALUES ('follow_interval_min_sec', '3');
INSERT OR IGNORE INTO config_thresholds (key, value) VALUES ('follow_interval_max_sec', '5');

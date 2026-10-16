-- 046: 关注间隔 3–5s → 2–4s（缩短一轮关注墙钟，腾出填窗时间）
UPDATE config_thresholds SET value = '2', updated_at = datetime('now', '+8 hours') WHERE key = 'follow_interval_min_sec';
UPDATE config_thresholds SET value = '4', updated_at = datetime('now', '+8 hours') WHERE key = 'follow_interval_max_sec';
INSERT OR IGNORE INTO config_thresholds (key, value) VALUES ('follow_interval_min_sec', '2');
INSERT OR IGNORE INTO config_thresholds (key, value) VALUES ('follow_interval_max_sec', '4');

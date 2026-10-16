-- 4.3.14：停禁图 — 默认/现网一律放行媒体
INSERT OR IGNORE INTO config_thresholds (key, value) VALUES ('media_load_mode', 'on');
UPDATE config_thresholds SET value = 'on' WHERE key = 'media_load_mode';

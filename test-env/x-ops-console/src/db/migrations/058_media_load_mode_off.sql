-- 4.4.0：重启禁图（纯DNR无DOM硬拦，防崩溃）— 新默认 off；不覆盖已有配置
INSERT OR IGNORE INTO config_thresholds (key, value) VALUES ('media_load_mode', 'off');

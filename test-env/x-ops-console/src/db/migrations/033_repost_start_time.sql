-- 转帖开跑时刻可配置
INSERT OR IGNORE INTO config_thresholds (key, value) VALUES
('repost_follow_work_end', 'true'),
('repost_start_hour', '21'),
('repost_start_min', '0');

-- 养号转帖：日额度用 min~max 随机；时额度单值
INSERT OR IGNORE INTO config_thresholds (key, value) VALUES
('nurture_daily_reposts_min', '1'),
('nurture_daily_reposts_max', '2'),
('nurture_hourly_reposts', '1');

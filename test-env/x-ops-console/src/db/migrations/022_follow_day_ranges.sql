-- Day1–Day6 关注配额区间（插件按上海自然日随机锁定一次）
INSERT OR IGNORE INTO config_thresholds (key, value) VALUES
('follow_daily_limit', '260'),
('follow_day1_min', '15'),
('follow_day1_max', '20'),
('follow_day2_min', '45'),
('follow_day2_max', '50'),
('follow_day3_min', '90'),
('follow_day3_max', '100'),
('follow_day4_min', '150'),
('follow_day4_max', '160'),
('follow_day5_min', '200'),
('follow_day5_max', '210'),
('follow_day6_min', '250'),
('follow_day6_max', '260');

-- 覆盖旧封顶 200
UPDATE config_thresholds SET value = '260', updated_at = datetime('now', '+8 hours')
WHERE key = 'follow_daily_limit' AND CAST(value AS INTEGER) < 260;

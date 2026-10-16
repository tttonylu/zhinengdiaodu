-- 转帖改凌晨开跑：不跟随下班；06:00 开跑（仍须 S0，即上班 07:00 前）
INSERT OR REPLACE INTO config_thresholds (key, value) VALUES
('repost_follow_work_end', 'false'),
('repost_start_hour', '6'),
('repost_start_min', '0');

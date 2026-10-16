-- 转帖固定 19:00 开跑（下班后转帖）；不动关注/养号工作窗（仍跨夜 06:00–02:00）
INSERT INTO config_thresholds (key, value) VALUES
  ('repost_follow_work_end', 'false'),
  ('repost_start_hour', '19'),
  ('repost_start_min', '0')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
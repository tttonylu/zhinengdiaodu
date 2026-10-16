-- 转帖错峰改后台账号 override；插件本地抖动默认关（0）
INSERT INTO config_thresholds (key, value) VALUES
  ('repost_start_jitter_max_min', '0'),
  ('repost_stagger_window_min', '240'),
  ('repost_follow_work_end', 'false'),
  ('repost_start_hour', '20'),
  ('repost_start_min', '0')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

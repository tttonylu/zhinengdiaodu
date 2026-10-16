-- 转帖：日配额拆成 Day1-4 / Day5+ 两档；跟随下班默认开启
INSERT INTO config_thresholds (key, value) VALUES
  ('repost_day14_quota', '2'),
  ('repost_day5_quota', '1'),
  ('repost_follow_work_end', 'true')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

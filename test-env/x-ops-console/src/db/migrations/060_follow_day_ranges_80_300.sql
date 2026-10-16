-- 关注日限梯度调整：Day1 80-90 起步，5天到 300 左右
INSERT INTO config_thresholds (key, value) VALUES
  ('follow_daily_limit', '310'),
  ('follow_day1_min', '80'),
  ('follow_day1_max', '90'),
  ('follow_day2_min', '135'),
  ('follow_day2_max', '155'),
  ('follow_day3_min', '190'),
  ('follow_day3_max', '215'),
  ('follow_day4_min', '240'),
  ('follow_day4_max', '270'),
  ('follow_day5_min', '285'),
  ('follow_day5_max', '300'),
  ('follow_day6_min', '290'),
  ('follow_day6_max', '310')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

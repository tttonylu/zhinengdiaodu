-- 养号评论降频：日评 2、时评 1、评论冷却 45 分、动作间隔 45–90s
INSERT OR REPLACE INTO config_thresholds (key, value) VALUES
  ('nurture_daily_comments', '2'),
  ('nurture_hourly_comments', '1'),
  ('nurture_comment_cooldown_min', '45'),
  ('nurture_daily_likes', '12'),
  ('nurture_hourly_likes', '2'),
  ('nurture_action_gap_min_sec', '45'),
  ('nurture_action_gap_max_sec', '90'),
  ('nurture_like_cooldown_min', '8');

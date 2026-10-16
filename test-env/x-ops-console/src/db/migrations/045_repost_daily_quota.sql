-- 转帖：固定开跑 + 每日条数收工（废弃双窗门禁，键仍可保留兼容）
INSERT INTO config_thresholds (key, value) VALUES
  ('repost_daily_quota', '3')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

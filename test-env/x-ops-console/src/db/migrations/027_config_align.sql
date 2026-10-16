-- 对齐插件：养号 enters/trends/profiles + 私信会话冷却键；钉死阶段策略真理
INSERT OR IGNORE INTO config_thresholds (key, value) VALUES
('nurture_daily_enters', '10'),
('nurture_hourly_enters', '2'),
('nurture_daily_trends_min', '5'),
('nurture_daily_trends_max', '10'),
('nurture_hourly_trends_min', '1'),
('nurture_hourly_trends_max', '2'),
('nurture_daily_profiles_min', '2'),
('nurture_daily_profiles_max', '5'),
('nurture_hourly_profiles_min', '0'),
('nurture_hourly_profiles_max', '1'),
('chat_cooldown_min_min', '50'),
('chat_cooldown_max_min', '60');

-- 确保转帖键存在（旧库可能已有）
INSERT OR IGNORE INTO config_thresholds (key, value) VALUES
('nurture_daily_reposts_min', '1'),
('nurture_daily_reposts_max', '2'),
('nurture_hourly_reposts', '1');

-- 钉死工作/私信时段与早间只养号（读取取最新一条）
INSERT INTO config_stage_policy (version, policy, updated_at) VALUES
(
  '2026-08-02-config-align',
  '{"workHours":{"start":[7,0],"end":[21,0]},"chatHours":{"start":[8,30],"end":[18,0]},"morningNurtureUntil":[8,0],"stages":{"S0":{"priority":[]},"S1":{"dayMax":2,"priority":["follow","nurture"]},"S2":{"dayMin":3,"priority":["follow","nurture"]},"S3":{"dayMin":3,"priority":["follow","chat","nurture"]},"S4":{"maxOccupyMin":30,"priority":["chat"],"disabled":true}},"cooldown":{"stallCooldownSec":180,"tickIntervalMs":10000,"watchdogMs":30000}}',
  datetime('now', '+8 hours')
);

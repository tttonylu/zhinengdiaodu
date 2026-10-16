-- 统一关注爬坡与阶段默认（对齐业务：Day1≤20, Day2=50, 其后每天+50）
INSERT OR IGNORE INTO config_thresholds (key, value) VALUES
('follow_day2_limit', '50');

UPDATE config_thresholds SET value = '20', updated_at = datetime('now', '+8 hours')
WHERE key = 'follow_first_day_limit';

UPDATE config_thresholds SET value = '50', updated_at = datetime('now', '+8 hours')
WHERE key = 'follow_step_per_day';

INSERT OR IGNORE INTO config_thresholds (key, value) VALUES ('follow_first_day_limit', '20');
INSERT OR IGNORE INTO config_thresholds (key, value) VALUES ('follow_step_per_day', '50');

INSERT INTO config_stage_policy (version, policy, updated_at) VALUES
(
  '2026-07-30-s1-follow',
  '{"workHours":{"start":[8,0],"end":[23,0]},"chatHours":{"start":[8,0],"end":[18,0]},"stages":{"S0":{"priority":[]},"S1":{"dayMax":2,"priority":["nurture","follow"]},"S2":{"dayMin":3,"dayMax":6,"priority":["follow","nurture"]},"S3":{"dayMin":7,"priority":["follow","chat","nurture"]},"S4":{"maxOccupyMin":30,"priority":["chat"]}},"cooldown":{"stallCooldownSec":180,"tickIntervalMs":10000,"watchdogMs":30000}}',
  datetime('now', '+8 hours')
);

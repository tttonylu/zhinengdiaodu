-- 软风控优先 + 加速关注：间隔 5–8s；S1 关注优先于养号
UPDATE config_thresholds SET value = '5', updated_at = datetime('now', '+8 hours') WHERE key = 'follow_interval_min_sec';
UPDATE config_thresholds SET value = '8', updated_at = datetime('now', '+8 hours') WHERE key = 'follow_interval_max_sec';

INSERT OR IGNORE INTO config_thresholds (key, value) VALUES ('follow_interval_min_sec', '5');
INSERT OR IGNORE INTO config_thresholds (key, value) VALUES ('follow_interval_max_sec', '8');

INSERT INTO config_stage_policy (version, policy, updated_at) VALUES
(
  '2026-07-30-soft-risk-follow-first',
  '{"workHours":{"start":[8,0],"end":[23,0]},"chatHours":{"start":[8,0],"end":[18,0]},"stages":{"S0":{"priority":[]},"S1":{"dayMax":2,"priority":["follow","nurture"]},"S2":{"dayMin":3,"dayMax":6,"priority":["follow","nurture"]},"S3":{"dayMin":7,"priority":["follow","chat","nurture"]},"S4":{"maxOccupyMin":30,"priority":["chat"]}},"cooldown":{"stallCooldownSec":180,"tickIntervalMs":10000,"watchdogMs":30000}}',
  datetime('now', '+8 hours')
);

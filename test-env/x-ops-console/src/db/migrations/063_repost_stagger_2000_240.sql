-- 兼职排班：工作 10:00–19:00；转帖 20:00 开跑；开跑后 0–240 分钟按号错峰
INSERT INTO config_stage_policy (version, policy, updated_at) VALUES (
  '2026-10-05-063',
  '{"test24h":false,"workHours":{"start":[10,0],"end":[19,0]},"chatHours":{"start":[8,0],"end":[18,0]},"morningNurtureUntil":[10,0],"stages":{"S0":{"priority":[]},"S1":{"dayMax":2,"priority":["follow","nurture"]},"S2":{"dayMin":3,"priority":["follow","nurture"]},"S3":{"dayMin":1,"priority":["chat","follow","nurture"]},"S4":{"maxOccupyMin":30,"priority":["chat"],"disabled":true}},"cooldown":{"stallCooldownSec":180,"tickIntervalMs":10000,"watchdogMs":30000}}',
  datetime('now', '+8 hours')
);

INSERT INTO config_thresholds (key, value) VALUES
  ('repost_follow_work_end', 'false'),
  ('repost_start_hour', '20'),
  ('repost_start_min', '0'),
  ('repost_start_jitter_max_min', '240')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

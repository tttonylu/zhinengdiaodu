-- 关注工作窗拉长为跨夜 06:00–02:00；私信保持 08:00–18:00
-- 早间只养号与上班对齐（一上班即可关注）
-- 转帖开跑改 05:00，保留 S0 窗 [05,06)
INSERT INTO config_stage_policy (version, policy, updated_at) VALUES (
  '2026-09-17-052',
  '{"test24h":false,"workHours":{"start":[6,0],"end":[2,0]},"chatHours":{"start":[8,0],"end":[18,0]},"morningNurtureUntil":[6,0],"stages":{"S0":{"priority":[]},"S1":{"dayMax":2,"priority":["follow","nurture"]},"S2":{"dayMin":3,"priority":["follow","nurture"]},"S3":{"dayMin":3,"priority":["chat","follow","nurture"]},"S4":{"maxOccupyMin":30,"priority":["chat"],"disabled":true}},"cooldown":{"stallCooldownSec":180,"tickIntervalMs":10000,"watchdogMs":30000}}',
  datetime('now', '+8 hours')
);

INSERT OR REPLACE INTO config_thresholds (key, value) VALUES
('repost_follow_work_end', 'false'),
('repost_start_hour', '5'),
('repost_start_min', '0');

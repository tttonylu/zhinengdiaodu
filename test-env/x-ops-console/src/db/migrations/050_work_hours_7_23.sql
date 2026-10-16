-- 工作窗恢复默认 07:00–23:00（禁 end=24 全天，否则永不进 S0、夜场转帖易挂）
-- 关 test24h；私信保持 08:00–18:00
INSERT INTO config_stage_policy (version, policy, updated_at) VALUES
(
  '2026-09-17-work-7-23',
  '{"test24h":false,"workHours":{"start":[7,0],"end":[23,0]},"chatHours":{"start":[8,0],"end":[18,0]},"morningNurtureUntil":[8,0],"stages":{"S0":{"priority":[]},"S1":{"dayMax":2,"priority":["follow","nurture"]},"S2":{"dayMin":3,"priority":["follow","nurture"]},"S3":{"dayMin":3,"priority":["chat","follow","nurture"]},"S4":{"maxOccupyMin":30,"priority":["chat"],"disabled":true}},"cooldown":{"stallCooldownSec":180,"tickIntervalMs":10000,"watchdogMs":30000}}',
  datetime('now', '+8 hours')
);

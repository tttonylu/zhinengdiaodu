-- 恢复正常私信时段：关 test24h；08:00–18:00；过点不开私信/不加债/不赶债
INSERT INTO config_stage_policy (version, policy, updated_at) VALUES
(
  '2026-09-14-chat-hours-0800-1800',
  '{"test24h":false,"workHours":{"start":[7,0],"end":[23,0]},"chatHours":{"start":[8,0],"end":[18,0]},"morningNurtureUntil":[8,0],"stages":{"S0":{"priority":[]},"S1":{"dayMax":2,"priority":["follow","nurture"]},"S2":{"dayMin":3,"priority":["follow","nurture"]},"S3":{"dayMin":3,"priority":["chat","follow","nurture"]},"S4":{"maxOccupyMin":30,"priority":["chat"],"disabled":true}},"cooldown":{"stallCooldownSec":180,"tickIntervalMs":10000,"watchdogMs":30000}}',
  datetime('now', '+8 hours')
);

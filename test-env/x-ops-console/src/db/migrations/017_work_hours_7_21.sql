-- 工作时段 07:00–21:00；早间 07–08 只养号（插件 stage-detector morningNurtureUntil）；私信仍 08:30–18
INSERT INTO config_stage_policy (version, policy, updated_at) VALUES
(
  '2026-07-30-work-hours-7-21',
  '{"workHours":{"start":[7,0],"end":[21,0]},"chatHours":{"start":[8,30],"end":[18,0]},"morningNurtureUntil":[8,0],"stages":{"S0":{"priority":[]},"S1":{"dayMax":2,"priority":["follow","nurture"]},"S2":{"dayMin":3,"priority":["follow","nurture"]},"S3":{"dayMin":3,"priority":["follow","chat","nurture"]},"S4":{"maxOccupyMin":30,"priority":["chat"],"disabled":true}},"cooldown":{"stallCooldownSec":180,"tickIntervalMs":10000,"watchdogMs":30000}}',
  datetime('now', '+8 hours')
);

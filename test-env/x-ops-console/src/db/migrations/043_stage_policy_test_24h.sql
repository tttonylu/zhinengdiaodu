-- 实测期：工作/私信全天放开（后续改回正常时段时关掉 test24h 并恢复小时）
INSERT INTO config_stage_policy (version, policy, updated_at) VALUES
(
  '2026-08-31-test24h',
  '{"test24h":true,"workHours":{"start":[0,0],"end":[24,0]},"chatHours":{"start":[0,0],"end":[24,0]},"morningNurtureUntil":[0,0],"stages":{"S0":{"priority":[]},"S1":{"dayMax":2,"priority":["follow","nurture"]},"S2":{"dayMin":3,"priority":["follow","nurture"]},"S3":{"dayMin":3,"priority":["chat","follow","nurture"]},"S4":{"maxOccupyMin":30,"priority":["chat"],"disabled":true}},"cooldown":{"stallCooldownSec":180,"tickIntervalMs":10000,"watchdogMs":30000}}',
  datetime('now', '+8 hours')
);

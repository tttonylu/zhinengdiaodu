-- 阶段阶梯：工作 08–22、私信 08:30–18；S3 dayMin=3；取消 S2 dayMax / S4 独占
INSERT INTO config_stage_policy (version, policy, updated_at) VALUES
(
  '2026-07-30-stage-ladder',
  '{"workHours":{"start":[8,0],"end":[22,0]},"chatHours":{"start":[8,30],"end":[18,0]},"stages":{"S0":{"priority":[]},"S1":{"dayMax":2,"priority":["follow","nurture"]},"S2":{"dayMin":3,"priority":["follow","nurture"]},"S3":{"dayMin":3,"priority":["follow","chat","nurture"]},"S4":{"maxOccupyMin":30,"priority":["chat"],"disabled":true}},"cooldown":{"stallCooldownSec":180,"tickIntervalMs":10000,"watchdogMs":30000}}',
  datetime('now', '+8 hours')
);

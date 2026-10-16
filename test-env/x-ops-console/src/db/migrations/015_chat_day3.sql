-- 日常私信提前到 Day≥3（S3.dayMin=3）；detect 顺序由插件 stage-detector 保证 chatTime 优先
INSERT INTO config_stage_policy (version, policy, updated_at) VALUES
(
  '2026-07-30-chat-day3',
  '{"workHours":{"start":[8,0],"end":[23,0]},"chatHours":{"start":[8,0],"end":[18,0]},"stages":{"S0":{"priority":[]},"S1":{"dayMax":2,"priority":["follow","nurture"]},"S2":{"dayMin":3,"priority":["follow","nurture"]},"S3":{"dayMin":3,"priority":["follow","chat","nurture"]},"S4":{"maxOccupyMin":30,"priority":["chat"]}},"cooldown":{"stallCooldownSec":180,"tickIntervalMs":10000,"watchdogMs":30000}}',
  datetime('now', '+8 hours')
);

# CF / 人机验证止血（ChallengeGuard）

日期：2026-08-15  
状态：已实现（插件 3.2.5 · 方案 A）

## 问题

Cloudflare 等验证页没有 X 主壳 DOM，白屏自愈把其当成白屏 → `reload(bypassCache)` + 清缓存 → 验证更难过 → 刷新死循环 → 账号异常。

## 方案 A（本版）

1. `ChallengeGuard` 检测 CF/Turnstile/验证文案（无 X 主壳时）
2. 命中时：**禁止 heal 硬刷新**；**停掉全部引擎**；面板提示
3. 连续卡在验证页 ≥20 分钟 → 熔断冷却 6 小时（可人工点启动解除）
4. S0→工作时段的整页 reload、内存 heal 同样先过 Guard

非目标（B/C）：完整 RiskGuard 分级、OPS 看板、代理治本。

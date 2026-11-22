# X 人机停损 + 养号降频对齐

日期：2026-11-02  
状态：已批准（用户选 C）  
板块：K1 + H（config.njk 默认）+ F（config-sync 兜底）+ D 只读对齐

## 问题

1. 页面出现 `Let's confirm you are a human` 时插件仍在跑（养号等），加重风控。
2. ChallengeGuard 文案库无该句；且 CF 文案路径在「有 X 主壳」时故意跳过——X 自家人机常叠在主壳上 → 漏检。
3. 插件养号稀默认（间隔 45–90s / 日赞 12 / 冷却 8 分）与 OPS `config.njk` 密默认（10–20s / 30 / 3）不一致；库内旧密值下发会盖掉稀默认。

## 方案

### K1 停损

- `shared/challenge-guard.js` 增加 **X 人机**文案信号（`confirm you are a human` 等）。
- **有 X 主壳也命中**（与 CF `cf-text` 门控分离）。
- 命中后沿用现链：停引擎、禁硬刷、20 分→熔断 6h。
- **禁止**自动过码 / 点验证。

### 养号降频（改默认值，不改键名）

对齐目标（= 插件 `nurture-config` / `DEFAULT_THRESHOLDS` 已有）：

| 键 | OPS 页旧 or | 目标 |
|----|-------------|------|
| nurture_action_gap_min/max_sec | 10 / 20 | 45 / 90 |
| nurture_like_cooldown_min | 3 | 8 |
| nurture_daily_likes | 30 | 12 |
| nurture_daily_comments | 10 | 2 |
| nurture_daily_enters | 10 | 5 |
| nurture_hourly_likes | 5 | 2 |
| nurture_hourly_comments | 2 | 1 |

改：`config.njk` or 兜底；`config-sync.js` intervals 里 10/20/3 兜底 → 45/90/8；`shared/config.js` MatrixConfig nurture 旧密默认对齐。

**运维：** 已入库的密值需在 OPS「保存养号设置」一次后才下发到各号。

## 非目标

自动过人机；改关注/私信节奏；改 A2 调度逻辑。

## 验收

1. 正文含 `Let's confirm you are a human` 且存在 `primaryColumn` → `detect().hit === true`，kind=`x-human`。
2. 普通首页文案不误杀。
3. OPS 空库展示 / config-sync 缺键兜底为稀默认。

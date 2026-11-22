# Day≥2 私信日龄闸设计

**日期：** 2026-11-02  
**状态：** 已批准落地

## 目标

账号运营 **Day1 禁止私信**，**Day≥2** 起才允许开私信；Day1 仍可关注与养号。

## 口径

- 日龄 = `matrix_stats_*.day_count`（与现网 StageDetector 一致）
- `day_count < 2` → 禁止一切私信启动路径（主轴 S3 + 软窗 chat_fill）
- `day_count ≥ 2` → 行为与现网一致

## 方案（B）

| 层 | 文件 | 行为 |
|----|------|------|
| A1 | `scheduler/stage-detector.js` | `S3.dayMin` 默认 2；私信时段且 `day≥dayMin` 才进 S3；否则 Day1 走 S1（无 chat） |
| SoftFill | `shared/soft-fill-mode.js` | `day<2` → `allowChat=false`，`reason=day_lt_2` |
| A4 镜像 | `scheduler-core.js` `resolveSoftFillModeCo` | 同上 |
| B4 | `follow/soft-risk.js` | 注释/无 SoftFill 兜底改为 `day≥2` |

## 不改

- A5 `chat-strategy`（日龄不归策略层）
- `content_chat` 发送/DOM
- Day1 关注、新号就绪、养号逻辑

## 验收

1. Day1 + 私信时段：`priority` 不含 `chat`；SoftFill `allowChat=false` / `day_lt_2`
2. Day≥2 + 私信时段：可进 S3 / SoftFill `chat_fill`
3. Day1 仍可 `follow`

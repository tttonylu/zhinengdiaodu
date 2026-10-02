# 诊断冻结契约 Implementation Plan

> **For agentic workers:** 按任务顺序落地；每步可独立验收。

**Goal:** 全模块阶段↔动作契约；异常上报并诊断冻结，便于完整走一轮取证与快速反馈修改。

**Architecture:** `shared/diag-contract.js` 统一裁判；A2 `coStart`/`coTick` 守闸；chat/follow/nurture 打点；面板解冻。

**Tech Stack:** Chrome MV3 content scripts · sessionStorage · SgTelemetry

---

## 文件

| 文件 | 职责 |
|------|------|
| `unified-scheduler/shared/diag-contract.js` | 契约表、noteAction、冻结、异常上报 |
| `unified-scheduler/scheduler-core.js` | coStart 拒冻；tick 检查；zombie/心跳改道冻结 |
| `unified-scheduler/chat/content_chat.js` | 守箱相位 noteAction |
| `unified-scheduler/obs/event-catalog.json` | diag_* 事件 |
| `unified-scheduler/ui/panel.js` | 冻结条 + 解冻按钮 |
| `unified-scheduler/manifest.json` | 注入 + 版本 |

## 任务

- [x] Spec 已写入 docs/superpowers/specs/2026-09-04-diag-freeze-contract-design.md
- [x] 实现 diag-contract.js + manifest 注入
- [x] A2 闸门 + zombie/90s 改道
- [x] C3 守箱 noteAction
- [x] follow/nurture 粗超时走冻结
- [x] 面板 + catalog + §13 + bump 4.0.28

## 验收

1. 人工制造守箱无进度 >45s → 出 `diag_anomaly` + 冻结，面板可见，coStart 不再拉起  
2. 点解冻 → 可继续调度  
3. force/coStart 同 pulse 仍只一条 round_start  

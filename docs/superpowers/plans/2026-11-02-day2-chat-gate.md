# Day≥2 私信日龄闸 Implementation Plan

> **For agentic workers:** 按任务顺序改；跨板块先写 §13 再改第二处。

**Goal:** Day1 禁私信、Day≥2 开私信；Day1 仍可关注/养号。

**Architecture:** A1 stage 主闸 + SoftFillMode/软窗双闸；A5 不碰。

**Tech Stack:** unified-scheduler（IIFE）、Node test、手册/工作指导。

---

## 文件

- `unified-scheduler/scheduler/stage-detector.js` — S3.dayMin=2 并生效
- `unified-scheduler/shared/soft-fill-mode.js` — day_lt_2
- `unified-scheduler/scheduler-core.js` — resolveSoftFillModeCo 镜像
- `unified-scheduler/follow/soft-risk.js` — 兜底 day≥2
- `unified-scheduler/test/` — SoftFill / stage 单测
- `docs/调度工作手册.md` A1、`docs/工作指导.md` A1+§13
- `unified-scheduler/manifest.json` bump

## Tasks

- [ ] SoftFill：`day<2` → nurture_only / day_lt_2
- [ ] stage-detector：S3 仅 day≥2
- [ ] scheduler-core + soft-risk 对齐
- [ ] 测试 + 文档 + manifest 4.6.162

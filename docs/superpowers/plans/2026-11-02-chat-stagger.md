# 私信时间片错峰 Implementation Plan

> **For agentic workers:** 按任务勾选执行；本计划对应 `docs/superpowers/specs/2026-11-02-chat-stagger-design.md`。

**Goal:** 本地时间片错峰限制私信新开并发（默认 2 槽 × 30 分），多开矩阵降 CPU。

**Architecture:** 纯函数模块 `scheduler/chat-stagger.js`；A2 `startChat`/`coTick` 接入；阈值经 F1 `sg_config_thresholds` + OPS 调度参数 UI。

**Tech Stack:** MV3 content script、OPS nunjucks thresholds、node:test

---

### Task 1: 纯函数 + 单测
- [ ] `unified-scheduler/scheduler/chat-stagger.js`
- [ ] `unified-scheduler/test/chat-stagger.test.js`

### Task 2: A2 接入 + manifest
- [ ] `scheduler-core.js` startChat + coTick
- [ ] manifest 注册脚本 + bump 4.6.163

### Task 3: F + H 阈值
- [ ] `config-sync.js` DEFAULTS
- [ ] `config.njk` 输入 + saveScheduler

### Task 4: 文档
- [ ] 工作指导 §13；手册 A2 一行

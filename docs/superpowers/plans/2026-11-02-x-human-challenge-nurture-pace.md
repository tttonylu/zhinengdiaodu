# X 人机停损 + 养号降频 Implementation Plan

> **For agentic workers:** 按任务勾选执行；TDD 先红后绿。

**Goal:** 检出 X「Let's confirm you are a human」即停引擎；OPS/兜底养号默认对齐稀节奏。

**Architecture:** K1 增加与 CF 分离的 `x-human` 文案路径（无视 X 主壳）；H/F/`config.js` 仅改默认数值不改键名。

**Tech Stack:** ChallengeGuard IIFE、node:test、OPS Nunjucks、config-sync。

---

### Task 1: 失败测试（X 人机文案）

- [x] `unified-scheduler/test/challenge-guard-x-human.test.js`
- [x] 抽出/调用 `isXHumanChallengeText`（或 mock DOM 跑 `detect`）
- [x] 断言：目标句命中；普通首页不命中；有主壳仍命中（实现后）

### Task 2: K1 实现

- [x] `shared/challenge-guard.js`：`isXHumanChallengeText` + detect 分支 `x-human-text`
- [x] 测试转绿；`node --check`

### Task 3: 养号默认对齐

- [x] `config.njk` or 值
- [x] `config-sync.js` intervals 兜底 45/90/8
- [x] `shared/config.js` nurture actionGap / likes / cooldown

### Task 4: 收尾

- [x] manifest → **4.6.165**（4.6.164 已被关注满额停养号占用）
- [x] `docs/工作指导.md` §13
- [x] 手册 K1 一行
- [x] 跑相关 test（8/8 通过）

# 关注配额 OPS 回灌根治 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 跨日/日限重抽后，面板「今日关注」已用数必须保持上海日真实值（通常�?0 起），禁止被 OPS `runtime.followed_today` 昨日残值抬回�?
**Architecture:** 单一真相源分层——本�?`matrix_stats_*.follows_today` 为实时账；跨日必�?`follows_today=0` + `follows_reset_day=今日`；任何路径（config-sync / 注册回包 / 心跳兜底）同日不得用 OPS 数抬高本地。OPS `resolveTodayFollowCount` 与账号列�?SQL 禁止裸读跨日残值；心跳写入�?`followed_today_date`（上海日），读时日不一致则�?0�?
**Tech Stack:** 插件 `unified-scheduler`（config-sync / scheduler-core / content_follow）；OPS `x-ops-console`（accounts-repo / runtime-status-repo / plugin routes）；`node --test`；manifest bump�?
---

## 背景与已证实根因

**用户症状�?* 全号「日限额度变了（�?Day3 �?191），但昨天已用还在（�?161/191）」�?
**机制�?*

1. 跨日本地�?`follows_today�?` 并重�?`daily_limit`（日龄进�?�?额度变大，正常）�?2. OPS `account_runtime_status.followed_today` **无日历日字段**，仍持昨日满额�?3. 下一�?`applyRemoteDayCount(..., today_follow_count)` 或注册回包把本地又抬�?161�?4. 面板显示 `161/191` �?像「只加额度、不重置」�?
**4.6.185 已做（仍不够）：**

| �?| 状�?|
|----|------|
| config-sync 跨日�?`follows_reset_day` + 挡回�?| 代码有；**壳未全员升到 4.6.185 则无�?* |
| 凌晨 &lt;6 无闩自愈再清 | 有；�?6 点后不再自愈 |
| follow / scheduler-core rollover 打闩 | �?|
| OPS `resolveTodayFollowCount` 防昨�?| **仓库有，NAS 未部署则现网仍回�?* |
| scheduler-core 注册兜底分支 | **仍删�?+ 可抬数（漏洞�?* |
| 账号列表 SQL 裸读 `rs.followed_today` | **仍漏洞（仪表/部分 API�?* |

---

## 文件地图

| 文件 | 职责 |
|------|------|
| `unified-scheduler/shared/config-sync.js` | 主路径：跨日清零、闩、禁�?|
| `unified-scheduler/scheduler-core.js` | `ensureFollowDailyRollover`�?*注册回包兜底必须�?F1 同语�?* |
| `unified-scheduler/follow/content_follow_v1522.js` | `getAccountStats` 跨日打闩 |
| `unified-scheduler/test/follow-quota-ops-boost.test.js` | 回灌单测（已有，需扩注册兜底） |
| `test-env/x-ops-console/src/repositories/accounts-repo.js` | `resolveTodayFollowCount` + list SQL |
| `test-env/x-ops-console/src/repositories/runtime-status-repo.js` | 心跳写入 `followed_today_date` |
| `unified-scheduler/scheduler-core.js` `pushRuntimeHeartbeat` | 上报 `followed_today_date` |
| `docs/调度工作手册.md` §A2 / §X；`docs/工作指导.md` §13 | 契约与变更记�?|
| `unified-scheduler/manifest.json` | bump **4.6.186** |

**禁止顺手改：** 巨石内无�?C/E 板块；不改关注点�?号池领号�?
---

### Task 0: 现网止血验收（先做，再写码）

**Files:** 无代码；运维动作

- [x] **Step 1�?:** 确认残留漏洞后直接进�?Task1�? 开发（现网需用户侧重�?**4.6.186** + OPS 迁移 075）�?
---

### Task 1: 堵死 scheduler-core 注册兜底回灌（插件）

**Files:**
- Modify: `unified-scheduler/scheduler-core.js`（`schedulerStart` �?`ops_account_register` 回调�?ConfigSync 缺失分支，约 1952�?990�?- Test: `unified-scheduler/test/follow-quota-ops-boost.test.js`（扩一则或新建 mirror 测试�?
**当前坏逻辑（必须改掉）�?*

```javascript
if (rolledLocal) {
  stats.follows_today = 0;
  delete stats.daily_limit;
}
// ...
if (rolledLocal) {
  try { delete stats.follows_reset_day; } catch (eDelHb) {}  // �?删闩�?} else if (remoteF > localF && !skipBoostHb) {
  stats.follows_today = remoteF;
}
```

- [x] **Step 1: 写失败测�?*  
  语义：跨日清零后 `follows_reset_day=today`；同�?`remoteF=161` 不得抬本地。对注册兜底函数抽镜像或导出测试缝（与现�?config-sync 测同口径）�?
- [x] **Step 2: 跑测确认�?*

- [x] **Step 3: 改注册兜底与 F1 对齐**  
  - `rolledLocal`：`follows_today=0`；`delete daily_limit`�?*`follows_reset_day=todayKey`（禁�?delete�?*  
  - `skipBoostHb = resetDayHb === todayKey`�?*不要** `&& !rolledLocal`�? 
  - 同日 `remoteF > localF` 仅当 `!skipBoostHb`  
  - 优先：有 `ConfigSync.applyRemoteDayCount` �?*只走�?*，删掉分叉抬数（YAGNI：避免双实现�?
- [x] **Step 4: 测绿 + `node --check scheduler-core.js`**

---

### Task 2: �?6 点仍可自愈（插件�?
**Files:**
- Modify: `unified-scheduler/shared/config-sync.js`（凌晨自愈块�?- Modify: `unified-scheduler/scheduler-core.js`（可选同逻辑�?ensureFollowDailyRollover 后）

**问题�?* 4.6.185 自愈�?`hour < 6`。用户若白天才重载，已灌 161 会钉死�?
- [x] **Step 1: 失败测试**  
  `date===today`、`follows_today>0`、`!follows_reset_day`、模�?hour=12 �?仍应清零并打闩（一次）�? 
  判定改为�?*无闩 + date 已是今日 + 已用>0** 即视为「跨日闩缺失的污染态」，不限小时�? 
  **安全�?* 有闩则永不误清（当日真关注后闩在，不会被清）�?
- [x] **Step 2: 实现**  
  去掉（或放宽）`hourSh < 6`；改为：

```javascript
if (!rolled && !skipOpsBoost && localFollows > 0 && !resetDay) {
  stats.follows_today = 0;
  stats.follows_reset_day = today;
  localFollows = 0;
  skipOpsBoost = true;
}
```

  注意：`resetDay` 空才修；人工重锁也会写闩，不冲突�?
- [x] **Step 3: 测绿**

---

### Task 3: OPS 读路径统一（禁止列�?SQL 裸读�?
**Files:**
- Modify: `test-env/x-ops-console/src/repositories/accounts-repo.js`  
  - `resolveTodayFollowCount`（巩固）  
  - `list`/`listForPage` �?`today_follow_count` CASE（约 198�?01 行）
- Test: 若有 accounts-repo 单测则补；否则加最�?node 测或脚本断言 SQL 不再 `THEN COALESCE(rs.followed_today`

- [x] **Step 1: 列表 SQL**  
  `today_follow_count` 不得直接 `rs.followed_today`。改为与 `resolveTodayFollowCount` 同规则，�?list 后逐行调用 `resolveTodayFollowCount`（N 小可接受�?0�?00 �?OK）�?
- [x] **Step 2: `resolveTodayFollowCount` 硬化**  
  - `followed_today_date`（Task 4）优先；  
  - 无日期时：心跳日 �?上海今日 �?logs�? 
  - 保留「今�?logs 远低�?runtime」保护，**去掉�?hour&lt;6 的强依赖**（或改为「logs=0 �?runtime�?0」即�?logs，避免白天仪表仍显示昨日）�?
- [x] **Step 3: 本地/容器跑相关测；准�?NAS 部署清单**

---

### Task 4: runtime 写入日历日（硬真相）

**Files:**
- Modify: `test-env/x-ops-console/src/repositories/runtime-status-repo.js`  
- Modify: migration 新文�?`075_followed_today_date.sql`（或 SQLite `ALTER` 兼容补列�? 
- Modify: `unified-scheduler/scheduler-core.js` `pushRuntimeHeartbeat` 增加 `followed_today_date: shanghaiDayKey()`  
- Modify: `test-env/x-ops-console/src/routes/api/plugin.js` 透传字段

- [x] **Step 1: 迁移**  
  `account_runtime_status.followed_today_date TEXT`（`YYYY-MM-DD` 上海日）�?
- [x] **Step 2: 心跳 upsert �?date**  
  插件每包带当日；OPS 写入。读时：`followed_today_date !== shanghaiDateKey()` �?视为 0（可同时�?DB 值异步修正为 0，可选）�?
- [x] **Step 3: 单测 / 手测**  
  模拟 date=昨天 + followed=161 �?resolve 返回 0�?
---

### Task 5: 心跳不再把脏数写�?OPS

**Files:**
- Modify: `unified-scheduler/scheduler-core.js` `buildHeartbeatPayload` / `pushRuntimeHeartbeat`

- [x] **Step 1:** 发心跳前调用 `ensureFollowDailyRollover()`（或 ConfigSync 同名）�? 
- [x] **Step 2:** `followed_today` 必须�?rollover 之后�?`getFollowedToday()`�? 
- [x] **Step 3:** 若存�?`follows_reset_day===today` 且本�?0，强制上�?0（防止竞态读旧缓存）�?
---

### Task 6: 文档 + 版本 + 验收

**Files:**
- Modify: `docs/调度工作手册.md` §A2 关注日限 / §X `H1↔A2/F`  
- Modify: `docs/工作指导.md` §13  
- Modify: `unified-scheduler/manifest.json` �?**4.6.186**

- [x] **Step 1: 手册契约**  
  写清：跨日闩、禁止抬数的全部入口、OPS `followed_today_date`、列表不得裸读�?
- [x] **Step 2: bump 4.6.186**（version / description / default_title�?
- [x] **Step 3: 验收清单（产品）**

| # | 操作 | 期望 |
|---|------|------|
| 1 | 全壳重载 4.6.186 | 面板版本一�?|
| 2 | OPS 迁移+部署 | `/health` ok |
| 3 | 污染号刷�?x.com | `今日关注` �?`0 / 日限`（日限可仍是 DayN 随机�?|
| 4 | �?1 分钟 config-sync | 已用仍为 0，不抬回 |
| 5 | 真关 1 个粉 | 变为 `1 / 日限` |
| 6 | OPS 账号列表今日关注 | 与插件一致或 �?插件，不为昨日满�?|

- [x] **Step 4: §13 记一行（�?ID：关注日�?/ F1→A2→H�?*

---

## 任务顺序与依�?
```
Task 0 止血验收
  �?Task 1 堵注册兜底（最快止住插件侧第二入口�?  �?Task 2 无闩污染态自愈（白天重载也可救）
  �?Task 5 心跳�?rollover
  �?Task 3 OPS 读统一
  �?Task 4 followed_today_date（硬根治�?  �?Task 6 文档版本验收
```

**建议提交粒度�?* Task1+2+5 一次插�?commit�?.6.186）；Task3+4 一�?OPS commit；勿混无关改动�?
---

## 风险与非目标

- **不做�?* �?DayN 区间数值、改关注点击、保存阈值自�?`reset_follow_daily_limit`（已废除，勿恢复）�? 
- **风险�?* 「无�?+ 已用>0」自愈若误伤——仅当闩缺失；正常跨�?重锁都有闩�? 
- **回滚�?* 插件退�?4.6.184；OPS 回滚 accounts-repo / 迁移忽略新列即可�?
---

## 执行入口

实施时用：`superpowers:executing-plans` �?`subagent-driven-development`，按 Task 0�? 勾选推进�? 
**未完�?Task 0（确认版本与 OPS 部署）前，不要假�?4.6.185「已失败」——多数现网回灌仍是未升级/未部署�?*

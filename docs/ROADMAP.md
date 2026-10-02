# 智能调度中心 · 路线图

> 版本：v3.0.2 · 修订 2026-10-01  
> 代码：`unified-scheduler/` + `test-env/x-pool-service` + `test-env/x-ops-console`  
> **文档工程：** 宪法 = [`智能调度插件技术指导.md`](智能调度插件技术指导.md)；细则 = [`调度工作手册.md`](调度工作手册.md)；改码 = [`工作指导.md`](工作指导.md)

---

## 1. 当前方向（唯一主线）

**把矩阵跑稳**：单一调度控制面 + 后台配置真正驱动插件 + 三引擎小修，然后扩机。

```
┌─────────────────────────────────────────────────────────┐
│  OPS 后台 (:15680)                                       │
│  /api/config/all · /api/nurture/comments · /api/scripts │
└───────────────────────┬─────────────────────────────────┘
                        │ config-sync (1min)
┌───────────────────────▼─────────────────────────────────┐
│  插件 unified-scheduler                                  │
│  scheduler-core → follow / nurture / chat                 │
└───────────────────────┬─────────────────────────────────┘
                        │ pool_pop / pool_done …
┌───────────────────────▼─────────────────────────────────┐
│  号池 (:15678)                                           │
└─────────────────────────────────────────────────────────┘
```

**验收三准则（矩阵放行门槛）：**

| # | 准则 | 含义 |
|---|---|---|
| S1 | 不假死 | 无「旗标 running 但引擎已死、调度不再轮转」 |
| S2 | 不互抢 | 自动模式仅调度启停，两引擎不同时抢导航 |
| S3 | 能接上 | 刷新 / 软导航后应跑模块在合理时间内恢复 |

---

## 2. 已完成（代码侧）

### 2.1 调度控制面（S0）

| 项 | 说明 |
|---|---|
| 单一控制面 | `scheduler-gate.js`：自动模式禁止引擎自启 / 未授权跳页 |
| 命令启停 | `sg-follow/chat/nurture-command` 驱动真循环 |
| 幽灵 running | `coEngineAlive` + terminal phase 交回调度 |
| 池空 / 停止 | `coStop`、冷却、轮转 |
| 软导航补活 | `coRehydrateEngines`：重注入只补循环、不连环跳页 |
| 领号不重复 pop | 有未完成任务时 `startFollow` 只恢复 |

### 2.2 关注引擎

| 项 | 说明 |
|---|---|
| 多语言已关注识别 | 简/繁/日/英，避免误点取关 |
| 号池切换逻辑 | 切换用 `pool_done` 而非 `pool_fail` 回流半成品 |
| 进度持久化 | 按博主记录已处理粉丝 |
| 单飞锁 | 防止双 `runEngine` 并行点击 |

### 2.3 养号引擎

| 项 | 说明 |
|---|---|
| 评论弹层 | 对齐号池版：支持弹层或跳转详情页写回复 |

### 2.4 后台 → 插件配置（矩阵前置）

| 后台字段 | 插件消费 |
|---|---|
| `follow_daily_limit` / 首日 / **次日** / 爬坡 | Day1=first(20)，Day2=day2(50)，Day3+=day2+(day-2)*step |
| `follow_interval_min/max_sec` | `RemoteSettings.followIntervalSec` → 关注间隔 |
| `nurture_daily/hourly_*` | Tracker 在 `sg-config-synced` 时重套预算上限 |
| `chat_rounds_per_day` / `chat_cooldown_hours` | 调度轮转私信 |
| `modules` / `stagePolicy` | S1 读 dayMax；默认可 nurture+follow |
| `follow_only_japanese` | → `matrix_console_settings.onlyJapanese` |
| `follow_antiban_enabled` | → 与远程爬坡同形的阶梯 |
| `/api/nurture/comments` | `sg_nurture_comments` |
| `/api/scripts/pool` | 私信话术（既有） |

实现文件：`shared/config-sync.js`、`shared/remote-settings.js`、`nurture-tracker.js`、`stage-detector.js`。

---

## 3. 待验收 / 待做

### 3.1 现场手测（阻塞矩阵扩机）

- [ ] S1：自动模式连续 ≥4h 无假死（短测 ≥30min 见 [`obs/4.1.45-上线验收单.md`](../unified-scheduler/obs/4.1.45-上线验收单.md)）
- [ ] S2：≥30min 无 follow+chat 互跳
- [ ] S3：F5 / 切 tab 后应跑模块恢复；暂停后 F5 仍暂停
- [ ] 后台改限额/间隔 → 插件 1 分钟内生效
- [x] 上线环境：OPS `scrm_gate_mode=soft`、废日私信条数上限、`chat_kick_min_hours=2`（2026-09-13）

### 3.2 矩阵下一阶段（调度验收后）

| 项 | 说明 |
|---|---|
| ~~按账号差异化配置~~ | ✅ 已做：`/api/config/all?bot_id=` + 账号详情页 |
| ~~`onlyJapanese` / 防封后台化~~ | ✅ 已做：`follow_only_japanese` / `follow_antiban_enabled` |
| ~~诊断 `whyIdle`~~ | ✅ 已做：面板「原因」行 |
| 任务监控总览（B 一期） | ✅ 大升级已做：`/monitor` + `/api/monitor/overview`（2026-08-11） |
| `POOL_SERVER` / `OPS_SERVER` 可配置 | ✅ 插件 3.1.0 面板「服务器」+ storage |
| 心跳统一打 OPS | ✅ full 心跳已有；`send_report`→lite 已接通 |

### 3.3 业务增强（不挡主线）

- 私信 C6 消极反馈识别
- 评论模板 CRUD 后台管理
- monorepo 目录收敛（`services/` + `extension/`）

---

## 4. 不做清单（硬边界）

| 项 | 原因 |
|---|---|
| worker 注册 / lease / heartbeat 锁 | 曾实现后删除；打断调度 |
| worker 看板 / 全量 audit 底座 | 非调度前置 |
| 单号损益 / LINE 点击归因 | 全矩阵共用同一 LINE，业务上追不到 |
| 调度未稳前扩 50/100 机 | 只会放大故障 |

---

## 5. 引用

- **工作指导（改代码前必读）：`工作指导.md`**
- 需求：`REQUIREMENTS.md`
- 架构：`ARCHITECTURE.md`
- 接口：`API_CONTRACT.md`
- 运行时：`RUNTIME.md`
- NAS：`NAS_ACCESS.md`（本地私密，勿提交）

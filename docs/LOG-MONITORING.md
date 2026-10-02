# 日志常态监控与数据库架构方案

> 版本: v1.1
> 状态: **已实施（插件 3.6.0 + 后台日志库已部署 NAS 测试环境）**
> 目标规模: 200-300 账号 / 4-6 终端 / 每终端 30-50 实例

## 1. 背景与目标

### 1.1 现状问题

- `obs/test-monitor.js` 是**手动开关**的测试监控：不开就不记录，无法发现"用户没开监控时出的问题"。
- `shared/telemetry.js` 缓冲上限 500 条，只按"已转发给 background"标记上传，**没有后端按条确认**，断网重试会丢事件。
- 缓冲使用 `chrome.storage.local`，在 30-50 实例共享时存在读改写竞争，日志互相覆盖丢失。
- 快照上报截断上下文：`recent_events` 只保留 60 条、`console_lines` 只保留 80 条。
- 遥测/活动日志与业务数据混在同一个 `x-ops-console.sqlite`：高写入与运营查询抢锁，无保留策略。
- 上次 DM 验证页问题定位困难，正是监控链路缺环（passcode 事件未进日志）。

### 1.2 目标

1. **日志常态化**：插件加载即记录，不依赖手动开关；结构化、带幂等键、可精确确认。
2. **上传准确**：每条日志有 `client_event_id`，后台按条去重、返回精确计数，断网断点续传不丢不重。
3. **容量可撑 300 账号**：按用途分库，批量写入，保留策略 + 磁盘水位告警。

## 2. 总架构：三库分库（不换引擎）

| 库 | 文件 | 内容 | 写频 | 保留 |
|---|---|---|---|---|
| 业务库 | `data/x-ops-console.sqlite` | 账号、线索、DM轮次、漏斗、配置 | 低 | 长期 |
| 日志库 | `data/x-ops-log.sqlite` | 插件遥测、诊断快照、小时汇总 | 高（批量） | 30 天明细 / 180 天汇总 / 14 天快照 |
| 号池库 | `data/x-pool.sqlite`（已有） | 账号分配、任务绑定 | 中 | 长期 |

SQLite + WAL 足够支撑：300 账号批量写入下，SQLite 写事务每秒个位数，远低于 WAL 上限。

### 2.1 部署拓扑

```text
终端1 (30-50 实例) ─┐
终端2 (30-50 实例) ─┤   批量+幂等上报
终端3 (30-50 实例) ─┼──► NAS 后台 (唯一写入点，Docker 15680)
终端4 (30-50 实例) ─┘        │
                             ├─ 业务库 (长期)
                             ├─ 日志库 (30天明细 + 180天汇总)
                             └─ 号池库 (已有)
```

多终端只是"运行端"，数据全部汇到 NAS，无终端间数据互通需求。

## 3. 插件侧设计（已实施，3.6.0）

### 3.1 常驻日志采集（`obs/test-monitor.js` 重写）

- 插件加载即自动启动，无需手动"测试监控 ON"；面板按钮改为"日志常态ON"只读状态。
- 存储使用 `sessionStorage`（每标签页独立，规避多实例共享 storage 的写竞争），旧 `localStorage` 数据一次性迁移。
- 记录结构（统一标准字段）：

```json
{
  "client_event_id": "evt_1728..._a1b2c3",
  "event_id": "chat.dm_pin_gate",
  "category": "chat",
  "severity": "warn",
  "label_zh": "DM PIN 门禁拦截",
  "session_id": "s_...",
  "account_handle": "@xxx#guard",
  "ts": 1728, "time_zh": "2026/8/24 15:00:00",
  "meta": { "reason": "pending_verify" }
}
```

- 30s checkpoint 记录调度状态摘要（本地环 + 每 10 次上报一次摘要事件）。
- 错误/生命周期/checkpoint 摘要经 `SgTelemetry.emit` 自动上报（`_from_monitor` 标记防回环）。
- co-tick 无变化时落盘节流到 15s，避免每秒序列化大 JSON。

### 3.2 上报链路（`shared/telemetry.js`）

- 缓冲改为 per-tab `sessionStorage`，上限 2000 条。
- `BATCH_SIZE` 40；flush 30-60s 随机抖动（替代固定 45s）。
- **精确确认**：`accounted()` 要求服务端 `ingested + deduped >= 批次大小`（新协议）或 `count >= 批次大小`（兼容旧协议）才标记上传。
- 失败 → `failStreak++` → 指数退避（5s → 120s max + 抖动），重试期间整批保留。
- 并发防护 `flushing`，避免多定时器重复刷。
- 快照截断放宽：recent_events 300、console_lines 200。

### 3.3 事件目录（`obs/event-catalog.json`）

新增 `test.monitor_started / stopped / exported / uploaded / test.error / test.lifecycle / test.checkpoint / test.state_change`。

## 4. 后台侧设计（已实施，已部署 NAS）

### 4.1 日志库 schema（`src/db/migrations-log/001_init.sql`）

```sql
CREATE TABLE IF NOT EXISTS log_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL DEFAULT 0,
  account_handle TEXT,
  client_event_id TEXT NOT NULL UNIQUE,    -- 幂等键
  event_id TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  category TEXT NOT NULL DEFAULT 'system',
  label_zh TEXT,
  session_id TEXT,
  meta_json TEXT,
  ts_ms INTEGER,
  created_at TEXT NOT NULL
);
-- 索引: (account_id, created_at) / (event_id, created_at) / (severity, created_at) / (created_at)

CREATE TABLE IF NOT EXISTS log_snapshots (...);   -- 14 天
CREATE TABLE IF NOT EXISTS log_rollups_hourly (...); -- 180 天
```

- 独立迁移器 `src/db/migrate-log.js`，配置项 `LOG_DB_PATH`（默认 `data/x-ops-log.sqlite`）。
- `app.logDb` 独立连接（WAL），与业务库互不抢锁。

### 4.2 批量入库（写路径，已实施）

- `POST /api/plugin/log/batch`：body `{ events: [...], account_handle }`。
- 单事务 `INSERT OR IGNORE`（按 `client_event_id` 幂等去重），返回 `{ ok, ingested, deduped, failed }`。
- 插件 `background.js` 的 `telemetry_emit` / 重试队列 / `telemetry_snapshot` 已改指 `/api/plugin/log/batch` 与 `/api/plugin/log/snapshot`。
- 错误事件沿用 `maybeAlertTelemetry` 规则触发 PushPlus 告警（计数走日志库）。
- 旧 `/api/plugin/telemetry/batch` 保留兼容旧版本插件（仍写业务库）。

### 4.3 查询路径（已实施）

- `GET /api/monitor/logs`（事件列表，支持 account/event_id/severity/category/since/until/limit/offset）
- `GET /api/monitor/logs/stats?hours=24`（总数、级别分布、小时趋势、活跃账号）
- `GET /api/monitor/logs/snapshots` / `.../snapshots/:id`
- 监控页 `/monitor` 新增"日志"Tab（`#logs` 直达，级别/账号筛选 + 24h 趋势条 + 事件表）。


### 4.3.1 指挥闭环观测（4.0.25+）

| event_id | 含义 |
|---|---|
| scheduler.round_start | 发租约（含 forceInboxPulse 的 via） |
| chat.round_plan | 密封名单 |
| chat.round_progress | 逐条进度 |
| chat.round_result | 轮结果 |
| scheduler.round_complete | 指挥收工 |
| scheduler.chat_zombie_reclaim | 假活回收（可 Push） |

- GET /api/monitor/logs/command-loop?account=&hours=6：按 pulseId 聚合断环
- GET /api/monitor/logs?event_ids=...：多事件筛选；监控页预设「指挥闭环」
- 插件：闭环事件优先出队 + 短延迟 flush；checkpoint 带 inboxPhase / chatLeasePulseId / chatProgressAgeSec

### 4.4 保留与清理（已实施，`src/services/log-retention.js`）

> 优化周期短，采用紧凑保留策略（30 天明细足够）：

| 数据 | 保留 | 处置 |
|---|---|---|
| log_events 明细 | 30 天 | 先累加进 log_rollups_hourly，再批量删除 |
| log_rollups_hourly | 180 天 | 直接删除 |
| log_snapshots | 14 天 | 直接删除 |
| activity_logs（业务库） | 90 天 | 直接删除（zhdate 兼容 zh 时间戳） |

- 调度：启动 60s 后首跑，之后每 6h 一次（`startLogRetentionScheduler`）。
- 磁盘水位：`df` 检查剩余空间 < 20G → PushPlus 告警（每天最多一次）。
- 批量删除每批 5000 行，避免长事务。
- 调整方式：只改 `log-retention.js` 的 `DEFAULT` 常量，重建容器即生效（无需改表）。

## 4.6 守箱节奏（3.6.1+，`chat/content_chat.js` + 后台 `chat_inbox_visit_cap_sec`）

- **单次守箱上限**：默认 150 秒（后台「私信参数 → 单次守箱时长」可调），到点 `completeChatRound('inbox_visit_cap')` 交回调度。
- **回查间隔**：只要还有「破冰已发、等回复」对象（`countReplyPending`/`countReplyPendingCo`），冷却 2-4 分钟回 `/messages` 扫新消息；无人等回复则恢复正常 25-35 分钟冷却。
- **DM 信箱明确检测**（`detectDmMailboxSource`）：
  - `url`：路径含 `/messages`；
  - `drawer`：DOM 出现 `[data-testid="DMDrawer"]`（任意页面弹出的 DM 抽屉）；
  - 两者都没有 → 视为非私信环境，守箱引擎不动作。
  - 会话列表不可见（打开了单个会话 `/messages/<id>` 且窄屏隐藏左栏）→ 自动回收件箱根视图 `/messages`。
  - 检测来源随 `inbox_watch_start` 事件上报，日志监控可见 `detect` 字段。

## 5. 容量估算与磁盘水位

- 300 实例 × 每分钟 5-15 条事件 × 1-3KB ≈ 1.5-8MB/min ≈ **2-8GB/天**。
- 日志库 30 天 ≈ 60-240GB（需按实际压缩 meta / 截断长字段，并配合保留策略）。
- 磁盘水位目标：日志库常驻 < 15GB，超过触发告警 + 缩短保留天数。

> NAS 磁盘仅剩 35G，保留任务（30/180/14 天）已上线；若实际日志量偏大，先调 `LOG_RETENTION_EVENT_DAYS` 类参数缩短周期。

## 6. 迁移与部署记录

```text
第1步 ✅ 新增 x-ops-log.sqlite + migrate-log 多库迁移
第2步 ✅ 后台 /api/plugin/log/batch + 快照入库 + 保留任务
第3步 ✅ 插件日志常态化 + 精确 ack（3.6.0）
第4步 ✅ 监控页日志 Tab + 查询 API
第5步 ✅ NAS Docker 重建部署并验证（幂等去重、UTF-8 中文、趋势统计均通过）
```

部署方式：`rsync src/ → /vol2/1000/test/x-ops-console/src/`，然后 `docker compose up -d --build --force-recreate`（容器内 `DATA_DIR=/data`，日志库落在 `./data/x-ops-log.sqlite`）。

## 7. 待办（后续优化）

1. 心跳降频：普通心跳 60s，状态变化即时（当前仍是高频心跳路径）。
2. 后台内存缓冲合并（当前每批次直接单事务落库，300 账号规模已足够；若超 500 账号再考虑内存缓冲 + 5s 落盘）。
3. 日志明细超量时动态缩短保留天数（接入配置阈值）。
4. 旧 `plugin_telemetry` / `telemetry_snapshots` 表数据只读保留，停止增长。

# 任务监控 · B 一期设计

> 日期：2026-07-29  
> 状态：逻辑审查已修复 · 待用户确认后进入实现  
> 范围：**仅一期（总览 + 心跳打通）**；二/三期只作边界说明，不在本期实现  
> 修订：2026-07-29 晚 · 逻辑性审查修复（engine 语义、字段合并、旧客户端、告警、验收）

---

## 1. 目标

在 OPS（`:15680`）提供统一「任务监控」总览，一眼看到：

1. 各账号是否在线、正在跑什么、为何 idle  
2. 号池任务量摘要（pending / assigned / completed / dead）  
3. 基础告警（心跳超时、号池 assigned 积压、号池不可达）

**成功标准：**

- 插件自动模式运行时，OPS 监控页 ≤60s 内可见该账号最新状态（30s 心跳 + 30s 页刷，最坏约 60s）  
- 「在线 / 陈旧 / 离线」是展示态，与「能否看到最新一行」分开：陈旧仍显示最近快照，不表示页面空白  
- 心跳失败不影响本机调度（监控只看不锁）  
- 号池摘要可读；号池短暂不可达时账号表仍显示，并提示号池离线

---

## 2. 非目标（硬边界）

| 不做 | 原因 |
|------|------|
| worker 注册 / lease / 心跳锁 | 曾实现后删除；会打断调度 |
| 因监控异常强制停引擎 | 监控失败不得拖垮业务 |
| 一期做账号/任务下钻详情页 | 属二期 |
| 一期做推送告警（企业微信等） | 属三期 |
| 一期做 `long_idle` 告警 | 轮转间隙 / S0 夜间会误报；whyIdle 只展示不告警，持续判定属二/三期 |
| 替换现有驾驶舱漏斗页 | 驾驶舱保留；监控是新入口 |

---

## 3. 架构

```
插件 content (scheduler-core = 主数据源)
        │  chrome.runtime.sendMessage（节流 ~30s 全量心跳）
        ▼
background.js
        │  POST /api/plugin/account/heartbeat
        │  （引擎 send_report 可转发，但须字段合并 + 节流）
        ▼
OPS x-ops-console (:15680)
        │  touch accounts
        │  字段级 merge upsert → account_runtime_status
        │  overview: accounts LEFT JOIN runtime + 日统计可选
        │  GET 号池 :15678/pool/status（2s 超时，失败降级）
        ▼
浏览器  /monitor  任务监控页（30s 自动刷新）
```

原则：**监控只观测，不调度。**

---

## 4. 数据模型

### 4.1 字段语义（必须统一）

| 字段 | 含义 | 取值 |
|------|------|------|
| `running_module` | 当前真正在跑的业务模块 | `follow` / `nurture` / `chat` / `null`（空闲） |
| `engine` | **面板展示态** | 有 `running_module` 时 = 该模块名；否则 `idle` / `coor`（调度空转） / `manual` |
| `why_idle` | 空闲原因 | 仅当 `running_module` 为空时有意义；有模块在跑时应为 `""` |
| `followed_today` | 监控表「今日关注」 | **一期以心跳值为准**（与 `daily-stats` 可能略有差，不在本期强行对齐） |

禁止再用同一字段一会儿表示「调度器叫 coor」、一会儿表示「业务叫 follow」而不加说明。

### 4.2 新表 `account_runtime_status`

| 列 | 类型 | 说明 |
|----|------|------|
| x_handle | TEXT PK | 账号 handle（小写，无 @） |
| bot_id | TEXT | 原始 `@handle#guard` |
| engine | TEXT | 展示态，见 §4.1 |
| stage | TEXT | S0–S4 |
| running_module | TEXT | 见 §4.1，空串表示 null |
| why_idle | TEXT | 见 §4.1 |
| followed_today | INTEGER | 今日关注（心跳） |
| follow_limit | INTEGER | 当日限额 |
| auto_mode | INTEGER | 0/1 |
| detail_json | TEXT | 可选扩展（如 url、chat_rounds_today） |
| last_seen_at | TEXT | 上海时间最后一次**任意**心跳到达 |
| updated_at | TEXT | 行更新时间 |

迁移：`012_account_runtime_status.sql`。

### 4.3 心跳负载

**全量心跳（scheduler-core，主路径）：**

```json
{
  "bot_id": "@handle#guard",
  "heartbeat_kind": "full",
  "engine": "follow",
  "stage": "S2",
  "running_module": "follow",
  "why_idle": "",
  "followed_today": 42,
  "follow_limit": 200,
  "auto_mode": true,
  "url": "https://x.com/...",
  "chat_rounds_today": 1
}
```

空闲示例：`"running_module": null`（或省略）、`"engine": "idle"`、`"why_idle": "池空/冷却 120s"`。

**轻量心跳（引擎 `send_report` 转发，可选）：**

```json
{
  "bot_id": "@handle#guard",
  "heartbeat_kind": "lite",
  "engine": "follow",
  "running_module": "follow"
}
```

轻量包**不得**携带空的 `stage` / `why_idle` / `followed_today` 去覆盖全量值（见 §5.1 合并规则）。

---

## 5. API

### 5.1 扩展 `POST /api/plugin/account/heartbeat`

**始终：**

1. ensureAccount + day_count 跨天逻辑  
2. touch `accounts.last_seen_at`

**`account_runtime_status` 写入规则（字段级合并）：**

| 请求形态 | 行为 |
|----------|------|
| 仅有 `bot_id`（旧客户端 / 无扩展字段） | **不 upsert 业务列**；若尚无 runtime 行可不创建，或只插一行并把 `last_seen_at` 更新、业务列保持默认/既有 |
| `heartbeat_kind=lite` 或仅含部分字段 | 只更新**请求体里显式出现的键** + 始终更新 `last_seen_at` / `bot_id`；未出现的键保持库中旧值 |
| `heartbeat_kind=full`（或带齐 stage/auto_mode/follow 等） | 对出现的键全部写入；`why_idle` 允许显式写 `""` 清空；`running_module` 显式 `null`/缺省空串表示空闲 |

判定「有扩展字段」：除 `bot_id` 外还存在 `engine` / `stage` / `running_module` / `why_idle` / `auto_mode` / `followed_today` / `follow_limit` / `heartbeat_kind` 任一键。

响应保持：`{ ok: true, day_count }`。

### 5.2 新增 `GET /api/monitor/overview`

**账号列表数据源（钉死）：**

```text
accounts
  LEFT JOIN account_runtime_status USING (x_handle)
  （可选 LEFT JOIN 当日 daily-stats，一期 UI 可不展示）
```

- 有 runtime：用 runtime 字段  
- 无 runtime：`engine/stage/...` 空，状态文案「从未上报」，`online=false`  
- 排序：在线优先 → `last_seen_at` 新→旧 → handle

返回形状：

```json
{
  "ok": true,
  "accounts": [
    {
      "x_handle": "xxx",
      "engine": "follow",
      "stage": "S2",
      "running_module": "follow",
      "why_idle": "",
      "followed_today": 42,
      "follow_limit": 200,
      "auto_mode": true,
      "last_seen_at": "...",
      "online": true,
      "presence": "online",
      "never_reported": false,
      "alerts": []
    }
  ],
  "pool": {
    "ok": true,
    "pending": 10,
    "assigned": 3,
    "completed": 100,
    "dead": 2
  },
  "alerts": [
    { "level": "warn", "code": "heartbeat_stale", "text": "@xxx 心跳超时", "handle": "xxx" }
  ],
  "generated_at": "..."
}
```

`presence`：`online` | `stale` | `offline` | `never`（与 §6 阈值一致）。

号池：OPS 服务端 `fetch(POOL_URL + '/pool/status')`，超时 2s；失败则 `pool.ok=false`，账号表照常。  
`POOL_URL` 默认 `http://192.168.0.100:15678`（环境变量可覆盖，一期无 UI）。

### 5.3 插件侧

| 路径 | 职责 |
|------|------|
| **scheduler-core 全量心跳（主）** | 每 **30s** 节流；`heartbeat_kind=full`；含 engine/stage/running_module/why_idle/auto_mode/限额 |
| **优雅停止** | 用户点停止时立刻再发一包 `full`：`auto_mode=false`，`running_module=null`，`engine=idle` |
| **引擎 send_report** | 继续写本地 `chrome.storage`；转发 OPS 时标 `lite`，background **同 handle ≥15s** 节流；禁止用空字段打全量列 |
| **杀进程 / 关页** | 无法保证终包 → 仅靠 `last_seen_at` 超时变为 stale/offline（见验收） |

---

## 6. UI：`/monitor`

- 导航：驾驶舱旁「任务监控」  
- 顶部：告警条（有则显示）  
- KPI：在线数 / 自动模式数（`auto_mode=1` 且 presence≠offline） / 号池 pending / assigned  
- 表格：账号 | 在线态 | 阶段 | 引擎 | 模块 | 原因 | 今日关注 | 心跳时间  
- 刷新：30s（meta 或 fetch overview）  
- 样式：沿用现有 shell

**在线判定（展示用）：**

| presence | 条件 |
|----------|------|
| never | 无 runtime 行 |
| online | `last_seen_at` ≤ 90s |
| stale | 90s &lt; 龄 ≤ 5min |
| offline | 龄 &gt; 5min |

文案：在线 / 陈旧 / 离线 / 从未上报。陈旧行仍展示最近快照（含 whyIdle），避免误解为「没数据」。

**告警规则（一期，仅这三条）：**

| code | 条件 | level |
|------|------|-------|
| heartbeat_stale | 最近一次心跳 `auto_mode=1`，且 presence 为 stale 或 offline | warn |
| pool_assigned_high | `pool.ok` 且 assigned ≥ 20（常量） | warn |
| pool_unreachable | `pool.ok === false` | warn |

`why_idle`：**只进表格「原因」列，不产生告警。**

---

## 7. 错误与降级

- 心跳 POST 失败：插件 console 即可，一期不做重试队列  
- overview 号池失败：黄条「号池不可达」+ `pool_unreachable`  
- 无 runtime 的账号：列表仍出现，「从未上报」

---

## 8. 验收（一期）

1. 重载插件 → 开自动 → ≤60s 内 `/monitor` 出现该 handle，阶段/引擎/模块与本机一致  
2. **优雅停止**：点停止 → 很快看到 `auto_mode=false`（终包），不一定变离线  
3. **粗暴停止**：关标签/杀浏览器 → 不再更新 → 经 90s 变陈旧，经 5min 变离线；`auto_mode` 可能仍为旧值 true，但应出现 `heartbeat_stale`  
4. 关掉号池服务 → 账号表仍在 + 号池告警  
5. 造 idle（池空冷却等）→ 「原因」列有 whyIdle，**顶部不应因此刷 long_idle**  
6. 关注引擎单独 `send_report` 与调度全量交错 → `stage`/`why_idle` **不被空值抹掉**

---

## 9. 二期 / 三期（本期不实现）

- **二期：** 账号下钻（号池任务 + 近 30 条活动）；assigned 归属  
- **三期：** `long_idle`（需持续时长状态机）、假死/互抢启发式、外部推送  

---

## 10. 实现文件预估

| 区域 | 文件 |
|------|------|
| OPS DB | `migrations/012_account_runtime_status.sql` |
| OPS API | `routes/api/plugin.js`（heartbeat 合并逻辑）、新建 `routes/api/monitor.js` |
| OPS 页 | `routes/pages/monitor.js`、`views/monitor.njk`、各页导航 |
| 插件 | `background.js`（节流 + lite/full）、`scheduler-core.js`（30s 全量 + 停止终包） |

---

## 11. 与路线图关系

完成本期后：勾选「心跳统一打 OPS」；ROADMAP 3.2 增加「任务监控（一期总览）」；二期另开。

---

## 12. 逻辑审查纪要（已消化）

| 原问题 | 修复 |
|--------|------|
| `engine` 与示例不一致 | §4.1 钉死展示态 vs `running_module` |
| 双路上报互相覆盖 | §5.1 字段级合并；lite 不写空业务列 |
| 旧客户端整行清空 | 仅 `bot_id` 时不覆盖业务列 |
| `long_idle` 误报 | 一期删除该告警，whyIdle 仅展示 |
| 账号列表数据源含糊 | `accounts LEFT JOIN runtime` |
| 今日关注双源 | 一期以心跳为准 |
| 停自动验收含糊 | 拆分优雅停止 vs 粗暴停止 |
| ≤60s vs 在线 90s | 成功标准写明：可见性 ≠ presence |

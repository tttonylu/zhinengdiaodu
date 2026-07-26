# 智能调度中心 v3.0 接口契约

> 版本：v3.0.0 · 2026-07-26
> 涵盖：号池 `x-pool-service` + 运营后台 `x-ops-console` + 插件 `unified-scheduler`
> 原则：**只新增不改既有接口**（避免破坏 test-env 沙箱）

---

## 0. 调用约定

- 后端默认端口：号池 `192.168.0.100:15678` / 运营后台 `192.168.0.100:15680`（v3.0 抽到 config）
- 客户端 `fetch` 超时 `5000ms`（v3.0 改：3 次指数退避重试 [2s, 4s, 8s]，仍失败返回 `ok:false, error`）
- 所有响应 JSON 格式：`{ ok: boolean, ...其它字段, error?: string }`
- 插件内调用流：`content_script → chrome.runtime.sendMessage(action, payload) → background.js fetch → 后端`
- 命名约定：插件 → 背景 action 使用 `snake_case`；后端路径 `/api/...` / `/pool/...`

---

## 一、号池 `x-pool-service` 既有接口（保留）

| Method | Path | 用途 |
|---|---|---|
| GET | `/health` | 服务健康检查 |
| GET | `/pool/pop?worker_id=xxx` | 领号（保留向后兼容） |
| POST | `/pool/push` body `{handle, source}` | 推单个博主入池 |
| POST | `/pool/push_batch` body `{handles:[]}` | 批量推博主入池 |
| POST | `/pool/done` body `{id}` | 标记任务完成 |
| POST | `/pool/fail` body `{id}` | 标记任务失败（释放重领） |
| POST | `/pool/dead` body `{id}` | 标记号死 |
| POST | `/pool/dead_by_handle` body `{handle}` | 按 handle 标记号死 |
| GET | `/pool/status` | 池状态 |

### v3.0 新增（M0）

#### POST /pool/lease
> 领任务并取得续约锁 token（替代 `/pool/pop` 的新协议；`/pool/pop` 保留向后兼容）

**Request**
```json
{
  "worker_id": "@handle#guard",
  "worker_meta": {
    "hostname": "WS-01",
    "ip_tail": "100",
    "profile": "P03",
    "client_version": "3.0.0"
  }
}
```

**Response 200**
```json
{
  "ok": true,
  "task_id": 12345,
  "handle": "target_user",
  "lease_token": "<uuid>",
  "lease_ttl_sec": 60,
  "assigned_at": 1780000000000
}
```

**错误码**
- `ok:false, error:"pool_empty"` 池空
- `ok:false, error:"worker_locked"` worker 已持有任务
- `ok:false, error:"worker_not_registered"` worker 未注册（需先 `POST /api/workers/register`）

#### POST /pool/heartbeat
> worker 每 60s 续约一次 + 上报状态便于看板

**Request**
```json
{
  "worker_id": "@handle#guard",
  "task_id": 12345,
  "lease_token": "<uuid>",
  "engine": "follow",
  "follow_phase": "active",
  "day_count": 7,
  "followed_today": 34,
  "chat_rounds_today": 1,
  "ts": 1780000060000
}
```

**Response 200**
```json
{ "ok": true, "lease_expired": false, "renewed_until": 1780000120000 }
```

**错误码**
- `ok:false, error:"lease_expired"` → 客户端必须立即 `pool/lease` 重领（任务已自动重分配）
- `ok:false, error:"worker_unknown"` → 注册表失效，需 `POST /api/workers/register`

#### GET /pool/workers
> ops-console 看板拉全部 worker 状态

**Response 200**
```json
{
  "ok": true,
  "workers": [
    {
      "worker_id": "@alice#guard",
      "hostname": "WS-01", "ip_tail": "100", "profile": "P03",
      "engine": "follow", "task_id": 12345,
      "lease_expires_at": 1780000120000,
      "last_heartbeat_at": 1780000060000,
      "alive": true,
      "day_count": 7, "followed_today": 34, "chat_rounds_today": 1
    }
  ]
}
```

#### POST /pool/workers/register
> worker 启动时注册（一次性）

**Request** `{ worker_id, hostname, ip_tail, profile, client_version }`
**Response** `{ ok:true, registered:true }`

---

## 二、运营后台 `x-ops-console` 既有接口（保留）

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/links` | 取推广链接池 |
| POST | `/api/links` body `{links:[]}` | 保存推广链接池 |
| GET | `/api/scripts/pool` | 取话术池 |
| POST | `/api/plugin/log` body `{bot_id,target,action_type,detail,message}` | 上报业务日志 |
| POST | `/api/plugin/activity/report` body `{...}` | 上报活动事件 |
| POST | `/api/plugin/activity/check` body `{...}` | 校验活动 |
| POST | `/api/plugin/account/register` body `{bot_id}` | 注册账号（首次） |
| POST | `/api/plugin/dm/record` body `{bot_id,target_handle,round_number,message_content,result}` | 私信发送记录 |
| GET | `/api/plugin/dm/rounds/{handle}` | 查 handle 已发轮次 |
| POST | `/api/plugin/dm/check` body `{...}` | 私信前置校验 |
| POST | `/api/plugin/dm/next` body `{...}` | 领下一个私信目标 |
| POST | `/api/plugin/dm/result` body `{...}` | 上报私信结果 |

### v3.0 新增（M0 / M1）

#### POST /api/plugin/audit  ★（M0 数据底座核心）
> 插件上报全量审计事件（异步批量，失败本地入队）

**Request body（单条）**
```json
{
  "bot_id": "@alice#guard",
  "ts": 1780000000000,
  "event_type": "dm_negative_feedback",
  "target": "@bob",
  "severity": "warn",
  "detail": {
    "reason": "blocked_by_user",
    "round": 2,
    "script_id": "v3",
    "ip_tail": "100",
    "day_count": 5
  }
}
```

**支持的 event_type 枚举（v3.0 初版）**
- `pool_lease` / `pool_done` / `pool_fail` / `pool_dead`
- `follow_start` / `follow_batch_end` / `follow_soft_risk` / `follow_hard_risk`
- `nurture_daily_exhausted` / `nurture_action`
- `dm_round_sent` / `dm_link_click` / `dm_negative_feedback`（**C6 核心**）
- `engine_stall_recovered` / `network_retry` / `page_drift_fixed`
- `account_dead`（带死亡快照 detail）

**批量上报（推荐）**
```
POST /api/plugin/audit/batch
body: { events: [<同上对象>] }
resp: { ok:true, accepted: N, rejected: 0 }
```

**Response** `{ ok:true }` 或批量 `{ ok:true, accepted:N, rejected:M, errors:[...] }`

#### GET /api/plugin/audit
> 看板追溯查询

**Query**
- `bot_id` 过滤
- `event_type` 过滤
- `from` / `to`（毫秒时间戳）
- `limit`（默认 100，上限 1000）

**Response**
```json
{
  "ok": true,
  "total": 234,
  "events": [ {同 POST body 对象} ]
}
```

#### GET /api/nurture/comments  ★ B6
> 取评论模板库

**Response**
```json
{
  "ok": true,
  "version": "2026-07-26-001",
  "updated_at": 1780000000000,
  "categories": [
    {
      "id": "food",
      "name": "美食",
      "templates": ["美味しそう🍽️", "これ食べたい！"]
    },
    { "id": "cute", "name": "可爱", "templates": ["可愛いすぎる😍"] }
  ]
}
```

#### POST /api/nurture/comments
> 增改模板（管理员）

**Request**
```json
{
  "category_id": "food",
  "action": "upsert" | "delete",
  "templates": ["美味しそう🍽️", "新加的评论 🆕"]
}
```

**Response** `{ ok:true, version:"2026-07-26-002" }`

#### GET /api/dashboard/workers  ★ 看板
> 一屏看全部 worker 状态（聚合自 worker 注册表 + heartbeat + audit）

**Response**
```json
{
  "ok": true,
  "workers": [
    {
      "worker_id": "@alice#guard",
      "hostname": "WS-01", "ip_tail": "100", "profile": "P03",
      "alive": true,
      "engine": "follow", "day_count": 7,
      "followed_today": 34, "chat_rounds_today": 1,
      "last_heartbeat_at": 1780000060000,
      "dead_this_week": 0, "negative_feedback_7d": 2
    }
  ],
  "summary": {
    "total_workers": 25,
    "alive_workers": 23,
    "dead_today": 1,
    "total_followed_today": 168,
    "total_chat_rounds_today": 12
  }
}
```

#### GET /api/dashboard/account-pnl  ★ 单号损益表
> 单号级损益查询（24h / 7d / 30d）

**Query** `?bot_id=&range=24h`

**Response**
```json
{
  "ok": true,
  "rows": [
    {
      "bot_id": "@alice#guard",
      "account_age_days": 12,
      "day_count": 7,
      "followed_24h": 34, "followed_7d": 198,
      "dm_sent_24h": 4, "dm_replies_24h": 2,
      "line_clicks_24h": 1,
      "negative_feedback_24h": 0,
      "alive": true,
      "dead_at": null,
      "death_snapshot": null
    },
    {
      "bot_id": "@bob#guard",
      "alive": false,
      "dead_at": 1780000060000,
      "death_snapshot": {
        "ip_tail": "100", "hostname": "WS-01", "profile": "P03",
        "followed_last_24h": 89,
        "script_id_last": "v3",
        "trigger_event": "follow_hard_risk",
        "trigger_at": 1780000059000
      }
    }
  ]
}
```

#### POST /api/config/overrides  ★ 阈值后台热改
> 改 matrix_config_overrides（插件 chrome.storage 拉取源）

**Request**
```json
{
  "path": "limits.followLimit",
  "value": 180
}
```

**Response** `{ ok:true, applied_at: 1780000060000 }`

**生效路径**：后端写 ops DB → ops `/api/config/overrides` 还要靠 chrome.storage 同步给插件。
>v3.0 实现选项：插件继续从 chrome.storage.matrix_config_overrides 读，ops-console 后台页面通过 background 长连接推送（action: `sg_config_override_push`）。
>v3.0 简化版：插件 30s 拉 `/api/config/overrides` 拉取最新。

---

## 三、插件 → 背景 action 命名空间（chrome.runtime.sendMessage）

### 既有（保留）
| action | 方向 | 用途 |
|---|---|---|
| `pool_pop` / `pool_push` / `pool_push_batch` / `pool_done` / `pool_fail` / `pool_dead` / `pool_dead_by_handle` | CS→BG | 号池操作 |
| `pool_status` / `pool_health` | CS→BG | 状态 |
| `pool_links` / `pool_links_save` | CS→BG | 链接池 |
| `scripts_pool` / `fetch_script_pool` | CS→BG | 话术池 |
| `log_action` / `report_log` / `chat_log_action` | CS→BG | 日志上报 |
| `ops_activity_report` / `ops_activity_check` / `report_followed` | CS→BG | 活动上报 |
| `ops_account_register` / `ops_dm_record` / `ops_dm_rounds` / `ops_dm_check` / `ops_dm_next` / `ops_dm_result` | CS→BG | DM |
| `set_my_handle` / `get_my_handle` / `ping` | CS→BG | 元信息 |
| `send_report` | CS→BG | 心跳状态 |
| `sg_scheduler_start` / `sg_scheduler_pause` / `sg_scheduler_status` | UI→BG→CS | 调度控制 |
| `sg_manual_follow` / `sg_manual_chat` / `sg_manual_nurture` | UI→BG→CS | 手动启 |
| `sg_nurture_only` / `sg_nurture_throttled` / `sg_test_chat_first` | CS↔BG | 养号/调试 |

### v3.0 新增
| action | 方向 | 用途 |
|---|---|---|
| `pool_lease` | CS→BG | 领任务+续约锁 token（替代 pool_pop 的新协议） |
| `pool_heartbeat` | CS→BG→server | 续约 + 状态上报 |
| `pool_workers_register` | CS→BG→server | worker 启动一次注册 |
| `report_audit` | CS→BG→server | 单条 audit 上报 |
| `report_audit_batch` | CS→BG→server | 批量 audit 上报 |
| `fetch_remote_comments` | CS→BG→server | 拉远端评论模板 |
| `fetch_remote_config_overrides` | CS→BG→server | 拉远端阈值覆盖 |

---

## 四、单号损益表所需字段（数据底座口径）

> 这是 v3.0 的核心 KPI 口径，所有审计事件须按下表对齐字段。

| 字段 | 来源 | 用途 |
|---|---|---|
| `bot_id` | id_extractor (`@handle#guard`) | 行主键 |
| `account_age_days` | account/register API | 账号天数 |
| `day_count` | sessionStorage.matrix_stats | 养号天数 |
| `followed_24h` / `_7d` | audit `follow_batch_end` 累计 | 关注量 |
| `dm_sent_24h` / `_7d` | audit `dm_round_sent` 累计 | 私信量 |
| `dm_replies_24h` | audit `dm_negative_feedback` 反推 + ck | 回复量 |
| `line_clicks_24h` | ops-console `/api/links` 点击 | 转化量 |
| `negative_feedback_24h` / `_7d` | audit `dm_negative_feedback` | 拉冷事件计数 |
| `alive` | heartbeat TTL > now | 存活灯 |
| `dead_at` | audit `account_dead` | 死亡时间 |
| `death_snapshot` | audit `account_dead.detail` | 死亡快照（IP/hostname/profile/最后 24h 动作/最后话术） |

**死亡快照 detail 字段（C6 关键）：**
```json
{
  "ip_tail": "100", "hostname": "WS-01", "profile": "P03",
  "followed_last_24h": 89,
  "dm_sent_last_24h": 12,
  "script_id_last": "v3",
  "script_id_distribution_7d": {"v3": 5, "v1": 3},
  "trigger_event": "follow_hard_risk",
  "trigger_at": 1780000059000,
  "engine_state_at_death": "follow/active"
}
```

---

## 五、向后兼容

- v3.0 plugin 仍支持 `pool_pop`（保留对照），但优先走 `pool/lease`
- 通过 `MatrixConfig.use_lease = true|false` 切换
- 既有 storage 键全保留，不重排 SKeys
- audit 上报失败本地入 `sg_audit_queue`，下次启动重发

---

## 六、错误码统一表

| 码 | 含义 | 是否需要重试 |
|---|---|---|
| `pool_empty` | 号池无任务 | 否，30s 后再领 |
| `worker_locked` | worker 已持任务 | 否 |
| `worker_not_registered` | 注册表无此 worker | 是，需 register |
| `lease_expired` | 续约过期 | 是，立即重 lease |
| `worker_unknown` | 注册表失效 | 是，重新 register |
| `rate_limited` | 风控冷却 | 否，按冷却时间 |
| `validation_error` | 请求体非法 | 否，需开发修 |
| `server_error` | 5xx | 是，指数退避 |

---

## 七、引用

- 需求详见 `REQUIREMENTS.md`
- 架构详见 `ARCHITECTURE.md`
- 路线详见 `ROADMAP.md`
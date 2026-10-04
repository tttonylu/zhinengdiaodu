# 智能调度中心 · 接口契约

> 版本：v3.0.2 · 修订 2026-07-29  
> 号池 `x-pool-service` + 运营 `x-ops-console` + 插件 `unified-scheduler`

---

## 0. 约定

- 号池：`http://192.168.0.100:15678`
- OPS：`http://192.168.0.100:15680`
- 超时：约 5000ms
- 响应：`{ ok: boolean, ... }`
- 调用链：`content_script → chrome.runtime.sendMessage → background.js → fetch`

---

## 一、号池（现行）

| Method | Path | 用途 |
|---|---|---|
| GET | `/health` | 健康检查 |
| GET | `/pool/pop?worker_id=xxx` | 领号 |
| POST | `/pool/push` | 推单个博主 |
| POST | `/pool/push_batch` | 批量推 |
| POST | `/pool/done` | 任务完成 |
| POST | `/pool/fail` | 失败释放回 pending |
| POST | `/pool/dead` | 死号 |
| POST | `/pool/dead_by_handle` | 按 handle 死号 |
| GET | `/pool/status` | 池状态 |

---

## 二、运营后台（现行）

### 配置与内容（矩阵主控）

| Method | Path | 插件 action | 写入 |
|---|---|---|---|
| GET | `/api/config/all` | `fetch_remote_config` | `sg_config_*` / `sg_stage_policy` / `sg_module_switches` |
| GET | `/api/nurture/comments` | `fetch_nurture_comments` | `sg_nurture_comments` |
| GET | `/api/scripts/pool` | `scripts_pool` | 私信话术内存 |
| GET/POST | `/api/links` | `pool_links` | 推广链接 |

### `/api/config/all` 响应结构（摘要）

```json
{
  "ok": true,
  "thresholds": {
    "follow_daily_limit": 200,
    "follow_first_day_limit": 80,
    "follow_step_per_day": 40,
    "follow_interval_min_sec": 5,
    "follow_interval_max_sec": 8,
    "nurture_daily_likes": 30,
    "nurture_daily_comments": 10,
    "chat_rounds_per_day": 3,
    "chat_cooldown_hours": 2,
    "media_load_mode": "auto",
    "nav_min_interval_ms": 13000
  },
  "stagePolicy": { "workHours": {}, "chatHours": {}, "stages": {} },
  "modules": { "nurture": true, "follow": true, "chat": true }
}
```

### 业务上报（既有）

| Method | Path | 用途 |
|---|---|---|
| POST | `/api/plugin/log` | 业务日志 |
| POST | `/api/plugin/account/register` · `/heartbeat` | 账号 |
| POST | `/api/plugin/account/daily-stats` | 日统计 |
| POST | `/api/plugin/activity/report` · `/check` | 活动 |
| POST/GET | `/api/plugin/dm/*` | 私信记录 / 轮次 / next / result |
| POST | `/api/plugin/dm/roster` | 粉丝台账快照（封口上传：汇总 + items[]；失败不挡本地开人；OPS 落库见 [`OPS-DM-ROSTER.md`](OPS-DM-ROSTER.md)） |
| GET | `/api/plugin/dm/roster/:bot` | （OPS 侧）按 bot 抓取台账副本；本仓插件不强制轮询 |
| POST | `/api/accounts/:id/reset-dm` | 重置该号 OPS 私信进度（`dm_records`+leads 阶段）；body 可选 `wipe_plugin` 下发 `reset_chat_local` |
| POST | `/api/accounts/batch-reset-dm` | 批量同上；body `{ ids, wipe_plugin? }` |

远程指令白名单（claim）：`start` · `pause` · `reset_profile_media` · `reset_follow_daily_limit` · `reset_chat_local` · `clear_dead_handles`。

`reset_follow_daily_limit`（≥4.3.30）：清零本地 `follows_today`、按 DayN 立刻重抽 `daily_limit`、清 `followNextDelayUntil` / `quota_exhausted`；写 `follows_reset_day` 挡住同日 OPS `today_follow_count` 回灌。

---

## 三、插件 → background action

| action | 后端 |
|---|---|
| `pool_*` | 号池 |
| `fetch_remote_config` | `/api/config/all` |
| `fetch_nurture_comments` | `/api/nurture/comments` |
| `scripts_pool` | `/api/scripts/pool` |
| `pool_links` | `/api/links` |
| `log_action` / `report_daily_stats` | OPS 插件 API |
| `ops_account_*` / `ops_dm_*` | OPS 插件 API |
| `sg_scheduler_*` / `sg_manual_*` | 页内调度（不经过 HTTP） |
| `send_report` | **仅写 chrome.storage**（未打 OPS） |

---

## 四、错误与重试

| 场景 | 处理 |
|---|---|
| `pool_empty` | 调度冷却后再领 |
| 网络失败 | config-sync 用本地缓存兜底 |
| 5xx | 退避重试 |

---

## 五、引用

- `ARCHITECTURE.md` §3 配置流
- `REQUIREMENTS.md` · `ROADMAP.md` · `RUNTIME.md`

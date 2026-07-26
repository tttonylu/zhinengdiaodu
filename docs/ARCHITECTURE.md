# 智能调度中心 v3.0 架构

> 版本：v3.0.0 · 2026-07-26
> 主线：**自动化稳定性 / 规模化管理 / 模块化方便改**
> 当前形态：Chrome MV3 扩展 + 双后端（号池 / 运营后台）

---

## 1. 目标 monorepo 结构

```
D:\下载\智能调度\                    (根仓，git master 现未提交，立志 v3.0 归零提交)
├─ services\
│  ├─ x-pool-service\               (号池 + 任务劤 + worker 注册表)
│  └─ x-ops-console\               (阈值/模板/看板 + audit_logs + DM 战报)
├─ extension\
│  └─ unified-scheduler\            (MV3 插件，17 文件保留)
├─ docs\
│  ├─ REQUIREMENTS.md
│  ├─ ARCHITECTURE.md               (本文)
│  ├─ API_CONTRACT.md
│  └─ ROADMAP.md
├─ package.json                     (workspace)
└─ README.md
```

**迁移路径（M2）：**
- `号池\x-pool-service` → 删（与 test-env 副本合拼后归 git）
- `test-env\x-pool-service` → 副本入 `services\x-pool-service`
- `test-env\x-ops-console` → 副本入 `services\x-ops-console`
- `号池\x-ops-console` → 副本（如有）合并
- `DAN\x-ops-console` → 副本（migrations ≤ 003，作为旧版参考不入）
- `unified-scheduler/` → 入 `extension/unified-scheduler/`
- `DAN/` → 保留作为历史 stub，不参与构建

---

## 2. 现状代码逐文件（17 文件，按域分组）

| 层 | 文件 | 职责 | 关键依赖 / 存储 / 接口 |
|---|---|---|---|
| 背景 | `background.js` | SW 转发号池/运营/调度命令 | POOL/OPS_SERVER 硬编码；_alarm keepalive 0.083min |
| 调度 | `scheduler-core.js` | V5 状态机；tick 10s + watchdog 30s；跨页 prev 三字段 | SKeys；ops_account_register；pool_pop |
| 公共 | `shared/config.js` | MatrixConfig 单一权威 + chrome.storage.matrix_config_overrides 覆盖 | antiBan.limits=[0,50,100,150,200] |
| 公共 | `shared/storage-keys.js` | SKeys 唯一键名字典 | LK_*/SK_*/CK_* 前缀 |
| 公共 | `shared/logger.js` | 三路日志 (local/console/server 上送 warn/error) | matrix_my_handle (依赖 id_extractor) |
| 公共 | `shared/id_extractor.js` | 4 策略提 handle + bit_id | localStorage.matrix_my_handle/bit_id |
| 公共 | `shared/engine-utils.js` | 可取消 timer + 90s watchdog | sessionStorage.sg_*_running |
| 公共 | `shared/ui_console.js` | 拦截 console 展示引擎状态 | matrix_console_status |
| 关注 | `follow/content_follow_v1522.js` | 主关注引擎：领号/批次/阶梯/死号/恢复 | pool_pop/fail/done/report_followed；matrix_active_tab (2s) |
| 关注 | `follow/push_blogger.js` | 注入"推号池"按钮 + 批量队列 | pool_push/pool_push_batch；MatrixRisk tryAcquire("push") |
| 关注 | `follow/risk_control.js` | 令牌桶 follow/chat/push + 冷却 + 指数退避 [60,120,240,600] | localStorage.matrix_global_cooldown_until |
| 私信 | `chat/content_chat.js` | V16.6 三轮状态机 + DNA + 链接/话术同步 + 战报重发 | dan_promo_links (5min)；/api/links；/api/scripts/pool |
| 养号 | `nurture/nurture-config.js` | NurtureConfig 全局默认 + sg_nurture_settings 覆盖 | MatrixConfig.nurture |
| 养号 | `nurture/nurture-tracker.js` | 三层预算 (日/时/15min) + 点赞 3min 节流 | resetDaily/Hourly/Segment |
| 养号 | `nurture/nurture-comments.js` | 9 大类日文评论模板 + 智能匹配 | 硬编码 BANK；v3.0 上移 ops-console |
| 养号 | `nurture/nurture-engine.js` | V3.0.0 主循环 + 广告跳过 + 配额耗尽上送 | EngineUtils；sg_nurture_throttled |
| UI | `ui/panel.js` + `panel.css` | 右上面板渲染 + 5 按钮 | sg-scheduler-tick；sg_scheduler_status |
| UI | `ui/follow-btn.js` | 独立圆形悬浮起停按钮 | sg_scheduler_start/pause |

---

## 3. 三层架构图（围绕三大主线）

```
┌─────────────────────────────────────────────────────────────────────┐
│              monorepo D:\下载\智能调度                                │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  services/x-pool-service (号池)                              │  │
│  │  现有: pool/pop|push|done|fail|dead|status|health              │  │
│  │  v3.0 新增: pool/lease|heartbeat + pool/workers (注册表+锁)   │  │
│  └──────────────────┬──────────────────────────────────────────────┘  │
│                     │                                              │
│  ┌──────────────────┴─────────────────────────────────────────────┐ │
│  │  services/x-ops-console (运营后台)                              │ │
│  │  现有: api/links api/scripts/pool api/plugin/log               │ │
│  │       api/plugin/activity|dm|account 可视化阈值/话术           │ │
│  │  v3.0 新增: api/nurture/comments (B6 评论库 CRUD)               │ │
│  │            api/plugin/audit (C5 全量审计)                       │ │
│  │            api/dashboard/workers (P0 worker 看板)              │ │
│  │            api/dashboard/account-pnl (P0 单号损益)            │ │
│  └────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │ chrome.runtime.sendMessage (SW)
┌─────────────────────────────────────────────────────────────────────┐
│  extension/unified-scheduler (MV3)                                  │
│  ┌─── Service Worker: background.js ─────────────────────────────┐ │
│  │ v3.0: AbortSignal.timeout 抽到 config + 加指数退避重试 (D7)    │ │
│  │ v3.0: 新增 report_audit action → POST /api/plugin/audit        │ │
│  └───────────────────────────────┬─────────────────────────────────┘ │
│                                  │                                   │
│  ┌─── shared (公共层) ───────────┴─────────────────────────────────┐ │
│  │ config.js — 阈值统一来源 + chrome.storage.matrix_config_overrides│ │
│  │ storage-keys.js — SKeys 集中键名                                │ │
│  │ logger.js — warn/error 上送                                    │ │
│  │ id_extractor.js — handle 提取 + bit_id                          │ │
│  │ engine-utils.js — 可取消 timer + watchdog                       │ │
│  │ ui_console.js — 拦 console (已)                                 │ │
│  └───────────────────────────────┬─────────────────────────────────┘ │
│                                  │                                   │
│  ┌─── scheduler-core.js (调度核心 V5，保留无大改) ────┐            │ │
│  │ engine: idle → follow → nurture → chat → nurture_only           │ │
│  │ v3.0 补 D6 卡死自愈补丁 (已有 3-tick 触发 180s 冷却，加场景化)  │ │
│  └───────────────────────────────┬──────────────────────────────────┘ │
│                                  │ 事件: sg-scheduler-tick/sg-nurture-command
│        ┌─────────────────────────┼─────────────────────────┐          │
│  ┌─────┴───────┐         ┌──────┴──────┐         ┌───────┴──────┐   │
│  │ follow/     │         │ chat/       │         │ nurture/     │   │
│  │ content_    │         │ content_    │         │ nurture-      │   │
│  │ follow_     │         │ chat.js     │         │ engine.js     │   │
│  │ v1522.js    │         │ v3.0 加 C6  │         │ v3.0 改 B6    │   │
│  │             │         │ 消极反馈识别│         │ 从 API 拉模板 │   │
│  ├── push_     │         │ + 拉冷写audit│         │ + 本地 fallback│ │
│  │ blogger.js  │         └─────────────┘         ├──────────────┤   │
│  ├── risk_     │                                  │ nurture-      │   │
│  │ control.js  │                                  │ config/tracker/│  │
│  │ MatrixRisk  │                                  │ comments (改造)│  │
│  └─────────────┘                                  └──────────────┘   │
│  ┌──── ui/ ────────────────────────────────────────────────────┐   │
│  │ panel.js (右上面板，P0 同步 worker 看板数据)                  │   │
│  │ follow-btn.js (圆形按钮，起停调度)                            │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 4. 三层数据流

### 4.1 身份链
```
id_extractor.js → localStorage.matrix_my_handle / bit_id
              → chrome.runtime.sendMessage({action:"set_my_handle"})
              → background.js → chrome.storage.local
              → 被 logger / follow / chat 引用作 bot_id / worker_id
              → ops-console /api/plugin/account/register / dm/* 据此索引
```

### 4.2 配置链
```
shared/config.js MatrixConfig (默认)
  ← chrome.storage.local.matrix_config_overrides (管理员后台写)
  ← 各模块 getConfigValue(path) 实时读

nurture-config.js 在 MatrixConfig.nurture 之上叠 sg_nurture_settings (用户级)
v3.0: 阈值/活跃时段/预算都将通过 ops-console 写 matrix_config_overrides
```

### 4.3 风控链
```
risk_control.js MatrixRisk 三类令牌桶 (follow/chat/push)
  → push_blogger.js tryAcquire("push") 限流推号
  → follow 引擎 matrix_global_cooldown_until 共享冷却
  → 退避梯度 [60s,120s,240s,600s]，jitter 0.25
v3.0: 任务锁 + worker 续约锁补充跨机维度
```

### 4.4 任务流转
```
现有:
  pool_pop → current_blogger → 跳风扇页 → BatchManager 批量关注
  → pool_done / pool_fail → 阶梯限额 + 风控冷却 + 备份恢复

v3.0 加锁:
  pool/lease → 返回 task_id + lease_token (续约凭证)
  pool/heartbeat → 每 60s 续约，过期任务重新分配
  pool/workers → ops-console 拉全部 worker 状态灯
```

### 4.5 养号旁路
```
配额满 / Day 0 / nurture-lock 开 → matrix_pure_nurture_mode 写入
  → 跳回 home 页 → engine-utils.isActive('nurture')
  → nurture-engine.js tick 循环按权重随机
  → 每日预算耗尽 → sg_nurture_throttled 上报 background
v3.0: 评论模板从 /api/nurture/comments 拉，本地兜底
```

### 4.6 私信消极反馈链（v3.0 新增）
```
content_chat.js 三轮状态机 (icebreaker → ad{LINK} → kick)
  → 监听回复 → 识别关键词[拉黑/拒回/被举报] → 拉冷 24h
  → chrome.runtime.sendMessage({action:"report_audit"})
  → background → POST /api/plugin/audit
  → ops-console audit_logs 表 (worker_id, action_type, detail, ts)
  → 看板账号损益行标记"消极反馈"事件
```

### 4.7 状态回流
```
各引擎 → window 自定义事件 (matrix-*-log/status)
  → ui_console.js 捕获聚合 (拦截 console)
  → panel.js 每秒 sg_scheduler_status 拉背景 → 渲染右上面板
  → follow-btn.js 5s 同步 running 状态切色
v3.0: 增加 ops-console 后台 /api/dashboard/workers & /account-pnl
```

---

## 5. v3.0 新增组件

### 5.1 数据底座（M0 优先做）
| 组件 | 位置 | 用途 |
|---|---|---|
| audit_logs 表 | x-ops-console | 单号级损益表底座；全量敏感动作入库 |
| POST /api/plugin/audit | x-ops-console | 插件上报审计事件（异步批量） |
| GET /api/plugin/audit | x-ops-console | 看板追溯查询 |
| background.js report_audit | unified-scheduler | 转发审计 |
| worker 注册表 | x-pool-service | worker_id → 当前状态/在跑任务/心跳 |
| POST /pool/lease + heartbeat | x-pool-service | 领任务 + 60s 续约锁，过期重分配 |

### 5.2 业务模块（M1 并行）
| 组件 | 位置 | 用途 |
|---|---|---|
| GET/POST /api/nurture/comments | x-ops-console | B6 评论模板后台 CRUD |
| nurture-comments.js 改 fetch+fallback | unified-scheduler | 插件从 API 拉，离线兜底 |
| content_chat.js C6 识别块 | unified-scheduler | 监回复关键词 + 拉冷 + report_audit |
| 阈值后台编辑页 | x-ops-console | matrix_config_overrides 写界面 |
| worker 看板 | x-ops-console | 一屏看全部 worker 状态 |
| 单号损益页 | x-ops-console | 24h/7d 滞后追表 |

### 5.3 工程重构（M2，与 M0/M1 解耦可并行）
- monorepo 三仓合并 + 副本清理
- background.js POOL_SERVER/OPS_SERVER/超时 抽到 config.js
- storage-keys.js / config.js / nurture-config.js 继续维持集中化

---

## 6. 关键设计原则

1. **保真保留**：调度 v5 + 三引擎核心逻辑 v3.0 不重写，只在边缘补补丁
2. **数据先于重构**：M0 audit_logs 必须先于 M2 monorepo（启发单号损益的真实需求）
3. **后台可热改**：阈值/模板后台改 → chrome.storage.matrix_config_overrides → 插件 30s 内生效
4. **失败不阻塞**：审计/看板上报失败时本地入队，不影响业务主流程
5. **保单机多 profile**：v3.0 不改单机多 profile 拓扑；IP/设备指纹隔离留 v3.1

---

## 7. 兼容性

- MV3 限制保留：service worker 短生命周期，靠 alarm 5/0.083min 保活
- chrome.storage 与 localStorage/sessionStorage 三层职责继续分离
- 既有 storage 键全保留（SKeys 已集中化，不重排）
- 后端契约只新增不改既有接口（避免破坏 test-env 沙箱）

---

## 8. 引用

- 需求详见 `REQUIREMENTS.md`
- 接口契约详见 `API_CONTRACT.md`
- 路线与里程碑详见 `ROADMAP.md`
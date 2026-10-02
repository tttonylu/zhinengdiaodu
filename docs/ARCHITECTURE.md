# 智能调度中心 · 架构

> 版本：v3.7.43 · 修订 2026-10-01  
> **产品目的与全功能逻辑链（必须）：** [`智能调度插件技术指导.md`](智能调度插件技术指导.md)  
> **分板块细则：** [`调度工作手册.md`](调度工作手册.md)  
> **改码白名单：** [`工作指导.md`](工作指导.md)  
> 本文只做分层总览；冲突以技术指导为准。

---

## 1. 目录结构

```
D:\下载\智能调度\
├─ unified-scheduler\          ← Chrome MV3 扩展（唯一现网插件，见该目录 README）
├─ test-env\
│  ├─ x-pool-service\          ← 号池 :15678
│  ├─ x-ops-console\           ← 运营后台 :15680
│  └─ scrm-monitor\            ← SCRM
├─ docs\
└─ _archive\                   ← DAN / 旧号池快照，禁止当源码、禁止加载
```

NAS 部署路径：`/vol2/1000/test`（见本地 `NAS_ACCESS.md`）。

---

## 2. 扩展内分层

```
background.js              SW：HTTP 转发（号池 + OPS）
        ▲
config-sync.js             拉 /api/config/all → localStorage
remote-settings.js         统一读远程阈值
        ▲
scheduler-core.js          ★ 唯一调度大脑（coTick @10s）
        │  sg-*-command
   ┌────┼────┐
follow  chat  nurture
   │      │
   soft-risk / pool-api
   age-parse / target-db / promo-links / chat-gates / dm-pin / inbox-watch
   └────┴────┘
scheduler-gate.js          自动模式门禁（禁自启 / 禁未授权跳页）
stage-detector.js          S0–S4
page-router.js             URL 归属
shared/* · ui/*
```

**注意：** `scheduler/coordinator.js` 已废弃加载，调度逻辑全在 `scheduler-core.js`。

---

## 3. 数据流

### 3.1 配置（后台 → 插件）

```
OPS GET /api/config/all
  → background fetch_remote_config
  → config-sync 写入:
       sg_config_thresholds
       sg_config_intervals
       sg_stage_policy
       sg_module_switches
       sg_nurture_remote_cfg
       matrix_console_settings (镜像)
  → RemoteSettings / NurtureConfig / getLimit / getFollowInterval 消费
```

周期：1 分钟；页面加载时立即拉一次。

### 3.2 号池任务

```
pool_pop → 关注扫描 → pool_done | pool_dead
切换博主：pool_done（非 pool_fail，避免半成品回流）
有未完成任务：startFollow 只恢复，不重复 pop
```

### 3.3 调度状态

| 存储 | 作用 |
|---|---|
| `localStorage sg_state` | 自动模式、冷却、私信轮次等（跨刷新） |
| `sessionStorage sg_module_*` | 模块 running/phase（同 tab） |
| `sg_stage_policy` | S0–S4 时段与 priority（OPS 下发） |

---

## 4. 后端服务

| 服务 | 端口 | 职责 |
|---|---|---|
| x-pool-service | 15678 | 博主队列 pop/push/done/fail/dead |
| x-ops-console | 15680 | 配置、话术、链接、账号、私信、日志 |

插件 `background.js` 当前写死 `192.168.0.100`；矩阵下一阶段改为可配置。

---

## 5. 设计原则

1. **调度正确性优先** — 先稳再扩机  
2. **后台配置驱动** — 远程优先，本地兜底  
3. **引擎保真** — 只改交接边界  
4. **号池保持简单** — 不加 lease / 注册表  
5. **文档跟代码** — 以本目录 docs 为准

---

## 6. 引用

- `REQUIREMENTS.md` · `API_CONTRACT.md` · `ROADMAP.md` · `RUNTIME.md`

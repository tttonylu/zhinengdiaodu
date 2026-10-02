# 智能调度中心 · 运行时契约

> 版本：v3.0.2 · 修订 2026-10-01  
> 实现：`scheduler-core.js` 内置 `coTick`（**勿加载** `coordinator.js`）  
> **业务规则 / 逻辑链 / 少跳页：勿以本文为准** → 读 [`智能调度插件技术指导.md`](智能调度插件技术指导.md) 链 ID + [`调度工作手册.md`](调度工作手册.md) 子 ID。本文只约束模块启停与 `sg_module_*` 契约。

---

## 1. 目标

| 问题 | 要求 |
|---|---|
| A 假死 | 引擎结束 → 释放 `sg_module_*` → 调度可轮转 |
| B 互抢 | 自动模式仅调度启停；`scheduler-gate.js` 禁自启/未授权跳页 |
| C 接不上 | 刷新/软导航 → `coRehydrateEngines` 或按 stage resume |

---

## 2. 原则

1. 调度只做 start/stop，不重写引擎内核  
2. 自动模式：`sg_state.running === true` 时引擎不得私自 `tryAutoStart` / `recover`  
3. `sg_module_*.running` 必须与真循环一致  
4. `sg-*-command` 必须驱动真启停  
5. 远程配置（OPS）优先于本地面板  

---

## 3. 模块状态 `sg_module_{name}`

```javascript
{
  running: boolean,
  phase: 'starting' | 'active' | 'completed' | 'pool_empty'
        | 'quota_exhausted' | 'warmup' | 'idle' | string,
  targetUrl: string,
  startedAt: number,
  lastActive: number
}
```

| 事件 | 调度行为 |
|---|---|
| `pool_empty` / `completed` / `quota_exhausted` | `coStop` + 冷却 + 轮转 |
| 幽灵 running（旗标在、引擎死） | 一 tick 内清除并允许轮转 |
| 心跳 >90s 无真实活动 | 强制 stop |

---

## 4. 阶段 S0–S4

| Stage | 条件（摘要） | priority |
|---|---|---|
| S0 | 非工作时段（默认 08:00–22:00 外，北京时间） | `[]` |
| S1 | Day≤2 | `['follow','nurture']`（首日/次日额度） |
| S2 | Day≥3 非私信时段 | `['follow','nurture']` |
| S3 | Day≥3 私信时段（默认 08:30–18:00） | `['follow','chat','nurture']` |
| S4 | 已停用 | — |

配额满：从 priority 去掉 `follow`，Day≥3 私信时段仍可 `chat+nurture`。  
S4 私信独占已取消；私信时长由调度 `coMaxRun.chat`≈30min 约束。

阈值来自 `sg_stage_policy`（OPS `/api/config/all` 下发）。

---

## 5. coTick 流程（摘要）

```
每 ~10s:
  stage, priority = StageDetector.detect()
  if !sg_state.running: return
  if stage == S0: stop all; return

  纠正幽灵 running / terminal phase → coStop

  if 无模块在跑:
    按 priority 找 canRun && 冷却已过 → coStart
    follow: 有未完成任务则恢复，不重复 pool_pop
    chat: 检查 chatRoundsToday < 远程上限

  更新面板
```

---

## 6. 启停契约

| 动作 | 调度 | 引擎 |
|---|---|---|
| start | 写模块态 + `sg-*-command` start | 已在目标页 → 开循环；否则跳页后 resume |
| stop | `sg-*-command` stop + `running=false` | 停循环、清 timer、单飞锁失效 |

---

## 7. 刷新 / 软导航

| 场景 | 行为 |
|---|---|
| hard reload / 首次启动 | `coPrepareFreshRun` |
| 同 tab 软导航（SPA） | `coRehydrateEngines`：补活循环，**不改 URL** |
| `sg_state.running !== true` | 不强制开跑 |
| 暂停后刷新 | 保持暂停 |

---

## 8. 配置热更新

`config-sync.js` 每分钟拉 OPS → 写入 `sg_config_*`。  
引擎读 `RemoteSettings`；养号读 `NurtureConfig`（监听 `sg-config-synced` 事件刷新）。

---

## 9. 代码地图

| 文件 | 职责 |
|---|---|
| `scheduler-core.js` | coTick、coStart/coStop、resume、补活 |
| `shared/scheduler-gate.js` | 自动模式门禁 |
| `shared/config-sync.js` | 远程配置同步 |
| `shared/remote-settings.js` | 阈值读取 |
| `scheduler/stage-detector.js` | S0–S4 |
| `scheduler/page-router.js` | 跳页 |
| `follow/content_follow_v1522.js` | 关注 + 内置 warmup |
| `nurture/nurture-engine.js` | 独立养号 |
| `chat/content_chat.js` | 私信 |

follow 内置 warmup 与 NurtureEngine：自动模式下由调度轮转，不应双养号抢 `/home`。

---

## 10. 诊断

```javascript
await __sgDiag()   // 或 __matrix_console__.diag()
```

关注：`stage`、`schedulerRunning`、各模块 `running` / `engineAlive`、冷却、`currentCreator`。

---

## 11. 引用

- `ROADMAP.md` · `ARCHITECTURE.md` · `API_CONTRACT.md`

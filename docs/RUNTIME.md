# 智能调度中心 v3.0 三模块运行逻辑

> 版本：v3.0.0 · 2026-07-26
> 主线：**自动化稳定性 / 规模化管理 / 模块化方便改**
> 范围：本文定义同一账号（worker）在**单一浏览器页面**内，三模块（养号 / 关注 / 私信）的并发模型、阶段切换、页面支配与时间片轮转规则。
> 替代关系：本文件取代 `scheduler-core.js` V5 当前以 `S.engine` 单字段互斥的运行模型。

---

## 1. 设计原则

1. **三模块彻底解耦** — 每模块独立 lifecycle（start/stop/pause/resume/tick）、独立 tick 循环、独立 state 快照，互不直接调用。
2. **废除单字段互斥** — 不再用 `S.engine = follow|nurture|chat|nurture_only` 作为唯一排他字段；改为 Coordinator 按"阶段优先级 + 页面支配"轮转。
3. **同一时刻只有一个模块占用页面 DOM** — 三模块可同页并发 tick，但同一账号只有一个 URL，页面支配权归 Coordinator 仲裁。
4. **养号是基础，关注在养号之上，私信最重要** — 优先级按阶段动态变化，不固定。
5. **跨页 prev 快照升级** — 从 V5 的 3 字段（followActive/nurturing/chatRunning）升级为"每模块自带快照"。
6. **Stage Policy 后台可改** — 阶段阈值、优先级顺序、独占上限都从后台 `stage_policy` 写入，5 分钟同步到插件。
7. **V5 兼容保留** — 阶梯防封、风控令牌桶、备份恢复、私信轮次日界等机制保真保留（详见第 9 节迁移矩阵）。

---

## 2. 代码模块边界

### 2.1 目录结构（v3.0 目标）

```
unified-scheduler/
├─ scheduler/                       (新增调度层，替代 scheduler-core.js 主循环)
│  ├─ coordinator.js                 阶段判定 + 时间片轮转 + 模块 tick 分发
│  ├─ stage-detector.js               Day/时段/配额/退避 → S0-S4 + 读后台 stage_policy
│  └─ page-router.js                  URL 支配裁决 + 跳页执行（统一收口）
├─ follow/
│  ├─ content_follow_v1522.js        改：暴露 lifecycle，移除自调 window.location
│  ├─ push_blogger.js                 保留
│  └─ risk_control.js                 保留
├─ chat/
│  └─ content_chat.js                 改：暴露 lifecycle，补 C6 消极反馈识别
├─ nurture/
│  ├─ nurture-engine.js              改：暴露 lifecycle，跑独立 home/trends tick，不被 follow warmup 内嵌
│  ├─ nurture-config.js              保留
│  ├─ nurture-tracker.js             保留
│  └─ nurture-comments.js            改：v3.0 改 API 拉 + 本地兜底
├─ shared/                           公共层保留（config/storage-keys/logger/id_extractor/engine-utils/ui_console）
├─ ui/
│  ├─ panel.js                        改：新增"当前 page owner"指示灯
│  ├─ panel.css                       保留
│  └─ follow-btn.js                   保留
└─ background.js                      v3.0：pool/lease + heartbeat + report_audit + 抽硬编码
```

### 2.2 统一 Lifecycle 接口

每个业务模块导出标准接口，由 Coordinator 调度：

```javascript
Module = {
  name: 'follow' | 'chat' | 'nurture',

  start(),           // 初始化本模块 state（不抢页）
  stop(),            // 清理本模块 state + 释放页
  pause(), resume(), // 暂停/恢复（保留 state）

  canRun(stage),    // 在指定阶段是否准入（依据 day/配额/退避等）
  tick(ctx),        // 执行一次循环；ctx 含 pageOwner、stage
                    // 返回 { tookPage: bool, nextDelayMs: number }
  status(),         // 返回模块当前 state（供快照/看板）
}
```

- `tick` 返回 `tookPage: true` 告诉 Coordinator"本轮我占了页面权力"
- `nextDelayMs` 告诉 Coordinator 下次该不该让它跑（如 warmup 30min 返回 1800000）
- Coordinator 不会强制 stop 一个正在 tick 的模块，只在它 `tookPage: false` 时让次优模块进来

### 2.3 模块页面准入 URL（硬约束）

| 模块 | 必须在本 URL 才 tick | 否则须跳页 |
|---|---|---|
| follow | `https://x.com/{blogger}/followers` | 跳此 URL |
| chat | `https://x.com/{myHandle}/followers` | 跳此 URL |
| nurture | `https://x.com/home` 或 `https://x.com/explore`（trends） | 跳此 URL 之一 |

---

## 3. 阶段定义（S0-S4）

### 3.1 阶段表（默认阈值，后台 `stage_policy` 可改）

| Stage | 名称 | 准入条件 | 养号 | 关注 | 私信 | 页面归属 |
|---|---|---|---|---|---|---|
| **S0** | 静默 | 非工作时段（默认 23:00-08:00 北京） | 停 | 停 | 停 | 无 |
| **S1** | 纯养号 | Day<3 或配额满或全局退避中 | 跑 | 停 | 停 | nurture 独占 /home |
| **S2** | 关注+养号 | Day 3-6，或在非私信时段 Day≥3 | 跑（独立 tick） | 跑 | 停 | follow 主占，warmup 间隙让 nurture |
| **S3** | 全开 | Day≥7 且 08:00-18:00，配额未满 | 跑 | 跑 | 跑 | 三模块轮转抢页，私信优先 |
| **S4** | 私信独占 | 私信 round 刚启动并占用中 | 停 | 停 | 跑 | chat 独占 own/followers ≤30min |

### 3.2 阶段切换状态机

```
                 工作时段进入                       Day 3, 私信时段
        S0 ───────────────────→ S1或S2 ───────────────────→ S3
        ↑                          ↑                          │
        │                          │     私信 round 启动      │
        │                          └──────────────────────────┘
        │                              S4 (≤30min) → 回 S3
        │
        └────────── 23:00 或全局退避 ─────────────
```

### 3.3 阶段判定优先级（StageDetector 顺序）

```
S0 (非工作时段)  >>> S1 (Day<3 / 配额满 / 退避) >>> S4 (私信轮正在跑)
                                                       >>> S3 (Day≥7 & 私信时段)
                                                       >>> S2 (其它工作时段)
```

S4 优先级高于 S3：私信 round 一旦启动就独占，不管 Day 多大，直到 round 结束或撞 30min 硬上限。

---

## 4. 页面支配规则

### 4.1 URL → 合法 page owner 判定（PageRouter）

当前 URL：
- 包含 `/{blogger}/followers`（blogger ≠ myHandle） → `follow`
- 包含 `/{myHandle}/followers` → `chat`
- 等于 `/home` 或 `/explore` 或 `/i/...`（trends 内嵌） → `nurture`
- 其它（个人主页、tweet 详情、settings 等） → `none`（须跳回某 owner 的 home）

### 4.2 跳页决策

Coordinator 在 tick 中：
1. 算出 stage → 取 `priority[stage]`
2. 取第一个 `canRun(stage)=true` 的模块作为 `desiredOwner`
3. 若 `pageOwner === desiredOwner` → 直接 tick
4. 若 `pageOwner !== desiredOwner` → `PageRouter.jumpTo(desiredOwner.homeUrl)`
5. 当前 tick 不再调模块（等下一 tick 把页面跳到位）
6. pageOwner = none 时立即跳到 `desiredOwner.homeUrl`，不留空

### 4.3 跳页安全约束

- 单次 tick 最多跳 1 次页（避免抖动）
- 跳页后立即 savePrevSnapshot，下一 tick 验证跳页成功（沿用 V5 alignPage 思路）
- 连续 3 次 tick 跳同一 URL 失败 → 写 audit `engine_stall_recovered` + 进入 180s 全局 pause（沿用 V5 SK_PAUSED_TILL，但 180s 抽到 stage_policy.S_stallCooldown）

---

## 5. Coordinator 调度流程（10s tick 伪码）

```javascript
function onTick() {
  if (tickLock) { return; }
  tickLock = true;
  try {
    const stage     = StageDetector.current();            // S0-S4
    const pageOwner = PageRouter.fromUrl(window.location.href);
    const policy    = StagePolicy.get(stage);            // priority 等
    const now       = Date.now();

    // 1. S4 私信独占硬上限
    if (chat.isOccupying() && now - chat.occupyStartedAt > policy.S4_maxOccupyMin * 60000) {
      chat.release();     // 强制 chat 释放 → Coor 回到 S3
      audit.emit('engine_stall_recovered', { reason: 'chat_occupy_timeout' });
    }

    // 2. S0 静默：全停
    if (stage === 'S0') { stopAllExcept('.'); updatePanel(); return; }

    // 3. 沿 priority 队列找首个可跑模块
    let desiredOwner = null;
    for (const name of policy.priority) {
      const mod = modules[name];
      if (mod.canRun(stage) && mod.nextDelayUntil() < now) { desiredOwner = name; break; }
    }
    if (!desiredOwner) { updatePanel(); return; }   // 都在 cooldown

    // 4. 页面支配裁决
    if (pageOwner !== desiredOwner) {
      const url = PageRouter.homeUrlFor(desiredOwner);
      PageRouter.jumpTo(url);                         // window.location 一次性跳
      savePrevSnapshot({ desiredOwner });             // 沿用 V5 跨页机制
      updatePanel(); return;                          // 等下一 tick
    }

    // 5. 目标模块 tick
    const ctx = { stage, pageOwner, now };
    const r   = modules[desiredOwner].tick(ctx);

    // 6. tick 返回 tookPage=false → 让次优模块进来（同 tick 内）
    if (!r.tookPage && r.nextDelayMs > 0) {
      modules[desiredOwner].setNextDelayUntil(now + r.nextDelayMs);
      // 重新走第 3 步队列找次优
      retryWithNextCandidate(stage, policy, now);
    }

    // 7. 持久化 + 面板
    savePrevSnapshot({ pageOwner, moduleState: each module.status() });
    updatePanel();
  } finally {
    tickLock = false;
  }
}
```

### 5.1 tick 节奏

- V5 默认 10s（保留），DEBUG 模式 2s（保留）
- 看门狗 30s 触发重启 tick（V5 保留，但要补 tickLock 释放检查）
- 跳页后下一 tick 间隔 ≤2s 加快对齐（不在 V5 范围，新增跳页专用 agent event）

### 5.2 tick 间隔与 nextDelay 交互

| 模块返回 | Coordinator 行为 |
|---|---|
| `{tookPage:true, nextDelayMs:0}` | 本轮占用，下 tick 仍可被调用 |
| `{tookPage:true, nextDelayMs:N}` | 本轮占用，模块主动让页 N ms，下 tick 调度会跳过它 |
| `{tookPage:false, nextDelayMs:N}` | 本轮没活，立即让次优模块（同 tick 内） |

---

## 6. 关注×养号解耦与联动（S2 时间线示例）

> 这是 v3.0 的核心示例：**关注 warmup 间隙由 Coordinator 把页面让给养号**，而不像 V5 那样 follow 内嵌驱动 nurture。

```
Day 5 (S2 阶段)
 ├─ t=0s    Coor tick: stage=S2, url=/{blogger}/followers, pageOwner=follow
 │          priority[S2]=[follow, nurture], follow.canRun=true
 │          → follow.tick(): 跑 1 批关注，命中风控 HARD
 │          → 返回 {tookPage:true, nextDelayMs:1800000} (30min warmup)
 │          → follow.setNextDelayUntil(now+30min)
 │
 ├─ t=10s   Coor tick: follow 还在 nextDelayUntil 内（30min）
 │          沿队列到 nurture：nurture.canRun(S2)=true, nextDelayUntil 已过
 │          pageOwner=follow 但 desiredOwner=nurture → 不匹配
 │          → PageRouter.jumpTo('/home')
 │          → savePrevSnapshot, 等下一 tick
 │
 ├─ t=12s   Coor tick: url=/home, pageOwner=nurture, desiredOwner=nurture
 │          → nurture.tick(): 跑 5min 分片点赞 + 评论 2 条
 │          → 返回 {tookPage:true, nextDelayMs:300000} (养号分片 5min)
 │
 ├─ t=5min  Coor tick: nurture 还在分片内
 │          follow 仍在 warmup
 │          → 无人可跑（都在 nextDelayUntil 内）→ idle 等下一 tick
 │
 ├─ t=5min12s nurture tick 到点
 │          pageOwner=nurture → PageRouter 维持 /home
 │          → nurture.tick() 再跑一次分片
 │
 ├─ t=30min follow warmup 结束
 │          Coor tick: priority[S2]=[follow, nurture]
 │          follow.canRun=true, nextDelayUntil 已过
 │          pageOwner=nurture (在 /home) → desiredOwner=follow
 │          → PageRouter.jumpTo('/{blogger}/followers')
 │          → 等下一 tick
 │
 └─ ...     循环
```

**关键差异：**
- V5：follow warmup 直接调 `startNurture()` 把 engine 切到 nurture，nurture 跑完再切回 follow
- V3：follow 只报 `nextDelayMs=1800000` 给 Coor，Coor 自己决定跳 /home 让 nurture 跑
- 后果：你可以独立 stop nurture 仅让 follow tick 等 warmup，或独立 stop follow 让 nurture 一直占 /home → 这才是真正解耦

---

## 7. 私信 S4 独占硬上限

### 7.1 进入 S4

```
chat.round_start() 触发:
  → chat.isOccupying = true
  → chat.occupyStartedAt = Date.now()
  → StageDetector 强制 stage = S4（覆盖 S3）
  → Coordinator: priority[S4] = [chat]
  → other modules stop()
  → PageRouter.jumpTo('/{myHandle}/followers')
```

### 7.2 退出 S4

任一项触发即释放：
1. **正常**：chat.round_finish()（三轮发完）
2. **硬上限**：Coor tick 检测 `now - chat.occupyStartedAt > S4_maxOccupyMin * 60000`
   - 默认 30min，后台可改范围 10-60min
3. **异常**：chat.tick 连续 3 次返回 `tookPage:false`（无活可干）

```
chat.release():
  → chat.isOccupying = false
  → chat.setNextDelayUntil(now + 轮次间隔, 默认 2h，后台可改)
  → if (chat.todayRounds >= dayQuota) chat.suspend()    // 配额满
  → Coordinator 自动回到 S3 或 S2（依据当前 stage 判定）
```

### 7.3 S4 期间其他模块

- follow.stop() 仅清 state，不丢恢复点（沿用 V5 备份恢复）
- nurture.stop() 同
- S4 期内 tick 看 priority 只有 chat，其他模块 cannot run
- 即使 S4 全停 30min，follow/nurture 在 nextDelayUntil 后仍可排队等待 S4 退出

### 7.4 后台可改的 S4 阈值

```json
"S4": {
  "maxOccupyMin": 30,
  "roundIntervalMs": 7200000,
  "dayQuota": 3
}
```

---

## 8. Stage Policy 后台配置 schema

### 8.1 ops-console 后台编辑界面写入 `chrome.storage.matrix_stage_policy`（v3.0 简版）+ 后端 `stage_policies` 表（v3.1 全版）

### 8.2 schema 示例

```json
{
  "version": "2026-07-26-001",
  "work hours": "Asia/Shanghai",
  "stages": {
    "S0": {
      "trigger": { "workHours": ["23:00-08:00"] },
      "priority": []
    },
    "S1": {
      "trigger": { "dayMax": 2, "quotaFull": true, "inRetreat": true },
      "priority": ["nurture"],
      "page": "/home"
    },
    "S2": {
      "trigger": {
        "dayMin": 3, "dayMax": 6,
        "workHours": ["08:00-23:00"]
      },
      "priority": ["follow", "nurture"]
    },
    "S3": {
      "trigger": {
        "dayMin": 7,
        "workHours": ["08:00-18:00"],
        "quotaNotFull": true
      },
      "priority": ["chat", "follow", "nurture"]
    },
    "S4": {
      "trigger": { "chatRoundStarted": true },
      "maxOccupyMin": 30,
      "priority": ["chat"]
    }
  },
  "cooldown": {
    "stallCooldownSec": 180,    //  V5 硬编码 180s 抽到这里
    "tickIntervalMs": 10000,    //  V5 硬编码 10s 抽到这里
    "watchdogMs": 30000
  }
}
```

### 8.3 生效路径

1. 管理员在 ops-console 后台改 `stage_policy`
2. `POST /api/config/overrides` 写入 chrome.storage（沿用 v3.0 MatrixConfig 链路）
3. background.js 每 5min 推送 `sg_stage_policy_update` 给所有 worker tab
4. content_script 收到事件 → 重新加载 `MatrixConfig.stagePolicy`
5. Coordinator 下次 tick 生效（最长 10s + 5min 同步 = ≤5min10s）

---

## 9. 与 V5 兼容/迁移矩阵（含现存 12 项问题）

### 9.1 现存 12 项问题清单与处置

| # | 现存问题（详 [LEGACY_ISSUES]）| 严重度 | v3.0 处置 | 修复节奏 | 责任模块 |
|---|---|---|---|---|---|
| 1 | `S.engine` 单字段互斥（被迫开两页） | 高 | **废除** → 拆三模块 lifecycle + Coordinator | M0 P0 | scheduler/coordinator.js |
| 2 | 养号被 follow warmup 内嵌（借壳运行） | 高 | **改造** → nurture 独立 tick | M0 P0 | nurture/nurture-engine.js |
| 3 | URL 跳转散落各处 | 高 | **统一** → PageRouter 收口 | M0 P0 | scheduler/page-router.js |
| 4 | chat 启动条件耦合多个本地 key | 高 | **收拢** → StageDetector.canRun | M0 P0 | scheduler/stage-detector.js |
| 5 | 跨页 prev 只覆盖 3 字段 | 高 | **升级** → 每模块自带 status() 快照 | M0 P0 | scheduler/coordinator.js |
| 6 | watchdog 只 restartTick 不修脏 tickLock | 中 | **补丁** → 检查并清 tickLock | M0 P1 | scheduler/coordinator.js |
| 7 | 全局暂停 180s 硬编码 | 中 | **抽离** → stage_policy.cooldown.stallCooldownSec | M0 P1 | scheduler/stage-detector.js |
| 8 | `nurtureOnly` 与 `engine=nurture_only` 双轨 | 中 | **合并** → 统一用 `S.stage` 标识 S1 alias | M0 P1 | scheduler/coordinator.js |
| 9 | background alarm 5s 周期激进 | 低 | **暂不改** → 留 v3.1 观测后定 | — | background.js |
| 10 | tab 锁只覆盖 follow，chat/nurture 未锁 | 中 | **扩展** → 三模块都参与 tab 锁 | M1 P1 | follow/content_follow_v1522.js · chat · nurture |
| 11 | 配额满 nurture_only 与 nurture throttled ping-pong | 中 | **暂不行** → S4 独占结束后判断是否回 S1 还是 idle | M0 P2 | scheduler/stage-detector.js |
| 12 | 时区用 `toLocaleString` 字符串解析不稳定 | 低 | **暂不改** → 留 v3.1 改 Intl.DateTimeFormat | — | shared/config.js |

### 9.2 V5 保留的机制（行号对应 scheduler-core.js）

| V5 机制 | v3.0 落地 |
|---|---|
| prev 三字段跨页边沿（line 14, 65-67, 307-310） | **升级**：扩展为每模块 status() 快照，由 Coordinator.recover() 在 init 时一次性读 |
| alignPage 漂移对齐（line 149-170） | **迁移**到 PageRouter.alignIfDrifted() |
| 阶梯防封（line 41-46, antiBan.limits） | 保留在 follow 引擎内 |
| 风控令牌桶（risk_control.js） | 保留 |
| 备份恢复（matrix_follow_backup, dan_pending_reports） | 保留 |
| 私信轮次日界（line 225-226） | 保留在 chat 模块内部 |
| 配额满自动切纯养号（line 217-221） | 改为 StageDetector 检测配额 → 强制 S1 |
| sg_nurture_throttled（44 行） | 保留 → StageDetector 监听到立即 unblock S1 |
| scheduler-core.js V5 tick 主循环 | **保留文件作为 bootstrap**（init → launch coordinator），主循环迁到 coordinator.js |
| ABORT 5s fetch 超时 | 抽到 stage_policy.cooldown.fetchTimeoutMs + 加指数退避（M0/T6） |

### 9.3 迁移行动计划

| 阶段 | 文件改动 | 风险 |
|---|---|---|
| M0-T1 | 新增 scheduler/ 三件 | 0（纯新增） |
| M0-T2 | scheduler-core.js 改为 bootstrap + 转发到 coordinator | 中（保留同名入口，兼容 ui/panel.js 接口） |
| M0-T3 | follow 暴露 lifecycle 接口（保留 BatchManager 等） | 中 |
| M0-T4 | nurture-engine.js 暴露独立 tick（移除 warmup 内嵌） | 高（破坏现有解耦前置） |
| M0-T5 | chat 暴露 lifecycle（保留三轮状态机） | 中 |
| M0-T6 | PageRouter 统一收口 location.href 跳页 | 高 |
| M1-T1 | follow/chat/nurture 各自补 tab 锁 #10 | 中 |

---

## 10. 单账号 24h 跑通示例

### Day 1 → S1（纯养号）

```
08:00  StageDetector → S1（Day<3）
       priority=[nurture]
       Coor tick → PageRouter.jumpTo('/home')
       nurture.tick: 看 30 条推 + 点 5 个赞 + 评论 1 条
       nurture.tick: nextDelayUntil = +25min
08:25  nurture.tick: 同上
12:00  nurture.tick: 中午分片（lunch 期间权重 +0.5x）
18:00  nurture 继续
22:59  S1 → S0（workHours 结束）
23:00  全停
```

### Day 5 → S2（关注+养号）

```
08:00  StageDetector → S2（Day 3-6，工作时段）
       priority=[follow, nurture]
       follow.warmupUntil 没 → follow 占
       Coor 跳 /{blogger}/followers
       follow.tick: 跑 1 批关注，命中 HARD 风控
       → nextDelayMs=30min（warmup）
08:10   Coor 检测 follow nextDelayUntil 未到
        → 沿队列到 nurture
        → 跳 /home，nurture.tick: 5min 分片
08:15   nurture 暂停 5min
        follow 仍在 warmup
        → 无人可跑 → idle
08:30   warmup 结束，follow 拿回页面 → 跳 /{blogger}/followers 继续
12:00   工作时段结束 lunch break
18:01   进入非私信时段 [18:00-23:00]，S2 继续（无 S3）
23:00   S2 → S0
```

### Day 10 → S3/S4 切换（全开 + 私信独占）

```
08:00  StageDetector → S3（Day≥7 + 8:00-18:00 + 配额未满）
      priority=[chat, follow, nurture]
      chat.nextDelayUntil 已过（2h 间隔）
      Coor: 跳 /{myHandle}/followers
      chat.startRound() → S3 → S4（独占）
      chat.tick: 发 icebreaker，发 ad{LINK}，发 kick
      chat.round_finish() → S4 → S3
08:12  Coor: priority[S3]=[chat, follow, nurture]
      chat 在 nextDelayUntil（2h）
      → 到 follow → 跳 /{blogger}/followers 继续
10:00  follow warmup, Coor 跳 /home
      nurture.tick 5min 分片
12:00  全部模块在 lunch 权重，follow 抓页轻量
14:00  chat.nextDelayUntil 到 → 阻塞 pageOwner 判断 → 跳 own/followers → S4
14:12  chat 完成 → S4 → S3 → follow 接手
18:01  S3 窗口结束 → S2
22:59  S2 → S0
23:00  全停
```

---

## 11. 调度自愈机制

| 触发 | 处理 |
|---|---|
| tickLock 持续 60s 未释放 | watchdog 清 tickLock 强制重启 tick (问题 #6) |
| 连续 3 次 tick 页面没变 | 写 audit `page_drift_fixed` + 强制跳页 (V5 alignPage 保留) |
| chat 抢页 30min 没释放 | force release + audit `chat_occupy_timeout` (#7.2) |
| follow 3 tick 没 stash + 能跑 | 进 180s 全局 cooldown (line 287) (#7) |
| Module.tick 异常 | 计数器递增，3 次后该模块 stop + audit `engine_stall_recovered` |

---

## 12. UI 面板信号（panel.js 同步）

新增字段：

- `stage`: S0-S4 + 中文名
- `desiredOwner`: follow/chat/nurture/none
- `pageOwner`: 当前 URL 实际支配者
- `moduleStatus`: { follow: {...}, chat: {...}, nurture: {...} }（每模块 status() 转出）

面板可显示：
```
当前阶段: S2 关注+养号
当前支配: follow  → /@blogger/followers
下一支配估算: nurture（warmup 后 23min）
[养号独立] [关注独立] [私信独立] (三个手动按钮，每个可强制单模块独占 S? 5min 调试用)
[全部自动]
```

---

## 13. 引用

- 需求详见 `REQUIREMENTS.md`
- 架构详见 `ARCHITECTURE.md`
- 接口契约详见 `API_CONTRACT.md`
- 路线详见 `ROADMAP.md`
- 现存问题详表见本文第 9.1 节（V5 12 项 — 兼容性矩阵）
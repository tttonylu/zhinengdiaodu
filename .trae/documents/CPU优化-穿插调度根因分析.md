# CPU 占用根因分析与优化方案

## 摘要

用户反馈插件仍占用大部分 CPU，怀疑是"穿插调度"导致。经全量定时器审计，**穿插调度本身不是主因**，真正根因是：多个内容脚本的高频定时器在模块未运行时仍持续触发（"空转"），加上每次模块切换导航导致 ~30 个脚本重新注入。

## 现状：全量定时器清单

manifest.json 的 content_scripts 在**每个 x.com 页面**注入 ~30 个 JS 文件。以下定时器在页面加载后全部启动：

### 高频定时器（≤10s，主要 CPU 贡献者）

| # | 文件 | 行 | 间隔 | 门控条件 | 做什么 | 问题 |
|---|---|---|---|---|---|---|
| **1** | **content_follow_v1522.js** | **L2650** | **1s** | **仅 document.hidden** | 读 localStorage + 查 DOM + 更新面板风控区域 | **未按 isRunning 门控；关注模块停了也在跑；全系统最激进定时器** |
| 2 | content_chat.js | L12130 | 5-7s | 无（始终跑） | `__sgChatMainEngineTick`：DOM 扫描 + sessionStorage 读取 | 未按模块激活门控；chat 不在跑也触发 |
| 3 | content_chat.js | L12232 | 15s | 无（始终跑，显式移除了门控） | `chrome.runtime.sendMessage` 网络心跳 + sessionStorage/GM_getValue 读取 | 注释写"降低3倍负载"但仍是 15s 一次网络调用 |
| 4 | scheduler-core.js | L429 | 10s | 低功耗闸门（隐藏+停止+无模块） | coTick：读 config、查 4 模块状态、冻结检测 DOM 扫、决定切换 | 正常调度需要；但即使无模块在跑仍做维护工作 |
| 5 | scheduler-core.js | L5884 | 10s | document.hidden | claimRemote：`chrome.runtime.sendMessage` 拉 OPS 指令 | 每 10s 一次 SW 消息，即使空闲 |
| 6 | push_blogger.js | L440 | 10s | document.hidden | `main()`：DOM 扫描注入 | 未按模块激活门控 |
| 7 | content_follow_v1522.js | L4653 | 10s/30s | document.hidden 或 !isRunning | 诊断 DOM 扫描 | 已部分门控（隐藏时 30s） |
| 8 | follow-back-detect.js | L485 | 5s | document.hidden | `cleanupOrphanTrip`：DOM 清理 | 未按模块激活门控 |
| 9 | follow-back-detect.js | L183 | 10s | 路径检查 | `scanNotificationsPage` | 仅在 /notifications 页生效 |
| 10 | repost-panel.js | L453 | 4s | document.hidden | `updateDot`：面板圆点 UI 更新 | 未按模块激活门控 |
| 11 | ui/follow-btn.js | L74 | 5s | document.hidden | `chrome.runtime.sendMessage` 查调度状态 | 未按模块激活门控 |

### 低频定时器（≥60s，影响小）

| 文件 | 行 | 间隔 | 说明 |
|---|---|---|---|
| scheduler-core.js | L5891 | 30s | runtime heartbeat（门控：S.running OR coRunning） |
| scheduler-core.js | L1497 | 10min | SCRM gate 刷新 |
| scheduler-core.js | L5465 | 5min | 每日统计上报 |
| content_follow_v1522.js | L145 | 60s | 关注配置同步 |
| content_follow_v1522.js | L4790 | 60s | 养号心跳 CustomEvent |
| follow-back-detect.js | L499 | 60s | activeScanTick |
| content_chat.js | L2909 | 180s | 台账同步（门控：phase 检查） |
| content_chat.js | L594 | 30min | 脚本同步 |
| content_chat.js | L12163 | 5min | 内存监控 |
| promo-links.js | L124 | 5min | 推广链接同步 |

## 根因分析

### 根因 1（最大）：面板 1s 刷新定时器未按模块运行门控

[content_follow_v1522.js L2607-2650](file:///d:/下载/智能调度/unified-scheduler/follow/content_follow_v1522.js#L2607-L2650)

```js
_panelRefreshInterval = setInterval(() => {
    if (document.hidden) return;  // ← 只挡了隐藏标签，没挡 isRunning
    // 读 localStorage + 查 DOM + 更新面板...
}, 1000);  // ← 每 1 秒！
```

**影响**：这是全系统最高频的定时器。即使关注模块已停止、面板未打开，只要标签可见就每秒触发一次。每次读 localStorage（`getMatrixCooldownUntil`、`getNextGlobalFollowTime`）+ 查 DOM（`getElementById`）+ 更新文本和 class。在 4 核 CPU 上，仅此一项可贡献 3-5% 持续 CPU。

### 根因 2：私信模块定时器未按激活门控

- [content_chat.js L12130](file:///d:/下载/智能调度/unified-scheduler/chat/content_chat.js#L12130)：主引擎 5-7s tick，**始终运行**（无 `isActive`/`isRunning` 检查），即使 chat 模块未启动
- [content_chat.js L12232](file:///d:/下载/智能调度/unified-scheduler/chat/content_chat.js#L12232)：探针心跳 15s，**显式移除了门控**（注释"移除 `if (dan_auto_run !== 'true') return;` 限制"），每 15s 发一次 `chrome.runtime.sendMessage` 网络调用

**影响**：当关注/养号/转帖在跑时，私信的两个定时器仍在空转。主引擎 tick 每次 DOM 扫描 + sessionStorage 读取，心跳每次跨进程消息。

### 根因 3：多个 4-10s 定时器"雷群效应"

当标签可见时，以下定时器在同一秒内可能同时触发：
- coTick（10s）+ claimRemote（10s）+ push_blogger main（10s）+ chat main engine（5-7s）+ follow-back-detect cleanup（5s）+ repost updateDot（4s）+ follow-btn status（5s）+ panel refresh（1s）

最坏情况下每 10s 出现一次"脉冲"：7-8 个回调同时执行，各自做 DOM 读取 / localStorage 读取 / chrome.runtime.sendMessage。这造成 CPU 波动而非平稳占用，用户感知为"大部分时间高 CPU"。

### 根因 4：穿插调度切换 = 全页重载 = 脚本重注入

穿插调度的 CPU 开销不在 coTick 逻辑本身，而在**每次模块切换的页面导航**：
1. coTick 决定从模块 A 切到模块 B → 导航到新 URL（如 /home → /followers）
2. 页面重载 → manifest 注入的 ~30 个 JS 文件全部重新解析 + 执行 IIFE
3. 所有定时器重新启动，各自做首轮初始化工作
4. 如果切换频繁（每几分钟一次），每次切换产生 2-5s 的 CPU 尖峰

## 提议改动

### 改动 1（最高优先级）：面板 1s 刷新加 isRunning + 面板可见门控

**文件**：`follow/content_follow_v1522.js` L2607-2650  
**改法**：
```js
_panelRefreshInterval = setInterval(() => {
    if (document.hidden) return;
    if (!isRunning) return;              // 关注模块未运行 → 跳过
    var riskEl = document.getElementById('matrix-risk-status');
    if (!riskEl) return;                  // 面板未渲染 → 跳过
    // ...原有更新逻辑...
}, 2000);                                // 1s → 2s（冷却倒计时 2s 精度足够）
```

**风险**：极低。面板只在关注运行时需要实时倒计时；停止后面板本就无意义。

### 改动 2：私信主引擎 tick 加激活门控

**文件**：`chat/content_chat.js` L12130  
**改法**：
```js
window._sgChatMainEngineId = safeSetInterval(function () {
    try {
        if (sessionStorage.getItem('dan_auto_run') !== 'true') return;  // 未启动 → 跳过
        if (typeof window.__sgChatMainEngineTick === 'function') window.__sgChatMainEngineTick();
    } catch (eTick) { ... }
}, 5000 + Math.floor(Math.random() * 2000));
```

**风险**：低。原代码本就是为私信运行时设计；但需确认 `__sgChatMainEngineTick` 是否有被其他模块通过 `sg-chat-command` 事件间接触发的场景。需检查是否有"chat 模块未运行但仍需监听命令"的场景。

### 改动 3：私信探针心跳加低频门控

**文件**：`chat/content_chat.js` L12232  
**改法**：未运行时降频到 60s（而非完全关闭，保留白屏自愈检测）：
```js
safeSetInterval(() => {
    var isRunning = sessionStorage.getItem('dan_auto_run') === 'true';
    // ...心跳逻辑...
    if (!isRunning && Date.now() - lastProbeAt < 60000) return;  // 未运行时 60s 一次
    lastProbeAt = Date.now();
    // ...发送...
}, 15000);
```

**风险**：低。白屏自愈 45s 阈值不变，60s 探针仍能在 ~60s 内发现白屏。

### 改动 4：非活跃模块的 4-10s 定时器加 isActive 门控

**文件和改法**：

| 文件 | 行 | 改动 |
|---|---|---|
| push_blogger.js L440 | main() | 加 `if (!isRunning && !isSchedulerAutoMode()) return;` |
| follow-back-detect.js L485 | cleanup | 加 `if (!isRunning) return;`（关注模块停止时无需清理） |
| repost-panel.js L453 | updateDot | 加 `if (typeof isRunning !== 'undefined' && !isRunning) return;`（转帖未激活时面板圆点无意义） |
| ui/follow-btn.js L74 | btn status | 间隔 5s→10s（按钮状态 10s 精度足够） |

**风险**：低-中。push_blogger 需确认是否有"关注未运行但仍需注入 DOM"的场景。follow-back-detect 的 cleanup 在关注停止后可能还有残留需要清，可改为"停止后 30s 内仍跑，之后停"。

### 改动 5：claimRemote 间隔 10s → 15s（非自动模式）

**文件**：`scheduler-core.js` L5884  
**改法**：
```js
var claimInterval = isAutoMode() ? 10000 : 15000;  // 手动模式 15s
window._sgRemoteCmdTimer = setInterval(claimRemote, claimInterval);
```

**风险**：极低。OPS 远程指令延迟 5s 无感知。

## 不改动的部分

- coTick 10s 间隔（调度核心，已有低功耗闸门）
- runtime heartbeat 30s（已有 S.running/coRunning 门控）
- 低频定时器（≥60s，影响小）
- 穿插调度逻辑本身（模块切换是业务需要，无法避免导航）
- 各模块业务逻辑（关注点击、私信发送、转帖抓取等）

## 验证

- `node --check` 所有修改文件
- manifest.json bump 版本
- 工作指导.md §13 补记录
- 实机观察：标签可见 + 调度运行时 CPU 占用应下降 30-50%；标签可见 + 调度停止时 CPU 应接近 0%

# coTick 低功耗降频（隐藏+全 idle 时 10s→30s）实施计划

## 背景与研究结论（Repository Research）

### 现状定时器架构（scheduler-core.js）
- `installCoTimers()`（L425-435）装两个 interval，**每个 X 标签页各一份**：
  - `coTimer`：每 `tm.tick`（默认 10s，远端可覆盖，最小 3s）调 `coTick()`。
  - `coWdTimer`：每 `tm.watchdog`（默认 30s）巡检——距上次 tick >30s 且无锁则补一次；>60s 强制清锁补一次（防 coTick 卡死）。
- `coTick()`（L4296）每次执行的工作：
  1. `reconcileSchedulerHostIdentity('cotick')` 换号对账——**暂停时也跑**，但函数内部自带 15s 节流（L4301）。
  2. `ensureFollowDailyRollover / ensureNurtureDailyRollover` 跨日配额清零——**暂停时也跑**，纯上海日期字符串比较。
  3. **快速通道**：`!coRunning && !S.running`（调度停止/暂停）时，只做 4 模块（follow/chat/nurture/repost）的 sessionStorage 死引擎对齐（L4314-4324），然后 return。
  4. 运行中才做：永久冻结检测（内部 30s 节流）、StageDetector、onboarding、模块派发等重头工作。
- 直接调用点仅 start（L5437）/resume（L5507），其余只走两个定时器。
- 已有的可见性兜底先例：L5620 `visibilitychange`→visible 时补跑跨日清零；L6028 visible 时补查重置指令 seq。
- 标签隐藏后 Chromium 5 分钟会把定时器节流到约 1/min；但切走后的前 5 分钟仍按 10s 跑，且比特浏览器等指纹浏览器的节流行为不保证与标准 Chrome 一致。

### 关键判断
停止态 coTick 的实际开销 = 每 10s、每标签：2 次日期比较 + 1 次换号对账（15s 节流）+ 4 次 sessionStorage 读取。标签越多（多账号）累积越明显。运行态（coRunning/S.running=true）开销大但**本次不动**。

## 风险评估与收敛措施

| # | 风险 | 收敛措施 |
|---|---|---|
| R1 | 看门狗 30s 补 tick 会绕过"定时器降频"，且它在调用前写 `coLastTick`，可能让真正维护任务被无限推迟 | 不改两个 interval，**闸门放在 coTick 函数体最前面**；用独立时间戳 `_coLastFullTickAt` 判定 30s 节拍，与 `coLastTick` 解耦；跳过时主动喂 `coLastTick=Date.now()` 防误报卡死 |
| R2 | coTick 真卡死（锁被持有 >60s）时，跳过逻辑若也喂狗，会破坏看门狗 L432 的强制清锁救援 | 跳过分支增加 `!coTickLock` 条件；锁被持有时不喂狗、直接落到原有 `if (coTickLock) return`，60s 强制清锁路径原样保留 |
| R3 | 切回标签后调度响应最多慢 30s | 新增 `visibilitychange`（+`pageshow`/`focus`）监听：变可见且距上次完整 tick >10s 时立即补一次 coTick——**可见时零新增延迟**，与 L5620 既有模式一致 |
| R4 | 隐藏期间换号对账延迟 | 隐藏时用户无法在该标签换号；对账自带 15s 节流；切回可见立即补 tick。无实际影响 |
| R5 | 隐藏期间跨零点配额清零延迟 | 停止态无引擎消耗配额；且 L5612 既有 visible-wake 已会补跑跨日清零。双保险 |
| R6 | 死引擎对齐延迟（旗标 running 但循环已死） | 低功耗判定要求 **4 个模块旗标全部非 running**；只要有一个模块声称在跑，立即恢复 10s，对齐时效不变 |
| R7 | 自动模式在 /home 养号等待（coRunning=true）被误降频 | 闸门要求 `!coRunning && !S.running`，自动/手动运行中一律不降频。优化面严格限定为"暂停/停止 + 隐藏"标签 |
| R8 | 影响 node 测试（现有测试断言 coTick 调用跨日清零） | node 环境无 `document.hidden`，`coInLowPower()` catch/缺省恒返回 false；不定义任何 document 时行为与现状逐字节一致 |
| R9 | 上线后若有未预料副作用需要止血 | 闸门读取 `localStorage.sg_co_low_power_off==='1'` 一键关闭（仅隐藏态每 30s 读一次，不增加可见态开销） |

结论：闸门比原提议更窄（不是"运行中 idle 阶段"而是"停止+隐藏+无模块在跑"），且不改动定时器架构本身，可回退、可一键关闭。

## 改动文件

- `unified-scheduler/scheduler-core.js`：唯一代码改动文件
  1. 在 coTick 相关状态区（L1972 附近 `coTickLock/coRunning` 声明处）新增：
     - `var _coLastFullTickAt = 0;`
     - `var CO_LOW_POWER_TICK_MS = 30000;`
     - `coInLowPower()`：`document.hidden && !coRunning && !S.running && 四模块旗标均非 running && localStorage 未设 sg_co_low_power_off`，任何异常 return false。
  2. 在 `coTick()` 最顶部（`if (coTickLock) return` **之前**）插入闸门：
     - 低功耗且 `!coTickLock` 且 `_coLastFullTickAt>0` 且距今 <30s → `coLastTick=Date.now(); return;`
     - 否则 `_coLastFullTickAt = Date.now();` 后继续原有逻辑（不改原锁/try-finally 结构）。
  3. 在 init 区域（L5620 既有 visibilitychange 附近）新增一次性绑定：visible（含 pageshow/focus）且 `Date.now()-_coLastFullTickAt > 10000` 时立即调 `coTick()`。
- `unified-scheduler/manifest.json`：4.6.107 → 4.6.108，同步 description/default_title。
- `docs/工作指导.md` §13：追加 4.6.108 变更记录。

## 实施步骤（依赖顺序）

1. scheduler-core.js 新增状态变量与 `coInLowPower()`。
2. coTick 顶部插入低功耗闸门（含锁保护）。
3. init 区绑定可见性恢复补 tick。
4. `node --check scheduler-core.js`。
5. `npm test` 全量（预期 61/61 不受影响）。
6. manifest 升 4.6.108；工作指导 §13 记录。
7. 汇报，附人工验证方法。

## 验证（Validation）

- 语法：`node --check unified-scheduler/scheduler-core.js`。
- 回归：`npm test`（unified-scheduler 目录），预期 61/61。
- 人工验证（重载扩展后）：
  1. 暂停调度 → 切到别的标签 ≥1 分钟 → 切回：面板/调度立即响应（visible 补 tick），无僵死。
  2. 自动模式运行中切走标签：coTick 仍 10s（日志/行为不变）。
  3. 隐藏标签下观察任务管理器，多标签时 CPU 占用应进一步下降。
  4. 止血演练：localStorage 设 `sg_co_low_power_off=1` 后行为立即回到恒 10s。

## 不做的事（范围控制）

- 不重写 installCoTimers 的双 interval 架构（不换自调度 setTimeout 链）。
- 不改远端可调的 `tm.tick/tm.watchdog` 生效逻辑；运行中频率完全不动。
- 不动 background.js alarms、不动其它模块定时器。

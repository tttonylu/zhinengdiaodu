# 转帖夜场专场（21:00 后一轮）

日期：2026-08-06  
状态：已实现（插件 3.1.9）

补充（123）：
1. 开跑时刻可配：默认跟随 `workHours.end`；可取消跟随并设自定义 HH:MM（仍须 S0）
2. 夜场上限可配：`repost_max_minutes` / `maxMinutes`（默认 60）
3. 手动「只转帖」整轮 `done` 后同样 `markAutoDone`，当日夜场不再自动开

补充（2026-08-12）：
1. **默认开启**转帖模块
2. **双窗全员同跑**（暂不分哈希）：晚窗 `workEnd～23:00`，早窗 `03:00～05:00`；一日一轮
3. **来源号以 OPS 为准**：账号详情可配置；插件同步覆盖本机；心跳不再回写 targets
4. 无 `repost_targets` 则跳过；窗尾或 maxMinutes 硬停
5. 验收：手动整轮 done = 当日自动跳过（与补充 #3 一致）
6. 后续（未做）：按来源号统计转帖→回关率，筛选优质来源

## 背景

转帖已从 `repost-standalone` 迁入 `unified-scheduler`，但自动路径存在硬洞：S0 杀全模块、`canGo` 无 repost、养号饿死、跳页假死、本机列表被 OPS 覆盖。  
产品侧要求转帖**不跟白天关注/私信抢资源**，改为工作结束后夜场专场。

## 目标

| 目标 | 说明 |
|------|------|
| 固定开跑 | 对齐 `workHours.end`（默认 21:00 北京时间）自动开一轮 |
| 每博主 1 条 | 一天自动只一轮；总量 = 来源博主数 |
| 本机优先 | 浏览器已存列表优先；空才用 OPS |
| 硬上限 | 自动场最多 **60 分钟**；未完成停止，不追债，次日 21:00 再开 |
| 保留手动 | 任意时刻可手动启停转帖 |
| 硬规则保留 | 禁视频；正文禁 `@`；失败进 skip |

非目标：白天自动穿插转帖；原生转推；视频路径；跨日补跑未完成博主。

## 产品规则（已确认）

1. **时间**：工作停止后开跑（`workHours.end`，默认 21:00）；采用「插队专场」而非白天优先级垫底。
2. **条数**：每个来源博主每轮 1 条；一天自动一轮。
3. **博主**：本机 `sg_repost_targets` / `matrix_repost_targets` 优先；仅当本机为空时用 OPS `repost_targets`。
4. **收工**：全部处理完（成功或 skip）→ 标本日自动轮完成；或满 60 分钟强制停。
5. **手动**：不受夜场时钟/60 分钟自动场约束；用户自行停止或跑完停止。

## 方案

### 状态机（自动）

```
idle ──(到 workHours.end 且本日未完成且开关开且有博主)──► night_slot
night_slot ──(全员处理完)──► done_today
night_slot ──(满 60min)──► timed_out → 当日不再自动开
done_today / timed_out ──(上海日切)──► idle
```

存储建议（localStorage）：

| Key | 含义 |
|-----|------|
| `sg_repost_auto_date` | 上海日 `YYYY-MM-DD` |
| `sg_repost_auto_status` | `idle` \| `running` \| `done` \| `timeout` |
| `sg_repost_auto_started_at` | 本场开始 ms |
| `sg_repost_config.maxMinutes` | 默认 60 |
| `sg_repost_config.postsPerHandle` | 固定按 1（自动场） |

日切时重置 `auto_status`（若 date 变化）。

### 调度例外（核心）

当前：`stage === 'S0'` → 全模块 `coStop` 并 return。  

改为：

- S0 时：**仍停止** follow / chat / nurture
- S0 时：若自动夜场条件满足 → **允许** `repost` 启动/续跑
- S0 时：若 `repost` 已在自动场且未超时 → **不要** `coStop('repost')`
- S0 时：超时或 done → `coStop('repost')`，保持静默
- 非 S0（白天）：自动转帖 `canRun` 返回 false（仅手动可跑）

「到点」判定：上海时间 `t >= workEnd` 且（尚未跨入次日工作开始，或仅用「本日 auto 未完成」+「当前为 S0」即可；避免 07:00 前残留）。  
硬停：`now - started_at >= 60min` 或 次日进入工作时段（S0→非 S0）时强制停并标 timeout/中断。

### canGo / 饥饿

- 启动循环增加 `else if (c === 'repost')`：仅当夜场窗口（或手动模式）`canGo = true`
- 白天 priority 中的 `repost` 可保留但不自动 canGo；夜场不依赖 nurture 让位，由 S0 例外专场拉起
- `coMaxRun.repost` 与夜场 60 分钟对齐（或专场用独立计时，取更严者）

### 跳页假死

- `coPrepareFreshRun`：清 `sg_repost_running` / module 态（与其它引擎对称）
- `coRehydrateEngines`：若旗标在且（自动夜场未超时 **或** 非自动模式）→ 补活 `sg-repost-command start`（不强制改 URL 若已在目标页）
- `coEngineAlive('repost')` 已接旗标；心跳勿仅靠调度刷 `lastActive` 假装活着（优先 EngineUtils ping / 引擎内 ping）

### 本机博主 vs OPS

`config-sync.applyRepostRemote`：

- 若本机 `sg_repost_targets` 非空 → **不覆盖** targets；仍可同步 `dailyCap`/`appendLink`/`maxMinutes` 等
- 若本机为空 → 写入 OPS 列表
- 模块开关 `repost` 仍跟 OPS（默认关）

### 手动

- 面板增加「只转帖」或与现有手动入口同级：`sg_manual_repost`
- 手动：`SchedulerGate` 非自动或暂停协调器占用页时允许；自动模式下手动可切到「仅转帖」短暂占用（与只关注对称）
- 手动不写 `sg_repost_auto_status=done`（不影响夜场是否已跑过的判定）；可选：手动进行中跳过自动开场

### 引擎行为对齐

- 自动场强制 `postsPerHandle = 1`
- 冷却单位统一为**分钟**（`* 60000`）；OPS 文案与引擎一致
- `stop` / abort：所有 `waitFor*` 可取消；发送前检查 `isActive`
- 保留：禁视频、清 `@`、失败 skip

### OPS / 配置 UI

- 转帖页：强调「自动夜场 = 工作结束后 + 60 分钟」；来源号说明「本机优先」
- `repost_max_minutes` 阈值默认 60（可选）
- 阶段勾选里的 `repost`：白天 priority 不再是自动主路径；可弱化或注明「夜场由调度例外驱动」

## 必改漏洞清单（实现顺序）

1. S0 例外夜场 + 到点/60 分钟状态机  
2. `canGo` for repost + 白天自动禁止  
3. prepareFresh / rehydrate 含 repost  
4. config-sync 本机 targets 不覆盖  
5. 手动入口 `sg_manual_repost`  
6. 冷却分钟修正 + wait 可取消  

## 改动文件（预期）

- `unified-scheduler/scheduler-core.js` — S0 例外、canGo、rehydrate、手动  
- `unified-scheduler/repost/repost-tracker.js` — auto 状态、本机优先辅助  
- `unified-scheduler/repost/repost-engine.js` — 冷却单位、abort、夜场 postsPerHandle  
- `unified-scheduler/shared/config-sync.js` — targets 合并策略  
- `unified-scheduler/ui/panel.js` / `background.js` — 手动按钮  
- `unified-scheduler/manifest.json` — 版本 bump  
- OPS（可选）：`config.njk` 文案 + `repost_max_minutes` 阈值  

## 验收

1. 模块开 + 本机有 ≥1 博主：到 `workHours.end` 后自动开始转帖；关注/私信/养号保持停  
2. 每博主最多自动成功/尝试 1 条；跑完当日不再自动开  
3. 故意拖慢/多博主：满 60 分钟强制停；次日 21:00 可再开  
4. 本机有列表时改 OPS 来源号：1 分钟同步后本机列表不变  
5. 本机清空后：同步写入 OPS 列表  
6. 手动「只转帖」白天可跑；停止后不影响夜场「本日是否已自动完成」逻辑（若当日自动未跑，21:00 仍应自动开）  
7. 纯图源帖 compose 无 `@来源`；视频帖 skip  
8. 跳到来源主页后引擎能补活，不假死占坑  

## 风险

- 21:00 后浏览器休眠/笔记本合盖：闹钟不可靠；依赖扩展页仍打开 + tick；可接受为运营约束  
- 与「早间 S0→工作刷新页面」相遇：若夜场拖到接近 07:00，刷新会打断；60 分钟硬上限通常在 22:00 前结束，风险低  

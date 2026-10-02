# 诊断冻结 + 阶段动作契约（全模块）

> 日期：2026-09-04 · 状态：已批准执行  
> 基线插件：4.0.28+  
> 相关：[调度模块逻辑审查.md](../../调度模块逻辑审查.md) · 工作指导 A2/C3/G3

## 1. 目标

每个运行阶段只允许对应行为动作；动作不对或超时无合法动作 → **上报异常快照 → 诊断冻结（拒一切 coStart）**，便于完整走一轮取证；白名单内小问题可自动修并反馈，避免反复盲改。

## 2. 决策摘要

| 项 | 选择 |
|----|------|
| 停机策略 | **C 诊断冻结**（自动模式可仍开，但拒 coStart） |
| 范围 | **3** follow / chat / nurture（+ 指挥闸） |
| 架构 | 统一裁判 `SgDiagContract` + 分模块契约表 |
| 与假活关系 | zombie 改道：停引擎 + 冻结取证，不再默默续跑冲现场 |

## 3. 核心 API

- `sessionStorage.sg_diag_freeze`：`{ on, module, stage, reason, code, pulseId, at, url, lastAction, extra }`
- `SgDiagContract.noteAction(module, stage, action, meta?)`
- `SgDiagContract.assertOrFreeze(...)` / tick 内 `checkStaleOrFreeze()`
- `SgDiagContract.enterFreeze(payload)` / `clearFreeze()` / `isFrozen()`
- 事件：`scheduler.diag_anomaly`（upload+可 push）、`scheduler.diag_auto_repaired`、`scheduler.diag_freeze`、`scheduler.diag_unfreeze`

## 4. 契约粒度（分步收紧）

1. **骨架**：冻结闸门 + 事件 + 面板解冻  
2. **chat 守箱**：`scanning|sealed|executing|done` 白名单 + 45s  
3. **follow / nurture**：先按「running + 心跳超时」粗契约，再收紧动作表  
4. **chat 破冰 outbound**：独立超时（长于守箱）

## 5. 解冻

面板「解除诊断冻结」或 `window.__sgDiagUnfreeze()`；解冻后下一 tick 才允许 coStart。

## 6. 非目标（本版不做）

- 不自动关账号自动模式（除非用户手动停）  
- 不做 OPS 远程解冻（可后续加）  
- 不把对方「不回消息」当异常  

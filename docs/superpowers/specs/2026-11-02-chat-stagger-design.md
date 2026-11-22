# 私信时间片错峰设计

**日期：** 2026-11-02  
**状态：** 已批准试跑

## 目标

单机多开（约 50 壳）时，私信时段不要全员同时重检；用**本地时间片**近似「一半在跑私信」，降低 CPU/撞页，提高整机有效吞吐。

## 为何不用全局并发计数

BitBrowser 一壳一档，扩展 storage 不跨窗。真·全局 cap 必须 OPS 租约。本版先做**纯本地时间片**，零跨壳通信即可试跑。

## 口径

| 键 | 默认 | 含义 |
|----|------|------|
| `chat_stagger_slots` | `2` | 槽数；`≤1` 关闭错峰 |
| `chat_stagger_slot_min` | `30` | 每槽占用墙钟分钟（上海时区） |

- `mySlot = hash(handle) % slots`（稳定）
- `activeSlot = floor(shanghaiMinutes / slotMin) % slots`
- **新开** chat：仅 `mySlot === activeSlot` 放行
- **已在跑** chat：不打断
- **软风控窗内**、**强制测私信**（`sg_chat_force_inbox`）：旁路错峰（短窗/人工不可等）

## 接入点（仅 A2）

- `startChat`：未在跑且未旁路 → 错峰挡则 return
- `coTick` chat `canGo`：同上，reason=`chat_stagger_wait`

未轮到时走 priority 下一模块（follow/nurture），不改 C3 检测。

## 不做（本版）

- OPS 全局并发租约
- 改查回复/扫根（方向 C）
- 放宽 45s 假活线

## 验收

1. `slots=2` 时约一半号日志出现 `chat_stagger_wait`，另一半可 start
2. 已在跑的号不因换槽被停
3. 软风控 chat_fill 不受挡
4. OPS 改 `chat_stagger_slots=1` 约 1 分钟后等效关闭

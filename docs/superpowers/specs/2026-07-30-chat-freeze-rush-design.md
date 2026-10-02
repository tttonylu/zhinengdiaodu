# 私信 17 点定格 + 18 点前赶工

日期：2026-07-30

## 规则（1A + 2A）

| 时段 | 行为 |
|------|------|
| `<` 定格点 | 正常按 `chat_target_db` 私信 |
| 定格点（默认 17:00） | 快照 pending（`round<3` 且未 done）→ `sg_state.chatFreezeHandles` |
| 定格点–chatHours.end（默认 17–18） | 只跑定格名单；取消会话冷却与日轮次上限；私信优先赶工 |
| 定格后新粉 | 可入库，当天不私信；次日进队 |
| `≥` chatHours.end | 停私信（现有 isChatTime） |

定格点 = `chatHours.end - 60min`（见 `TimeUtil.chatFreezeMinutes`）。

## 关键实现

- [`unified-scheduler/shared/time-util.js`](../../unified-scheduler/shared/time-util.js) — `isPastChatFreeze` / `isChatRushWindow`
- [`unified-scheduler/chat/content_chat.js`](../../unified-scheduler/chat/content_chat.js) — `ensureChatFreeze` / `isChatTargetAllowed` / `getSortedTargets` 过滤
- [`unified-scheduler/scheduler-core.js`](../../unified-scheduler/scheduler-core.js) — 调度侧定格、赶工 priority、`canGo` 放行
- [`unified-scheduler/ui/panel.js`](../../unified-scheduler/ui/panel.js) — 定格行

## `sg_state` 字段

- `chatFreezeDate` — 上海日
- `chatFreezeAt` — 定格时间戳
- `chatFreezeHandles` — handle 数组

跨日清空。赶工与软风控冲突时：**赶工私信优先**。

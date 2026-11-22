# DM 回复链路现场排障 SOP

> 适用扩展版本：**3.7.29+**（仅年龄分流 · inbox_done 可覆盖 · 等待期不拉黑 · 轮次只升不降 · 收件箱 aria · 路线 A 守箱）

## 一键诊断工具

在 X 页面 **调度面板** → 点 **回复链路** 按钮。
- 自动取当前目标（`current_target`）运行完整链路诊断。
- **Shift+点击**「回复链路」：闭环诊断（必要时自动导航收件箱/会话页，并检查 OPS 发送许可）。
- 结论复制到剪贴板，可直接粘贴到微信/邮件发给技术支持。
- 格式：`@handle` → 卡点环节 → 逐环节 [通过]/[失败] + 原因 + 建议。

### 实机验收脚本

在 x.com 控制台执行（扩展已重载）：

```javascript
await __sgVerifyReplyChain()              // 无参：取 current_target
await __sgVerifyReplyChain('handle')      // 指定目标，检查接线+持久化+SOP 场景
await __sgTraceReplyChainAsync('handle')  // 闭环诊断（含 OPS，必要时自动导航）

// 路线 A 分层验收（完整自动守箱）
await __sgAcceptRouteA('handle')          // 在列表页验 A1；在会话页验 A2+A3
await __sgCalibrateInboxUnread(['h1','h2']) // A1 校准：采样预览/未读
await __sgDumpConversation('handle')      // A2：rawBubbleCount / messages
await __sgDmSendability()                 // 可发三态：can_send / hard_closed / pending
```

或粘贴 [`obs/reply-chain-verify.js`](reply-chain-verify.js) 全文后运行 `await __sgReplyChainVerify('handle')`。

## 路线 A 守箱验收（完整自动）

目标：列表认出回复 → 打开会话 → 抽出对方气泡 → 闸门通过 → 自动发广告。

| 层 | 在哪跑 | 命令 | 通过条件 |
|----|--------|------|----------|
| A1 收件箱 | `/i/chat` 列表，目标行可见 | `await __sgAcceptRouteA('handle')` 或 `__sgCalibrateInboxUnread` | `replied=true` 或 `unread=true` |
| A2 会话气泡 | 目标会话页 | `await __sgDumpConversation('handle')` | `rawBubbleCount>0`，`composerFilteredCount≈0`，`messages.length>0` |
| A3 闸门 | 会话页或查 DB | `debugTraceReplyChain` → `gate` | `lastInboundAt > iceSentAt`，`canSendAdNow` 为 ok |
| A4 端到端 | 守箱自动跑 | 面板启动守箱，人工确认发广告 | round 从 1 晋级到 2 |

**分层验收示例**：

```javascript
// 1. 在收件箱列表（目标行可见）
await __sgAcceptRouteA('handle')
// 期望 layers.A1_inbox.ok === true

// 2. 打开该目标会话后
await __sgAcceptRouteA('handle')
// 期望 layers.A2_bubbles.ok === true，layers.A3_gate.ok === true（等待期已过时）

// 3. 若 A2 失败：看 composerFiltered 是否等于 rawBubbleCount（误滤）
await __sgDumpConversation('handle')
```

连续 2 次实机失败且校准无效 → 暂停路线 A，改评简化探测（路线 B）。

## 链路环节说明

| 环节 | 缩写 | 检查内容 | 通过条件 |
|------|------|----------|----------|
| 目标入库 | db | 目标是否在 `chat_target_db` 中 | 有 round / firstSeen |
| 轮次状态 | round | 当前 round 是否为 1 且未 done | round===1 && !done |
| 对方数字ID | peer_id | 是否有 peerId（用于直接导航/行匹配） | peerId 非空 |
| 破冰发送 | ice_sent | 是否有 iceSentAt（本地破冰记录） | iceSentAt 非 0 |
| 回复等待期 | wait | 列表探测等待（adMinWait），**不是**发送闸门 | 已过或仅影响何时打开探测 |
| 发送闸门 | gate | lastInboundAt / 差集确认 | 可发 |
| 收件箱行 | inbox_row | 当前在收件箱列表页时，目标行是否可见 | 行可见或不在列表页 |
| 收件箱回复信号 | inbox_signal | 行可见时是否判为回复或未读 | replied 或 unread |
| 会话回复 | reply | 当前在会话页时，是否检测到对方回复 | 有对方气泡或未读 |
| 发送闸门 | gate | 当前在会话页时，闸门是否放行 | canSendAdNow 返回 ok |
| OPS 许可 | ops | 闭环/async 诊断追加：OPS 是否允许发送 | allowed=true（仅 async） |

## 收件箱误判排查（未读 / 回复预览）

收件箱判定字段（`debugTraceReplyChain` → `inbox` 或 `extractInboxRowPreview`）：

| 字段 | 含义 |
|------|------|
| `preview` | 行预览文本（aria-description 第 3 段或 innerText 兜底） |
| `previewFromSelf` | 预览是否带 You sent / 送信済 等本方前缀 |
| `confidence` | `strong_peer` / `weak_peer` / `own` / `unknown` |
| `replied` | `inboxPreviewIndicatesPeerReply`：`strong_peer`/`weak_peer` 或预览非本方话术时为 true |
| `unread` / `unreadSource` / `unreadPrecise` | 未读 DOM 命中及来源（精确命中优先打开） |

**常见误判**：
- `previewFromSelf=true` → 最后一跳是本方破冰，不是对方回复；应等对方回或守箱探测。
- `unread=true` 但 `unreadPrecise=false` → 可能是旧版宽泛 selector 误报（已收紧）；看 `unreadSource`。
- `confidence=weak_peer` → 仍可能 `replied=true`（会打开）；排序低于 strong_peer 与精确未读。

**实机校准（3–5 个已知样本行）**：

```javascript
// 1. 批量采样（需在 /i/chat 且目标行可见）
await __sgCalibrateInboxUnread(['handle1','handle2','handle3'])

// 2. 单行 DOM  dump
__sgChatBridge.debugDumpInboxRowHTML('handle')

// 3. 若确认某 testid/aria-label 稳定表示未读，写入缓存
__sgChatBridge.debugSaveInboxUnreadSelectors({
  version: 1,
  testids: ['unreadIndicator'],
  ariaLabels: ['未读消息']
})
```

打开优先级：`strong_peer` > 精确未读 > 普通未读 > `weak_peer` > 探测队列。

## 五类故障场景

### A. 目标未入库

**症状**：`debugTraceReplyChain` 输出 `db 卡在「目标入库」— DB 中无此目标`。

**排查**：
1. 检查目标是否在粉丝页被扫描过（面板 → 只私信 跑一轮）
2. 手动查看 `chat_target_db`：`JSON.parse(localStorage.getItem('chat_target_db'))`
3. 检查是否被号池拒绝：`sg_fleet_handles` 中是否包含该 handle

**恢复**：
- 回到粉丝页（`/followers`）重新扫描
- 或手动写入 DB：`db[handle] = { round:1, firstSeen: Date.now() }`

### B. 缺对方数字ID（peerId）

**症状**：`peer_id 卡在「缺 peerId（无法直接导航/行匹配）」`

**排查**：
1. 是否在收件箱列表页（`/i/chat`）？目标行是否可见？
2. 控制台执行 `findInboxConversationElement('@handle')` 看能否找到 DOM 行。
3. 控制台执行 `captureDmPeerIdFromRow('@handle', row)` 手动回写。

**恢复**：
- 打开 `/i/chat` 收件箱，让调度自动下滑扫描，命中目标行会自动回写 peerId。
- 或手动导航：`debugOpenDmConversation('@handle', '/i/chat/123456-789012')` 导航时会自动回写。

### C. 缺破冰发送记录（iceSentAt）

**症状**：`ice_sent 卡在「缺 iceSentAt（本地未记录破冰发送时间）」`

**排查**：
1. 检查 DB 条目：`db[handle]` 是否有 `iceSentAt` 字段。
2. 检查 OPS 是否已记录 round1 破冰发送（OPS 运行日志搜索 `round=1`）。
3. 如果 OPS 有记录但本地没有，可能是 `chat_target_db` 被清空过。

**恢复**：
- 等待调度重新执行 round1 破冰（自动）。
- 或手动补写：`db[handle].iceSentAt = Date.now() - 30 * 60 * 1000`（设为 30 分钟前，跳过等待期）。

### D. 回复等待期未过

**症状**：`wait 卡在「破冰后等待期未过（剩 X 分钟）」`

**排查**：
1. 破冰发送时间：`db[handle].iceSentAt`
2. 列表探测等待：`getChatIntervalCfg().adMinWaitMin`（默认 20 分钟）——仅影响何时主动打开会话探测；差集确认后发送闸门不再卡此项
3. 发送闸门：`canSendAdNow`（需 peerTexts + lastInboundAt > iceSentAt）
3. 剩余分钟数由诊断直接输出。

**恢复**：
- 无需人工干预，到期后调度守箱会自动回查。
- 如需强制跳过：`localStorage.setItem('sg_config_intervals', JSON.stringify({ chat_ad_min_wait_min: 1 }))` 设为 1 分钟（排障后记得改回）。

### E. 已确认回复但闸门未开

**症状**：`gate 卡在「reply_not_confirmed」`

**排查**：
1. 检查 `lastInboundAt`：`db[handle].lastInboundAt` 是否已记录。
2. 检查 `replySeenAt`：`db[handle].replySeenAt` 是否已记录。
3. 收件箱行预览：`extractInboxRowPreview(row)` 是否有对方新消息文本。
4. 会话页诊断：`debugDumpConversationState('@handle')` 看 `messages` 数组和 `composer` 状态。

**恢复**：
- 确认回复已存在（对方气泡可见）但 `lastInboundAt` 未更新时：
  - 手动执行 `window.__sgChatBridge.markLastInboundAt('handle')` 补写时间戳，之后调度会通过闸门。
- 如果等待期已过且 `lastInboundAt` 已写，闸门自动放行（`canSendAdNow` 返回 `ok`）。
- 如果对方气泡不可见但你有第三方证据确认对方已回：
  - 手动设置 `lastInboundAt` 为一个大于 `iceSentAt` 的时间戳即可。

## 面板状态解读

面板「回复」行显示 `dan_reply_state` 当前值：

| 字段 | 含义 |
|------|------|
| `decision` | `reply_detected` / `send_gate_open` / `no_reply` / `composer_not_ready` 等 |
| `source` | `message_dom` / `unread_indicator` / `none` |
| `hasReply` | 是否检测到对方气泡或未读 |
| `unreadSeen` | 是否有未读标记 DOM |
| `target` | 当前目标 handle |
| `at` | 检测时间戳，面板显示相对时间（分前 / h前） |

- 持久化保活：重启标签页后，`localStorage` 中的镜像自动回填到 `sessionStorage`，面板不丢状态。
- 如果面板显示「回复 --」：说明当前无活跃目标，或 `dan_reply_state` 为空。

## 高级调试命令

在 X 页面控制台执行：

```javascript
// 手动补写 lastInboundAt（故障 E 恢复）
window.__sgChatBridge.markLastInboundAt('handle')

// 闭环诊断（自动导航 + OPS 步；跨页 resume 后读结果）
await __sgChatCmd('debugTraceReplyChainAsync', ['handle'], 20000)
// 或主世界：await __sgTraceReplyChainAsync('handle')
window.__sgChatBridge.debugGetReplyTraceAsyncResult()

// 实机验收（接线 + 持久化 + SOP 场景）
await __sgVerifyReplyChain('handle')

// 一键链路诊断（当前目标）
window.__sgChatBridge.debugTraceReplyChain('@handle')

// 完整链路诊断（含分段结论 + 卡点定位 + 建议动作）
// 返回 { chain, stuckAt, verdict, db, inbox, reply, gate, ... }

// 会话页 DOM 诊断
window.__sgChatBridge.debugDumpConversationState('@handle')

// 通道强开（直接导航到会话页）
window.__sgChatBridge.debugOpenDmConversation('@handle', '/i/chat/peerId-myId')

// 清除错配 peerId（让引擎回退到显示名匹配）
window.__sgChatBridge.debugClearTargetPeerId('@handle')

// 收件箱行预览
window.__sgChatBridge.extractInboxRowPreview('@handle')

// 查看完整回复检测状态
JSON.parse(localStorage.getItem('dan_reply_state'))

// 查看目标 DB
JSON.parse(localStorage.getItem('chat_target_db'))
```

## 典型排障流程

1. 面板点「回复链路」→ 看 `verdict` 卡在哪一环。
2. 按上述五类故障对应处理。
3. 处理完后再次点「回复链路」确认链路全通。
4. 如果卡在「收件箱行」→ 打开 `/i/chat` 确保收件箱已加载。
5. 如果卡在「会话回复」→ 用 `debugOpenDmConversation` 导航到会话页，等待自动滚动读取。
6. 如果卡在「发送闸门」→ 检查 `lastInboundAt` 和 `replySeenAt` 是否已设。
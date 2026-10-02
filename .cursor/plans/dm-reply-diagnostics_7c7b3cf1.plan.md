---
name: dm-reply-diagnostics
overview: 把现有的 DM 回复链路从“快照式排查”升级成“可一键闭环”的诊断工具，并把 `replySeenAt` / `dan_reply_state` 从易丢失的会话态提升为可恢复的持久化证据。
todos:
  - id: diagnostic-trace
    content: 把 `debugTraceReplyChain(handle)` 升级成分段结论输出，覆盖 DB、收件箱、会话读取和发送闸门四个环节。
    status: completed
  - id: persist-reply-evidence
    content: 将 `replySeenAt`、`lastInboundAt` 和 `dan_reply_state` 持久化，并补上启动回填逻辑。
    status: completed
  - id: wire-panel-entry
    content: 把现有面板诊断入口接到新的闭环诊断结果，方便现场直接调用与复制。
    status: completed
isProject: false
---

# DM 回复链路闭环诊断

## 目标
- 让 `debugTraceReplyChain(handle)` 直接告诉你某个目标卡在 `db → inbox → conversation → gate` 的哪一环。
- 把 `replySeenAt`、`lastInboundAt` 和 `dan_reply_state` 从 session 级证据升级为可恢复的持久化状态，避免重载后丢证据。
- 保持现有扫描/发送逻辑不回退，只增强诊断与状态恢复。

## 计划
- 在 [unified-scheduler/chat/content_chat.js](unified-scheduler/chat/content_chat.js) 里抽出一组小型诊断辅助函数，围绕现有实现复用：
  - 现有闸门：`canSendAdNow()`（`no_peer_texts` / `missing_ice_sent_at` / `reply_not_confirmed` / `reply_confirmed`）
  - 现有会话读取：`readReplyStateAfterScroll()`、`detectDmReplyState()`、`collectPeerDmMessages()`
  - 现有收件箱命中：`pickActionableInboxRows()`、`findInboxConversationElement()`、`captureDmPeerIdFromRow()`
- 将 `debugTraceReplyChain(handle)` 从“静态快照”扩展为“分段结论 + 原因 + 建议动作”的结构化输出：
  - `db`：目标是否存在、`peerId/displayName/round/iceSentAt/replySeenAt/lastInboundAt`
  - `inbox`：行是否可见、是否命中、预览文本、是否未读、是否判定为回复
  - `conversation`：当前会话页是否读到底、`detectDmReplyState()` 的 `decision/source/texts`
  - `gate`：`canSendAdNow()` 的 `ok/reason`，并说明下一步该补哪一个字段
- 把回复证据持久化落到 `chat_target_db`：
  - 在收件箱命中回复、或会话页确认回复时，统一写入 `replySeenAt`、`lastInboundAt`
  - 把 `dan_reply_state` 复制一份到持久化存储，启动时可恢复到 session 里，避免刷新后只剩空状态
  - 启动/恢复时补一层“从持久化状态回填 session”的兼容逻辑
- 在 [unified-scheduler/ui/panel.js](unified-scheduler/ui/panel.js) 复用现有诊断入口，增加或绑定一个“查看回复链路/复制诊断”的动作，让现场可以直接调用 `debugTraceReplyChain(handle)`，而不是只看面板上的简略状态。
- 如需新增持久化 key，则补到 [unified-scheduler/shared/storage-keys.js](unified-scheduler/shared/storage-keys.js)，避免诊断状态在多个模块里散落硬编码。

## 交付结果
- 一个可直接定位卡点的 `debugTraceReplyChain(handle)`。
- 断电/刷新后仍能保留的回复证据。
- 现有面板能直接触发诊断，适合现场排障。
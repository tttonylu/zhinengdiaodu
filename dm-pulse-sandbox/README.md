# DM 只读脉冲沙盒

独立验证新版 X 会话栏的元素识别和有界脉冲，不是生产插件的组成部分。当前版本只做读取，不打开会话、不发送消息、不筛选列表、不读写生产存储，也不接入调度或 OPS。

## 已验证的页面契约

- 会话行：`a[role="option"][id^="dm-conversation-option-"]`
- 未读标记：行内 `[data-icon="icon-circle-fill"]`
- 行结构：行内 `[data-inbox-row]`
- 旧版 `[data-testid^="dm-conversation-item-"]` 和 `aria-description` 不属于本版适配器。

2026-11-09 的 Codex 浏览器实测：静态采样识别 9 行、1 条未读；刷新后前 4 次采样列表尚未就绪，约 4.3 秒出现 9 行，约 4.9 秒通过稳定窗口并输出 `unread_found`。这些结果只代表本次测试账号、页面和网络条件。

## 本地测试

需要 Node.js 24，无第三方依赖：

```powershell
npm test --prefix dm-pulse-sandbox
```

夹具中的名称、消息和数字 ID 均为虚构内容，只保留实机语义结构。真实预览正文、显示名、头像 URL 和会话 ID 不写入报告或仓库。

## Codex 浏览器只读实验

1. 用 Codex 内置浏览器打开 X，由用户手动登录测试账号。
2. 用户手动打开 `https://x.com/i/chat`，确保不在具体会话页。
3. 调用 `browser/readonly-probe.js` 的 `sampleVisibleInbox(tab)` 采样；传入 `src/pulse.js` 的 `runReadonlyPulse({ samples, now })`。
4. 用 `src/report.js` 的 `buildPublicReport(result)` 生成仅含计数、匿名摘要和结构健康的报告。

采样函数只读取 URL、列表容器、加载状态和 option 行。没有浏览器自动化常驻服务；每次实机验证明确执行、明确结束。若浏览器工具无法加载本地模块，只应在当前受控工具会话执行对应只读函数，不自行换用生产浏览器。

## 脉冲规则

- 总预算 15 秒，名义采样间隔 500ms；真实验收使用实际耗时作为 `now`。
- 有效行出现后，匿名摘要连续两次一致才确认 `unread_found` 或 `no_unread_confirmed`。
- 可信空态至少保留 5 秒，并在其后再次采样，才输出 `empty_confirmed`。
- 加载未完成、无明确空态的零行，不得解释成无未读或真空列表。
- 错误页面、未知旧结构、无效 ID 和异常行结构必须显式报错。

| verdict | 含义 |
|---|---|
| `unread_found` | 当前已渲染行中存在精确未读标记 |
| `no_unread_confirmed` | 当前有效行经过稳定采样均无未读 |
| `empty_confirmed` | 可信空态经过宽限和复核仍无会话行 |
| `loading_timeout` | 预算内没有足够证据确认列表业务状态 |
| `selector_degraded` | 行 ID 或结构不符合新版契约 |
| `unsupported_schema` | 遇到未纳入本版的旧结构 |
| `wrong_surface` | 不在会话列表根 |
| `samples_exhausted` | 输入采样不足，尚未形成最终结论 |

快照模式只覆盖已渲染行，不滚动、不追求历史全量。列表底部“正在加载更多对话”不被当成空态。

## 深扫模式（0.4.0）

`run_deep_pulse` 在快照规则之上增加有界滚动，用来覆盖虚拟列表：

- 默认预算 15 秒，滚动步长 600px，最多 3 步，每步后等待 700ms 再采样。
- 只滚动会话列表容器，不点击行、不打开会话、不发送消息、不写存储。
- 以匿名 `conversationKey` 去重，跨滚动窗口累计 `uniqueRowsSeen` 与 `uniqueUnreadRows`。
- 到达底部、连续两次没有新增行或预算用尽即停止，并把列表恢复到原滚动位置。
- 深扫报告里的 `visibleRows` 是单次窗口最多行数，`unreadRows` 是跨窗口去重后的未读数。
- `scanComplete` 表示扫描是否自然触底或确认无新增行；因预算或步数上限提前结束时为 `false`。

滚动只能覆盖虚拟列表已渲染过的范围，不等同于服务端历史全量；未打开会话，因此不能验证会话内气泡。

升级到 0.5.0 时，打开扩展弹窗，先点「重载扩展（应用新版本）」，再运行深扫或会话探针。弹窗标题旁的状态会显示当前已加载版本。

## 会话气泡探针（0.5.0）

`read_unread_conversation` 在显式 `allowOpen=true` 时执行一次受控会话探针：

- 在会话栏里找首条带 `icon-circle-fill` 的未读行，只点击这一行一次。
- 等待 URL 进入 `/i/chat/<peer>-<me>`，读取 `role="log"` 内的 `article` 气泡。
- 按气泡中心 X 坐标相对会话容器左右分区，统计 `peerBubbles` / `ownBubbles` / `unknownBubbles`。
- 统计文本气泡、链接气泡、附件组、最后一条方向、最长文本长度，以及输入框是否存在、是否为空。
- 不返回消息正文、显示名、handle、完整 URL 或真实会话 ID；不填写输入框、不按回车、不发送。
- **该操作会把会话标记为已读**，所以工具要求显式 `allowOpen=true`，且不提供默认自动调用。

2026-11-09 在 Codex 内置浏览器测试号上人工验证了新版会话页：打开首条未读「むーみん」后，`role="log"` 中读到 2 个 `article`、1 个附件组、2 个链接气泡，方向均为对方，输入框存在且为空。该次打开已将这条会话标记为已读。

同一页面按探针算法统计：

```json
{
  "bubbleCount": 2,
  "peerBubbles": 2,
  "ownBubbles": 0,
  "unknownBubbles": 0,
  "textBubbles": 2,
  "linkBubbles": 2,
  "attachmentGroups": 1,
  "lastDirection": "peer",
  "maxTextLength": 40,
  "hasComposer": true,
  "composerHasText": false
}
```

注意：气泡节点是 `div[role="article"]`，不是 `<article>` 标签；附件组是 `role="group"`，位于消息列表内而不是每条气泡内。

0.5.0 重载后的测试 Chrome 当前没有未读会话，`read_unread_conversation` 会返回 `no_unread`；因此扩展侧的真实打开动作尚未在测试 Chrome 上复现。上面的打开、标记已读和气泡统计是在 Codex 内置浏览器测试号上完成的，扩展侧代码用同一套选择器和几何分类。

弹窗里的脉冲/深扫/会话探针结果还可以回传到本地捕获服务，便于无 MCP 新会话时验证：

```powershell
node dm-pulse-sandbox/scripts/capture-report.mjs
```

服务只监听 `127.0.0.1:47322`，收到一次 POST 后打印 JSON 并退出。

## 2026-11-09 测试副本 InboxV2 适配器实机

测试副本重载为「智能调度中心【测试副本·V2适配器·勿上生产】」后，`inboxV2Diag` 在隔离世界返回：

```json
{
  "schema": "xchat-v2",
  "listReady": true,
  "rowCount": 12,
  "unreadCount": 0,
  "preciseUnreadCount": 0,
  "peerIdCount": 12,
  "displayNameCount": 12,
  "handleAvailable": false
}
```

- 12 行全部从 `row.id` 解析出 peerId；显示名和预览也全部提取成功。
- 行内没有 handle：`handleAvailable:false`。绑定必须以 DB 的 peerId 为主，displayName 为兜底。
- 当前账号 0 未读，所以 `[data-icon="icon-circle-fill"]` 精确未读分支还没有实机命中。
- 适配器只读，不点击、不发送；`inbox-watch` 的三个入口已指向它。

## 2026-11-09 内置浏览器完整链路验证

测试号会话栏 10 行、0 未读；强制首行进入会话后：

```json
{
  "urlPath": "/i/chat/1921556032637345792-2055104981112635393",
  "headerHandle": "muumin375242",
  "identity": "ok_header",
  "bubbleCount": 2,
  "peerBubbles": 2,
  "ownBubbles": 0,
  "textBubbles": 2,
  "linkBubbles": 2,
  "attachmentGroups": 1,
  "hasReply": true,
  "composerReady": true,
  "composerHasText": false,
  "canSend": true
}
```

- 新版会话头 handle 在 shadow DOM 内，必须深查 `main` 下的单段 profile 链接；`muumin375242` 已验证可提取。
- 2 条都是对方消息，composer 存在且为空；`canSend` 只是状态判断，没有发送。
- 测试副本的 `runInboxWatchTick` 已补上 `chatGo` 测试放行、回列表等待和会话头 handle 回填；之前报告里的 `identity_pending / handle:""` 是旧代码导致的。

## 2026-11-09 内置浏览器真实发送验证

在 Codex 内置浏览器测试号上完成一次真实私信发送：

```json
{
  "bubbleCount": 3,
  "peerBubbles": 2,
  "ownBubbles": 1,
  "unknownBubbles": 0,
  "lastDirection": "own",
  "messageFound": true,
  "composerLengthAfter": 0
}
```

- 测试文案 `テスト送信です。返信不要です。` 出现在右侧己方气泡，时间戳与「已发送」正常。
- 发送后输入框清空，左侧列表预览同步为 `你: テスト送信です。返信不要です。`。
- 这验证了真实发送链路：输入框写入、发送按钮、消息落库/气泡、已发送状态、composer 清空。

## 干跑回复判定

`runInboxWatchTick` 现在会在打开会话后继续计算回复路线，但不填入、不发送：

- 没有 DB 目标 / 没有 `iceSentAt`：闸门 `missing_ice_sent_at`，`messageType:none`，`wouldSend:false`。
- 有 `iceSentAt` 且会话中已有对方文本：闸门 `peer_texts_in_session`。
- dating 池、对方文本里没有年龄：路线 `greeting_ad`，准备 `ad` 话术，`wouldSend:true`，仍为 `dryRun:true`。
- job 池按 `job_intent_no` / `job_yes` / `job_reply_soft` 分流；年龄低于阈值走 `reject`。

测试专用 `seedTestTarget` 只在 DB 没有该 handle 时写入 round1 + `iceSentAt`，用来验证闸门和路线，不会覆盖已有目标。

## 验证边界

- 已实机验证：新版行、未读与认证图标的区分，刷新慢加载，稳定确认。
- 已离线验证：真实空态的宽限逻辑、持续加载超时、错误页面、结构退化、深扫跨窗口去重、会话气泡统计和报告脱敏。
- 已在 Codex 内置浏览器人工验证：会话页 `role="log"` / `article` / 输入框结构，打开未读会标记已读。
- 尚未实机验证：扩展侧自动打开并回读、深扫滚动与位置恢复、真实空账号、真实全已读列表、其他语言、长期稳定性。

第一阶段通过不代表可以上线。任何发送行为和生产接入都需要另立设计与验收，不属于本项目。

## MCP 桥（扩展 v0.5.0）

扩展带一个本地后台通道，可把检测结果交给 Codex 的本地 stdio MCP。除显式授权的会话探针外，其余工具只读。配置、工具清单、自检命令和已知边界见 `mcp-bridge/README.md`。

```powershell
npm install --prefix dm-pulse-sandbox/mcp-bridge
npm run gen:config --prefix dm-pulse-sandbox/mcp-bridge
npm run doctor --prefix dm-pulse-sandbox/mcp-bridge
```

桥只监听 `127.0.0.1`，使用随机令牌；没有任何发送或调度工具。深扫的页面副作用是临时滚动并恢复列表位置；会话探针的副作用是打开一条会话并将其标记为已读。

## 2026-11-09 实机结果（MCP 只读桥）

测试环境：新版 X 会话栏 + 生产插件测试副本 + DM Pulse Sandbox 0.3.0，同一测试浏览器配置。

脉冲：

```json
{
  "verdict": "unread_found",
  "durationMs": 520,
  "visibleRows": 12,
  "unreadRows": 1,
  "selectorHealth": {
    "listReady": true,
    "loading": false,
    "loadingMore": false,
    "structureValid": true
  }
}
```

共存（T1-A，被动、自动调度关闭）：

```json
{
  "urlPath": "/i/chat",
  "surface": "list",
  "sandboxInjected": true,
  "listboxReady": true,
  "visibleRows": 12,
  "productionExtensionDetected": true,
  "productionTestCopyDetected": true,
  "productionMainWorldBridgePresent": true,
  "productionIsolatedBridgeReachable": true,
  "productionReportsDmPath": true,
  "productionGlobalsVisibleInMainWorld": false,
  "pageSgKeyCount": 60
}
```

结论：

- 会话列表确实位于闭合 shadow DOM 中，主文档 `querySelector('[role="listbox"]')` 返回 `null`，必须递归遍历 shadow roots 才能命中。这是旧方案“一直扫描不到消息”的直接原因。
- 两个扩展可被动共存：主世界注入互不覆盖，隔离世界通过页面自带的 `__sgChatCmd` 只读桥可正常响应。
- `productionGlobalsVisibleInMainWorld: false` 属预期现象：生产副本模块运行在隔离世界，主世界本就读不到；不能用它判断生产插件是否运行。
- 本结果只代表该测试账号、页面与网络条件；未验证发送、点击、自动调度和比特浏览器实机。

## 2026-11-09 0.4.0 深扫实机（热注入）

扩展清单仍是 0.3.0 时，`chrome.scripting.executeScript({ files })` 已能注入磁盘上的 0.4.0 探针；`probeRev` 为 `0.4.0`。本次测试账号只有 12 条会话，滚动到 880px 即触底：

```json
{
  "mode": "deep",
  "probeRev": "0.4.0",
  "durationMs": 2342,
  "visibleRows": 12,
  "uniqueRowsSeen": 12,
  "uniqueUnreadRows": 1,
  "unreadRows": 1,
  "verdict": "unread_found",
  "scrollSteps": 2,
  "bottomReached": true,
  "restoredScroll": true,
  "scanComplete": true
}
```

- 滚动容器在 shadow DOM 内，是 `div` 而不是 `[role="listbox"]`；探针优先找可滚动祖先，找不到时在列表附近按可见区域和 `scrollHeight` 选容器。
- 滚动轨迹 `0 → 600 → 880`，结束后恢复原位置；没有点击、打开会话或发送。
- 该账号没有更多会话可加载，因此“跨滚动窗口新增行”的去重逻辑只在离线夹具中验证，尚未在实机出现新行。
- 清单版本要等弹窗触发重载后才变为 0.4.0；代码热注入不等同于扩展升级完成。

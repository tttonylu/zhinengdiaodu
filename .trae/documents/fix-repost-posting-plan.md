# 转帖发帖（E1 执行）板块 · 诊断与修复计划

> 链 ID：**L-REPOST · 转帖 S0**（宪法 §4）
> 板块：**E1 转帖执行**（`repost/repost-engine.js` 发帖路径）+ A2 调度（`scheduler-core.js` 拉起）
> 状态：**调查已毕，待确认根因后动码**

---

## 1. 已读文档（按文档三角顺序）

| 文档 | 读了什么 |
|------|----------|
| `docs/智能调度插件技术指导.md`（宪法） | §2 总链条、§3 少跳页、§4 **L-REPOST** 链定义、§6 自洽纪律 |
| `docs/调度工作手册.md`（手册） | §0 开工五步、§X 契约表（含 `E↔A2`、`E2↔G1`）、**§E1 执行 / E2 日程 / E3 克隆 / E4 浮层** 全文 |
| `docs/工作指导.md`（白名单） | §6 E 板块表格、§11 巨石改动纪律、§12 检查清单、§13 变更记录（4.6.1~4.6.4 全部） |
| `docs/ARCHITECTURE.md` | 扩展分层、`repost/` 目录归属、`_archive/` 禁止当源码 |

## 2. 转帖发帖的代码全景（E1 发帖路径）

`repost/repost-engine.js` 的 `repostTweet(article, sourceHandle)` 是发帖核心，路径完整：

```
runOnce()                          ← scheduler-core 通过 sg-repost-command 拉起
  ├─ 检查熔断/冷却/日配额
  ├─ 导航到来源号主页 x.com/<source>?lang=ja
  ├─ findLatestTweets()            ← 虚拟列表下滚扫描可转帖
  └─ repostTweet(article, handle)  ← ★ 发帖路径
       ├─ dedupe / 跳视频 / 跳非日文
       ├─ 提取正文、去 @、追加链接
       ├─ mediaGateOpen → 下图 (图片 blob)
       ├─ 开 compose / 清残留
       ├─ insertEditorText()       ← 拟人键盘输入(4.6.1)
       ├─ 上传图片 (fileInput+DataTransfer)
       ├─ scrubEditorMentions()    ← 发送前二次清 @
       ├─ waitForEnabled(postBtn) → humanClick(发送)
       └─ 确认成功(编辑器消失/toast/URL变化) → markPosted + bumpDaily
```

## 3. 已做排查结论（代码**没有丢**）

| 检查项 | 结果 |
|--------|------|
| `repost/repost-engine.js` | 完整：`repostTweet`/`insertEditorText`/`findLatestTweets`/`closeCompose`/`recover`/导出块 `window.RepostEngine` 全在，相对 HEAD 净 **+241 行** |
| `repost/repost-tracker.js` `repost-panel.js` `profile-clone.js` | 都在，净增长 |
| `shared/engine-utils.js` | `typeTextHumanLike`/`humanClick`/`looksLikeAntiSpam`/`markAntiSpamCooldown`/`segmentForTyping` 全在 |
| `manifest.json` 引用的 59 个文件 | **0 缺失、0 空文件、0 语法错误**（逐个 `node --check`） |
| `chat/content_chat.js` 相对 HEAD | 只少 55 个**守箱**函数（inboxQueue* / runInboxWatchTick 等），**无一个转帖函数**，全项目残留引用 = **0** |
| 全量测试 | **52/52 通过** |

> `git diff` 里看似大量「-function …」删除，实测是 **LF→CRLF 行尾噪声**（`normalizeServerUrl`/`mediaGateOpen`/`parseAgeFromInbound`/`canSendAdNow` 等当前文件仍各命中 1 处定义）。

## 4. 事件解释（用户贴的两条日志不是报错）

```
16:55:42 chat.host_reconcile
16:55:42 chat.fan_roster_baseline_clear
```

两者**成对**由 `content_chat.js::reconcileChatHostIdentity()` 发出：当 `getMyHandle()`（读导航栏 `AppTabBar_Profile_Link`，指向登录本号）与 `sessionStorage.dan_target_username` 不一致时，清一次私信会话脏数据。这是**换号对账的正常动作，不是异常**，也不清转帖状态。它出现在 16:55 说明转帖导航到来源号主页时触发了私信模块的重新对账——是「转帖导航→页面重载→chat 初始化对账」的连带表现，而非转帖失败的直接原因。

## 5. 真正的疑点（唯一没定论的）

代码静态核查下「转帖发帖源码缺失」不成立。剩下的可能只有两条，且都指向**运行时/部署**而非源码：

1. **加载的扩展 ≠ 本目录代码**：改完代码但 Chrome/比特浏览器里 `chrome://extensions/` 未重载，或加载的是另一份拷贝（NAS 打包 / 旧 zip），导致「改了不生效」。
2. **浏览器控制台当前仍有具体报错**：`findInboxConversationElement` 修复后，若又有新的运行期错误，需要**当前** F12 控制台的报错原文来定位。

## 6. 计划（确认根因后再动码）

### 阶段 1 —— 定位（不动码）
- [ ] 确认扩展加载目录 = `d:\下载\智能调度\unified-scheduler`，且已「重新加载扩展 + 刷新 X 页面」
- [ ] 抓当前转帖失败时 F12 控制台的报错原文 + Service Worker 日志（`background.js` 的 `Logger` 输出）
- [ ] 若控制台干净但转帖仍不动 → 抓面板「只转帖」按钮点击后的 `sg-repost-command` 是否派发、`runOnce` 是否进入

### 阶段 2 —— 修复（锁定子 ID，一次只改一个）
- 若根因是 **E1**（发帖执行 bug）→ 只改 `repost/repost-engine.js`，先改手册 §E1 再改码
- 若根因是 **A2**（拉起/导航）→ 只改 `scheduler-core.js`，先查 `E↔A2` 契约
- 若根因是**部署/加载** → 不属代码，给重载/重打包步骤

### 阶段 3 —— 验收（按手册 §E1 终态）
- [ ] 发帖成功后 `sg_repost_posted_ids` 增一条、`sg_repost_last_ok_at` 刷新、日配额 +1
- [ ] 面板「新号就绪」发帖状态正确（`hasPostedOk` 命中）
- [ ] `node --check` + 全量测试通过；manifest bump；工作指导 §13 记一笔

## 7. 需要你拍板的唯一输入

请提供**当前**（重载扩展后）转帖失败时的 **F12 控制台报错原文 / 截图**，或确认「加载的扩展目录就是本仓库 `unified-scheduler`」。我拿到后按阶段 2 锁子 ID 动码，不再散改。
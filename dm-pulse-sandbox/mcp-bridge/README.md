# DM Pulse MCP Bridge（只读）

把测试浏览器里的 DM Pulse Sandbox 扩展，接到 Codex 的本地 stdio MCP 上。Codex 可以直接读取会话栏脉冲和共存状态，不需要你手敲控制台命令。

## 架构

```text
Codex
  ↓ stdio MCP（本机进程）
dm-pulse-bridge/server.mjs
  ↓ ws://127.0.0.1:<port>/bridge（随机令牌）
DM Pulse Sandbox 扩展 background.js
  ↓ chrome.scripting.executeScript({ world: "MAIN" })
X 页面（含 shadow DOM）
```

- 只监听 `127.0.0.1`，非回环连接直接拒绝。
- 首次握手必须携带本地随机令牌，令牌长度 32，使用摘要后定长比较。
- 帧上限 64KB，超限在解析前拒绝。
- 所有返回值经过脱敏：凭证、Cookie、handle、显示名、消息正文、头像、完整 URL 一律移除；绝对 URL 只保留 path。

## 六个工具

| 工具 | 作用 |
|---|---|
| `health` | 桥状态、回环绑定、已连接会话数 |
| `list_sessions` | 扩展版本、协议版本、心跳时间、是否过期 |
| `run_pulse` | 有界只读脉冲：只计数行与未读，不点击、不打开、不发送 |
| `run_deep_pulse` | 有界深扫：滚动虚拟列表并跨窗口去重统计，结束后恢复滚动位置；不点击、不打开、不发送 |
| `read_unread_conversation` | 显式 `allowOpen=true` 时打开首条未读会话并读取气泡统计；会标记已读，不发送 |
| `get_coexistence_state` | URL 路径、界面类型、列表就绪、沙盒注入、生产副本主世界/隔离世界桥是否可达 |

没有发送、关注、转帖、启动调度等工具。`run_deep_pulse` 的页面副作用是临时滚动会话列表并恢复；`read_unread_conversation` 会打开一条会话并将其标记为已读，必须显式传 `allowOpen=true`，且不填写输入框、不发送。

0.4.0+ 后台在请求未携带 `deep` 参数时默认执行深扫；本桥的 `run_pulse` 会显式传 `deep: false` 保持快照语义，`run_deep_pulse` 显式传 `deep: true`。

## 首次配置

```powershell
npm install --prefix dm-pulse-sandbox/mcp-bridge
npm run gen:config --prefix dm-pulse-sandbox/mcp-bridge
```

会在两处写入同一份随机令牌：

- `dm-pulse-sandbox/mcp-bridge/bridge-config.json`
- `dm-pulse-sandbox/extension/bridge-config.js`

两个文件都已加入 `.gitignore`。更换令牌后必须重新加载扩展。

## 注册到 Codex

```powershell
codex mcp add dm-pulse-bridge -- node "D:\下载\智能调度\dm-pulse-sandbox\mcp-bridge\server.mjs"
codex mcp list
```

新建 Codex 会话后，`dm-pulse-bridge` 的四个工具才会出现在工具列表里。

## 自检

```powershell
npm run doctor --prefix dm-pulse-sandbox/mcp-bridge
npm run doctor --prefix dm-pulse-sandbox/mcp-bridge -- --pulse
npm run doctor --prefix dm-pulse-sandbox/mcp-bridge -- --deep
npm run doctor --prefix dm-pulse-sandbox/mcp-bridge -- --read
```

`doctor` 会自己起重连窗口并等待扩展握手：

- 退出码 `0`：扩展已连上，已输出会话、健康、共存状态。
- 退出码 `2`：`NO_SESSION`，通常是扩展没重新加载，或浏览器没打开 `x.com/i/chat`。
- `EADDRINUSE`：Codex 已经启动了同一端口的桥，直接在会话里调用 MCP 工具即可。

## 测试

```powershell
npm test --prefix dm-pulse-sandbox/mcp-bridge
```

覆盖：令牌校验、非 hello 首帧拒绝、回环绑定、请求/响应关联、超时、断线清理、脱敏、工具白名单，以及真实 stdio MCP 端到端转发。

## 已知边界

- 已做：快照脉冲、虚拟列表有界深扫、跨窗口唯一行/未读聚合、滚动位置恢复、受控会话气泡统计。
- 未做：发送消息、自动回复、持久化、比特浏览器专项适配。
- 比特浏览器 154 内核满足 MV3 与 `world: "MAIN"` 要求，但尚未实机验证；验证前不要接入生产账号。
- `chrome.management` 只用于返回“是否检测到生产/测试副本”的布尔值，不返回扩展列表。
- 生产副本的模块运行在隔离世界，主世界无法直接读到 `SgInboxWatch`。共存检测改用页面自带的主世界→隔离世界只读桥 `__sgChatCmd('isDmPath')`，因此 `productionGlobalsVisibleInMainWorld` 为 `false` 属正常现象，不代表生产副本未运行。
- 若扩展与正式版加载在同一浏览器配置，X 的 `localStorage/sessionStorage` 同源共享，不能视为隔离环境。

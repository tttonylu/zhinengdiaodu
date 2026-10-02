# SCRM 常驻浏览器 + 轻量刷新

日期：2026-08-02  
状态：已确认并实现

## 背景

当前 `scrm-nas` 每 30 分钟冷启动 Chrome → 完整 `goto` 分享页 → 密码验证 → 全表翻页。  
单次常因 `Page.goto` 超时拖到 2–3 分钟；cookie 虽落在 `.chrome_data`，但抓完就关浏览器，没有真正「一直登录」。

OPS 门禁 stale = **45 分钟**无有效快照则卡私信。需要工作时段更及时，同时降低反复进页带来的风控压力。

## 领域假设（已确认）

1. 监控号配置正确、分享链接正确。
2. **一旦某客服号在列表中被成功抓到过，后续不会整号从列表消失**；只会变成离线 / 异常离线 / 平台关闭等状态。
3. 因此：第二次及以后扫出「未找到」，优先视为**抓取失败**（翻页未刷新、DOM 未就绪等），而不是号被删。

## 目标

| 目标 | 指标 |
|------|------|
| 缩短单次耗时 | 稳态刷新目标 **≤ 30–60s**（不含首次冷启动） |
| 降低风控面 | 工作时段少做完整进页；非工作时段少碰页面 |
| 门禁新鲜度 | 工作时段快照间隔远小于 45min stale |
| 不误杀 | 历史已定位的号，偶发扫丢不立刻 `not_found` 卡门禁 |

非目标：不改 SCRM 网页本身；不改插件私信逻辑（仅间接受益于更稳的 gate）。

## 方案总览

**进程内常驻 Chrome（方案 A）+ 首次定位 / 后续轻刷 + 历史状态继承。**

```
容器启动
  → 启动 persistent Chrome（.chrome_data）
  → 打开分享页并完成一次登录（cold）
  → 全表翻页定位监控号（locate）
  → 上报 OPS

工作时段循环（约 12min ± 抖动）
  → 轻量 refresh（reload 或停留页再抽）
  → 更新已定位号的 online/status
  → 上报 OPS（含继承逻辑）

非工作时段
  → 不刷列表（浏览器可挂着）
  → 可选：极低频保活 reload（默认关，或每天 1 次）
```

## 组件与职责

### 1. BrowserSession（新建，可落在 `scraper_final.py` 或拆 `browser_session.py`）

- 持有 `playwright` / `persistent_context` / `page` 生命周期。
- API 建议：
  - `ensure_ready()` — 无浏览器则启动；页面无数据则 cold 登录
  - `cold_open()` — `goto` + 密码 + 等「共 N 条」
  - `light_refresh()` — `page.reload`（或等价）；已在列表且能读到 total 则跳过完整密码流
  - `close()` — 进程退出时清理
- 崩溃 / 连续失败 → 重建 context 再 `cold_open`。

### 2. 抓取模式

| 模式 | 何时 | 行为 |
|------|------|------|
| `locate` | 启动后首次；监控号列表变更；连续轻刷失败需重定位 | 全表翻页（保留指纹等待 + 去重），建立 `located_agents` |
| `status` | 工作时段常规刷新 | 轻刷后抽取；**优先在已见页/筛选结果中更新状态**；不必为「会不会消失」每次翻完全部页 |
| `recover` | 轻刷后读不到表格 / Cloudflare / 需重新验证 | 走 `cold_open`，必要时再 `locate` |

**`status` 模式细节（建议实现顺序）：**

1. `light_refresh()`，等「共 N 条」或表格行出现。
2. 抽当前可见页；若命中全部监控号 → 结束。
3. 未命中的号：若本地 `located_agents` 已有记录 → **本轮不标 not_found**，进入「继承」；可选再翻少量页尝试更新。
4. 仅当某号**从未成功 locate 过**（新配置 / 首次）→ 才升级为完整 `locate`。

> 若 SCRM UI 有按 ID 搜索/筛选，后续可加成「点搜再抽」进一步缩短；首版不依赖，用轻刷 + 有限翻页即可。

### 3. 调度（`main.py`）

| 时段 | 间隔 | 动作 |
|------|------|------|
| `workStart`–`workEnd`（现有配置） | **12 分钟**，±60–120s 抖动 | `status` 刷新 + 上报 |
| 非工作时段 | 跳过列表抓取 | 浏览器保持；不关 context |
| 启动 | 立即 | `cold` + `locate` 一次 |

配置项（写入 `config.json`，带默认）：

- `scrapeIntervalMin` = 12
- `scrapeJitterSec` = 90
- `idleKeepalive` = false（或 `daily`）

PushPlus：保持「未找到（真·首次 locate 失败）/ 状态有变化 / 异常」才推，避免 12 分钟刷爆。

### 4. 状态继承与 OPS 上报

本地持久化（建议 `last-snapshot.json` 扩展，或旁路 `located-cache.json`）：

```json
{
  "located": {
    "@871sbroc": {
      "firstSeenAt": "...",
      "lastSeenAt": "...",
      "lastGood": { "online": true, "statusText": "在线", "nickname": "...", "...": "..." }
    }
  }
}
```

**上报规则：**

| 情况 | `agents` | `notFound` | `snapshot_at` | 门禁影响 |
|------|----------|------------|---------------|----------|
| 本轮抽到该号 | 用新数据；更新 `lastGood` | 不含 | 更新 | 正常 |
| 本轮未抽到，但 `located` 有历史 | **回填 `lastGood`**，可加 `stale_row: true` / `inherited: true` | **不含** | 若本轮页面可读（有 total/表格）则更新；否则不更新以免「假新鲜」 | 按继承的 online 判断；避免误 `未找到` |
| 本轮页面不可读（刷新失败） | 不覆盖上次成功快照 | — | **不更新** | 沿用旧快照；超过 45min 仍 stale 卡死（安全网） |
| 监控号变更后从未 locate 成功 | 无 | 含新号 | 更新（若页面可读） | `未找到`，不放行 |

**默认策略（对应此前选项 1）：**  
号不会消失 → 继承上次状态，不因单次漏扫报 `not_found`。  
45 分钟完全抓不到可读页面 → 仍靠 OPS stale 停私信。

### 5. 与现有翻页修复的关系

已部署的「翻页等指纹变化 + 去重 + 大小写不敏感」保留，用于 `locate` / `recover`。  
`status` 模式不再把「翻到重复页就整号 not_found」当成业务结论。

## 错误处理

| 症状 | 动作 |
|------|------|
| `goto`/reload 超时但表格已在 | 视为可读，继续抽 |
| 连续 2 次轻刷无 total | `recover`：重建或 cold_open |
| 重建后仍失败 | 推送异常；不写假 snapshot_at |
| Chrome 进程死 | `ensure_ready` 重建 persistent context |

## 文件改动范围

- `test-env/scrm-monitor/scraper_final.py` — Session + locate/status/继承
- `test-env/scrm-monitor/main.py` — 调度间隔/抖动；常驻不每次关浏览器
- OPS：`scrm-status-repo.js` **原则上不改**（继续吃上报的 agents/notFound/snapshot）；若上报带 `inherited`，UI 可后续显示「继承」，非首版必须
- 部署：同步到 `scrm-nas` 的 `/app` 与 host mirror

## 验收

1. 冷启动后首次能 locate `@…` 并 `allow_chat` 正确。  
2. 第二次起日志显示 `mode=status`，耗时明显短于冷启动（目标 ≤1min）。  
3. 人为制造翻页失败（或中断抽取）时：已 locate 号**不上报 not_found**，gate 不因「未找到」关闭。  
4. 停止抓取 >45min：gate `stale=true` 仍关闭。  
5. 工作时段外：调度跳过，无频繁进页。  
6. 修改监控号：对新号走 `locate`，未出现前可 `not_found`。

## 风险与回退

- 常驻 Chrome 内存：Docker 已有；异常时重建。  
- 继承状态可能短时间「显示在线但实际已离」：可接受；真实离线会在下一次成功 `status` 更新；最坏 12min 级延迟。  
- 回退：配置 `residentBrowser=false` 恢复旧「每次 launch+close + 30min」路径（实现时加开关）。

## 待你确认的默认项

1. 工作间隔 **12 分钟 ± 抖动** — 可改 10/15。  
2. 漏扫继承 = **保留上次 online/status**（不是立刻卡门禁）。  
3. 非工作时段默认 **不保活刷新**。  
4. 首版不做 UI 搜索框优化。

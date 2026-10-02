# 缓存自愈方案 B

> 日期：2026-07-30  
> 状态：已确认 · B + C（4.1.28 recreate）+ 媒体清扫（4.1.30）  
> 范围：扩展侧定时清 X/媒体缓存 + 白屏/内存受控硬刷新或关 tab 重建 + 刷新熔断

---

## 1. 目标

解决：地址栏 URL 已变，页面白屏/转圈；手动清浏览器缓存后能好一阵。多实例场景下避免「清缓存 + 硬刷新」演变成刷新/握手风暴。媒体图/视频缓存堆积导致卡顿时，勤清 HTTP/CacheStorage（不清 cookies）。

**成功标准：**

- 每约 **45** 分钟自动清理 X/媒体相关 HTTP/CacheStorage 缓存，且不清 cookies / localStorage
- 堆≈300MB（代理，扩展读不到磁盘缓存精确 MB）时可只 purge、不重建 tab
- URL 已切换但主内容区长时间无有效 DOM 时，走「清缓存 → 限流硬刷新/重建」自愈
- 同一 Chrome profile 内刷新熔断：间隔 ≥10 分钟，滚动 60 分钟内 ≤2 次；`sg_paused_till` 未过期时禁止刷新
- 自动模式下引擎禁止私自 `reload`；内存过高只 `sg_request_heal`，由 background 裁决

---

## 2. 非目标（硬边界）

| 不做 | 原因 |
|------|------|
| 清 cookies / 登录态 | 会掉号 |
| 清业务 localStorage / chrome.storage 调度状态 | 打断轮转与恢复 |
| 精确按磁盘缓存 300MB 计数 | Chrome 扩展无 API |
| 改号池 / OPS 服务端 | 与本问题无关 |
| 放宽 page-router 3 次跳转冷却 | 自愈须服从现有防风暴逻辑 |
| 定时任务主动 reload 所有 tab | 多实例整点齐刷 |

---

## 3. 架构

```
chrome.alarms (sg_cache_purge, 45min)
        │
        ▼
background.js  purgeXCache()  —— 仅 cache + cacheStorage；15min 防抖
        │                      origins: x/twitter + pbs/abs/video/ton.twimg
        │
content (scheduler-core / chat 内存监控)
        │  堆≥300MB → sg_purge_cache
        │  堆>400MB → sg_request_heal (recreate)
        ▼
background.js
        │  熔断 (sg_heal_last_at / sg_heal_window)
        │  pausedTill 门禁
        │  purge → reload 或 recreate
        ▼
当前 X tab 硬刷新或关 tab 重建（登录保留）
```

原则：**清缓存可定时；硬刷新/重建必须限流且单点裁决。**

---

## 4. 行为细则

### 4.1 默认参数

| 项 | 值 |
|----|----|
| 定时清缓存 | 每 **45** 分钟（`chrome.alarms` → `sg_cache_purge`） |
| purge 防抖 | 同 profile 距上次成功 purge ≥**15** 分钟 |
| 清的类型 | `cache: true`, `cacheStorage: true` |
| origins | x.com / twitter.com / pbs / abs / **video** / **ton** .twimg.com |
| 白屏判定 | 调度在跑时，健康 DOM 持续缺失 ≥45s（URL 变化后重置宽限期） |
| 刷新熔断 | 同 profile：距上次 heal ≥10min；滚动 60min 内 ≤2 次 |
| 与冷却关系 | 请求携带 / 校验 `sg_paused_till`；未过期 → 拒绝 reload |
| 清缓存代理阈值 | 堆 ≥**300MB** 或 DOM ≥6000 → 仅 `sg_purge_cache` |
| 重建阈值 | 堆 >**400MB** 或 DOM >8000 → `reason=memory` recreate heal |

### 4.2 健康 DOM（调度探针）

**4.1.26 起**：禁止单靠侧栏壳判定健康。纯白 SPA 常残留 `AppTabBar_*` / 空 `primaryColumn`，旧逻辑会永久「健康」→ 看门狗永不 heal。

任一存在即视为健康：

- `[data-testid="UserCell"]` / `article[data-testid="tweet"]` / 发帖框 / 资料编辑框
- DM 相关：`dmComposerTextInput` / `conversation` / `DMConversation` / `dm-conversation-item-*`
- `primaryColumn` 内 `UserName` / `sendDMFromProfile`
- `primaryColumn` 去空白文本 ≥80 字（空壳骨架通常远低于此）

私信侧：心跳白屏≥45s 也会 `sg_request_heal`；主循环软跳转不得重置 `dan_last_healthy_time`（用独立 `dan_last_soft_recovery_at` 冷却）。

SW 熔断仍生效：间隔 ≥10min；滚动 1h 内 ≤2 次；`sg_paused_till` / ChallengeGuard 拒绝硬刷。

### 4.3 消息协议

| action | 方向 | 行为 |
|--------|------|------|
| `sg_request_heal` | content → SW | `{ reason, pausedTill?, mode? }`；SW 返回 `{ ok, skipped?, reason?, mode? }` |
| `sg_purge_cache` | content → SW | 仅 purge（15min 防抖）；不 reload |
| （alarm）`sg_cache_purge` | SW 内部 | 只 purge，不 reload |

### 4.4 chrome.storage.local 熔断键

- `sg_heal_last_at` — 上次成功硬刷新/重建时间戳
- `sg_heal_window` — 近 60 分钟内成功 heal 的时间戳数组
- `sg_heal_last_mode` — `reload` | `recreate`
- `sg_cache_last_purge_at` — 上次定时/顺带清缓存时间（可观测）

---

## 5. 文件变更

| 文件 | 变更 |
|------|------|
| `unified-scheduler/manifest.json` | `permissions` 增加 `browsingData` |
| `unified-scheduler/background.js` | `purgeXCache`、alarm、`sg_request_heal` + 熔断 |
| `unified-scheduler/scheduler-core.js` | 白屏探针 + paused 门禁 |
| `unified-scheduler/chat/content_chat.js` | 内存超限改为 `sg_request_heal` |

`SchedulerGate.blockReloadInAuto` 保持：自动模式引擎不得直接 `reload`。

---

## 6. 方案 C（4.1.28 已启用）

当页面特别卡（堆内存/DOM 爆）或白屏硬刷无效时：

- `tabs.create` 同窗同 URL → `tabs.remove` 旧 tab（先开再关，避免丢页）
- 触发：`reason=memory|lag` 或 `mode=recreate`；白屏若本小时内已做过 `reload` 仍复发 → 升级 recreate
- recreate 失败则回退 `tabs.reload(bypassCache)`
- 服从与 B 相同的全局熔断（≥10min；滚动 60min ≤2）
- 自动模式：新 tab 读 `localStorage.sg_state.running` 恢复调度（session 旗标清空后 prepareFresh）

### 4.3 消息协议（补充）

| 字段 | 说明 |
|------|------|
| `mode` | 可选 `reload`（默认）/ `recreate` |
| 返回 `mode` | 实际执行的模式 |

`sg_heal_last_mode` 记上次成功模式，供白屏升级判断。

---

## 7. 验收清单

- [ ] `sg_request_heal` reason=memory：关旧开新、登录仍在、自动模式恢复
- [ ] 白屏首次：reload；同小时再白屏：recreate
- [ ] 3 分钟内连续 heal：第 2 次起被熔断跳过
- [ ] `sg_paused_till` 生效期间 heal 被拒绝
- [ ] 定时 alarm 约每 45min 仅清缓存、不刷新所有 tab（含 video/ton）
- [ ] 堆≥300MB：`sg_purge_cache` 成功且不掉登录；15min 内重复请求 skipped
- [ ] 自动模式内存 >400MB 走 recreate，不再直接 `location.reload`

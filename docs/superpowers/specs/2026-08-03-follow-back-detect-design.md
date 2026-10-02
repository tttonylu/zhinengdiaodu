# 回关检测加强（A1 被动 + A2 轻量主动）

日期：2026-08-03  
状态：已实现（插件 3.0.29）

## 背景

运营口径：真实回关率约 **5–10%** 属正常；看板今日仅约 **0.3%**，高度怀疑 **检测漏记**。  
现有逻辑：

- 通知页：碰巧打开才扫一次，不主动跳转
- 主路径：私信扫自己粉丝列表再交叉（绑在私信节奏上）

## 目标

| 目标 | 说明 |
|------|------|
| 降低漏记 | OPS `follow_back` 更接近真实回关 |
| 不抢主任务 | 关注/私信进行中不跳转 |
| 可关闭 | 默认开主动扫，可用 localStorage 关掉 |

非目标：蓝 V/带链质量过滤（方案 B/C）；不改 OPS 入库规则。

## 方案

### A1 被动加强

- SPA 路由进入 `/notifications` 即扫（hook `pushState`/`replaceState` + `popstate`）
- 停留通知页：MutationObserver + 定时再扫
- 通知单元格内提取**全部**关注者 handle（多人合并通知）
- 停在自己的 `/followers` 时，定期 `UserCell` → `reportFromFollowers`

### A2 轻量主动（可配置）

- 默认开启；间隔默认 **35 分钟**（`sg_fb_active_scan_min`）
- 仅当关注、私信均未在跑时，短途前往 `/notifications` 扫描后返回
- 用 `sg_fb_scan_hold` 让养号 tick **暂不**把页面拽回 home
- 扫完清 hold，回到出发页（优先原 URL，否则 `/home`）

配置键：

| Key | 默认 | 含义 |
|-----|------|------|
| `sg_fb_active_scan` | 开（非 `"0"`） | `"0"` 关闭主动扫 |
| `sg_fb_active_scan_min` | `35` | 主动扫间隔（分钟） |
| `sg_fb_last_active_scan_at` | — | 上次主动扫完成时间 |

## 改动文件

- `unified-scheduler/follow/follow-back-detect.js` — 主逻辑
- `unified-scheduler/nurture/nurture-engine.js` — 尊重 `sg_fb_scan_hold`
- `unified-scheduler/manifest.json` — 版本 bump

## 验收

1. 打开通知页：控制台出现 `[回关检测] 通知上报`
2. 自动模式养号中空闲约间隔后：短暂进通知再回，且养号不立刻拽回打断扫描
3. `sg_fb_active_scan=0` 后不再主动跳转
4. 关注/私信运行中不触发主动扫

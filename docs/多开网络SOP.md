# 多开网络 · 运维 SOP（4.4.1+）

指纹/IX **一窗一 Chrome 档**，扩展 storage 不跨窗。握手慢主要靠：**分批开机 + 代理容量 + 插件错峰**，别指望扩展 alone 治本。

## 开机与容量

- 同机矩阵建议分批开：每批错开 **1–2 分钟**，勿整机同时起 30–50 窗。
- 代理尽量 **一窗一路**；共用一个出口易打满 CONNECT。
- 勿对全部窗同时「清缓存 / 刷新 / 杀进程整点重启」。
- 验收口径：握手改善 ≠ 无限加窗。
- **未灌水（白 X 壳）禁止连环换号/同 URL 硬跳**；同博主内优先 click / `history.back`；三引擎共用 `sg_shared_soft_heal_at` 软愈冷却（约 60s）。

## 插件侧已做（勿再手工齐刷）

| 项 | 行为 |
|----|------|
| 定时 purge | 每档按 `bit_id` → handle → `installationId` 哈希，下次清缓存 **±12–20min** 抖动 |
| 冷启动 | **已取消** 4 分钟 idle（4.3.9 起开跑即启引擎） |
| S0 转帖 | 开跑点后 **+0–240min** 种子抖动（可配 `repost_start_jitter_max_min`），避免齐跑卡死 |
| 导航间隔 | 默认 `nav_min_interval_ms=45000`（OPS 可调；残留 13s 旧默认会被抬到 45s） |
| 延迟空壳 | `loading_shell` 宽限 ~105s；**首次只 soft reload、不 purge** |
| 媒体 | **4.4.0 默认禁图**（`media_load_mode=off`；纯 DNR 拦 pbs/video/ton/pbs-mu.twimg.com，无 DOM 硬拦）；转帖/克隆走 fetch 不受影响 |
| Aw Snap | SW 检测崩溃 title / `chrome-error`（含日文エラー）→ 熔断内 recreate |
| 软导航（4.2.61） | 粉丝页灌水闸；关注/破冰/养号优先 click·back；共用 soft_reload 冷却 |

## OPS 阈值

- `media_load_mode`：`off`（默认禁图，纯 DNR）| `on`（放行）— **系统配置 → 调度参数 → 媒体加载**（`auto` 已废弃，按 off 处理）
- `chat_script_pool`：`dating`（交友）| `job`（兼职粉）— **系统配置 → 调度参数 → 话术池**
- `nav_min_interval_ms`：多开建议 40000–60000（默认 45s）

## 禁图历史与踩坑记录

| 版本 | 方案 | 问题 | 结局 |
|------|------|------|------|
| ~4.3.1 | DNR + DOM prototype 劫持（双层拦截） | ① 插件崩溃（Aw Snap）；② DM 私信无法进入 | 全线撤退，默认 on |
| 4.3.14 | 默认放行（`media_load_mode=on`） | 占内存/带宽 | 权宜之计 |
| **4.4.0** | **纯 DNR 禁图，移除 DOM 硬拦** | — | 重启禁图，无崩溃风险 |

**踩坑教训：**
- DOM prototype 劫持（改写 `img.src` / `setAttribute` 等）是 Aw Snap 崩溃的根因，与 X 的 React/Lexical 渲染引擎冲突
- DNR 只拦 `image`/`media` resourceType，不拦 `fetch`，所以转帖/资料克隆拉图不受影响，无需开闸
- DNR 的 `requestDomains` 只配 `pbs/video/ton/pbs-mu.twimg.com`，**不含 `abs.twimg.com`**（头像/emoji/壳资源），DM 私信核心功能不受影响

## IX 注意

若指纹壳 **DNR 无效**：时间线被动图仍会占带宽；克隆/转帖走 fetch 不受影响。用一台 IX 实机看 Network：页内 img 是否被 block。

## 回滚

OPS 把 `media_load_mode` 设为 `on` 即卸禁图规则，1 分钟内全量生效。

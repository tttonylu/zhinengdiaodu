# 禁图系统重做计划：场景化开关 + 去 DOM 硬拦

> 归属子ID：K2（缓存自愈 + 多开错峰 + 媒体闸）
> 文档版本：v1.0
> 日期：2026-10-03

---

## 一、问题背景与根因分析

### 1.1 现状

当前版本（4.3.14+）`media_load_mode` 默认 `on`（即禁图已停用），用户反映资源占用大，想重新启用禁图。但之前开启禁图时存在两个严重 bug：

1. **插件容易崩溃（Aw Snap / 渲染进程崩溃）**
2. **DM 私信无法进入（页面加载失败 / 输入框未就绪）**

### 1.2 现有架构回顾

现有禁图系统由三层组成：

| 层级 | 实现 | 文件 |
|------|------|------|
| 网络层 | DNR 静态 + 动态规则，拦 pbs/video/ton/pbs-mu.twimg.com 的 image/media | `rules/twimg-block.json` + `background.js` |
| DOM 层 | MAIN world 劫持 `img.src` / `video.src` / `setAttribute` 等原型 | `shared/media-block-main.js` |
| 视觉层 | CSS 隐藏 `tweetPhoto` / `videoPlayer` 容器 | `shared/media-block.css` |

闸门机制：`mediaGateRef` 引用计数 + 3 分钟墙钟超时。转帖 / 资料克隆时临时开闸拉图。

### 1.3 Bug 根因分析

#### Bug 1：插件崩溃 → 根因是 MAIN world 的 DOM 原型劫持

`media-block-main.js` 在 `mode=off` 时会调用 `installHardDomPatchesOnce()`，做以下事情：

- 劫持 `HTMLImageElement.prototype.src` / `srcset` 的 setter
- 劫持 `HTMLVideoElement.prototype.src` / `poster` / `srcObject`
- 劫持 `HTMLSourceElement.prototype.src`
- **全局劫持 `Element.prototype.setAttribute`**

**为什么会崩溃：**

1. **`setAttribute` 全局劫持影响面极广** — 所有 DOM 元素的所有属性设置都会经过自定义逻辑，X/Twitter 的 React 前端大量使用原生 DOM 操作，极易触发边界情况
2. **原型链污染与框架冲突** — React / Lexical（发帖/私信编辑器）对原生 DOM API 有强依赖，原型被改写后可能触发不可预期的行为，最终导致渲染进程崩溃（Aw Snap）
3. **与自愈机制形成恶性循环** — 禁图 → 崩溃 → recreate → 重新加载禁图 → 又崩溃（4.3.5 的 Aw Snap 自愈可能反而加剧了这个问题）

**历史佐证（工作指导.md 变更记录）：**
- 4.3.2："现网紧急把 media_load_mode 改回 on 止损「输入框未就绪」"
- 4.3.14："停禁图+确认改我方气泡" — 直接默认 on，相当于全线撤退

#### Bug 2：DM 无法进入 → 根因是 DNR 全局拦截 + 私信页面无开闸

虽然 4.3.1 已经收窄了拦截范围（不拦 `abs.twimg.com` / 头像 / emoji），但：

1. **DNR 是全 tab 全局生效的** — 禁图开启后，所有 x.com 标签页的 pbs.twimg.com 图片都被拦
2. **私信页面没有开闸逻辑** — 进入 `/messages` 或 `/i/chat` 时，`mediaGateRef=0`，DNR 拦截生效
3. **私信页面初始化依赖 twimg 资源** — DM PIN 码页面、消息列表、对话界面的某些关键媒体资源（如加密相关 UI、头像之外的装饰元素、消息媒体预览等）加载失败会导致页面白屏或初始化卡死，表现为"无法进入私信"或"输入框未就绪"

**历史佐证：**
- 4.3.1 明确写了"护 DM，避免进箱才开闸" — 说明当时已经意识到 DM 有问题，但只做了部分缓解（不拦 abs.twimg）
- 4.3.2 紧急把 mode 改回 on 止损"输入框未就绪" — 进一步印证了禁图与 DM 的冲突

---

## 二、改进方案：场景化禁图

### 2.1 核心思路

**不再"一刀切"全局禁图，而是按页面场景智能开关：**

| 场景 | 策略 | 实现方式 |
|------|------|----------|
| 首页时间线 / 探索页 / 趋势页 | **禁图**（省资源主力） | DNR + CSS 隐藏 |
| 关注/粉丝列表 | **禁图** | DNR + CSS 隐藏 |
| 他人资料页（非转帖时） | **禁图** | DNR + CSS 隐藏 |
| 转帖下载图片时 | **临时开闸** | 转帖引擎 `mediaGateOpen/Close`（现有） |
| 资料克隆拉图时 | **临时开闸** | 克隆引擎 `mediaGateOpen/Close`（现有） |
| **DM 私信页面**（/messages, /i/chat） | **自动开闸** | 路径检测 → 自动开闸 |
| 发帖框（compose） | **随宿主页面** | 一般在禁图页弹出，但发帖框内预览图需手动开闸（转帖已处理） |

### 2.2 关键改进点

#### 改进 1：移除 MAIN world DOM 硬拦（解决崩溃）

**删掉 `media-block-main.js` 中的所有 prototype 劫持代码**，只保留闸门状态同步功能。

- 删除 `installHardDomPatchesOnce()` 函数及调用
- 删除 `patchSrcSetter()` 函数
- 删除 `shouldBlockUrl()` 函数（不再需要 DOM 层判断）
- 删除 `hardDomBlock()` 函数
- 删除 `hardPatchesInstalled` 标志
- `isAllowlistedTwimg()` 保留（可能被其他逻辑引用？需检查）
- 保留 `window.__SG_MEDIA_GATE__` 和 postMessage 通信（闸门状态同步仍需要）
- 版本号从 4.3.14 升到 4.4.0

**为什么安全：**
- DNR（Declarative Net Request）是 Chrome 原生网络层拦截，在请求发出前就 block，不会触发任何 DOM 渲染问题
- CSS 隐藏确保即使某些请求绕过 DNR，也不会显示裂图占位
- 历史上 DOM 硬拦是为了兼容 IX 环境（DNR 可能不生效），但带来的崩溃风险远大于收益
- 如果 IX 环境 DNR 失效，顶多是不禁图，不会崩溃；而崩溃会导致整个调度停摆

#### 改进 2：DM 私信页面自动开闸（解决 DM 无法进入）

**在隔离世界 content script 中增加页面路径检测**，进入私信相关路径时自动开闸，离开时自动关闸。

实现要点：
- 检测路径：`/messages`、`/i/chat`、`/i/chat/pin`
- 使用 SPA 路由监听：`popstate` + `hashchange` + 轮询兜底
- 进入私信路径 → `chrome.runtime.sendMessage({action:'media_gate_open', reason:'dm_page'})`
- 离开私信路径 → `chrome.runtime.sendMessage({action:'media_gate_close', reason:'dm_page'})`
- 30s 防抖，避免快速切换时频繁开关
- 每 60s 检查一次：如果仍在私信页且闸门已关（墙钟超时），重新开闸（续期）
- 使用现有的 ref 计数机制，与转帖/克隆的开闸互不干扰

#### 改进 3：转帖开闸保持不变

现有 `repost-engine.js` 的开闸/关闸逻辑已经很成熟，不需要改动。唯一需要确认的是：转帖在资料页进行，资料页不属于私信页，所以禁图默认开启，转帖时手动开闸 — 这与现有逻辑完全一致。

#### 改进 4：配置默认值改为 off（重新启用禁图）

- `config-sync.js` 中 `media_load_mode` 默认值从 `'on'` 改为 `'off'`
- `background.js` 中 `readMediaLoadMode()` 的默认值也同步改
- OPS 后台 migration：`media_load_mode` 全局默认改为 `off`
- 注意：`auto` 值仍然按 `on` 处理（保持 4.3.14 的兼容逻辑）

---

## 三、具体修改清单

### 3.1 必须修改的文件

| # | 文件 | 修改内容 | 风险 |
|---|------|----------|------|
| 1 | `unified-scheduler/shared/media-block-main.js` | 移除 DOM 硬拦（prototype 劫持），只保留闸门状态同步 | 低（DNR + CSS 已有兜底） |
| 2 | `unified-scheduler/shared/media-block-sync.js` | 增加 DM 页面路径检测 → 自动开闸/关闸 | 中（需测试路径切换逻辑） |
| 3 | `unified-scheduler/shared/config-sync.js` | `media_load_mode` 默认值从 `'on'` 改为 `'off'` | 低（OPS 可覆盖） |
| 4 | `unified-scheduler/background.js` | `readMediaLoadMode()` 默认值同步改 `'off'` | 低 |
| 5 | `test-env/x-ops-console/src/db/migrations/` | 新增 migration：`media_load_mode` 全局默认改为 `'off'` | 低 |
| 6 | `docs/调度工作手册.md` K2 节 | 更新媒体闸说明 | 低 |
| 7 | `docs/工作指导.md` | 新增版本记录 | 低 |

### 3.2 可选优化（如果时间允许）

| # | 优化项 | 说明 |
|---|--------|------|
| A | `media-block-main.js` 瘦身 | 既然移除了 DOM 硬拦，main.js 可以大幅简化，甚至把闸门同步也移到 sync.js 里 |
| B | 闸门续期优化 | DM 页面停留时自动续期，避免 3 分钟墙钟导致中途禁图 |

---

## 四、实施步骤

### 步骤 1：移除 DOM 硬拦

1. 打开 `media-block-main.js`
2. 删除 `hardDomBlock()`、`shouldBlockUrl()`、`isAllowlistedTwimg()`、`patchSrcSetter()`、`installHardDomPatchesOnce()` 函数
3. 删除 `hardPatchesInstalled` 变量
4. 删除 `onGateChanged()` 中对 `installHardDomPatchesOnce()` 的调用
5. 保留 `gate` 对象、`emitState()`、message 监听（闸门状态同步仍需 MAIN world 广播）
6. 更新版本号注释
7. 验证：mode=off 时不再安装 DOM 补丁，DNR + CSS 仍然生效

### 步骤 2：DM 页面自动开闸

1. 在 `media-block-sync.js` 中新增 `dmPageGate` 模块：
   - `isDmPage()`：检测 `location.pathname` 是否匹配私信路径
   - `ensureDmGateOpen()`：如果在私信页且闸门未开，则调用开闸
   - `ensureDmGateClosed()`：如果不在私信页且之前开过 DM 闸，则调用关闸
   - `startPathWatcher()`：监听 SPA 路由变化（popstate + 轮询）
2. 路径匹配规则：
   - `/messages` → 是
   - `/i/chat` → 是（含 `/i/chat/pin`、`/i/chat/xxx`）
   - 其他 → 否
3. 防抖：路径变化后 300ms 再判断，避免快速闪切
4. 续期：每 60s 检查一次，仍在私信页就重新 open（防止 3 分钟墙钟超时）
5. 用 ref 计数：DM 开闸用 `reason='dm_page'`，与转帖的 `reason='repost'` 互不干扰

### 步骤 3：默认值改为 off

1. `config-sync.js` 中 `DEFAULT_THRESHOLDS.media_load_mode` 从 `'on'` 改为 `'off'`
2. `background.js` 中 `readMediaLoadMode()` 默认值同步改
3. OPS 后台新增 migration 058：把 `config` 表中 `media_load_mode` 的全局默认从 `'on'` 改为 `'off'`（注意只改默认值，不要覆盖已有的账号 override）

### 步骤 4：文档更新

1. `调度工作手册.md` K2 节：更新媒体闸说明，增加"场景化禁图"描述
2. `工作指导.md`：新增 4.4.0 版本记录
3. `多开网络SOP.md`：更新媒体相关说明

---

## 五、验收标准

### 5.1 崩溃验证

- [ ] `media_load_mode=off` 时，浏览时间线 10 分钟无 Aw Snap
- [ ] `media_load_mode=off` 时，打开发帖框、输入文字、上传图片无崩溃
- [ ] `media_load_mode=off` 时，关注/养号引擎连续运行 30 分钟无崩溃
- [ ] DevTools 控制台无 prototype 相关的警告或错误

### 5.2 DM 功能验证

- [ ] `media_load_mode=off` 时，进入 `/messages` 页面正常显示
- [ ] `media_load_mode=off` 时，点击私信会话进入对话正常
- [ ] `media_load_mode=off` 时，DM PIN 码页面正常显示输入框
- [ ] `media_load_mode=off` 时，私信中发送/接收图片正常
- [ ] 从私信页跳转到首页后，时间线图片恢复被拦截（禁图生效）
- [ ] 从首页跳转到私信页后，私信图片正常加载（开闸生效）

### 5.3 转帖功能验证

- [ ] `media_load_mode=off` 时，转帖引擎正常下载图片
- [ ] `media_load_mode=off` 时，转帖发布后图片正常显示
- [ ] 转帖过程中 DM 页面（如果打开）不受影响

### 5.4 资源占用验证

- [ ] `media_load_mode=off` 时，时间线滚动的网络请求量明显低于 `on` 模式
- [ ] `media_load_mode=off` 时，内存占用低于 `on` 模式（大致估计）

---

## 六、风险与回滚

### 6.1 风险

| 风险 | 概率 | 影响 | 应对 |
|------|------|------|------|
| 移除 DOM 硬拦后，IX 环境 DNR 不生效导致不禁图 | 中 | 低（顶多不禁图，不会崩） | 多开网络 SOP 中已说明 IX 可能 DNR 无效，属已知情况 |
| DM 路径检测不准确，误开/误关 | 低 | 中 | 路径匹配规则简单明确（/messages, /i/chat），风险低 |
| 闸门 ref 计数紊乱，导致一直开/一直关 | 低 | 中 | 3 分钟墙钟作为兜底；ref 计数逻辑简单 |
| OPS 配置同步异常，mode 未正确下发 | 低 | 低 | 本地有默认值兜底 |

### 6.2 回滚方案

如果出现严重问题，可通过以下方式快速回滚：

1. **OPS 后台**：把 `media_load_mode` 改回 `on`，所有插件 1 分钟内同步生效
2. **代码回滚**：revert 本次提交即可
3. **应急**：用户手动在面板设置中把 mode 改为 on（如果面板有这个选项的话）

---

## 七、版本号建议

建议版本号从 4.3.x 升级到 **4.4.0**，因为这是媒体闸架构的重大调整（移除 DOM 硬拦 + 场景化开关）。

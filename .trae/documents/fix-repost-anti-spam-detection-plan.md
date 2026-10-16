# 完成方案：自动转帖触发 X 反垃圾检测的修复（已实施）

## 1. 问题结论

X 的 compose 编辑器是 **React/Lexical**，不是普通 input。直接 `execCommand('insertText')` 或 `.click()` 不会生成真实键盘/鼠标事件序列，平台检测到 `isTrusted=false` 和机械时序后，就会弹出「此请求疑似为自动发送」或评论里的「Something went wrong, but don’t fret — let’s give it another shot.」。

## 2. 已实施改动

| 文件 | 改动 |
|------|------|
| `shared/engine-utils.js` | 新增账号级工具：`randDelay`、`sleep`、`typeTextHumanLike`、`humanClick`、`looksLikeAntiSpam`、`markAntiSpamCooldown`、`isAntiSpamCooldown`、`msUntilAntiSpamCooldownEnd`、`getAntiSpamCount` |
| `repost/repost-engine.js` | 文本写入优先走 `typeTextHumanLike`；compose/发送/Try again/retry 点击走 `humanClick`；全链路延迟随机化；命中反垃圾文案即进入 60–120 分钟冷却；`runOnce` 入口检查冷却 |
| `nurture/nurture-engine.js` | 评论写入/点击同样接入拟人化；`postComment` 检查冷却；拒绝条命中反垃圾文案时触发冷却 |
| `manifest.json` | 4.6.0 → 4.6.1，描述更新 |
| `docs/调度工作手册.md` | §E1 新增拟人化发帖路径与踩坑记录 |
| `docs/工作指导.md` | §13 新增 4.6.1 变更记录 |

## 3. 验证结果

- `node --check shared/engine-utils.js` ✅
- `node --check repost/repost-engine.js` ✅
- `node --check nurture/nurture-engine.js` ✅
- `node test/japanese-tweet-gate.test.js` ✅
- `manifest.json` JSON 校验 ✅

## 4. 后续操作

1. 重新加载扩展（`chrome://extensions/`）。
2. 测试手动转帖与养号评论。
3. 若仍触发反垃圾提示，检查 `localStorage.sg_antispam_cooldown_until` 是否被写入，并观察是否进入冷却。

## 5. QA 补记（4.6.2）

4.6.1 实施后按项目标准（`工作指导.md` §12 检查清单 / `调度工作手册.md` §E1）复核，发现并修复 2 处缺陷：

| 缺陷 | 现象 | 修复 |
|------|------|------|
| 拟人输入分段重叠 | `typeTextHumanLike` 非日文分支按 `i += randDelay(2,6)` 步进，却取 `slice(i, i+6)`，片段相互重叠 → 拼接后重复/丢字。实测 `https://x.com/abc123` → `https:://x.c.com/abc123`；`looksOk` 只校验前缀，坏文本会被放行发出 | 抽出 `EngineUtils.segmentForTyping()`，步进宽度=切片宽度；含半角假名按字符切 |
| `humanClick` 重复触发 click | 派发合成 `click` 后又调 `el.click()`，一次点击触发两次 `onClick`（发送/点赞重复动作，更像机器人） | 去掉 `el.click()`；合成 `click` 改用真 `MouseEvent`（带坐标） |

验证结果：

- `node --check`：`engine-utils.js` / `repost-engine.js` / `nurture-engine.js` ✅
- 新增 `test/human-typing-segment.test.js`：分段拼接还原原文 + 随机压力 + 单击不重复 ✅
- 全量测试：除**基线既有红**的 `scrm-gate-failclosed.test.js` 外全部通过
- `manifest.json` 4.6.1 → 4.6.2 ✅

未处理（跨板块，按子 ID 隔离单独提）：`test/scrm-gate-failclosed.test.js` 期望 fail-closed，与 4.4.1「SCRM 闸门紧急 fail-open」相矛盾，基线即失败；属 A5/C5 板块，未在本次 E1/D1 改动中触碰。

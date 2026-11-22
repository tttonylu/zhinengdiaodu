# DM 只读脉冲 · 独立 MV3 测试壳设计

> 日期：2026-11-09  
> 项目代号：`dm-pulse-sandbox/extension`  
> 阶段：第二阶段，设计已确认  
> 原则：完全独立、只读取证、不进正式版

## 1. 目标

证明第一阶段的新版元素适配器和只读脉冲能在真实 MV3 content script（ISOLATED world）里运行，而不只是 Codex 浏览器主世界。

## 2. 硬边界

- 不修改 `unified-scheduler/` 任何文件，不加载生产插件。
- 测试壳目录完全独立：`dm-pulse-sandbox/extension/`。
- 无 background service worker、无 storage、无定时轮询、无生产依赖。
- 不打开会话、不发送消息、不筛选列表、不读写生产存储。
- 手动点击扩展图标触发一次有界脉冲，跑完即停。

## 3. 目录结构

```text
dm-pulse-sandbox/extension/
  manifest.json          # 最小权限：activeTab + x.com/i/chat*
  probe.js               # 唯一 content script（ISOLATED world）
  panel.html             # action popup：一个按钮 + 报告区
  panel.js               # popup 逻辑：注入并触发一次脉冲
  src/
    selectors.js         # UMD：元素契约
    inbox-parser.js      # UMD：行解析（FNV-1a 匿名哈希）
    pulse.js             # UMD：有界状态机
    report.js            # UMD：脱敏报告
```

`src/` 从沙盒根目录移入 `extension/src/`（MV3 的 js 路径不能指向扩展目录外）。Node 测试路径相应调整，保持单份代码、两个运行环境。

## 4. UMD 改造

四个模块从 CommonJS 改为 UMD：

```js
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./selectors'));
  } else {
    root.DmPulseInboxParser = factory(root.DmPulseSelectors);
  }
}(typeof self !== 'undefined' ? self : this, function (selectors) {
  // 原代码
}));
```

匿名哈希从 `node:crypto` sha256 换成纯 JS FNV-1a（32 位），因为 content script 没有 Node 内置模块。FNV-1a 对测试沙盒的匿名化足够——目标是避免明文会话 ID 落盘，不是密码学安全。

## 5. manifest.json

```json
{
  "manifest_version": 3,
  "name": "DM Pulse Sandbox",
  "version": "0.2.0",
  "permissions": ["activeTab"],
  "action": { "default_popup": "panel.html" },
  "content_scripts": [{
    "matches": ["https://x.com/i/chat*"],
    "js": ["src/selectors.js", "src/inbox-parser.js", "src/pulse.js", "src/report.js", "probe.js"],
    "run_at": "document_idle"
  }]
}
```

- 只匹配 `x.com/i/chat*`，不匹配其他页面。
- 无 `world` 字段，默认 ISOLATED。
- 无 background、无 storage、无 host_permissions（content_scripts 的 matches 足够）。

## 6. probe.js（content script）

在 ISOLATED world 用原生 DOM 读取会话行，输出与第一阶段完全一致的结构化报告。

```js
// 监听 popup 的触发消息
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'DM_PULSE_RUN') return;
  const samples = [];
  const times = [];
  const start = Date.now();
  function sample() {
    // 用原生 DOM 读取，不调 Playwright
    const rows = [...document.querySelectorAll('a[role="option"][id^="dm-conversation-option-"]')];
    // ... 构建 sample 对象
    samples.push(sample);
    times.push(Date.now() - start);
    if (times[times.length - 1] >= 15000 || done) {
      const result = DmPulsePulse.runReadonlyPulse({ samples, now: times });
      sendResponse(DmPulseReport.buildPublicReport(result));
      return;
    }
    setTimeout(sample, 500);
  }
  sample();
  return true; // async sendResponse
});
```

## 7. panel.html / panel.js（popup）

- 一个「运行只读脉冲」按钮。
- 一个报告展示区（JSON 格式化）。
- 点击后向当前 tab 发 `DM_PULSE_RUN` 消息，等待报告返回。

## 8. 验收标准

1. 独立 Chrome 测试壳（不装生产插件）加载 `dm-pulse-sandbox/extension/`。
2. 登录测试号，打开 `/i/chat`。
3. 点扩展图标 → 点「运行只读脉冲」。
4. 报告的行数、未读数、verdict 与第一阶段 Codex 浏览器结果一致。
5. 控制台无错误，无生产存储写入。

## 9. 回退

从 `chrome://extensions` 移除「DM Pulse Sandbox」即可。生产零改动。

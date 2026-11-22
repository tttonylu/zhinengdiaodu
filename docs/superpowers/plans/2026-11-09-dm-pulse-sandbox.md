# DM 只读脉冲沙盒实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在独立目录交付新版 X 会话栏的只读元素解析、有界脉冲状态机、离线夹具和 Codex 浏览器验收证据，全程不改变生产私信行为。

**Architecture:** `selectors` 定义新版语义元素契约，`inbox-parser` 将采样输入规范化为脱敏行摘要，`pulse` 用虚拟时钟可测的状态机区分加载、稳定结果和异常，`report` 负责报告隐私检查。Codex 浏览器只提供实时采样与重载，不传入点击、筛选、写入或发送能力。

**Tech Stack:** Node.js 24 内置 `node:test`、CommonJS、真实/脱敏 DOM 采样、Codex in-app browser Playwright 只读接口；无第三方运行时依赖。

**设计依据：** `docs/superpowers/specs/2026-11-09-dm-pulse-sandbox-design.md`

**生产边界：** 只新增 `dm-pulse-sandbox/` 与本计划；不修改 `unified-scheduler/`、OPS 和生产配置。未经用户明确要求，不执行 Git commit。

---

### Task 1: 独立项目骨架与新版元素契约

**Files:**
- Create: `dm-pulse-sandbox/package.json`
- Create: `dm-pulse-sandbox/.gitignore`
- Create: `dm-pulse-sandbox/src/selectors.js`
- Create: `dm-pulse-sandbox/src/inbox-parser.js`
- Create: `dm-pulse-sandbox/fixtures/xchat-v2-samples.js`
- Test: `dm-pulse-sandbox/test/inbox-parser.test.js`

- [ ] **Step 1: 写新版行、未读和结构失败的测试**

使用 Node 内置测试工具；输入采用 2026-11-09 实机确认的语义结构，不含真实姓名、正文或数字会话 ID。断言新版行计数、精确未读、自己预览、非法 ID 和 `unsupported_schema`，并确认认证图标不算未读。

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseInboxSample } = require('../src/inbox-parser');
const { unreadFixture, readFixture } = require('../fixtures/xchat-v2-samples');

describe('xchat-v2 inbox parser', () => {
  it('识别 9 行且只把 circle-fill 行当未读', () => {
    const result = parseInboxSample(unreadFixture);
    assert.equal(result.schema, 'xchat-v2');
    assert.equal(result.rows.length, 9);
    assert.deepEqual(result.rows.map(row => row.unread), [true, false, false, false, false, false, false, false, false]);
    assert.equal(result.rows[0].selfPreview, false);
    assert.equal(result.rows[8].selfPreview, true);
    assert.equal(result.selectorHealth.valid, true);
  });

  it('全已读不被认证图标误判', () => {
    const result = parseInboxSample(readFixture);
    assert.equal(result.unreadRows, 0);
    assert.equal(result.rows.length, 2);
  });

  it('非法会话 ID 和旧 schema 显式失败', () => {
    assert.throws(() => parseInboxSample({ ...unreadFixture, rows: [{ ...unreadFixture.rows[0], id: 'bad' }] }), /idShapeValid/);
    assert.equal(parseInboxSample({ surface: 'list', listReady: true, rows: [{ kind: 'legacy' }] }).verdict, 'unsupported_schema');
  });
});
```

- [ ] **Step 2: 运行测试确认因实现缺失而失败**

Run: `node --test dm-pulse-sandbox/test/inbox-parser.test.js`
Expected: FAIL，`Cannot find module '../src/inbox-parser'`。

- [ ] **Step 3: 实现最小元素契约、脱敏夹具与解析器**

`selectors.js` 暴露 `ROW_ID_RE`、`UNREAD_ICON`、`CONVERSATION_PATH_RE`，以及用于浏览器采样的选择器常量。`inbox-parser.js` 只接收普通对象，输出 `rowKey=row-1` 形式的匿名行标识和会话标识哈希，不返回预览正文、真实显示名、真实 ID 或头像 URL。

```js
const ROW_ID_RE = /^dm-conversation-option-\d+:\d+$/;
const UNREAD_ICON = '[data-icon="icon-circle-fill"]';
const CONVERSATION_PATH_RE = /^\/i\/chat\/\d+(?:-\d+)?\/?$/;

function parseInboxSample(sample) {
  if (sample.rows?.some(row => row.kind === 'legacy')) {
    return { schema: 'unsupported', verdict: 'unsupported_schema', rows: [], unreadRows: 0, selectorHealth: { valid: false } };
  }
  for (const row of sample.rows || []) {
    if (!ROW_ID_RE.test(row.id)) throw new Error('idShapeValid: invalid conversation id');
  }
  const rows = (sample.rows || []).map((row, index) => ({
    rowKey: `row-${index + 1}`,
    conversationKey: `conversation-${index + 1}`,
    unread: row.icons.includes('icon-circle-fill'),
    selfPreview: /^(你|You)[:：]/.test(row.previewPrefix || ''),
    idShapeValid: true,
    structureValid: row.inboxRow === true
  }));
  return { schema: 'xchat-v2', verdict: null, rows, unreadRows: rows.filter(row => row.unread).length,
    selectorHealth: { valid: rows.every(row => row.structureValid) } };
}
```

夹具至少含 1 条带 `icon-circle-fill` 的行、1 条只有 `icon-verified` 的行、1 条 `previewPrefix='你:'` 的行。项目脚本只运行自身测试，`.gitignore` 忽略 `artifacts/`、`node_modules/` 和日志。

- [ ] **Step 4: 运行解析器测试并检查生产目录未变**

Run: `node --test dm-pulse-sandbox/test/inbox-parser.test.js`
Expected: 3 个测试全部 PASS。

Run: `git status --short -- unified-scheduler dm-pulse-sandbox`
Expected: `unified-scheduler` 不出现本项目造成的变化；只出现沙盒新文件。

### Task 2: 有界脉冲状态机

**Files:**
- Create: `dm-pulse-sandbox/src/pulse.js`
- Test: `dm-pulse-sandbox/test/pulse.test.js`

- [ ] **Step 1: 写慢加载、稳定窗口、空列表和超时的失败测试**

测试用普通对象采样和显式时间输入，不使用真实等待。`runReadonlyPulse({ samples, now })` 每次推进一个采样点；默认总预算 15000ms、间隔 500ms、空列表宽限 5000ms。空态证据只来自 `emptyState=true`，加载指示来自 `loading=true`。

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runReadonlyPulse } = require('../src/pulse');
const { unreadFixture, readFixture } = require('../fixtures/xchat-v2-samples');

const loading = { surface: 'list', listReady: false, loading: true, emptyState: false, rows: [] };
const empty = { surface: 'list', listReady: true, loading: false, emptyState: true, rows: [] };
const repeat = (sample, count) => Array.from({ length: count }, () => sample);
const sequence = (...groups) => groups.flatMap(([sample, count]) => repeat(sample, count));

describe('readonly pulse', () => {
  it('早期空读后能识别未读，并等待稳定采样', () => {
    const result = runReadonlyPulse({ samples: sequence([loading, 6], [unreadFixture, 2]) });
    assert.equal(result.verdict, 'unread_found');
    assert.equal(result.visibleRows, 9);
    assert.equal(result.unreadRows, 1);
    assert.equal(result.samples.length, 8);
  });

  it('有行无未读经过稳定窗口才确认', () => {
    const result = runReadonlyPulse({ samples: sequence([readFixture, 2]) });
    assert.equal(result.verdict, 'no_unread_confirmed');
    assert.equal(result.samples.length, 2);
  });

  it('持续加载不能报无未读或空列表', () => {
    const result = runReadonlyPulse({ samples: repeat(loading, 31) });
    assert.equal(result.verdict, 'loading_timeout');
    assert.equal(result.durationMs, 15000);
  });

  it('可信空态经过宽限期才能确认空列表', () => {
    const result = runReadonlyPulse({ samples: repeat(empty, 12) });
    assert.equal(result.verdict, 'empty_confirmed');
    assert.ok(result.durationMs >= 5500);
  });

  it('错误页面和摘要变化不提前收工', () => {
    assert.equal(runReadonlyPulse({ samples: [{ ...unreadFixture, surface: 'conversation' }] }).verdict, 'wrong_surface');
    const result = runReadonlyPulse({ samples: [unreadFixture, readFixture, readFixture] });
    assert.equal(result.verdict, 'no_unread_confirmed');
    assert.equal(result.samples.length, 3);
  });
});
```

- [ ] **Step 2: 运行测试确认状态机尚不存在**

Run: `node --test dm-pulse-sandbox/test/pulse.test.js`
Expected: FAIL，`Cannot find module '../src/pulse'`。

- [ ] **Step 3: 实现最小纯状态机**

实现 `runReadonlyPulse({ samples, now, budgetMs=15000, intervalMs=500, emptyGraceMs=5000 })`。`now` 是可选采样时钟数组，仅测试使用；缺省时间由索引乘间隔计算。摘要以匿名行的 `conversationKey/unread/selfPreview/structureValid` 序列比较。无更多采样且未到预算时返回 `samples_exhausted`，不能猜测最终业务结论。异常采样记为 `selector_degraded`。

```js
function runReadonlyPulse({ samples, now, budgetMs = 15000, intervalMs = 500, emptyGraceMs = 5000 }) {
  // 每个采样先检查 surface，再 parseInboxSample；相同匿名摘要连续两次才稳定。
  // rows=0 时只有 listReady && !loading && emptyState 才能累计空列表宽限。
  // 任何超时均返回结构化报告，不抛给浏览器驱动，不遗留计时器。
}
```

- [ ] **Step 4: 运行脉冲测试并做全量回归**

Run: `node --test dm-pulse-sandbox/test/pulse.test.js`
Expected: 5 个测试全部 PASS。

Run: `npm test --prefix dm-pulse-sandbox`
Expected: 当前全部测试 PASS，无真实网络或计时器等待。

### Task 3: 报告脱敏和真实页面采样适配

**Files:**
- Create: `dm-pulse-sandbox/src/report.js`
- Create: `dm-pulse-sandbox/browser/readonly-probe.js`
- Test: `dm-pulse-sandbox/test/report.test.js`

- [ ] **Step 1: 写报告隐私和浏览器采样只读边界测试**

断言报告不包含预览正文、显示名、头像 URL、真实数字会话 ID；采样函数只允许 `getByRole('option')`、`evaluateAll`、`waitForTimeout`、`reload`，不包含 `click`、`fill`、`goto` 具体会话或 `localStorage` 写入。浏览器导出的是普通对象，能直接送入解析器与状态机。

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildPublicReport } = require('../src/report');
const { runReadonlyPulse } = require('../src/pulse');
const { unreadFixture } = require('../fixtures/xchat-v2-samples');

describe('public pulse report', () => {
  it('仅保留匿名计数和结构诊断', () => {
    const report = buildPublicReport(runReadonlyPulse({ samples: [unreadFixture, unreadFixture] }));
    const serialized = JSON.stringify(report);
    assert.equal(report.verdict, 'unread_found');
    assert.equal(report.visibleRows, 9);
    assert.doesNotMatch(serialized, /previewText|displayName|avatarUrl|dm-conversation-option-\d/);
    assert.doesNotMatch(serialized, /変態|むーみん|1921556032637345792/);
  });
});
```

- [ ] **Step 2: 运行测试确认报告模块缺失**

Run: `node --test dm-pulse-sandbox/test/report.test.js`
Expected: FAIL，`Cannot find module '../src/report'`。

- [ ] **Step 3: 实现公共报告与只读采样适配器**

`buildPublicReport` 仅白名单复制 `schema/pulseId/startedAt/durationMs/verdict/visibleRows/unreadRows/samples/selectorHealth/errors`。`readonly-probe.js` 提供：

```js
async function sampleVisibleInbox(tab) {
  const options = tab.playwright.getByRole('option');
  const rows = await options.evaluateAll(elements => elements.map(element => ({
    id: element.id,
    inboxRow: !!element.querySelector('[data-inbox-row]'),
    icons: [...element.querySelectorAll('[data-icon]')].map(icon => icon.getAttribute('data-icon')),
    previewPrefix: '', // 浏览器只返回自己预览布尔值，不返回消息正文
    selfPreview: false,
    href: element.getAttribute('href') || ''
  })));
  return { surface: 'list', listReady: true, loading: false, emptyState: false, rows };
}
```

最终实现须把 `selfPreview` 规范化为解析器输入，不读取预览正文；`surface` 根据当前 URL 校验，`listReady` 根据列表容器与采样结果计算。函数不得导航或点击。

- [ ] **Step 4: 运行报告及全量离线测试**

Run: `node --test dm-pulse-sandbox/test/report.test.js`
Expected: PASS。

Run: `npm test --prefix dm-pulse-sandbox`
Expected: 所有离线测试 PASS。

### Task 4: Codex 浏览器复验与项目交付

**Files:**
- Create: `dm-pulse-sandbox/README.md`
- Create: `dm-pulse-sandbox/artifacts/.gitkeep`（目录仅说明用途，实际输出仍忽略）
- Modify: `dm-pulse-sandbox/test/report.test.js`（只在前序测试失败暴露问题时补回归）

- [ ] **Step 1: 静态页面真实采样**

在用户已登录的 Codex 浏览器标签 `https://x.com/i/chat` 调用只读采样。不断言行数永远为 9，而是将实时结果与页面可见行、侧栏未读计数和 `[data-icon="icon-circle-fill"]` 对照。

Expected: 主选择器读到实际行数；未读只落在带精确图标的行；无会话打开、无发送、无存储写入。

- [ ] **Step 2: 刷新后验证慢加载与有界二次采样**

刷新列表页，先采一次，再按 500ms 间隔采样，最多 15 秒。保留实际采样计数、耗时、加载指示和终态。

Expected: 初次 `rows=0` 不直接判空；列表出现后经稳定窗口输出 `unread_found` 或 `no_unread_confirmed`。若未出现，输出 `loading_timeout` 或 `selector_degraded`，而不是伪报成功。

- [ ] **Step 3: 写 README、核对边界并运行完整验证**

README 记录人工登录、只读工具运行方式、测试命令、参数、结论表、隐私规则、已实测/未实测项和第二阶段准入。特别注明无真实空列表时，`empty_confirmed` 只算离线验证。

Run: `npm test --prefix dm-pulse-sandbox`
Expected: 全部测试 PASS。

Run: `git diff --check -- dm-pulse-sandbox docs/superpowers/plans/2026-11-09-dm-pulse-sandbox.md`
Expected: 无空白错误。

Run: `git status --short -- unified-scheduler dm-pulse-sandbox`
Expected: 无本项目对生产扩展的改动。

- [ ] **Step 4: 交付验收摘要，不自行进入第二阶段**

报告实际测试数量、真实页面行数/未读数、慢加载观察、未能实机覆盖的场景和文件路径。明确生产插件未修改、未发送消息、未打开会话。未经用户另行批准，不开始 MV3 测试壳或生产接入。

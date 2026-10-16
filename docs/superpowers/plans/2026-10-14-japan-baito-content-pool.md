# 日本兼职矩阵 · 原创内容池自动发帖 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 两个日本兼职招募发帖号（まい/あかり）的每日原创日文推文经"AI 生产 → OPS 内容池人工一键审核 → 插件到点 claim 拟人直发 → 回报 posted"闭环自动发布。

**Architecture:** OPS 新增 content_pool_items 表与 `/content` 审核页、`/api/content/*` 生产侧接口、`/api/plugin/content-pool/*` 插件侧接口；插件 repost-engine 在 `repost_content_pool=1` 的账号上从"扫来源号"切到"claim 内容池"，claim 到的文字+图片走现有 pending 两阶段发帖链路，成功/失败/重试统一回报；模式开关经现有 config-sync 账号 override 自动下发（H1 mergeAccountConfig 对任意 override 键自动合入 thresholds，无需改 H1）。

**Tech Stack:** Fastify 5 + better-sqlite3 + Nunjucks（OPS）；MV3 content script + chrome.runtime SW opsFetch（插件）；node:test（双侧）。

**对应宪法链：** §X 新增契约行；§E 新增 E5；§H 新增 H11；F1 补充键说明。规格见 [2026-10-14-japan-baito-accounts-design.md](file:///d:/下载/智能调度/docs/superpowers/specs/2026-10-14-japan-baito-accounts-design.md)。

---

## File Structure

**新建文件**

| 文件 | 职责 |
|---|---|
| `test-env/x-ops-console/src/db/migrations/070_content_pool.sql` | 内容池表 + 索引 |
| `test-env/x-ops-console/src/repositories/content-pool-repo.js` | 表 CRUD / 原子 claim / 状态流转 |
| `test-env/x-ops-console/src/services/content-media.js` | dataURL 图片落盘、文件名白名单、Content-Type 映射 |
| `test-env/x-ops-console/src/routes/api/content-pool.js` | 生产侧 ingest + 插件 claim/report/media GET + 批量审核动作 API |
| `test-env/x-ops-console/src/routes/pages/content.js` | `/content` 审核页路由（列表/批准/拒绝/重试/删除/编辑） |
| `test-env/x-ops-console/src/views/content.njk` | 审核页模板 |
| `test-env/x-ops-console/test/content-pool-api.test.js` | API 全链路测试 |
| `unified-scheduler/repost/content-pool-client.js` | 内容脚本侧：claim / report / 取图 Blob |
| `unified-scheduler/test/content-pool-client.test.js` | client 的模式判定与 blob 还原逻辑抽离测试 |
| `x-japan-accounts/content/week1-20261015.md` | P0 第一周内容包（42 条文案+14 张图） |

**修改文件**

| 文件 | 改动概要 |
|---|---|
| `docs/调度工作手册.md` | §X 加契约行；§E 加 E5；§H 表加 H11；F1 补说明；最后 §13 记录本次变更 |
| `test-env/x-ops-console/src/app.js` | 注册 contentPoolApiRoutes / contentPageRoutes；开 `/content-media` 静态目录 |
| `test-env/x-ops-console/src/views/partials/shell-nav.njk` | 加「内容池」导航 |
| `unified-scheduler/manifest.json` | repost-tracker 之后、repost-engine 之前加载 content-pool-client.js |
| `unified-scheduler/background.js` | 加 ops_content_pool_claim/report/media 三个 SW 代理（复用 opsFetch） |
| `unified-scheduler/repost/repost-engine.js` | runOnce 插入内容池分支；pending 成功/跳过分支加 posted/retry 回报 |
| `unified-scheduler/shared/config-sync.js` | applyRepostRemote 的 cfg 加 `contentPoolMode` 透传 |
| `unified-scheduler/manifest.json` | 版本 4.6.125 → 4.6.126（version/description/default_title 三连） |

---

## Task 1: 宪法链 — 手册 E5/H11/§X/F1（先文档后代码）

**Files:**
- Modify: `docs/调度工作手册.md`（先加子 ID 契约，代码任务从 Task 2 起）

- [ ] **Step 1: §X 跨板块契约总表追加一行（H9↔E1/F1 行之后）**

在第 75 行（`| H9↔E1/F1 | 来源号池 | ...` 那行）之后插入：

```markdown
| H11↔E5/F1 | 原创内容池 | OPS `content_pool_items` 表为原创发帖唯一来源；插件按号 claim 已批准且到期（scheduled_jst_at ≤ 当前日本墙钟）的一条，原子 approved→claimed，成功报 posted、可恢复失败报 retry（回 approved 待重发）、彻底失败报 failed；账号 override `repost_content_pool=1` 经 F1 透传切模式；**空池/无到期 = 跳过，5 分钟后再查，绝不硬发、不扫来源号**；内容脚本不直接连 OPS，claim/report/取图均经 background `opsFetch`/跨域 fetch | H11 建池+审核+claim 语义；E5 claim→pending 两阶段→回报；F1 键透传不改读法 |
```

- [ ] **Step 2: §E 转帖 章 E4 之后（第 619 行 `---` 前）新增 E5**

```markdown
### E5 原创内容池（4.6.126）

**职责：** `repost/content-pool-client.js` + repost-engine 内容池分支。`repost_content_pool=1` 的账号放弃扫来源号，改为 claim OPS 内容池。

**闭环：**
1. runOnce 起：该号无 pending 时先 claim（带本号 handle，SW `ops_content_pool_claim` 代理）；无到期内容 → `scheduleNext(5min)`，不 stop、不导航、不扫来源号。
2. claim 到 → 经 SW 下载配图 Blob → `savePendingContent(text, blobs, '', String(item.id))`，再给 pending 补 `contentPoolId` → 跳 `/compose/post`（与 E1 完全相同的两阶段发布与拟人规则）。
3. 发布成功 → `ContentPoolClient.report(id,'posted',{external_post_id})`；发布被判定可恢复失败（media_download_fail 等）→ report 'retry'（回 approved，下轮重发）；判定不可恢复（mention_blocked/mismatch 放弃/反垃圾冷却）→ report 'failed'（人工处理，不自动重发）。
4. claim 是原子的（approved→claimed 条件更新）；同一账号只允许一个标签页跑 repost（沿用既有单实例约束）。

**禁止：**
- 内容脚本里写死任何 OPS 地址/令牌（一律走 background opsFetch，内外网 failover 复用现有通道）。
- claim 不到内容时把空文本/旧内容发出去；禁止 fallback 回来源号模式。
- 正文规则与 E1 相同：标签 ≤3、零裸词、零外链零联系 ID（H11 入库时不做语言校验，红线由内容生产侧 prompt + 人工审核双保险）。

**耦合：** H11↔E5/F1。日程窗口仍受 E2/A2 约束（内容池账号通过 repost_start_hour=11 / repost_eve_end_hour=23 的账号 override 扩窗，引擎 tick 在窗内空转查询，无需改 scheduler-core）。
```

- [ ] **Step 3: §H OPS 后台表格 H10 行之后新增 H11**

```markdown
| H11 | **原创内容池** — `content_pool_items`（account_handle/persona/text/media_urls/scheduled_jst_at/status: pending·approved·claimed·posted·failed·rejected/external_post_id/fail_reason/source）；`/content` 页按日审核（批量批准/拒绝/删除/重试/编辑）；生产侧 `POST /api/content/ingest`（含 dataURL 配图落盘 `/data/content-media/`，GET `/content-media/:file` 白名单文件）；插件侧 `GET /api/plugin/content-pool/claim?bot_id=` 原子领单、`POST /api/plugin/content-pool/report`；时间按日本墙钟比较（store 'YYYY-MM-DDTHH:MM' JST 墙钟，不用 UTC 换算）；retry=claimed→approved；failed/rejected 不自动重发；**repost_content_pool 是普通账号 override 键，H1 mergeAccountConfig 自动下发，不新增字段/不改组装逻辑** |
```

- [ ] **Step 4: §F F1 config-sync 末尾补充一行提示（第 628 行那段之后）**

```markdown
> `repost_content_pool`（账号 override，'1'/'0'）：为 '1' 时 repost cfg 携带 `contentPoolMode:true`，引擎进 E5 内容池模式；读法/拉取节奏不变。
```

- [ ] **Step 5: 提交**

```bash
git add docs/调度工作手册.md
git commit -m "docs: 新增 E5/H11 内容池宪法链契约（日本兼职矩阵）"
```

---

## Task 2: 迁移 070 + content-pool-repo

**Files:**
- Create: `test-env/x-ops-console/src/db/migrations/070_content_pool.sql`
- Create: `test-env/x-ops-console/src/repositories/content-pool-repo.js`
- Test: `test-env/x-ops-console/test/content-pool-api.test.js`（仓储层断言写在 describe('repo') 内，Task 4 与路由断言同文件）

- [ ] **Step 1: 写迁移 SQL**

`src/db/migrations/070_content_pool.sql`：

```sql
-- H11 原创内容池：AI/人工生产的待发推文，人工审核后插件 claim 直发
CREATE TABLE IF NOT EXISTS content_pool_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_handle TEXT NOT NULL COLLATE NOCASE,   -- 目标发帖号 handle（不带 @）
  persona TEXT NOT NULL DEFAULT '',              -- mai / akari，便于筛选
  text TEXT NOT NULL,                            -- 日文正文（≤1000 字，标签≤3 由生产侧保证）
  media_urls TEXT NOT NULL DEFAULT '[]',         -- JSON 数组，相对路径 /content-media/xxx.jpg
  scheduled_jst_at TEXT NOT NULL,                -- 'YYYY-MM-DDTHH:MM' 日本墙钟
  status TEXT NOT NULL DEFAULT 'pending',        -- pending/approved/claimed/posted/failed/rejected
  source TEXT NOT NULL DEFAULT 'manual',         -- ai_daily / manual
  external_post_id TEXT NOT NULL DEFAULT '',
  fail_reason TEXT NOT NULL DEFAULT '',
  claimed_at TEXT,
  posted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
);

CREATE INDEX IF NOT EXISTS idx_content_pool_claim
  ON content_pool_items(account_handle, status, scheduled_jst_at);
CREATE INDEX IF NOT EXISTS idx_content_pool_status ON content_pool_items(status);
```

- [ ] **Step 2: 先确认迁移加载机制（无需改码）**

Run（在 `test-env/x-ops-console`）：`node -e "const {createDb}=require('./src/db/client'); const db=createDb(':memory:'); const t=db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='content_pool_items'\").get(); console.log(t&&t.name)"`

Expected: 输出 `content_pool_items`（migrate.js 自动扫 migrations 目录；若没有自动扫描，先读 `src/db/migrate.js` 确认 070 被带上的方式并照做，再继续）。

- [ ] **Step 3: 写失败测试（repo 部分）**

`test/content-pool-api.test.js`：

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createDb } = require('../src/db/client');
const { createContentPoolRepo } = require('../src/repositories/content-pool-repo');

function jstNow() {
  const d = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' });
  const t = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Tokyo', hour12: false }).slice(0, 5);
  return d + 'T' + t;
}

test('repo: pending→approve→claim→posted 全流程', () => {
  const db = createDb(':memory:');
  const repo = createContentPoolRepo(db);
  const id = repo.insert({ accountHandle: 'mai_test', persona: 'mai', text: 'テスト投稿 #メルレ', mediaUrls: [], scheduledJstAt: '2026-10-15T12:10', source: 'ai_daily' });
  assert.ok(id > 0);

  let due = repo.claimDue('mai_test', '2026-10-15T12:00');
  assert.equal(due, null, 'pending 不可 claim');

  repo.setStatus([id], 'approved');
  assert.equal(repo.claimDue('mai_test', '2026-10-15T12:00'), null, '未到点不可 claim');

  const got = repo.claimDue('mai_test', '2026-10-15T12:10');
  assert.ok(got && got.id === id);
  assert.equal(got.status, 'claimed');
  assert.equal(repo.claimDue('mai_test', '2026-10-15T13:00'), null, 'claimed 不重复领');

  repo.report(id, 'posted', { externalPostId: '123' });
  const row = db.prepare('SELECT status, external_post_id, posted_at FROM content_pool_items WHERE id=?').get(id);
  assert.equal(row.status, 'posted');
  assert.equal(row.external_post_id, '123');
  assert.ok(row.posted_at);
});

test('repo: retry 回 approved 可重新 claim；failed 不重发', () => {
  const db = createDb(':memory:');
  const repo = createContentPoolRepo(db);
  const id = repo.insert({ accountHandle: 'akari_test', persona: 'akari', text: 'x', mediaUrls: ['/content-media/a.jpg'], scheduledJstAt: '2026-10-15T21:20' });
  repo.setStatus([id], 'approved');
  assert.ok(repo.claimDue('akari_test', '2026-10-15T22:00'));
  repo.report(id, 'retry', { failReason: 'media_download_fail' });
  assert.equal(db.prepare('SELECT status FROM content_pool_items WHERE id=?').get(id).status, 'approved');
  assert.ok(repo.claimDue('akari_test', '2026-10-15T22:05'));

  repo.report(id, 'failed', { failReason: 'mention_blocked' });
  assert.equal(repo.claimDue('akari_test', '2026-10-15T22:10'), null);
});

test('repo: listForReview 按状态/日期/hook 过滤 + 批量 setStatus + edit + stats', () => {
  const db = createDb(':memory:');
  const repo = createContentPoolRepo(db);
  repo.insert({ accountHandle: 'mai_test', persona: 'mai', text: 'a', mediaUrls: [], scheduledJstAt: '2026-10-15T12:00' });
  const bid = repo.insert({ accountHandle: 'mai_test', persona: 'mai', text: 'b', mediaUrls: [], scheduledJstAt: '2026-10-16T12:00' });
  assert.equal(repo.listForReview({}).length, 2);
  assert.equal(repo.listForReview({ status: 'pending' }).length, 2);
  assert.equal(repo.listForReview({ date: '2026-10-15' }).length, 1);
  repo.setStatus([bid], 'rejected');
  assert.equal(repo.listForReview({ accountHandle: 'mai_test' }).length, 2);
  repo.edit(bid, { text: 'b2', scheduledJstAt: '2026-10-16T18:00' });
  const r = db.prepare('SELECT text, scheduled_jst_at FROM content_pool_items WHERE id=?').get(bid);
  assert.equal(r.text, 'b2');
  assert.equal(r.scheduled_jst_at, '2026-10-16T18:00');
});
```

- [ ] **Step 4: 运行确认失败**

Run: `node --test test/content-pool-api.test.js`
Expected: FAIL（Cannot find module '../src/repositories/content-pool-repo'）。

- [ ] **Step 5: 实现 repo**

`src/repositories/content-pool-repo.js` 完整代码：

```js
'use strict';

/**
 * H11 原创内容池仓储
 * status: pending（待审）/ approved（已批准待发）/ claimed（插件已领）/
 *         posted（已发）/ failed（失败待人工）/ rejected（拒绝）
 * 时间一律日本墙钟字符串 'YYYY-MM-DDTHH:MM'，比较走字典序
 */
const VALID_STATUS = new Set(['pending', 'approved', 'claimed', 'posted', 'failed', 'rejected']);

function createContentPoolRepo(db) {
  const now = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }).slice(0, 19);

  function hydrate(row) {
    if (!row) return row;
    let media = [];
    try { media = JSON.parse(row.media_urls || '[]'); } catch (e) { media = []; }
    return Object.assign({}, row, { media_urls: Array.isArray(media) ? media : [] });
  }

  return {
    insert({ accountHandle, persona, text, mediaUrls, scheduledJstAt, source }) {
      const h = String(accountHandle || '').replace(/^@/, '').toLowerCase().trim();
      const body = String(text || '').trim();
      const sched = String(scheduledJstAt || '').trim();
      if (!h) throw new Error('account_handle required');
      if (!body) throw new Error('text required');
      if (body.length > 1000) throw new Error('text too long (max 1000)');
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(sched)) throw new Error('bad scheduled_jst_at');
      const urls = (Array.isArray(mediaUrls) ? mediaUrls : []).filter(Boolean).slice(0, 4);
      const info = db.prepare(`
        INSERT INTO content_pool_items (account_handle, persona, text, media_urls, scheduled_jst_at, source)
        VALUES (@h, @p, @t, @m, @s, @src)
      `).run({
        h, p: String(persona || ''), t: body,
        m: JSON.stringify(urls), s: sched, src: String(source || 'manual'),
      });
      return Number(info.lastInsertRowid);
    },

    listForReview({ status, date, accountHandle } = {}) {
      const where = [];
      const params = {};
      if (status && VALID_STATUS.has(status)) { where.push('status = @status'); params.status = status; }
      if (date && /^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
        where.push("substr(scheduled_jst_at,1,10) = @date"); params.date = date;
      }
      if (accountHandle) {
        where.push('LOWER(account_handle) = LOWER(@handle)');
        params.handle = String(accountHandle).replace(/^@/, '');
      }
      const sql = 'SELECT * FROM content_pool_items '
        + (where.length ? 'WHERE ' + where.join(' AND ') : '')
        + ' ORDER BY scheduled_jst_at ASC, id ASC';
      return db.prepare(sql).all(params).map(hydrate);
    },

    /** 原子领单：approved 且到期的最早一条 → claimed */
    claimDue(handle, nowJst) {
      const h = String(handle || '').replace(/^@/, '').toLowerCase().trim();
      if (!h || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(nowJst)) return null;
      const row = db.prepare(`
        SELECT * FROM content_pool_items
        WHERE LOWER(account_handle) = LOWER(@h) AND status = 'approved' AND scheduled_jst_at <= @now
        ORDER BY scheduled_jst_at ASC, id ASC LIMIT 1
      `).get({ h, now: nowJst });
      if (!row) return null;
      const upd = db.prepare(`
        UPDATE content_pool_items SET status = 'claimed', claimed_at = @ts, updated_at = @ts
        WHERE id = @id AND status = 'approved'
      `).run({ id: row.id, ts: now() });
      if (upd.changes === 0) return null;
      return hydrate(db.prepare('SELECT * FROM content_pool_items WHERE id = ?').get(row.id));
    },

    report(id, result, { externalPostId, failReason } = {}) {
      if (!Number.isInteger(id) || id <= 0) throw new Error('bad id');
      if (result === 'posted') {
        db.prepare(`
          UPDATE content_pool_items
          SET status='posted', external_post_id=@pid, fail_reason='', posted_at=@ts, updated_at=@ts
          WHERE id=@id
        `).run({ id, pid: String(externalPostId || '').slice(0, 64), ts: now() });
      } else if (result === 'retry') {
        db.prepare(`
          UPDATE content_pool_items SET status='approved', claimed_at=NULL,
            fail_reason=@reason, updated_at=@ts WHERE id=@id AND status='claimed'
        `).run({ id, reason: String(failReason || '').slice(0, 200), ts: now() });
      } else if (result === 'failed') {
        db.prepare(`
          UPDATE content_pool_items SET status='failed', fail_reason=@reason, updated_at=@ts
          WHERE id=@id
        `).run({ id, reason: String(failReason || '').slice(0, 200), ts: now() });
      } else {
        throw new Error('bad report result');
      }
    },

    setStatus(ids, status) {
      if (!VALID_STATUS.has(status)) throw new Error('bad status');
      const nums = (Array.isArray(ids) ? ids : [ids]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      if (!nums) return 0;
      const stmt = db.prepare(
        "UPDATE content_pool_items SET status = ?, updated_at = datetime('now', '+8 hours') WHERE id = ?"
      );
      let changed = 0;
      const tx = db.transaction((list) => {
        for (const id of list) changed += stmt.run(status, id).changes;
      });
      tx(nums);
      return changed;
    },

    edit(id, { text, scheduledJstAt }) {
      const body = String(text || '').trim();
      const sched = String(scheduledJstAt || '').trim();
      if (!body || body.length > 1000) throw new Error('bad text');
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(sched)) throw new Error('bad scheduled_jst_at');
      db.prepare(`
        UPDATE content_pool_items SET text=@t, scheduled_jst_at=@s, updated_at=@ts
        WHERE id=@id AND status IN ('pending','approved','failed')
      `).run({ t: body, s: sched, ts: now(), id: Number(id) });
    },

    remove(ids) {
      const nums = (Array.isArray(ids) ? ids : [ids]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      if (!nums) return 0;
      return db.prepare(`DELETE FROM content_pool_items WHERE id IN (${nums.map(() => '?').join(',')})`).run(...nums).changes;
    },
  };
}

module.exports = { createContentPoolRepo };
```

- [ ] **Step 6: 运行确认通过**

Run: `node --test test/content-pool-api.test.js`
Expected: 3 个 repo 测试 PASS。

- [ ] **Step 7: 提交**

```bash
git add src/db/migrations/070_content_pool.sql src/repositories/content-pool-repo.js test/content-pool-api.test.js
git commit -m "feat(H11): content_pool_items 迁移与仓储（claim/report/审核）"
```

---

## Task 3: content-media 图片落盘服务

**Files:**
- Create: `test-env/x-ops-console/src/services/content-media.js`
- Test: `test/content-pool-api.test.js`（追加 describe 前先写失败断言）

- [ ] **Step 1: 追加失败测试到 test 文件末尾**

```js
const { saveContentMedia, MEDIA_CONTENT_TYPES } = require('../src/services/content-media');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('media: dataURL 落盘返回 /content-media 路径并可读回；非法类型拒绝', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpm-'));
  const png1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const rel = saveContentMedia(png1x1, dir);
  assert.match(rel, /^\/content-media\/[a-f0-9-]{36}\.png$/);
  const full = path.join(dir, path.basename(rel));
  assert.ok(fs.existsSync(full));
  assert.ok(MEDIA_CONTENT_TYPES['.png']);
  assert.throws(() => saveContentMedia('data:image/gif;base64,R0lGODlhAQABAAAAACw=', dir), /unsupported media type/);
  assert.throws(() => saveContentMedia('not a dataurl', dir), /bad dataUrl/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/content-pool-api.test.js`
Expected: FAIL（Cannot find module '../src/services/content-media'）。

- [ ] **Step 3: 实现服务**

`src/services/content-media.js` 完整代码：

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MEDIA_CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
const MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

/**
 * 把 dataURL 图片落到 mediaDir，返回相对 URL '/content-media/<uuid><ext>'。
 * 只允许 jpeg/png/webp；拒绝其它 mime；最大 8MB。
 */
function saveContentMedia(dataUrl, mediaDir) {
  const m = /^data:(image\/jpeg|image\/png|image\/webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m) {
    if (/^data:/.test(String(dataUrl || ''))) throw new Error('unsupported media type');
    throw new Error('bad dataUrl');
  }
  const ext = MIME_TO_EXT[m[1]];
  const buf = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  if (buf.length < 100) throw new Error('media too small');
  if (buf.length > 8 * 1024 * 1024) throw new Error('media too large');
  fs.mkdirSync(mediaDir, { recursive: true });
  const name = crypto.randomUUID() + ext;
  fs.writeFileSync(path.join(mediaDir, name), buf);
  return '/content-media/' + name;
}

/** 文件名白名单校验 + 绝对路径拼接（防目录穿越） */
function resolveMediaFile(mediaDir, file) {
  if (!/^[a-f0-9-]{36}\.(jpe?g|png|webp)$/i.test(String(file || ''))) return null;
  const full = path.join(mediaDir, file);
  if (path.dirname(full) !== path.resolve(mediaDir)) return null;
  return full;
}

function mediaDirFromApp(appOrConfig) {
  const base = (appOrConfig && appOrConfig.contentMediaDir) ||
    path.join(__dirname, '..', '..', '..', 'data', 'content-media');
  return path.resolve(base);
}

module.exports = { saveContentMedia, resolveMediaFile, mediaDirFromApp, MEDIA_CONTENT_TYPES };
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/content-pool-api.test.js`
Expected: 4 测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/services/content-media.js test/content-pool-api.test.js
git commit -m "feat(H11): 内容池配图落盘服务（白名单 mime/文件名）"
```

---## Task 4: 内容池 API（ingest + claim/report + 取图 + 批量动作）+ app.js 注册 + 导航

**Files:**
- Create: `test-env/x-ops-console/src/routes/api/content-pool.js`
- Modify: `test-env/x-ops-console/src/app.js:31`（require）与 `:98`（register）
- Modify: `test-env/x-ops-console/src/views/partials/shell-nav.njk`
- Test: `test/content-pool-api.test.js`（追加 HTTP 链路测试）

- [ ] **Step 1: 追加失败测试（注意 buildApp 需要 media 目录配置，用 buildApp({dbPath:':memory:', contentMediaDir: 临时目录})）**

在测试文件顶部 require 增加：

```js
const { buildApp } = require('../src/app');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
```

末尾追加：

```js
async function mkApp() {
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpapi-'));
  const app = buildApp({ dbPath: ':memory:', contentMediaDir: mediaDir });
  await app.ready();
  return { app, mediaDir };
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('api: ingest(pending)→批量approve→claim(未到期空)→到期领到→取图200→posted', async () => {
  const { app, mediaDir } = await mkApp();
  const ing = await app.inject({
    method: 'POST', url: '/api/content/ingest',
    headers: { 'Content-Type': 'application/json' },
    payload: {
      account_handle: 'Mai_Demo', persona: 'mai', source: 'ai_daily',
      text: '今日はコンビニ夜勤前にちょこっと😊 #メルレ',
      media: [{ data_url: PNG }],
      scheduled_jst_at: '2026-10-15T12:10',
    },
  });
  assert.equal(ing.statusCode, 200);
  const id = ing.json().id;
  assert.ok(id > 0);

  // claim 未批准 → 空
  const empty = await app.inject({ method: 'GET', url: '/api/plugin/content-pool/claim?bot_id=Mai_Demo&now=2026-10-15T12:00' });
  assert.equal(empty.json().item, null);

  const appr = await app.inject({
    method: 'POST', url: '/api/content/approve',
    headers: { 'Content-Type': 'application/json' }, payload: { ids: [id] },
  });
  assert.equal(appr.json().changed, 1);

  const early = await app.inject({ method: 'GET', url: '/api/plugin/content-pool/claim?bot_id=Mai_Demo&now=2026-10-15T12:09' });
  assert.equal(early.json().item, null);

  const got = await app.inject({ method: 'GET', url: '/api/plugin/content-pool/claim?bot_id=mai_demo&now=2026-10-15T12:10' });
  const item = got.json().item;
  assert.ok(item && item.id === id);
  assert.equal(item.media_urls.length, 1);
  assert.match(item.media_urls[0], /^\/content-media\//);

  const img = await app.inject({ method: 'GET', url: item.media_urls[0] });
  assert.equal(img.statusCode, 200);
  assert.equal(img.headers['content-type'], 'image/png');
  assert.ok(img.rawPayload.length > 100);

  const rep = await app.inject({
    method: 'POST', url: '/api/plugin/content-pool/report',
    headers: { 'Content-Type': 'application/json' },
    payload: { bot_id: 'mai_demo', id, result: 'posted', external_post_id: '999' },
  });
  assert.equal(rep.json().ok, true);

  const page = await app.inject({ method: 'GET', url: '/content?status=posted' });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /今日はコンビニ夜勤前にちょこっと/);
  await app.close();
});

test('api: ingest 非法时间/空文案/超大标签拒绝', async () => {
  const { app } = await mkApp();
  const ask = async (payload) => (await app.inject({
    method: 'POST', url: '/api/content/ingest',
    headers: { 'Content-Type': 'application/json' }, payload,
  })).statusCode;
  assert.equal(await ask({ account_handle: 'a', text: 'x', scheduled_jst_at: 'bad' }), 400);
  assert.equal(await ask({ account_handle: 'a', text: '', scheduled_jst_at: '2026-10-15T12:00' }), 400);
  assert.equal(await ask({ account_handle: 'a', text: 'x', scheduled_jst_at: '2026-10-15T12:00' }), 200);
  await app.close();
});

test('api: reject/delete/retry/edit 动作', async () => {
  const { app } = await mkApp();
  const ing = await app.inject({
    method: 'POST', url: '/api/content/ingest',
    headers: { 'Content-Type': 'application/json' },
    payload: { account_handle: 'a', text: 'old', scheduled_jst_at: '2026-10-15T12:00' },
  });
  const id = ing.json().id;
  const edit = await app.inject({
    method: 'POST', url: '/api/content/' + id + '/edit',
    headers: { 'Content-Type': 'application/json' },
    payload: { text: 'new #メルレ', scheduled_jst_at: '2026-10-15T18:00' },
  });
  assert.equal(edit.json().ok, true);
  const rej = await app.inject({
    method: 'POST', url: '/api/content/reject',
    headers: { 'Content-Type': 'application/json' }, payload: { ids: [id] },
  });
  assert.equal(rej.json().changed, 1);
  const del = await app.inject({
    method: 'POST', url: '/api/content/delete',
    headers: { 'Content-Type': 'application/json' }, payload: { ids: [id] },
  });
  assert.equal(del.json().changed, 1);
  await app.close();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/content-pool-api.test.js`
Expected: FAIL（404，路由不存在）。

- [ ] **Step 3: 实现 API 路由（含取图静态回源、日本墙钟 claim）**

`src/routes/api/content-pool.js`：

```js
'use strict';

const { createContentPoolRepo } = require('../../repositories/content-pool-repo');
const { saveContentMedia, resolveMediaFile, mediaDirFromApp, MEDIA_CONTENT_TYPES } = require('../../services/content-media');
const path = require('node:path');

function jstNowWall() {
  const d = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' });
  const t = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Tokyo', hour12: false }).slice(0, 5);
  return d + 'T' + t;
}

function hashtagCount(text) {
  const m = String(text || '').match(/#[^\s#@＠]+/g);
  return m ? m.length : 0;
}

async function contentPoolApiRoutes(app) {
  const repo = createContentPoolRepo(app.db);
  const mediaDir = mediaDirFromApp(app.appConfig || {});

  // ---------- 生产侧：写入内容池（AI 定时任务/人工） ----------
  app.post('/api/content/ingest', async (request) => {
    const b = request.body || {};
    const text = String(b.text || '').trim();
    const sched = String(b.scheduled_jst_at || '').trim();
    if (!String(b.account_handle || '').trim() || !text || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(sched)
        || text.length > 1000 || hashtagCount(text) > 3) {
      return { statusCode: 400, error: 'bad_request',
        msg: 'account_handle/text/scheduled_jst_at(YYYY-MM-DDTHH:MM) 必填，正文≤1000字，标签≤3个' };
    }
    let mediaUrls = [];
    try {
      for (const m of (Array.isArray(b.media) ? b.media : []).slice(0, 4)) {
        if (m && m.data_url) mediaUrls.push(saveContentMedia(m.data_url, mediaDir));
      }
    } catch (e) {
      return { statusCode: 400, error: 'bad_media', msg: String(e.message || e) };
    }
    const id = repo.insert({
      accountHandle: b.account_handle, persona: b.persona, text,
      mediaUrls, scheduledJstAt: sched, source: b.source === 'ai_daily' ? 'ai_daily' : 'manual',
    });
    return { ok: true, id, media_urls: mediaUrls };
  });

  // ---------- 审核动作（JSON API，页面表单也 POST 到这里由页面路由转发不可，故页面直接用表单端点） ----------
  app.post('/api/content/approve', async (request) => {
    const changed = repo.setStatus((request.body || {}).ids, 'approved');
    return { ok: true, changed };
  });
  app.post('/api/content/reject', async (request) => {
    const changed = repo.setStatus((request.body || {}).ids, 'rejected');
    return { ok: true, changed };
  });
  app.post('/api/content/delete', async (request) => {
    const changed = repo.remove((request.body || {}).ids);
    return { ok: true, changed };
  });
  app.post('/api/content/:id/retry', async (request) => {
    repo.report(Number(request.params.id), 'retry', { failReason: 'manual_retry' });
    repo.setStatus([Number(request.params.id)], 'approved');
    return { ok: true };
  });
  app.post('/api/content/:id/edit', async (request) => {
    const b = request.body || {};
    if (hashtagCount(b.text) > 3) return { statusCode: 400, error: 'too_many_hashtags' };
    try {
      repo.edit(Number(request.params.id), { text: b.text, scheduledJstAt: b.scheduled_jst_at });
      return { ok: true };
    } catch (e) {
      return { statusCode: 400, error: 'bad_input', msg: String(e.message || e) };
    }
  });

  // ---------- 插件侧：原子领单 ----------
  app.get('/api/plugin/content-pool/claim', async (request) => {
    const botId = request.query.bot_id || request.query.worker_id || '';
    const handle = String(botId).replace(/^@/, '').trim();
    if (!handle) return { ok: false, msg: 'bot_id required' };
    const nowJst = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(request.query.now || ''))
      ? request.query.now : jstNowWall();
    const item = repo.claimDue(handle, nowJst);
    if (!item) return { ok: true, item: null, now_jst: nowJst };
    return { ok: true, now_jst: nowJst, item: {
      id: item.id, text: item.text, media_urls: item.media_urls,
      scheduled_jst_at: item.scheduled_jst_at, persona: item.persona,
    } };
  });

  // ---------- 插件侧：回报 ----------
  app.post('/api/plugin/content-pool/report', async (request) => {
    const b = request.body || {};
    const id = Number(b.id);
    if (!id || !['posted', 'retry', 'failed'].includes(String(b.result))) {
      return { statusCode: 400, error: 'bad_request', msg: 'id + result(posted|retry|failed) required' };
    }
    try {
      repo.report(id, String(b.result), { externalPostId: b.external_post_id, failReason: b.fail_reason });
      return { ok: true };
    } catch (e) {
      return { statusCode: 400, error: 'report_failed', msg: String(e.message || e) };
    }
  });

  // ---------- 配图回源（CORS 已全局开；文件名严格白名单） ----------
  app.get('/content-media/:file', async (request, reply) => {
    const full = resolveMediaFile(mediaDir, request.params.file);
    if (!full) return reply.code(404).send({ error: 'not_found' });
    const ext = path.extname(full).toLowerCase();
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    reply.header('Content-Type', MEDIA_CONTENT_TYPES[ext] || 'application/octet-stream');
    return reply.send(require('node:fs').createReadStream(full));
  });
}

module.exports = { contentPoolApiRoutes, jstNowWall };
```

> 页面需要的表单 POST（approve/reject/delete/retry/edit）走页面路由单独实现（Task 5），本文件只提供 JSON API；两者共用 repo，不互相 require。

- [ ] **Step 4: app.js 注册路由 + 支持 contentMediaDir 配置（两处编辑）**

`src/app.js` 第 31 行后加：

```js
const { contentPoolApiRoutes } = require('./routes/api/content-pool');
const { contentPageRoutes } = require('./routes/pages/content');
```

第 98 行 `app.register(sourcesPageRoutes);` 后加：

```js
  app.register(contentPoolApiRoutes);
  app.register(contentPageRoutes);
```

contentPageRoutes 在 Task 5 创建；**为了让本任务测试能跑通**，本步先创建占位文件 `src/routes/pages/content.js`：

```js
'use strict';
async function contentPageRoutes(app) {
  const { createContentPoolRepo } = require('../../repositories/content-pool-repo');
  const repo = createContentPoolRepo(app.db);
  app.get('/content', async (request, reply) => {
    const q = request.query || {};
    return reply.view('content.njk', {
      title: '原创内容池', navActive: 'content',
      items: repo.listForReview({ status: q.status, date: q.date, accountHandle: q.handle }),
      status: q.status || '', date: q.date || '', handle: q.handle || '', msg: '',
    });
  });
}
module.exports = { contentPageRoutes };
```

并创建最小视图 `src/views/content.njk`（Task 5 重写为完整审核页）：

```html
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>{{ title }}</title>
<link rel="stylesheet" href="/public/app.css"></head>
<body><header class="shell-header"><h1>X 运营轻总控后台</h1>
{% set navActive = 'content' %}{% include 'partials/shell-nav.njk' %}</header>
<main class="shell-main">{% for it in items %}{{ it.text }}{% endfor %}</main></body></html>
```

- [ ] **Step 5: 导航 partial 加「内容池」**

`src/views/partials/shell-nav.njk` 第 13 行（来源号池）后加：

```html
  <a href="/content" class="{{ 'active' if navActive == 'content' else '' }}">内容池</a>
```

- [ ] **Step 6: 运行全量 API 测试**

Run: `node --test test/content-pool-api.test.js`
Expected: 7 测试全 PASS。

- [ ] **Step 7: 提交**

```bash
git add src/routes/api/content-pool.js src/routes/pages/content.js src/views/content.njk src/app.js src/views/partials/shell-nav.njk test/content-pool-api.test.js
git commit -m "feat(H11): 内容池 ingest/claim/report/取图 API 与最小页面挂载"
```

---

## Task 5: /content 完整审核页（表单动作 + 图片预览 + 按日分组）

**Files:**
- Modify: `test-env/x-ops-console/src/routes/pages/content.js`（替换占位）
- Modify: `test-env/x-ops-console/src/views/content.njk`（替换占位）
- Test: `test/content-pool-api.test.js`（追加表单端点断言）

- [ ] **Step 1: 追加失败测试**

```js
test('page: 表单批量批准/拒绝/删除/重试/编辑后重定向回列表', async () => {
  const { app } = await mkApp();
  const ing = await app.inject({
    method: 'POST', url: '/api/content/ingest',
    headers: { 'Content-Type': 'application/json' },
    payload: { account_handle: 'mai_x', text: 'page-test #メルレ', scheduled_jst_at: '2026-10-15T12:00' },
  });
  const id = ing.json().id;

  const form = async (url, payload) => app.inject({
    method: 'POST', url,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(Object.entries(payload).map(([k, v]) => [k, String(v)])).toString(),
  });

  let r = await form('/content/approve', { ids: id, back: '/content?status=pending' });
  assert.equal(r.statusCode, 302);
  assert.equal(r.headers.location, '/content?status=pending&msg=' + encodeURIComponent('已批准 1 条'));

  r = await form('/content/' + id + '/reject', { back: '/content' });
  assert.equal(r.statusCode, 302);
  r = await form('/content/' + id + '/retry', { back: '/content' });
  assert.equal(r.statusCode, 302);
  r = await form('/content/' + id + '/edit', { text: 'edited', scheduled_jst_at: '2026-10-15T19:00', back: '/content' });
  assert.equal(r.statusCode, 302);
  r = await form('/content/' + id + '/delete', { back: '/content' });
  assert.equal(r.statusCode, 302);
  await app.close();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/content-pool-api.test.js`
Expected: FAIL（POST /content/approve 404）。

- [ ] **Step 3: 替换页面路由为完整版 `src/routes/pages/content.js`**

```js
'use strict';

const { createContentPoolRepo } = require('../../repositories/content-pool-repo');

const STATUS_LABEL = {
  pending: '待审', approved: '已批准', claimed: '待发/已领', posted: '已发', failed: '失败', rejected: '已拒',
};

/** /content 审核页：列表筛选 + 表单动作（与 JSON API 共用 repo） */
async function contentPageRoutes(app) {
  const repo = createContentPoolRepo(app.db);

  app.get('/content', async (request, reply) => {
    const q = request.query || {};
    const items = repo.listForReview({ status: q.status, date: q.date, accountHandle: q.handle })
      .map((it) => Object.assign({}, it, { status_label: STATUS_LABEL[it.status] || it.status }));
    const counts = {};
    for (const s of Object.keys(STATUS_LABEL)) {
      counts[s] = repo.listForReview({ status: s }).length;
    }
    return reply.view('content.njk', {
      title: '原创内容池', navActive: 'content',
      items, counts, STATUS: STATUS_LABEL,
      status: q.status || '', date: q.date || '', handle: q.handle || '',
      msg: String(q.msg || ''),
    });
  });

  function back(request) {
    const b = String((request.body || {}).back || '/content');
    return /^\/content(\?|$)/.test(b) ? b : '/content';
  }
  function withMsg(loc, msg) {
    const sep = loc.includes('?') ? '&' : '?';
    return loc + sep + 'msg=' + encodeURIComponent(msg);
  }

  app.post('/content/approve', async (request, reply) => {
    const ids = [].concat((request.body || {}).ids || []).map(Number).filter(Boolean);
    const changed = repo.setStatus(ids, 'approved');
    return reply.redirect(withMsg(back(request), `已批准 ${changed} 条`));
  });
  app.post('/content/reject', async (request, reply) => {
    const ids = [].concat((request.body || {}).ids || []).map(Number).filter(Boolean);
    const changed = repo.setStatus(ids, 'rejected');
    return reply.redirect(withMsg(back(request), `已拒绝 ${changed} 条`));
  });
  app.post('/content/:id/reject', async (request, reply) => {
    repo.setStatus([Number(request.params.id)], 'rejected');
    return reply.redirect(withMsg(back(request), '已拒绝'));
  });
  app.post('/content/:id/retry', async (request, reply) => {
    repo.report(Number(request.params.id), 'retry', { failReason: 'manual_retry' });
    repo.setStatus([Number(request.params.id)], 'approved');
    return reply.redirect(withMsg(back(request), '已重置为待发'));
  });
  app.post('/content/:id/delete', async (request, reply) => {
    repo.remove([Number(request.params.id)]);
    return reply.redirect(withMsg(back(request), '已删除'));
  });
  app.post('/content/:id/edit', async (request, reply) => {
    const b = request.body || {};
    try {
      repo.edit(Number(request.params.id), { text: b.text, scheduledJstAt: b.scheduled_jst_at });
      return reply.redirect(withMsg(back(request), '已保存'));
    } catch (e) {
      return reply.redirect(withMsg(back(request), '保存失败：' + String(e.message || e)));
    }
  });
}

module.exports = { contentPageRoutes };
```

- [ ] **Step 4: 替换视图 `src/views/content.njk`**

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>{{ title }} - X 运营轻总控后台</title>
  <link rel="stylesheet" href="/public/app.css">
  <style>
    .cp-tabs{display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap}
    .cp-tabs a{padding:4px 12px;border:1px solid #30363d;border-radius:14px;font-size:12px;color:#8b949e;text-decoration:none}
    .cp-tabs a.on{background:#1f6feb;color:#fff;border-color:#1f6feb}
    .cp-card{border:1px solid #30363d;border-radius:8px;padding:12px;margin-bottom:10px;background:#0d1117}
    .cp-meta{font-size:12px;color:#8b949e;margin-bottom:6px}
    .cp-text{white-space:pre-wrap;font-size:14px;line-height:1.7;color:#c9d1d9;margin:6px 0}
    .cp-imgs{display:flex;gap:8px;margin:8px 0}
    .cp-imgs img{width:120px;height:120px;object-fit:cover;border-radius:6px;border:1px solid #30363d}
    .cp-st{display:inline-block;padding:2px 10px;border-radius:10px;font-size:12px}
    .cp-st-pending{background:#30363d;color:#d29922}
    .cp-st-approved{background:#1f6feb;color:#fff}
    .cp-st-claimed{background:#8957e5;color:#fff}
    .cp-st-posted{background:#238636;color:#fff}
    .cp-st-failed{background:#f85149;color:#fff}
    .cp-st-rejected{background:#21262d;color:#8b949e}
    .cp-actions{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
    .cp-actions button,.cp-actions .btn{padding:4px 12px;font-size:12px;border-radius:4px;border:1px solid #30363d;background:#21262d;color:#c9d1d9;cursor:pointer}
    .cp-actions .go{background:#238636;border-color:#238636;color:#fff}
    .cp-actions .no{background:#21262d;color:#ff7b72;border-color:#f85149}
    .cp-edit{width:100%;min-height:90px;background:#0d1117;border:1px solid #30363d;color:#c9d1d9;border-radius:4px;padding:8px;font-size:13px}
    .flash-msg{margin:0 0 12px;padding:8px 14px;background:rgba(35,134,54,.15);border:1px solid #238636;border-radius:6px;color:#3fb950;font-size:13px}
    details summary{cursor:pointer;font-size:12px;color:#8b949e;margin:6px 0}
  </style>
</head>
<body>
  <header class="shell-header">
    <h1>X 运营轻总控后台</h1>
    {% set navActive = 'content' %}
    {% include 'partials/shell-nav.njk' %}
  </header>
  <main class="shell-main">
    {% if msg %}<div class="flash-msg">{{ msg }}</div>{% endif %}

    <div class="cp-tabs">
      {% for s, label in STATUS %}
      <a href="/content?status={{ s }}" class="{{ 'on' if status == s else '' }}">{{ label }} {{ counts[s] }}</a>
      {% endfor %}
      <a href="/content" class="{{ 'on' if not status else '' }}">全部</a>
    </div>

    <form method="get" action="/content" style="margin-bottom:14px;font-size:13px">
      <input type="hidden" name="status" value="{{ status }}">
      <label>日期 <input type="date" name="date" value="{{ date }}" style="background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:3px 6px;border-radius:4px"></label>
      <label style="margin-left:8px">账号 <input type="text" name="handle" value="{{ handle }}" placeholder="handle" style="background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:3px 6px;border-radius:4px"></label>
      <button type="submit" class="btn-save">筛选</button>
    </form>

    <!-- 批量批准：空表单放顶部，卡片内 checkbox 用 form 属性关联（禁止嵌套 form） -->
    <form method="post" action="/content/approve" id="batchApproveForm">
      {% if items.length and (status == '' or status == 'pending' or status == 'failed') %}
      <p><button type="submit" class="btn-save">批准所有勾选内容</button>
      <span class="cp-meta">（待审/失败卡片的勾选框默认选中，可取消）</span></p>
      {% endif %}
    </form>

      {% for it in items %}
      <div class="cp-card">
        <div class="cp-meta">
          <span class="cp-st cp-st-{{ it.status }}">{{ it.status_label }}</span>
          &nbsp;@{{ it.account_handle }}（{{ it.persona }}）&nbsp;
          JST {{ it.scheduled_jst_at }} · {{ it.source }} · #{{ it.id }}
          {% if it.fail_reason %}&nbsp;<span style="color:#f85149">失败原因：{{ it.fail_reason }}</span>{% endif %}
        </div>
        <div class="cp-text">{{ it.text }}</div>
        {% if it.media_urls.length %}
        <div class="cp-imgs">{% for u in it.media_urls %}<img src="{{ u }}" alt="img">{% endfor %}</div>
        {% endif %}
        <div class="cp-actions">
          {% if it.status in ['pending','failed'] %}
          <label style="font-size:12px;color:#8b949e"><input type="checkbox" name="ids" value="{{ it.id }}" form="batchApproveForm" checked> 加入批量批准</label>
          {% endif %}
          {% if it.status == 'pending' %}
          <button type="submit" form="batchEdit{{ it.id }}" class="go">批准</button>
          <button type="submit" form="batchReject{{ it.id }}">拒绝</button>
          {% endif %}
          {% if it.status == 'failed' %}
          <button type="submit" form="retry{{ it.id }}" class="go">重置待发</button>
          {% endif %}
          {% if it.status in ['approved','claimed'] %}
          <button type="submit" form="reject{{ it.id }}">撤回拒绝</button>
          {% endif %}
          <button type="submit" form="del{{ it.id }}" class="no">删除</button>
        </div>
        <details>
          <summary>编辑文案/时间</summary>
          <form method="post" action="/content/{{ it.id }}/edit" id="edit{{ it.id }}">
            <textarea name="text" class="cp-edit">{{ it.text }}</textarea>
            <div style="margin-top:6px">
              <input type="datetime-local" name="scheduled_jst_at" value="{{ it.scheduled_jst_at }}"
                style="background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:3px 6px;border-radius:4px">
              <span class="cp-meta">（日本时间）</span>
              <button type="submit" class="btn-save">保存</button>
            </div>
          </form>
        </details>
      </div>
      <!-- 单条隐藏表单 -->
      <form id="batchEdit{{ it.id }}" method="post" action="/content/approve" style="display:none"><input type="hidden" name="ids" value="{{ it.id }}"></form>
      <form id="batchReject{{ it.id }}" method="post" action="/content/{{ it.id }}/reject" style="display:none"></form>
      <form id="retry{{ it.id }}" method="post" action="/content/{{ it.id }}/retry" style="display:none"></form>
      <form id="reject{{ it.id }}" method="post" action="/content/{{ it.id }}/reject" style="display:none"></form>
      <form id="del{{ it.id }}" method="post" action="/content/{{ it.id }}/delete" style="display:none"
            onsubmit="return confirm('确定删除 #{{ it.id }}？')"></form>
      {% else %}
      <div class="cp-card muted" style="text-align:center;padding:24px">暂无内容</div>
      {% endfor %}
  </main>
</body>
</html>
```

- [ ] **Step 5: 跑测试 + 全量回归**

Run: `node --test test/content-pool-api.test.js && node --test`
Expected: 内容池 8 测试 PASS；x-ops-console 全量测试无回归。

- [ ] **Step 6: 提交**

```bash
git add src/routes/pages/content.js src/views/content.njk test/content-pool-api.test.js
git commit -m "feat(H11): /content 审核页（按日/状态筛选、批量批准、编辑、重试、预览图）"
```

---

## Task 6: NAS 部署 OPS（全量 src tar → build → force-recreate）

> 按项目教训：禁止只 cp 改动文件，必须全量 src 同步后重建镜像。

- [ ] **Step 1: 本地全量测试通过后，按既有部署脚本模式全量同步 NAS**

参照 `test-env/x-ops-console/_deploy_h9_sources_pool.ps1` 的方式：tar 整个 `src/` + package*.json → scp 到 NAS /tmp → 远端 .sh 解包覆盖 `/vol2/1000/test/x-ops-console/src` → `docker compose build && docker compose up -d --force-recreate`。远端脚本先 `sed -i "s/\r$//"` 去 CRLF，sudo 密码走 stdin（见 docs/NAS_ACCESS.md；勿内联 bash 到 PowerShell）。

- [ ] **Step 2: 验证迁移与接口**

```powershell
Invoke-WebRequest -UseBasicParsing "http://<NAS_HOST>:<PORT>/health"
Invoke-WebRequest -UseBasicParsing "http://<NAS_HOST>:<PORT>/content"
```

再用一次 ingest→approve→claim 烟测（Invoke-RestMethod，JSON body 必须非空）。
Expected: /health 200；/content 200 含「内容池」；claim 在批准+到期后领到 item。

- [ ] **Step 3: 验证配图可跨域读回（插件 SW 视角）**

浏览器直接访问 ingest 返回的 `/content-media/xxx.png`：200 + `image/png`。

---

## Task 7: 插件 content-pool-client（SW 代理 + 内容脚本客户端）

**Files:**
- Modify: `unified-scheduler/background.js`（1068 行附近 message 路由加 3 个 action）
- Create: `unified-scheduler/repost/content-pool-client.js`
- Modify: `unified-scheduler/manifest.json`（加载顺序 + 版本三连，版本放 Task 10 一起）
- Test: `unified-scheduler/test/content-pool-client.test.js`

- [ ] **Step 1: background.js 新增三个 SW 代理（放在 `ops_repost_source_status` 分支之后）**

```js
  if (request.action === 'ops_content_pool_claim') {
    var cpQuery = '?bot_id=' + encodeURIComponent(request.bot_id || '');
    if (request.now) cpQuery += '&now=' + encodeURIComponent(request.now);
    opsFetch('/api/plugin/content-pool/claim' + cpQuery)
      .then(function (d) { sendResponse(d); })
      .catch(function () { sendResponse({ ok: false, error: 'claim_fetch_fail' }); });
    return true;
  }
  if (request.action === 'ops_content_pool_report') {
    opsFetch('/api/plugin/content-pool/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bot_id: request.bot_id || '',
        id: request.id,
        result: request.result || 'failed',
        external_post_id: request.external_post_id || '',
        fail_reason: request.fail_reason || '',
      }),
    }).then(function (d) { sendResponse(d); }).catch(function () { sendResponse({ ok: false }); });
    return true;
  }
  if (request.action === 'ops_content_pool_media') {
    // SW 跨域取图 → dataURL 回内容脚本（host 权限沿用 OPS failover 基址）
    fetch(request.url, { credentials: 'omit' })
      .then(function (r) {
        if (!r.ok) throw new Error('http_' + r.status);
        return r.blob();
      })
      .then(function (blob) {
        return new Promise(function (resolve, reject) {
          var fr = new FileReader();
          fr.onloadend = function () { resolve({ ok: true, dataUrl: fr.result, type: blob.type, size: blob.size }); };
          fr.onerror = reject;
          fr.readAsDataURL(blob);
        });
      })
      .then(function (d) { sendResponse(d); })
      .catch(function (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); });
    return true;
  }
```

注意：取图 URL 必须由内容脚本传**相对路径**（`/content-media/..`），SW 拼 OPS 基址。在 `fetch(request.url...)` 前改为：

```js
    var cpImgBase = (typeof OPS_BASES !== 'undefined' && OPS_BASES[0]) || '';
```

若没有现成基址常量，最终实现统一走一个小 helper：`function opsUrl(p){ return opsFetch._base ? opsFetch._base + p : p; }`——先在 background.js 查 `fetchJsonWithFailover` 使用的 host 解析，把 claim/report 已经由 opsFetch 代拼；图片同样改用 opsFetch 同款基址：把 media 分支改为**先经 ops 同源路径**（OPS 本就托管 /content-media，opsFetch 接受完整 path），即不裸 fetch：

最终 media 分支用与 opsFetch 同源的 fetch 组装（执行时读 background.js 顶部 `fetchJsonWithFailover('ops', ...)` 的 base 解析函数复用之；若该函数只返回 JSON，则新增 `opsFetchRaw(path)` 与其并列、共用 base 选择，media 分支调它）。**禁止在内容脚本和本分支写死 IP。**

- [ ] **Step 2: 写失败测试（可纯逻辑部分：dataURL→Blob、模式开关读取）**

`unified-scheduler/test/content-pool-client.test.js`：

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 以无 chrome/window 依赖的方式加载客户端，注入沙箱桩
function loadClient() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'repost', 'content-pool-client.js'), 'utf8');
  const sandbox = {
    window: {},
    chrome: { runtime: { sendMessage: () => {} } },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    Blob: class Blob { constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type; } },
    Uint8Array,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.ContentPoolClient;
}

test('client: dataUrlToBlob 还原字节与 mime', () => {
  const C = loadClient();
  const b64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).toString('base64');
  const blob = C._test.dataUrlToBlob('data:image/png;base64,' + b64);
  assert.equal(blob.type, 'image/png');
  assert.ok(blob.parts[0] instanceof Uint8Array);
  assert.equal(blob.parts[0].length, 6);
});

test('client: isPoolMode 只认真值', () => {
  const C = loadClient();
  assert.equal(C._test.isPoolMode({ contentPoolMode: true }), true);
  assert.equal(C._test.isPoolMode({ contentPoolMode: false }), false);
  assert.equal(C._test.isPoolMode({}), false);
  assert.equal(C._test.isPoolMode(null), false);
});
```

- [ ] **Step 3: 运行确认失败**

Run（在 `unified-scheduler`）：`node --test test/content-pool-client.test.js`
Expected: FAIL（模块不存在）。

- [ ] **Step 4: 实现 content-pool-client.js**

`repost/content-pool-client.js`：

```js
// =============================================================================
// E5 原创内容池客户端：claim / report / 取图（经 background SW，不直连 OPS）
// =============================================================================
(function () {
  'use strict';
  if (window.ContentPoolClient) return;

  function send(message) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(message, function (resp) {
          void chrome.runtime.lastError;
          resolve(resp || { ok: false });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    });
  }

  function isPoolMode(cfg) {
    return !!(cfg && cfg.contentPoolMode === true);
  }

  function dataUrlToBlob(dataUrl) {
    var m = /^data:([^;,]+);base64,(.*)$/.exec(String(dataUrl || ''));
    if (!m) throw new Error('bad dataUrl');
    var bin = atob(m[2]);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: m[1] });
  }

  var ContentPoolClient = {
    /** 领单；无到期返回 null，异常返回 {error} */
    async claim(handle, nowJst) {
      var r = await send({ action: 'ops_content_pool_claim', bot_id: handle || '', now: nowJst || '' });
      if (!r || !r.ok) return { error: (r && r.error) || 'claim_fail' };
      return r.item || null;
    },

    async report(id, result, meta) {
      meta = meta || {};
      return send({
        action: 'ops_content_pool_report',
        bot_id: meta.botId || '',
        id: id, result: result,
        external_post_id: meta.externalPostId || '',
        fail_reason: meta.failReason || '',
      });
    },

    /** 相对路径数组 → Blob[]；任一失败整体失败（对齐 E1 图优先：缺图整条放弃） */
    async fetchMedia(relUrls) {
      var out = [];
      for (var i = 0; i < relUrls.length; i++) {
        var r = await send({ action: 'ops_content_pool_media', url: relUrls[i] });
        if (!r || !r.ok || !r.dataUrl) throw new Error((r && r.error) || 'media_fail');
        out.push(dataUrlToBlob(r.dataUrl));
      }
      return out;
    },

    _test: { isPoolMode: isPoolMode, dataUrlToBlob: dataUrlToBlob },
  };

  window.ContentPoolClient = ContentPoolClient;
})();
```

- [ ] **Step 4b: background media 分支最终写法（用共享 base 的 raw fetch）**

执行时先 Grep background 头 60 行确认 `fetchJsonWithFailover` 如何选择内外网 base；在它旁边导出同步 helper（如已存在 `opsBaseUrl()` 直接用），然后把 media 分支改成：

```js
  if (request.action === 'ops_content_pool_media') {
    opsFetchRaw(request.url)
      .then(function ({ blob, type }) {
        return new Promise(function (resolve, reject) {
          var fr = new FileReader();
          fr.onloadend = function () { resolve({ ok: true, dataUrl: fr.result, type: type, size: blob.size }); };
          fr.onerror = reject;
          fr.readAsDataURL(blob);
        });
      })
      .then(sendResponse)
      .catch(function (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); });
    return true;
  }
```

`opsFetchRaw(path)` 与 `opsFetch` 共用同一 base/故障转移序列，返回 `{blob,type}`；path 以 `/content-media/` 开头。若故障转移工具不易复用，允许在 `fetchJsonWithFailover` 同文件加 20 行镜像函数（GET + r.blob()），但必须复用同一组 base，禁止新写地址。

- [ ] **Step 5: manifest 注入客户端（repost-tracker 之后、repost-engine 之前）**

`manifest.json` 第 126-127 行之间加：

```json
        "repost/content-pool-client.js",
```

- [ ] **Step 6: 跑 client 测试**

Run: `node --test test/content-pool-client.test.js`
Expected: 2 测试 PASS。

- [ ] **Step 7: 提交**

```bash
git add background.js repost/content-pool-client.js manifest.json test/content-pool-client.test.js
git commit -m "feat(E5): 内容池 SW 代理与内容脚本客户端（claim/report/取图）"
```

---

## Task 8: repost-engine 内容池分支 + 成功/失败回报

**Files:**
- Modify: `unified-scheduler/repost/repost-engine.js`（runOnce 两处插桩 + 新函数）

- [ ] **Step 1: runOnce 在 pendingEarly 分支结束（第 1576 行 `}`）之后、`var current = T().getCurrent();`（1578 行）之前插入内容池分流**

```js
      // E5：内容池模式 —— 不扫来源号，claim 到就走既有两阶段发布
      var cpCfgPool = null;
      try { cpCfgPool = T().getConfig ? T().getConfig() : null; } catch (eCp) { cpCfgPool = null; }
      if (window.ContentPoolClient && (!cpCfgPool || cpCfgPool.contentPoolMode === true
          || cpCfgPool.contentPoolMode === 'true' || cpCfgPool.contentPoolMode === 1)) {
        await runContentPoolTick();
        return;
      }
```

- [ ] **Step 2: 成功分支补回报（约 1535-1538 行）**

把：

```js
        if (pubOk === true) {
          clearPendingContent();
          consecutiveFails = 0;
          log('发布成功');
```

改为：

```js
        if (pubOk === true) {
          if (pendingEarly.contentPoolId && window.ContentPoolClient) {
            window.ContentPoolClient.report(pendingEarly.contentPoolId, 'posted', {
              externalPostId: pendingEarly.tweetId || '',
            }).then(function (r) {
              try { log('内容池回报 posted id=' + pendingEarly.contentPoolId + (r && r.ok ? '' : ' 失败')); } catch (e) {}
            });
          }
          clearPendingContent();
          consecutiveFails = 0;
          log('发布成功');
```

- [ ] **Step 3: 跳过/失败分支补回报（约 1558-1566 行）**

`if (pubOk && pubOk.skipped) {` 块内 `clearPendingContent();` 之后加：

```js
          if (pendingEarly.contentPoolId && window.ContentPoolClient) {
            // 可恢复（等图/媒体临时问题）→ retry；内容红线放弃 → failed 人工处理
            var cpRetryReasons = { media_restore_fail: 1, media_download_fail: 1, api_business: 0 };
            var cpResult = cpRetryReasons[pubOk.reason] === 1 ? 'retry' : 'failed';
            window.ContentPoolClient.report(pendingEarly.contentPoolId, cpResult, { failReason: pubOk.reason || 'skipped' });
            log('内容池回报 ' + cpResult + ' id=' + pendingEarly.contentPoolId + ' reason=' + (pubOk.reason || ''));
          }
```

发布异常（catch 分支 pubOk=false）时 pending 保留可重试；为避免 claimed 卡死，在 `consecutiveFails++; log('发布失败 ...')` 之后加：

```js
        if (pendingEarly.contentPoolId && window.ContentPoolClient && consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
          window.ContentPoolClient.report(pendingEarly.contentPoolId, 'failed', { failReason: 'publish_failed_x5' });
        }
```

- [ ] **Step 4: 新增 runContentPoolTick（放在 runOnce 函数之后）**

```js
  // E5：内容池模式一轮 —— claim→下图→存 pending→跳发帖页；空池定时再查
  async function runContentPoolTick() {
    var myHandle = '';
    try {
      if (T().getMyHandle) myHandle = T().getMyHandle() || '';
      if (!myHandle) myHandle = (JSON.parse(localStorage.getItem('matrix_my_handle') || '""') || '');
    } catch (eH) { myHandle = '';
      if (!myHandle) myHandle = (JSON.parse(localStorage.getItem('matrix_my_handle') || '""') || '');
    }
    if (!myHandle) {
      log('内容池：认不到本号 handle，60 秒后再查');
      isProcessing = false;
      scheduleNext(60000);
      return;
    }

    var item;
    try {
      item = await window.ContentPoolClient.claim(myHandle);
    } catch (e) { item = { error: String(e && e.message || e) }; }
    if (item && item.error) {
      log('内容池 claim 异常：' + item.error + '，60 秒后再查');
      isProcessing = false;
      scheduleNext(60000);
      return;
    }
    if (!item) {
      log('内容池无到期内容，5 分钟后再查');
      isProcessing = false;
      scheduleNext(5 * 60000);
      return;
    }

    var urls = item.media_urls || [];
    var blobs = [];
    if (urls.length) {
      try {
        blobs = await window.ContentPoolClient.fetchMedia(urls);
      } catch (eImg) {
        log('内容池配图下载失败 id=' + item.id + '：' + (eImg && eImg.message) + '，报 retry 延后重发');
        await window.ContentPoolClient.report(item.id, 'retry', { failReason: 'media_download_fail' });
        isProcessing = false;
        scheduleNext(60000);
        return;
      }
    }

    try {
      await savePendingContent(item.text, blobs, '', String(item.id));
      var pend = JSON.parse(sessionStorage.getItem(PENDING_CONTENT_KEY) || 'null');
      if (pend) {
        pend.contentPoolId = item.id;
        sessionStorage.setItem(PENDING_CONTENT_KEY, JSON.stringify(pend));
      }
      log('内容池已存待发 id=' + item.id + '（图 ' + blobs.length + '），导航发帖页');
    } catch (eSave) {
      log('内容池存待发失败：' + (eSave && eSave.message));
      await window.ContentPoolClient.report(item.id, 'retry', { failReason: 'save_pending_fail' });
      isProcessing = false;
      scheduleNext(30000);
      return;
    }

    // 与既有 pending 路径一致：跳 /compose/post，保持 isProcessing，重载后 runOnce 走 pendingEarly 发布
    var navOk = true;
    var pubUrl = 'https://x.com/compose/post';
    try {
      if (typeof SchedulerGate !== 'undefined' && SchedulerGate.go) navOk = !!SchedulerGate.go('repost', pubUrl, { force: true });
      else { location.href = pubUrl; }
    } catch (eNav) { navOk = false; }
    if (!navOk) {
      log('跳转发帖页被节流，待发已保留，稍后重试');
      setTimeout(function () { isProcessing = false; scheduleNext(8000); }, 200);
    }
  }
```

> 说明：`getMyHandle` 若 tracker 中不存在，执行时在 repost-tracker.js 查本号 handle 的既有读取函数名（E2 踩坑记录里的认号优先级：导航栏 Profile 链接 > matrix_my_handle > matrix_stats_*），把上面读取替换为该现成函数；禁止用 location.pathname。

- [ ] **Step 5: 语法检查 + 相关测试**

Run: `node --check repost/repost-engine.js && node --check repost/content-pool-client.js && node --test test/`
Expected: 语法 OK；既有测试无回归。

- [ ] **Step 6: 提交**

```bash
git add repost/repost-engine.js
git commit -m "feat(E5): repost-engine 内容池模式分流与 posted/retry/failed 回报"
```

---

## Task 9: config-sync 透传 contentPoolMode + tracker 确认 + 账号开窗配置

**Files:**
- Modify: `unified-scheduler/shared/config-sync.js:389`（cfg 对象加一行）

- [ ] **Step 1: applyRepostRemote 的 cfg 增加模式位（appendLink 那行前加）**

```js
        contentPoolMode: truthy(thresholds.repost_content_pool, false),
```

- [ ] **Step 2: 确认 tracker 透传（只读检查，无需改码）**

Grep `repost/repost-tracker.js` 的 `setConfig`：必须是 Object.assign 全量保存（使 contentPoolMode 随 getConfig 读出）。若其维护字段白名单，则把 `contentPoolMode` 加进白名单。

- [ ] **Step 3: 两个发帖号注册后写账号 override（部署后一次性数据操作，经现有账号中心或 SQL）**

对まい/あかり两个 handle 写 override：

```sql
INSERT INTO config_account_overrides (x_handle,key,value)
SELECT x_handle,'repost_content_pool','1' FROM accounts
WHERE LOWER(x_handle) IN ('<mai_handle>','<akari_handle>')
ON CONFLICT DO UPDATE SET value='1';
```

同时给两号写转帖窗口 override（JST 11:00–23:00 可发；键名沿用现有 repost_start_hour / repost_eve_end_hour，值按现有语义是北京还是 JST 以 F1/A1 既有约定为准——执行时核对 `repost_start_hour` 的消费方时区后再写，**不确定就先只开 12-22 点保守窗口**）。

- [ ] **Step 4: 实测下发**

插件 chrome://extensions reload → X 标签页控制台看 `[ConfigSync] 转帖来源` 与 localStorage `sg_repost_config`：含 `contentPoolMode: true`。

- [ ] **Step 5: 提交**

```bash
git add shared/config-sync.js
git commit -m "feat(F1): repost cfg 透传 contentPoolMode（repost_content_pool 账号 override）"
```

---

## Task 10: 版本三连 + 手册 §13 记录 + 扩展 reload 验收

**Files:**
- Modify: `unified-scheduler/manifest.json`（version/description/default_title）
- Modify: `docs/工作指导.md` §13

- [ ] **Step 1: manifest 版本 4.6.125 → 4.6.126，description/default_title 同步写明内容池模式**

- [ ] **Step 2: 工作指导 §13 追加变更记录（按既有格式：版本/日期/板块子 ID/改了什么/为什么）**

- [ ] **Step 3: 提交**

```bash
git add manifest.json docs/工作指导.md
git commit -m "release: 4.6.126 原创内容池自动发帖（E5/H11）"
```

- [ ] **Step 4: 实机验收清单**

1. OPS `/content` 有一条 approved 且到期的まい测试帖（含 1 图）；
2. まい号浏览器重载扩展，转帖模块在开窗内启动；
3. 观察日志依次出现：claim→存待发→跳 /compose/post→粘贴/注图→发布成功→`内容池回报 posted`；
4. OPS `/content?status=posted` 看到该条；
5. 清空池后日志为「无到期内容，5 分钟后再查」，**不导航、不发空帖**；
6. 第二个标签页同时启动不重复领（claimed 原子性）。

---

## Task 11: 每日 07:00 定时生产（P3，验收通过后创建）

- [ ] **Step 1: 用 Schedule 工具创建周期任务**

cron `0 7 * * *`，timezone `Asia/Shanghai`，message（自包含，执行体就是给我的指令）：

```text
执行日本兼职矩阵每日内容生产（10/15 起，工作日无休）：
1. 读取 x-japan-accounts/ 下的人设档案与内容日历（week1 包之后按周滚动），确定今天 JST 日期与阶段（第1-2周养号期零导流；第3-4周铺垫；第5周起转化）。
2. 为まい生成 3 条、あかり生成 3 条日文原创推文（标签1-2个、零裸词零外链零LINE ID、首句钩子、短句换行），按 12:00/18:00/21:20 左右错峰给 scheduled_jst_at；每号 1 张配图（内置 GenerateImage，不露脸素人随手拍风格，固定道具连续；水印规避构图）。
3. 调 OPS POST /api/content/ingest（NAS 地址见 docs/NAS_ACCESS.md；图片以 data_url 传入；source=ai_daily），状态默认 pending。
4. 生成 A↔B 互评剧本 1 组（错时 5-15 分钟、真人语气）；第3-4周起加私信号评论承接话术。
5. 产出后 pushplus 或直接在任务结果里汇总：每条 id/账号/计划时间，等待人工 8 点前在 /content 一键批准。
失败重试 1 次仍失败则告警，不得写半截数据。
```

- [ ] **Step 2: 首周（10/15–10/21）不启用定时任务**，由 P0 内容包人工推进；第二周起启用并连续观察 3 天产出质量后再保持。

---

## 验收标准（整体）

- OPS：`node --test` 全绿；`/content` 审核流可用；NAS 容器重建后迁移 070 生效。
- 插件：`node --test test/` 全绿；内容池账号 claim→拟人发帖→回报闭环在实机成功 ≥3 条（含 1 条带图、1 条纯文、1 次空池不空发）。
- 内容：P0 第一周 42 条文案 + 14 张配图交付，人工审核后 10/15 开始发布。
- 文档：手册 E5/H11/§X/F1 与工作指导 §13 齐备，版本 4.6.126。

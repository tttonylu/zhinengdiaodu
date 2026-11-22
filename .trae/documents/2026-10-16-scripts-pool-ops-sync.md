# 兼职话术池 OPS 化 + 插件双向同步

## Context

用户要在 OPS 后台直接编辑兼职（job）话术，插件自动同步，不再每次改话术都发版重载（昨晚改话术被迫发了 4.6.139）。

**现状（探索结论）**：
- OPS 其实已有「话术中心」页（`/scripts`，导航第 7 项），含 `script_sets/script_templates/script_settings` 三表（002_scripts.sql）、scripts-repo、页面+API 全套——但**只有 dating（约会）一个池**（v1-v10 种子全是约会话术），所以用户"找不到兼职话术池"。
- 插件已有同步链路：`fetchScriptsFromServer`（content_chat.js:513）→ background `scripts_pool`（background.js:911）→ OPS `GET /api/scripts/pool` → `applyServerScripts`（535）写 localStorage `dan_scripts` + 定时同步 `startScriptSync`（593，间隔 SCRIPTS_SYNC_INTERVAL）。
- **缺口**：job 池完全插件本地——`SCRIPT_DEFAULTS_JOB` v1.9 硬编码（content_chat.js:6475-6548，6 套 v1-v6，字段 icebreaker/ad_template/kick_message/final_kick_message/reject_message/foreigner_reject），bootstrap 进 `dan_scripts_job`（`ensureJobScriptsBootstrapped` 6612），由 `chat_script_pool` 阈值选择池（5447-5463）。`applyServerScripts` 只写 dating key，job 池永远不同步。
- `getPoolPayload()`（scripts-repo.js:85）version 硬编码 `'2.0'`，无池维度；插件版本比较是**字符串比较**（有 '10'<'2' 隐患）；dating 有防回滚守卫（imported_from_json + soft-ice 检查，545-552）。

## 目标

OPS 话术中心支持双池（兼职 job / 约会 dating）管理；OPS 任何编辑即时生效并递增池版本；插件按各自 localStorage key 同步两个池；OPS 不可达时回落插件内置兜底（现有行为不变）。

## 改动

### A. OPS 侧（test-env/x-ops-console/src/）

1. **迁移 `072_scripts_pool_dim.sql`**（最新编号 071 之后）
   - `ALTER TABLE script_sets ADD COLUMN pool TEXT NOT NULL DEFAULT 'dating'`（存量 v1-v10 自动归 dating）
   - `CREATE INDEX idx_script_sets_pool ON script_sets(pool, enabled)`

2. **repositories/scripts-repo.js**
   - `listSets(pool)` / `listFullSets(pool)` / `getPoolPayload(pool)` 加 pool 过滤（pool 缺省 'dating' 保持兼容）
   - 版本机制：废弃硬编码 '2.0'，改 `script_settings` 里 `pool_version_<pool>` 整数计数器（初值 3，高于 dating '2.1' 和 job '1.9'，数值比较均通过）；`upsertSet/upsertTemplate/deleteSet/setEnabled` 任一写操作后 `bumpPoolVersion(pool)`
   - `upsertSet` 支持写入 pool 列

3. **routes/api/scripts.js**
   - `GET /api/scripts/pool?pool=xxx`（缺省 dating，向后兼容插件旧版）
   - 其余 CRUD 接 pool 参数；`TEMPLATE_TYPES` 不变（final_kick_message 已在插件端合并，OPS 模板类型保持现有 5 种 + 增加 `final_kick_message` 类型支持，repo 透传即可）

4. **routes/pages/scripts.js + views/scripts.njk**
   - 页面顶部加池 tab：**兼职（job）/ 约会（dating）**，默认选中兼职；每个 tab 内列表/编辑/启停/删除逻辑不变，仅按 pool 过滤
   - 新建话术 set 时归属当前 tab 的池
   - SCRM 链接管理区块保持不变
   - onReady 种子：dating 空→现有逻辑不变；**job 空→从 `unified-scheduler/chat_scripts_job.json` 种子**（仿现有 getDefaultScripts 模式，读插件侧 JSON 文件）

5. **新增 `unified-scheduler/chat_scripts_job.json`**：把当前 SCRIPT_DEFAULTS_JOB v1.9 的 6 套内容原样导出（set_id `job_v1`..`job_v6`），既是 OPS 种子来源，也是插件离线兜底的数据镜像

### B. 插件侧（unified-scheduler/）

6. **background.js:911**：`scripts_pool` action 透传 `request.pool` → `opsFetch('/api/scripts/pool?pool=' + (pool||'dating'))`

7. **chat/content_chat.js**
   - `fetchScriptsFromServer(pool)`：带 pool 请求
   - `applyServerScripts(poolData, pool)`：按 pool 决定写入 key（`dan_scripts` / `dan_scripts_job`）；**版本比较改数值比较**（`parseFloat`，两处：dating 防回滚、job 的 serverVer>localVer 判断）；dating 保留 soft-ice 守卫，job 不需要
   - `syncScriptsFromServer` / `startScriptSync` / 启动 3 秒同步（613）：**两个池都拉都应用**
   - `ensureJobScriptsBootstrapped` 保留作离线兜底；本地 version 语义不变
   - 面板手动同步按钮（7470）同步双池

### C. 宪法链与发布

8. 手册 §C7 更新：话术池 OPS 化、pool 维度、版本计数器、双池同步语义（先改手册再改码）
9. manifest 4.6.139 → **4.6.140**（version/description/default_title 三连）
10. 工作指导.md §13 追加变更记录
11. NAS 全量部署 OPS（tar→scp→远端解包→docker compose build→up，走 _deploy 脚本模式，sudo 密码 stdin）

### D. 测试

- OPS：scripts-repo pool 过滤/版本递增测试；API `?pool=job` 下发测试（buildApp + :memory: 模式）
- 插件：applyServerScripts job 池写入 `dan_scripts_job`、数值版本比较、双池同步测试（test/ 现有 mock 模式）
- 两端 `node --test` 全绿后部署

## 关键决策

- **池版本计数器初值 3**：数值上 > dating 本地 '2.1'、> job 本地 '1.9'，首次同步即可覆盖；字符串比较改数值比较后无进位隐患
- **API 缺省 pool=dating**：旧版插件（4.6.139 及以下）不带 pool 参数仍能拿到 dating 池，不炸
- **job 池种子 = 当前线上 v1.9 内容**：OPS 首次打开兼职 tab 即看到正在用的 6 套话术，所见即所得
- **不动 dating 池数据**：只加 pool 列，现有 10 套约会话术与页面行为不变

## 验证

1. OPS 测试 + 插件测试全绿
2. NAS 部署后：打开 `/scripts` → 兼职 tab 见 6 套 v1.9 话术；编辑其中一套破冰 → 保存
3. 插件重载 4.6.140 后（或等同步间隔）：job 账号 localStorage `dan_scripts_job` 对应 set 内容更新、`source='server'`
4. 断 OPS 网：插件回落本地兜底，聊天不中断

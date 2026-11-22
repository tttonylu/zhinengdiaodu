const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const chatSrc = fs.readFileSync(path.join(root, 'chat', 'content_chat.js'), 'utf8');
const bgSrc = fs.readFileSync(path.join(root, 'background.js'), 'utf8');

test('后台标签预检：过期缓存不得直接判“没有任务”', () => {
  // 现场 13:58：用的是 4.5 分钟前的 211 行快照，同一份列表 4 分钟前
  // 有 16 条“对方最后发言”，这拍却报 peer_last=0 / candidates=0，
  // 于是判 no_task、连标签都不激活 —— 表现成“脉冲没在扫、也没回”。
  const start = chatSrc.indexOf('var cacheTrustMs');
  assert.ok(start > 0, '必须存在缓存新鲜度判定');
  const block = chatSrc.slice(start, start + 700);
  assert.match(block, /cacheTrustMs/);
  assert.match(block, /cache_age_ms/);
  assert.match(block, /cache_stale_forced_scan/);
  // 真正决定“不激活标签”的条件必须带上 cacheFresh
  const gateStart = chatSrc.indexOf('if (hiddenPre && cacheFresh && hiddenPre.actionable === 0');
  assert.ok(gateStart > 0, 'no_task 必须要求缓存新鲜');
});

test('X 标签页彻底消失时后台必须自动重建守箱页', () => {
  // 现场 14:02 之后：X 标签被关掉，Chrome 里只剩扩展页与别的站。
  // keepalive 还在写 system.sw_alive，OPS 看着“在跑”，
  // 但内容脚本一个都不存在，chat.inbox_* 从此彻底停止。
  assert.match(bgSrc, /function maybeRespawnMissingXTab\(/);
  assert.match(bgSrc, /function shouldRespawnXTab\(/);
  const scan = bgSrc.slice(
    bgSrc.indexOf('function scanCrashedXTabs'),
    bgSrc.indexOf('function scanCrashedXTabs') + 1400
  );
  assert.match(scan, /if \(!tabs \|\| !tabs\.length\) \{/);
  assert.match(scan, /maybeRespawnMissingXTab\(\)/);
  // 只重建后台页，绝不抢焦点
  const respawn = bgSrc.slice(
    bgSrc.indexOf('function maybeRespawnMissingXTab'),
    bgSrc.indexOf('function maybeRespawnMissingXTab') + 1200
  );
  assert.match(respawn, /active: false/);
  assert.doesNotMatch(respawn, /active: true/);
  // 必须有节流，避免 X 崩了以后每 60 秒开一个新标签
  assert.match(respawn, /X_RESPAWN_GAP_MS/);
  assert.match(respawn, /X_RESPAWN_MAX_PER_HOUR/);
});

test('守箱开关必须同步到扩展存储，后台才知道要不要重建', () => {
  // 后台读不到页面的 localStorage；不同步的话“自动重建”永远不触发。
  assert.match(chatSrc, /sg_inbox_watch_on/);
  const setMode = chatSrc.slice(
    chatSrc.indexOf('function setRunMode('),
    chatSrc.indexOf('function setRunMode(') + 1400
  );
  assert.match(setMode, /chrome\.storage\.local\.set/);
  assert.match(setMode, /sg_inbox_watch_on: m === 'inbox'/);
  assert.match(bgSrc, /chrome\.storage\.local\.get\(\['sg_inbox_watch_on', 'sg_run_mode'\]/);
});

test('终催文案不得复用首次催加原句', () => {
  // 现场：direct_v1 / curious_v1 / blunt_v1 三套话术只有 kick_message，
  // 没有 final_kick_message；旧兜底链退回 kick_message，
  // 同一个人连着收到两遍一模一样的「まだかなー🥺 …」。
  const start = chatSrc.indexOf("if (route === 'kick') {");
  assert.ok(start > 0);
  const block = chatSrc.slice(start, start + 1400);
  assert.match(block, /var firstKickTpl/);
  assert.match(block, /var finalKickTpl/);
  assert.match(block, /kickTpl === firstKickTpl/);
  assert.match(block, /FINAL_KICK_MESSAGE/);
});

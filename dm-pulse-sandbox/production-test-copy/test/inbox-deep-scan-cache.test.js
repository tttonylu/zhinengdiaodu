const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const chatSrc = fs.readFileSync(path.join(root, 'chat', 'content_chat.js'), 'utf8');
const followSrc = fs.readFileSync(path.join(root, 'follow', 'content_follow_v1522.js'), 'utf8');
const configSrc = fs.readFileSync(path.join(root, 'shared', 'config-sync.js'), 'utf8');

test('节流拍用文字快照覆盖整份列表，绝不缓存 DOM 节点', () => {
  // 4.9.98：深扫 3 分钟一次；中间拍必须仍能看见整份列表，否则下方老会话永远轮不到。
  // 但只能缓存纯文字字段：旧实现把 <a>/<div> 序列化成 {}，读回来全是空对象。
  const save = chatSrc.slice(
    chatSrc.indexOf('function saveInboxDeepRowsCache'),
    chatSrc.indexOf('function loadInboxDeepRowsCache')
  );
  assert.match(save, /__sgSnapshot: true/);
  assert.match(save, /text: text/);
  // 快照必须保留换行：显示名/时间/预览是三行，压成一行会让 preview 变空，
  // 整份列表都会判成 unknown，脉冲等于什么都没看见。
  assert.match(save, /\.split\('\\n'\)/);
  assert.match(save, /\.join\('\\n'\)/);
  assert.doesNotMatch(save, /JSON\.stringify\(rows\)/);
  assert.match(chatSrc, /loadInboxDeepRowsCache\(8 \* 60 \* 1000\)/);
  assert.match(chatSrc, /served_from_cache: true/);
  assert.match(chatSrc, /visible_only: false/);
  const throttled = chatSrc.indexOf('served_from_cache: true');
  const branch = chatSrc.slice(throttled - 600, throttled + 400);
  assert.match(branch, /cacheNow\.rows/, '节流拍必须优先用整份列表的文字快照');
});

test('缓存拍必须用实时 DOM 刷新未读，不能沿用旧快照的已读状态', () => {
  // 现场：蓝点明明亮着，OPS 却报 unread=0 / candidates=0。
  // 根因是深扫快照把 3 分钟前的 unreadInfo 一起缓存了。
  assert.match(chatSrc, /function refreshSnapshotRowsUnread\(/);
  assert.match(chatSrc, /allRowsScanned = refreshSnapshotRowsUnread\(cacheNow\.rows\)/);
  const fn = chatSrc.slice(
    chatSrc.indexOf('function refreshSnapshotRowsUnread'),
    chatSrc.indexOf('function refreshSnapshotRowsUnread') + 2600
  );
  assert.match(fn, /getInboxRowUnread\(lr\)/);
  assert.match(fn, /if \(hit\.unread\)/);
  // 可见行的“视觉未读消失”也要同步，否则旧蓝点会一直挂着。
  assert.match(fn, /!row\.unreadInfo\.precise/);
  assert.match(chatSrc, /cache_unread_refreshed/);
});

test('同一 peerId 有两条台账时，反查必须选真实账号而不是临时 p<peerId>', () => {
  // 现场：同一个人既有 @handle 台账（有破冰/广告历史），
  // 又有一条 p<peerId> 临时记录（round=0）。旧逻辑返回先遍历到的那条，
  // 于是永远判成“没破冰、不处理”，对方回信也永远不会被回复。
  const fn = chatSrc.slice(
    chatSrc.indexOf('function resolveLedgerHandleByPeerId'),
    chatSrc.indexOf('function resolveLedgerHandleByDisplayName')
  );
  assert.match(fn, /ledgerEntryEvidenceRank\(/);
  assert.match(fn, /bestRank/);
  const rankFn = chatSrc.slice(
    chatSrc.indexOf('function ledgerEntryEvidenceRank'),
    chatSrc.indexOf('function ledgerEntryEvidenceRank') + 1200
  );
  assert.match(rankFn, /\^p\\d\{5,\}\$/);
  assert.match(rankFn, /iceSentAt/);
  // 扫描阶段的 peerId → handle 映射也必须按证据强度挑，不能后写覆盖。
  assert.match(chatSrc, /var pid2rank = \{\};/);
  assert.match(chatSrc, /pidRank > \(pid2rank\[pidKey\] \|\| 0\)/);
});

test('打开会话拿到真实 @handle 后，临时 p<peerId> 必须并回真实账号', () => {
  // 现场：列表行只有 peerId → 建了临时 p<peerId>（round=0）；
  // 真实账号台账有破冰/广告历史，但两者没关联，于是永久判“没破冰”。
  assert.match(chatSrc, /var headerAdoptable = /);
  assert.match(chatSrc, /ledgerMatchedBy = 'header_adopted'/);
  const block = chatSrc.slice(
    chatSrc.indexOf('var headerAdoptable = '),
    chatSrc.indexOf("if (!targetHandle && peerId) targetHandle = 'p' + peerId;")
  );
  // 只补空缺，不能覆盖真实账号已有证据
  assert.match(block, /toEntry\[f\] === undefined/);
  assert.match(block, /mergedFromSyntheticKey/);
  // 临时记录保留但标记，避免历史 OPS 断链
  assert.match(block, /mergedInto: adoptTo/);
  // 从未核对过的临时记录也要给一次验证打开的机会
  assert.match(chatSrc, /var spNeverVerified = !spLastPreview;/);
});

test('点击后仍停在列表页时必须判 open_nav_failed，不能继续读正文', () => {
  // 现场：open_mode=click、url_peer_id 为空、path 仍是 /i/chat，
  // 却继续读气泡 → 0 条 → reply_read_failed，看起来像对方没回。
  const marker = '硬校验：真的进到会话详情页才允许读正文';
  const i = chatSrc.indexOf(marker);
  assert.ok(i > 0, '缺少打开后的会话页硬校验');
  const block = chatSrc.slice(i, i + 1400);
  assert.match(block, /pathHasConversationId\(\)/);
  assert.match(block, /isDmInboxListRootPath\(\)/);
  assert.match(block, /reason: 'open_nav_failed'/);
  assert.match(block, /没有进入会话详情/);
});

test('已合并的临时台账不再占用 peerId，不能把真实账号回写挡住', () => {
  // 现场：临时 p<peerId> 并进真实账号后仍保留 peerId，
  // peerIdOwnedByOther 把它当成“另一个人”，真实账号回写 peerId 被拒绝，
  // 接着 identity_pending，对方回复永远读不进来。
  const i = chatSrc.indexOf('function peerIdOwnedByOther');
  assert.ok(i > 0);
  const fn = chatSrc.slice(i, i + 1600);
  assert.match(fn, /if \(e\.mergedInto\) continue;/);
  assert.match(fn, /\^p\\d\{5,\}\$\/\.test\(nh\)/);
  assert.match(fn, /\^dn_\/i\.test\(nh\)/);
});

test('后台“有没有活”预检必须只读，不得写台账', () => {
  // 预检每 20 秒跑一次；若它顺手清冷却、写 adopted 记录、记 pendingAt，
  // 就会在用户看不见时改状态，并与真正的脉冲互相覆盖。
  const i = chatSrc.indexOf('function hiddenInboxHasWork');
  assert.ok(i > 0);
  // 4.9.113：预检里新增了未读/对方最后发言的预统计，窗口相应放宽。
  const fn = chatSrc.slice(i, i + 4200);
  assert.match(fn, /readOnly: true/);
  assert.match(chatSrc, /var readOnly = !!opts\.readOnly;/);
  assert.match(chatSrc, /if \(rc\.reset && !readOnly && handle && db\[handle\]\)/);
  assert.match(chatSrc, /if \(!readOnly && !db\[adoptOwnKey\]\)/);
  assert.match(chatSrc, /if \(handle && !readOnly\)/);
  assert.match(chatSrc, /if \(dbDirty && !readOnly\)/);
});

test('拉新阶段必须保持 inbox 相位，不能与看门狗互相覆盖', () => {
  // 旧代码在进入粉丝列表时写 outbound，看门狗每 5 秒又拉回 inbox，
  // 关注/养号会趁机抢走页面，破冰做到一半就跳走。
  const i = chatSrc.indexOf('function startInboxRosterScan');
  assert.ok(i > 0);
  const fn = chatSrc.slice(i, i + 3200);
  assert.doesNotMatch(fn, /setChatPhase\('outbound'\)/);
  assert.match(fn, /sessionStorage\.setItem\('dan_chat_phase', 'inbox'\)/);
});

test('新版会话栏行纳入页面健康判定，正常列表不再被判白屏', () => {
  const fn = chatSrc.slice(
    chatSrc.indexOf('function isChatHealthyDom'),
    chatSrc.indexOf('function isChatHealthyDom') + 900
  );
  assert.match(fn, /dm-conversation-option-/);
});

test('配置同步不再强制关闭 24 小时覆盖', () => {
  assert.doesNotMatch(configSrc, /localStorage\.setItem\('sg_test_24h', 'false'\)/);
  assert.match(configSrc, /sg_test_24h: _t24/);
  assert.match(configSrc, /start: \[0, 0\], end: \[24, 0\]/);
});

test('关注粉丝列表反馈拆成 loading / empty / 真漂移，不再用 step_mismatch 冒充', () => {
  assert.match(followSrc, /follow\.followers_loading_wait/);
  assert.match(followSrc, /follow\.followers_empty/);
  assert.match(followSrc, /follow\.page_handle_mismatch/);
  const loadingGuard = followSrc.slice(
    followSrc.indexOf('follow.followers_loading_wait') - 1200,
    followSrc.indexOf('follow.followers_loading_wait') + 2400
  );
  assert.doesNotMatch(loadingGuard, /emit\('follow\.step_mismatch'/);
});

test('直达会话页等正文渲染，不拿列表行数判空后刷新', () => {
  assert.match(chatSrc, /function waitInboxConversationRendered/);
  assert.match(chatSrc, /var onConvPath = pathHasConversationId\(pathI\)/);
  assert.match(chatSrc, /reason = onConvPath \? 'pending_render' : 'list_loading'/);
  assert.match(chatSrc, /list_loading: '会话列表还在加载/);
  assert.match(chatSrc, /inboxShellRendered/);
  assert.match(chatSrc, /page_rendering_wait/);
  assert.match(chatSrc, /sg_inbox_shell_short_since/);
  const convWait = chatSrc.indexOf('waitInboxConversationRendered(15000)');
  const listWait = chatSrc.indexOf('inboxEnsureListRendered(12000)');
  assert.ok(convWait > 0 && listWait > 0, '会话页与列表页必须有各自的等待');
});

test('会话打开优先滚到行再点击；找不到行只上报，不再整页直达', () => {
  assert.match(chatSrc, /async function revealInboxRowForItem/);
  // 4.9.98：现场直达 /i/chat/<peer>-<my> 100% 读不到正文，只保留人工强制测试入口。
  assert.match(chatSrc, /if \(item\.forced\s*\n\s*&& !row\s*\n\s*&& navUrl/);
  assert.match(chatSrc, /actualOpenMode = navMode/);
  assert.match(chatSrc, /click_render_timeout/);
  assert.match(chatSrc, /deep_row_gone/);
  assert.match(chatSrc, /scroller: scDiag/);
  assert.match(chatSrc, /X 会把 \/i\/chat\/<peer>-<my> 重定向回列表/);
});

test('刷新被限流只等 20 秒，点击未挂载按 5 秒换目标', () => {
  assert.equal((chatSrc.match(/result\.retryInMs = 20000;/g) || []).length >= 2, true);
  // 4.9.39：click_render_timeout / deep_row_gone 不再保留 pending 硬等，
  // 改成「记失败 + 跳过该目标」，否则同一目标每 5 秒重试会卡死整个队列。
  assert.match(chatSrc, /result\.reason === 'deep_row_gone'[\s\S]{0,400}markInboxTargetSkip/);
  // 4.9.115：点击 12 秒没进会话不再直接记失败返回（那是死代码，会把
  // 「按地址直达」的兜底永远挡住）。现在先真的尝试直达一次；
  // 直达也不可用才记 open_unreachable。两条路径都必须落失败证据。
  assert.match(chatSrc, /noteInboxRenderFailure\(handle, item\.preview, 'open_unreachable'\)/);
  assert.match(chatSrc, /result\.reason === 'deep_row_gone'/);
});

test('缓存行数明显少于上次深扫时必须重新深扫（4.9.117）', () => {
  // 现场：从会话页回列表只渲染 109 行，缓存里是 211 行，
  // 旧逻辑 3 分钟内直接复用缓存，导致另外 102 行（含 39 条未破冰、4 条对方发言）
  // 连候选都没进，OPS 只显示 no_task。
  assert.match(chatSrc, /var cacheShrunk = false;/);
  assert.match(chatSrc, /liveRowCount \+ 5 < prevCacheRows/);
  assert.match(chatSrc, /opts\.forceDeep \|\| cacheShrunk \|\|/);
  assert.match(chatSrc, /why_deep = cacheShrunk \? 'cache_shrunk' : 'interval'/);
  // 升级上来没有 meta 时，用缓存自身行数做基线，否则第一次升级仍会漏。
  assert.match(chatSrc, /if \(!prevCacheRows\) \{/);
  assert.match(chatSrc, /sg_inbox_deep_rows_meta/);
});

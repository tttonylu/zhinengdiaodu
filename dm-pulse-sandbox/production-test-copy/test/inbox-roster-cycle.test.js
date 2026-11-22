'use strict';
/**
 * 私信两阶段：拉新（粉丝列表）→ 破冰 → 守箱。
 * 1) 纯函数 roster-check 的 7 种结论；
 * 2) content_chat 是否真的把两阶段接上（守箱看门狗不会把拉新页面拉回 /i/chat、
 *    队列只排破冰、守箱只打开已破冰会话、三个收工出口都会回守箱）。
 *
 * 运行：node --test --test-force-exit test/inbox-roster-cycle.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadRosterCheck() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'chat', 'roster-check.js'), 'utf8');
  const window = {};
  const sandbox = { window, console, Math, Number, parseInt, isFinite, Date };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return window.SgRosterCheck;
}

function loadTimeUtil(store) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'shared', 'time-util.js'), 'utf8');
  const sandbox = {
    window: {},
    console,
    Math,
    Number,
    parseInt,
    isFinite,
    Date,
    Intl,
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.TimeUtil;
}

const RosterCheck = loadRosterCheck();
const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'content_chat.js'), 'utf8');
const stateSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'inbox-state.js'), 'utf8');
const decisionSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'inbox-decision.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'obs', 'event-catalog.json'), 'utf8'));

const NOW = 1700000000000;
const MIN = 60 * 1000;
const INTERVAL = 30 * MIN;

function decide(over) {
  return RosterCheck.decide(Object.assign({
    now: NOW,
    count: 100,
    baselineCount: 100,
    firstScanDone: true,
    lastCheckAt: NOW - 31 * MIN,
    intervalMs: INTERVAL,
    hasPendingIceDebt: false,
    iceBlocked: false,
  }, over || {}));
}

describe('拉新判定：8 种结论', () => {
  it('first_scan：没有基线 → 全量扫一次', () => {
    const r = decide({ firstScanDone: false, baselineCount: 0 });
    assert.equal(r.result, 'first_scan');
    assert.equal(r.scanList, true);
  });

  it('no_growth：粉丝数没涨 → 只回守箱，不扫列表', () => {
    const r = decide({ count: 100 });
    assert.equal(r.result, 'no_growth');
    assert.equal(r.scanList, false);
    assert.equal(r.delta, 0);
  });

  it('growth：粉丝数增加 → 进列表登记破冰', () => {
    const r = decide({ count: 104 });
    assert.equal(r.result, 'growth');
    assert.equal(r.scanList, true);
    assert.equal(r.delta, 4);
  });

  it('count_down：掉粉 → 下调基线，不滚列表', () => {
    const r = decide({ count: 97 });
    assert.equal(r.result, 'count_down');
    assert.equal(r.scanList, false);
    assert.equal(r.updateBaseline, true);
  });

  it('drain_ice：还欠破冰 → 先清队列', () => {
    const r = decide({ count: 104, hasPendingIceDebt: true });
    assert.equal(r.result, 'drain_ice');
    assert.equal(r.scanList, true);
    assert.equal(r.fresh, false, '队列里还有在跑的破冰 → 不重建队列');
  });

  it('drain_ice：队列空了但台账还有没破冰的人 → 重扫列表捞回来', () => {
    const r = decide({ count: 104, hasLedgerIceBacklog: true });
    assert.equal(r.result, 'drain_ice');
    assert.equal(r.fresh, true, '队列没有在跑的任务 → 允许重建队列重新登记');
  });

  it('not_due：没到 30 分钟 → 不查也不算涨粉', () => {
    const r = decide({ count: 104, lastCheckAt: NOW - 5 * MIN });
    assert.equal(r.result, 'not_due');
    assert.equal(r.due, false);
  });

  it('rescan_gap：上次没读全粉丝列表 → 即使人数没涨也补扫，且不推进基线', () => {
    const r = decide({ count: 100, baselineCount: 100, hasRosterGap: true });
    assert.equal(r.result, 'rescan_gap');
    assert.equal(r.scanList, true);
    assert.equal(r.fresh, true);
    assert.equal(r.updateBaseline, false);
  });

  it('count_unreadable：主页读不到粉丝数 → 不带着 0 扫列表', () => {
    const r = decide({ count: 0 });
    assert.equal(r.result, 'count_unreadable');
    assert.equal(r.scanList, false);
  });

  it('额度挡住时不会反复跳列表：有债也只按涨粉判断', () => {
    const r = decide({ count: 104, hasPendingIceDebt: true, iceBlocked: true });
    assert.equal(r.result, 'growth');
  });

  it('每次结论都有中文原因，OPS 不需要猜', () => {
    for (const key of Object.keys(RosterCheck.RESULTS)) {
      const code = RosterCheck.RESULTS[key];
      assert.ok(RosterCheck.REASON_ZH[code], code + ' 缺少中文原因');
    }
  });
});

describe('拉新阶段接线', () => {
  it('循环状态与查数间隔已实现', () => {
    assert.match(chatSrc, /var INBOX_CYCLE_KEY = 'sg_inbox_cycle'/);
    assert.match(chatSrc, /function enterInboxRosterPhase\(/);
    assert.match(chatSrc, /function exitInboxRosterPhase\(/);
    assert.match(chatSrc, /function runInboxRosterPhaseTick\(/);
    assert.match(chatSrc, /sg_roster_check_min/);
    assert.match(chatSrc, /DEFAULT_ROSTER_CHECK_MIN = 30/);
    // 必须读本次页面数字：拿旧缓存会永远判“没涨粉”
    assert.match(chatSrc, /readOwnFollowerCount\(\{ noCache: true \}\)/);
    // 掉粉要真的下调基线，不能只写 lastCheckAt
    assert.match(chatSrc, /setBaselineCount: !!decision\.updateBaseline/);
    // 4.9.132：浅扫未读全时不能推进基线，下一拍必须补扫
    assert.match(chatSrc, /hasRosterGap: !!base\.gapPending/);
    assert.match(chatSrc, /!b\.gapPending && \(c\.scanActive \|\| opts\.setBaselineCount\)/);
    assert.match(chatSrc, /payload\.gapPending = !!prevGap\.gapPending/);
    // 拉新只在私信时段做，避免半夜扫列表/发破冰
    assert.match(chatSrc, /function isChatWorkWindowNow\(/);
    assert.match(chatSrc, /exitInboxRosterPhase\('outside_chat_hours'\)/);
  });

  it('只在脉冲空闲、没有待续跑发送时切换，不打断正在处理的会话', () => {
    const i = chatSrc.indexOf('isInboxRosterDue())');
    assert.ok(i > 0);
    const block = chatSrc.slice(i - 260, i + 60);
    assert.match(block, /!st\.busy/);
    assert.match(block, /!st\.pending/);
    assert.match(block, /!_inboxPulseBusy/);
  });

  it('守箱看门狗在拉新阶段不拉回 /i/chat', () => {
    const i = chatSrc.indexOf('function startInboxSurfaceWatchdog');
    const block = chatSrc.slice(i, i + 1400);
    assert.match(block, /api\.inboxCyclePhase\(\) === 'roster'/);
    assert.match(block, /dan_chat_phase/);
  });

  it('切换不改运行模式，守箱开关不会被关掉', () => {
    const i = chatSrc.indexOf('function enterInboxRosterPhase(');
    const j = chatSrc.indexOf('function exitInboxRosterPhase(');
    const block = chatSrc.slice(i, j);
    assert.doesNotMatch(block, /setRunMode\(/);
    // 拉新也必须私信独占：改成 outbound 会被养号/关注抢页面，形成导航打架
    assert.match(block, /setChatPhase\('inbox'\)/);
  });

  it('拉新阶段队列只排破冰，广告/催加交回守箱', () => {
    assert.match(chatSrc, /handled_in_watch/);
    const i = chatSrc.indexOf('function iceQueueAdd(');
    const block = chatSrc.slice(i, i + 900);
    assert.match(block, /inboxCyclePhase\(\) === 'roster' && addKind !== 'ice'/);
    assert.match(chatSrc, /function pruneNonIceQueueForRoster\(/);
  });

  it('三个收工出口都先回守箱，不会停引擎/回关注', () => {
    for (const fn of ['function completeChatRound(', 'function finishIceOutboundAfterQueue(', 'function finishSoftRiskFanQueueDone(']) {
      const i = chatSrc.indexOf(fn);
      assert.ok(i > 0, fn);
      const block = chatSrc.slice(i, i + 400);
      assert.match(block, /inboxCyclePhase\(\) === 'roster'/, fn + ' 缺少拉新出口');
      assert.match(block, /exitInboxRosterPhase\(/, fn + ' 没有回守箱');
    }
  });

  it('守箱只打开已破冰会话，没破冰的计入 scan_drop.noIce', () => {
    assert.match(chatSrc, /if \(handle && !iceAt\) \{/);
    assert.match(chatSrc, /drop\.noIce\+\+/);
    assert.match(chatSrc, /no_ice_from_roster/);
    assert.match(chatSrc, /function inboxWatchRowEligible\(/);
    assert.match(chatSrc, /没破冰、守箱不处理/);
    // 守箱给陌生人建的身份占位行，不能被算成“粉丝破冰债”，否则每轮都白扫列表
    assert.match(chatSrc, /if \(e\.watchOnly\) continue;/);
    assert.match(chatSrc, /if \(entry\.watchOnly && !entry\.iceSentAt\) continue;/);
  });

  it('状态机两侧对没破冰一律 ice_via_roster_only', () => {
    assert.match(stateSrc, /return skip\('ice_via_roster_only'\)/);
    assert.match(decisionSrc, /return skipResult\('ice_via_roster_only'\)/);
    assert.match(chatSrc, /ice_via_roster_only: '破冰只能从粉丝列表发起/);
  });

  it('OPS 事件与诊断已登记', () => {
    const ids = catalog.events.map((e) => e.id);
    assert.ok(ids.includes('chat.inbox_cycle'));
    assert.ok(ids.includes('chat.fan_roster_check'));
    assert.match(chatSrc, /diag\.cycle = \{/);
  });

  it('读粉丝数不被过严的本号判定挡死，且带诊断', () => {
    // getMyHandle() 可能拿到 worker id 或为空；必须用导航栏本号链接兜底
    assert.match(chatSrc, /a\[data-testid="AppTabBar_Profile_Link"\]/);
    assert.match(chatSrc, /var selfProof = my \|\| navHandle;/);
    assert.match(chatSrc, /__sgFollowerReadDetail/);
    assert.match(chatSrc, /read_detail:/);
  });

  it('心跳带矩阵化资源指标', () => {
    assert.match(chatSrc, /heap_mb:/);
    assert.match(chatSrc, /dom_nodes:/);
    assert.match(chatSrc, /timers:/);
    assert.match(chatSrc, /performance\.memory/);
  });

  it('广告/催加缺少任何 LINE 联系方式时禁止发送', () => {
    // 只认 line.me 会把「LINE ID：@xxx」这类线上话术池全部判死，
    // 现在要求文案里至少有一条可联系路径（line.me / LINE ID / ライン）。
    assert.match(chatSrc, /function hasLineContact\(text\)/);
    assert.match(chatSrc, /LINE\\s\*\(\?:ID\|ＩＤ\|id\)/);
    assert.match(chatSrc, /if \(hasLineContact\(kickTpl\)\) return stripLinkPlaceholder\(kickTpl\);/);
    assert.match(chatSrc, /sendError = \(needsLinkRoute && !linkReady\) \? 'no_promo_link' : 'no_message_text';/);
    assert.match(chatSrc, /no_promo_link: '文案里没有可用的 LINE 联系方式/);
  });

  it('manifest 已加载规则模块并升到 4.9.69+', () => {
    // 版本号会随修复继续上涨，这里只要求「不低于引入两阶段循环的 4.9.69」，
    // 避免每次修 bug 都要改测试版本断言。
    const parts = String(manifest.version || '').split('.').map(Number);
    const atLeast = parts[0] > 4
      || (parts[0] === 4 && (parts[1] > 9 || (parts[1] === 9 && parts[2] >= 69)));
    assert.ok(atLeast, 'manifest version 需 >= 4.9.69，当前 ' + manifest.version);
    const files = manifest.content_scripts.find((c) => c.js && c.js.indexOf('chat/content_chat.js') >= 0).js;
    assert.ok(files.indexOf('chat/roster-check.js') >= 0);
    assert.ok(files.indexOf('chat/roster-check.js') < files.indexOf('chat/content_chat.js'));
  });

  it('主引擎作用域桥：文件末尾的看门狗/测试按钮不能再直接引用私有函数', () => {
    assert.match(chatSrc, /window\.__sgInboxApi = \{/);
    assert.match(chatSrc, /ensureEngine: ensureChatMainEngine/);
    const firstIifeEnd = chatSrc.indexOf('\n})();');
    const tail = chatSrc.slice(firstIifeEnd);
    const privateFns = [
      'ensureChatMainEngine', 'loadInboxState', 'saveInboxState',
      'exitInboxRosterPhase', 'inboxCyclePhase', 'reportChatMetric', 'setRunMode'
    ];
    for (const name of privateFns) {
      assert.doesNotMatch(
        tail,
        new RegExp('(?<!api\\.)(?<![A-Za-z0-9_$])' + name + '\\b'),
        '第二个 IIFE 不能直接引用 ' + name
      );
    }
  });

  it('主循环有 5 秒保活，整页导航/clearAllTimers 后能自动重挂', () => {
    assert.match(chatSrc, /function startChatEngineKeepalive\(\)/);
    const i = chatSrc.indexOf('function startChatEngineKeepalive()');
    const block = chatSrc.slice(i, i + 900);
    assert.match(block, /setInterval\(/);
    assert.match(block, /5000/);
    assert.match(block, /ensureChatMainEngine\(\)/);
    assert.match(block, /getRunMode\(\) === 'inbox'/);
  });

  it('拉新阶段有独立心跳，导航失败有次数上限和 OPS 证据', () => {
    const i = chatSrc.indexOf('function runInboxRosterPhaseTick()');
    const block = chatSrc.slice(i, i + 9000);
    assert.match(block, /inboxLoopHeartbeat\('roster'/);
    assert.match(block, /navTries >= 3/);
    assert.match(block, /profile_nav_failed/);
    assert.match(block, /nav_to_profile/);
    assert.match(block, /nowNav - navAt/);
    assert.match(block, /< 10000\)/);
  });

  it('破冰队列在跑时，离开粉丝列表（资料页/会话页）不算页面走丢', () => {
    const i = chatSrc.indexOf('function runInboxRosterPhaseTick()');
    const block = chatSrc.slice(i, i + 9000);
    assert.match(block, /var iceInFlight = false/);
    assert.match(block, /dan_auto_step/);
    assert.match(block, /roster_ice_inflight/);
    assert.match(block, /if \(!scanOnList && !iceInFlight && at/);
    assert.ok(
      block.indexOf('iceInFlight') > 0
        && block.indexOf("exitInboxRosterPhase('roster_scan_page_lost')") > block.indexOf('var iceInFlight'),
      '页面走丢判定必须排除正在执行的破冰任务'
    );
  });

  it('同一目标重复选中时不再刷屏 same doing 事件', () => {
    const i = chatSrc.indexOf('function iceQueueMark(');
    const j = chatSrc.indexOf('function forceRescanForRosterGap(');
    assert.ok(i > 0 && j > i, 'iceQueueMark 必须可定位');
    const block = chatSrc.slice(i, j);
    assert.match(block, /var prevStatus = String\(q\.items\[idx\]\.status \|\| ''\)/);
    assert.match(block, /if \(nextStatus === prevStatus && nextReason === prevReason\) return true;/);
    assert.ok(
      block.indexOf('nextStatus === prevStatus') < block.indexOf("SgTelemetry.emit('chat.task_item_done'"),
      '必须先判重再上报，否则 OPS 还是每人刷一串 doing'
    );
  });

  it('资料页没渲染完不能直接判“对方没开私信”永久拉黑', () => {
    const i = chatSrc.indexOf('var headerReady = false;');
    const j = chatSrc.indexOf("iceQueueMark(targetHandle, 'skipped', 'no_dm')");
    assert.ok(i > 0 && j > i, '资料页判定与 no_dm 终态都必须可定位');
    const block = chatSrc.slice(i, j);
    assert.match(block, /if \(!headerReady && failDMCount < 6\)/);
    assert.match(block, /iceQueueMark\(thHdr, 'deferred', 'profile_not_ready'\)/);
    assert.match(block, /chat\.profile_not_ready/);
    assert.ok(
      block.indexOf('profile_not_ready') < block.indexOf('no_dm'),
      '必须先走 profile_not_ready 延后，才允许进入 no_dm 永久终态'
    );
  });
});

describe('脉冲认人：会话行 → 台账', () => {
  it('行里没有 @handle 时，先用 peerId 反查台账，再用显示名兜底', () => {
    assert.match(chatSrc, /function resolveLedgerHandleByPeerId\(/);
    assert.match(chatSrc, /function resolveLedgerHandleByDisplayName\(/);
    const i = chatSrc.indexOf('var ledgerMatchedBy = String(item.matchedBy');
    assert.ok(i > 0);
    const block = chatSrc.slice(i, i + 4200);
    assert.match(block, /resolveLedgerHandleByPeerId\(peerId, ledgerDb\)/);
    assert.match(block, /resolveLedgerHandleByDisplayName\(item\.displayName, ledgerDb\)/);
    assert.ok(
      block.indexOf('resolveLedgerHandleByPeerId') < block.indexOf('resolveLedgerHandleByDisplayName'),
      'peerId 必须比显示名优先'
    );
    // 只有全都匹配不上才合成 p<peerId>
    assert.ok(
      block.indexOf("if (!targetHandle && peerId) targetHandle = 'p' + peerId") > block.indexOf('resolveLedgerHandleByDisplayName'),
      '合成 p<peerId> 必须是最后兜底'
    );
    // 4.9.106：临时 p<peerId> 命中会话头真实 @handle 时，必须并回真实账号，
    // 否则真实账号的破冰/广告历史永远对不上这条会话。
    assert.match(block, /var headerAdoptable = /);
    assert.match(block, /ledgerMatchedBy = 'header_adopted'/);
  });

  it('显示名重名时不猜，避免把 A 的会话接成 B', () => {
    assert.match(chatSrc, /dn2h\[dn\] = '__dup__'/);
    assert.match(chatSrc, /dn2h\[dnKey\] !== '__dup__'/);
  });

  it('匹配结果进 OPS：能看出这次是靠什么认出对话人的', () => {
    assert.match(chatSrc, /ledger_matched_by: ledgerMatchedBy/);
    assert.match(chatSrc, /peer_id: '会话行没有 @handle，用数字 peerId 反查台账命中'/);
    assert.match(chatSrc, /synthetic_new: '台账里没有这个人/);
    assert.match(chatSrc, /result\.ledgerMatchedBy = \(tick && tick\.ledgerMatchedBy\)/);
  });
});

describe('待续跑目标不能永久挡住拉新', () => {
  it('空闲时超过 3 分钟的 pending 必须回收并留下证据', () => {
    assert.match(chatSrc, /function reapStaleInboxPending\(now\)/);
    const start = chatSrc.indexOf('function reapStaleInboxPending');
    assert.ok(start > 0);
    const block = chatSrc.slice(start, start + 900);
    assert.match(block, /stReap\.busy \|\| _inboxPulseBusy/);
    assert.match(block, /< 180000/);
    assert.match(block, /abandonInboxPending\(pendReap, 'pending_expired'/);
    assert.match(block, /stReap\.pending = null/);
  });

  it('主引擎每拍先回收，再判断是否该回主页查粉丝数', () => {
    const start = chatSrc.indexOf('function runInboxModeTick()');
    const gate = chatSrc.indexOf("enterInboxRosterPhase('due')", start);
    assert.ok(start > 0 && gate > start);
    const block = chatSrc.slice(start, gate);
    assert.match(block, /reapStaleInboxPending\(Date\.now\(\)\)/);
  });

  it('守箱模式下出站引擎必须短路，两条发送链不能同时跑', () => {
    const start = chatSrc.indexOf('window.__sgChatMainEngineTick = function ()');
    assert.ok(start > 0, '缺少主引擎 tick');
    const head = chatSrc.slice(start, start + 900);
    // 守箱开关开着时：拉新阶段决定是否放行出站；其余情况只跑守箱并 return。
    assert.match(head, /getRunMode\(\) === 'inbox' && isInboxWatchEnabled\(\)/);
    assert.match(head, /if \(inboxCyclePhase\(\) === 'roster'\)/);
    assert.match(head, /runInboxRosterPhaseTick\(\) !== 'fallthrough'/);
    assert.match(head, /runInboxModeTick\(\);\s*\n\s*return;/);
  });

  it('同一账号多标签只允许一个主标签发送，其余待命', () => {
    assert.match(chatSrc, /function claimInboxTabLeadership\(\)/);
    assert.match(chatSrc, /INBOX_TAB_LEADER_KEY/);
    assert.match(chatSrc, /INBOX_TAB_LEADER_TTL_MS = 90000/);
    const start = chatSrc.indexOf('function runInboxModeTick() {');
    assert.ok(start > 0);
    const head = chatSrc.slice(start, start + 700);
    assert.match(head, /claimInboxTabLeadership\(\)/);
    assert.match(head, /another_tab_is_leader/);
    // 前台标签可以接管被节流的后台主标签
    assert.match(chatSrc, /holderHidden && iAmVisible/);
  });
});

describe('测试副本按正常工作时段运行', () => {
  it('未设置 sg_test_24h 时默认 24h；显式 false 才使用正常时段', () => {
    const T = loadTimeUtil({});
    assert.equal(T.isTest24h(), true);
    const h = T.readChatHours();
    assert.equal(h.startH, 0);
    assert.equal(h.endH, 24);
    const work = T.readWorkHours();
    assert.equal(work.startH, 0);
    assert.equal(work.endH, 24);

    const normal = loadTimeUtil({ sg_test_24h: 'false' });
    const nh = normal.readChatHours();
    assert.equal(nh.startH, 9);
    assert.equal(nh.endH, 18);
    const nw = normal.readWorkHours();
    assert.equal(nw.startH, 6);
    assert.equal(nw.endH, 2);
  });

  it('显式 sg_test_24h=false 恢复真实时段', () => {
    const T = loadTimeUtil({ sg_test_24h: 'false' });
    assert.equal(T.isTest24h(), false);
  });

  it('OPS 私信事件带 test_24h 标记', () => {
    assert.match(chatSrc, /test_24h: isTest24hMode\(\)/);
  });
});


describe('拉新阶段必须以 OPS 台账为准判定破冰债（4.9.118）', () => {
  it('本地库为空但 OPS 还有未破冰时，必须重新扫粉丝列表', () => {
    // 现场：OPS 台账 128 条 round=0 pending，但本地目标库没这些人，
    // countUnicedBacklogInDb() 返回 0 → ledger_ice_backlog=false
    // → 粉丝数没涨就再也不进粉丝列表 → 128 人永远拿不到破冰。
    assert.ok(chatSrc.includes('function countUnicedBacklogInOpsItems'), '必须有 OPS 侧破冰债统计');
    assert.ok(chatSrc.includes('opsIceBacklog = countUnicedBacklogInOpsItems(window.__sgOpsRosterItems)'), '必须用 OPS 台账计数');
    assert.ok(chatSrc.includes('if (opsIceBacklog > 0) ledgerIceBacklog = true;'), 'OPS 有债必须置位');
  });

  it('进拉新阶段先拉 OPS 台账，并缓存供下一拍使用', () => {
    assert.ok(chatSrc.includes('opsDmRosterFetch(function (r) {'), '必须主动拉 OPS 台账');
    assert.ok(chatSrc.includes('window.__sgOpsRosterItems = r.items'), '必须把台账装进内存');
    assert.ok(chatSrc.includes('sg_ops_roster_items'), '必须落 sessionStorage 供下一拍');
    assert.ok(chatSrc.includes('sg_ops_roster_pull_at'), '必须限频，不能每拍打 OPS');
  });

  it('OPS 破冰债口径与本地一致：排除 baseline_seed / 终态 / 已破冰', () => {
    const fn = chatSrc.slice(
      chatSrc.indexOf('function countUnicedBacklogInOpsItems'),
      chatSrc.indexOf('function iceQueueMark')
    );
    assert.ok(fn.includes("if (rs === 'baseline_seed') continue;"), 'baseline_seed 不算破冰债');
    assert.ok(fn.includes("if (st === 'skipped' || st === 'done' || st === 'failed') continue;"), '终态不算破冰债');
    assert.ok(fn.includes('if (iceAt || rnd >= 1) continue;'), '已破冰不算破冰债');
  });
});

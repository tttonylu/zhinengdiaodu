// =============================================================================
// 智能调度 — Service Worker
// API 中转：号池(关注) + 运营后台(私信) + 调度命令转发
// =============================================================================

// 家里台式机默认内网。4.6.181：本地运行默认只走内网，不自动切外网（需要时把 WAN_FAILOVER_ENABLED 改 true）
const DEFAULT_POOL_SERVER = 'http://192.168.0.100:15678';
// 测试副本：OPS 固定指向独立测试实例（独立库、端口 15681），禁止误连生产 15680。
const DEFAULT_OPS_SERVER = 'http://127.0.0.1:15681';
const TEST_OPS_LOCKED = true;
const FALLBACK_POOL_SERVER = 'https://haochi1.kooldns.cn';
const FALLBACK_OPS_SERVER = 'https://kongzhi1.kooldns.cn';
const WAN_FAILOVER_ENABLED = false;
const FAILOVER_STICKY_MS = 120000; // 外网成功后 sticky 2 分钟，再试内网（仅 WAN_FAILOVER_ENABLED 时有意义）
const LAN_TRY_MS = 2500;
const WAN_TRY_MS = 8000;
const STICKY_STORAGE_KEY = 'sg_failover_sticky'; // SW 回收后恢复线路记忆
const OPS_OUTBOX_KEY = 'ops_ledger_outbox';
const OPS_OUTBOX_ALARM = 'ops_outbox_flush';
const OPS_OUTBOX_MAX_TRIES = 8;
const OPS_OUTBOX_MAX_LEN = 80;

var cachedPoolServer = DEFAULT_POOL_SERVER;
var cachedOpsServer = DEFAULT_OPS_SERVER;
// 4.9.68：最近一次日志批量上报的真实返回。
// 现场出现“插件认为已上传、OPS 库里却没有”的情况时，必须能从这里看到
// 服务器实际返回的 ingested / deduped / failed，而不是只看到 ok:true。
var lastTelemetryResult = { at: 0, count: 0, ok: false, ingested: 0, deduped: 0, failed: 0, error: '', http_status: 0 };
// 4.9.117：最小化窗口恢复限频（模块级，消息处理器每次调用都是新作用域，
// 放在函数里等于没有限频）。10 分钟最多恢复一次，避免反复弹窗。
var lastWindowRestoreAt = 0;
var MIN_WINDOW_RESTORE_INTERVAL_MS = 10 * 60 * 1000;
function noteTelemetryResult(res, count, httpStatus) {
  try {
    lastTelemetryResult = {
      at: Date.now(),
      count: Number(count) || 0,
      ok: !!(res && res.ok),
      ingested: Number(res && res.ingested) || 0,
      deduped: Number(res && res.deduped) || 0,
      failed: Number(res && res.failed) || 0,
      error: String((res && (res.error || res.msg)) || ''),
      http_status: Number(httpStatus) || 0
    };
    chrome.storage.local.set({ sg_telemetry_last_result: lastTelemetryResult });
  } catch (eNote) {}
}
var liteHeartbeatThrottle = Object.create(null); // handle -> ts
// handle -> { module, at }：当前真实在跑的模块（由 full/lite 心跳共同维护）
var liveEngineByHandle = Object.create(null);
var LIVE_ENGINE_TTL_MS = 90 * 1000;

function normalizeEngineModule(v) {
  var s = String(v == null ? '' : v).toLowerCase().trim();
  if (s === 'null' || s === 'undefined' || s === 'none' || s === 'idle' || s === 'coor') return '';
  return s;
}

function noteLiveEngine(botId, payload, isFull) {
  payload = payload || {};
  botId = normalizeBotId(botId);
  if (!botId) return;
  var handle = handleFromBotId(botId);
  if (!handle) return;
  var eng = normalizeEngineModule(payload.engine);
  var mod = normalizeEngineModule(payload.running_module);
  var status = String(payload.status || '').toLowerCase().trim();
  var runningHint = status === 'running' || status === 'active' || status.indexOf('running') >= 0;
  var idleHint = status === 'idle' || status === 'stopped' || status === 'pause' ||
    status === 'paused' || status.indexOf('idle') >= 0;

  if (mod || (eng && runningHint && !idleHint)) {
    liveEngineByHandle[handle] = { module: mod || eng, at: Date.now() };
    return;
  }
  // full 心跳是调度器的权威快照：没有 running_module 就代表当前确实没有模块在跑
  if (isFull) {
    liveEngineByHandle[handle] = { module: '', at: Date.now() };
    return;
  }
  if (idleHint || !eng) {
    var live = getLiveEngine(handle);
    // 其他模块的空闲心跳不能清掉正在运行的模块；只允许同模块自报空闲
    if (!live || live === eng) {
      liveEngineByHandle[handle] = { module: '', at: Date.now() };
    }
  }
}

function getLiveEngine(handle) {
  var e = liveEngineByHandle[handle];
  if (!e) return '';
  if (Date.now() - (e.at || 0) > LIVE_ENGINE_TTL_MS) {
    delete liveEngineByHandle[handle];
    return '';
  }
  return e.module || '';
}
var swPresenceHbAt = 0; // 4.6.171：SW 保活 presence 心跳节流
var swTelemetryNudgeAt = 0; // 4.6.178：催页侧 flush
var swAlivePulseAt = 0; // 4.6.178：SW 侧存活遥测
var failoverSticky = {
  pool: { base: '', until: 0 },
  ops: { base: '', until: 0 },
};
// 4.6.180：外网挂死冷静期——避免每次 LAN 微抖都再卡 WAN_TRY_MS，拖死推博主/心跳
var WAN_COOLDOWN_MS = 5 * 60 * 1000;
var wanCooldownUntil = { pool: 0, ops: 0 };

function markWanDead(kind) {
  wanCooldownUntil[kind] = Date.now() + WAN_COOLDOWN_MS;
}
function clearWanCooldown(kind) {
  wanCooldownUntil[kind] = 0;
}
function wanInCooldown(kind) {
  return Date.now() < (wanCooldownUntil[kind] || 0);
}

/** 4.6.178：页侧 flushing 闩死时，SW 每 ≥60s 催一次出队 */
function nudgePagesTelemetryFlush() {
  var now = Date.now();
  if (swTelemetryNudgeAt && now - swTelemetryNudgeAt < 60000) return;
  swTelemetryNudgeAt = now;
  try {
    chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*', 'https://www.x.com/*'] }, function (tabs) {
      void chrome.runtime.lastError;
      if (!tabs || !tabs.length) return;
      for (var i = 0; i < tabs.length; i++) {
        try {
          chrome.tabs.sendMessage(tabs[i].id, { action: 'telemetry_flush_now' }, function () {
            void chrome.runtime.lastError;
          });
        } catch (eTab) {}
      }
    });
  } catch (eN) {}
}

/** 4.6.178：页冻住时仍每 ≥2min 打一条 SW 存活，防「心跳在、日志全死」盲区 */
function maybeSwAlivePulse() {
  var now = Date.now();
  if (swAlivePulseAt && now - swAlivePulseAt < 120000) return;
  try {
    chrome.storage.local.get(['my_handle', 'worker_id'], function (r) {
      var botId = normalizeBotId(r.worker_id || r.my_handle || '');
      if (!isRegistrableBotId(botId)) return;
      var handle = String(botId).replace(/^@/, '').replace(/#guard$/i, '').toLowerCase();
      if (!handle || handle === 'unknown') return;
      swAlivePulseAt = Date.now();
      var ts = Date.now();
      opsFetch('/api/plugin/log/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_handle: handle,
          events: [{
            client_event_id: 'sw_alive_' + ts + '_' + Math.random().toString(36).slice(2, 6),
            event_id: 'system.sw_alive',
            severity: 'info',
            category: 'system',
            label_zh: 'SW存活',
            session_id: 'sw',
            meta: {
              via: 'keepalive',
              build: (function () {
                try { return chrome.runtime.getManifest().version; } catch (eBuild) { return ''; }
              })()
            },
            ts: ts,
            account_handle: handle,
            upload: true
          }]
        })
      }).catch(function () {});
    });
  } catch (eP) {}
}

/**
 * 4.6.171 多开 BitBrowser 后台标签会把页面 setInterval(30s) 心跳拖到数分钟，
 * 仪表盘 15min / 监控 90s 大量假离线。SW keepalive 闹钟仍准 → 有 x.com 页时
 * 仅 touch last_seen（不带 engine/auto_mode，避免冲掉 full 心跳业务态）。
 */
function maybeSwPresenceHeartbeat() {
  var now = Date.now();
  // 55–70s 抖动，防 50+ 实例齐刷 OPS
  var minGap = 55000 + Math.floor(Math.random() * 15000);
  if (swPresenceHbAt && now - swPresenceHbAt < minGap) return;
  try {
    chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*', 'https://www.x.com/*'] }, function (tabs) {
      void chrome.runtime.lastError;
      if (!tabs || !tabs.length) return;
      chrome.storage.local.get(['my_handle', 'worker_id'], function (r) {
        var botId = normalizeBotId(r.worker_id || r.my_handle || '');
        if (!isRegistrableBotId(botId)) return;
        swPresenceHbAt = Date.now();
        opsFetch('/api/plugin/account/heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bot_id: botId }),
        }).catch(function () {});
      });
    });
  } catch (e) {}
}

// ====== failover sticky 持久化（防 SW 回收丢记忆） ======
function loadFailoverSticky() {
  try {
    chrome.storage.local.get([STICKY_STORAGE_KEY], function (r) {
      try {
        var saved = r && r[STICKY_STORAGE_KEY] ? JSON.parse(r[STICKY_STORAGE_KEY]) : null;
        if (saved && saved.pool) failoverSticky.pool = saved.pool;
        if (saved && saved.ops) failoverSticky.ops = saved.ops;
        // 4.6.183：关外网时清掉历史 WAN sticky，避免面板 active 仍显示 haochi1
        if (!WAN_FAILOVER_ENABLED) {
          var dirty = false;
          if (failoverSticky.pool && failoverSticky.pool.base && !isLanUrl(failoverSticky.pool.base)) {
            failoverSticky.pool = { base: '', until: 0 }; dirty = true;
          }
          if (failoverSticky.ops && failoverSticky.ops.base && !isLanUrl(failoverSticky.ops.base)) {
            failoverSticky.ops = { base: '', until: 0 }; dirty = true;
          }
          // 测试副本锁定独立测试 OPS：历史 sticky 指向生产也清掉
          if (TEST_OPS_LOCKED && failoverSticky.ops && failoverSticky.ops.base
              && normalizeServerUrl(failoverSticky.ops.base, '') !== DEFAULT_OPS_SERVER) {
            failoverSticky.ops = { base: '', until: 0 }; dirty = true;
          }
          if (dirty) saveFailoverSticky();
        }
        var now = Date.now();
        var poolAlive = failoverSticky.pool.until > now ? failoverSticky.pool.base : '(expired)';
        var opsAlive = failoverSticky.ops.until > now ? failoverSticky.ops.base : '(expired)';
        console.log('[调度-SW] failover sticky 已恢复 pool=', poolAlive, 'ops=', opsAlive,
          'wanFailover=', WAN_FAILOVER_ENABLED);
      } catch (eParse) {
        console.warn('[调度-SW] failover sticky 解析失败:', eParse);
      }
    });
  } catch (e) {}
}

/** 关外网时把误配的 WAN 地址改回内网默认（读写两端统一） */
function forceLanIfWanDisabled(kind, url) {
  var u = normalizeServerUrl(url, kind === 'pool' ? DEFAULT_POOL_SERVER : DEFAULT_OPS_SERVER);
  if (!WAN_FAILOVER_ENABLED && !isLanUrl(u)) {
    return kind === 'pool' ? DEFAULT_POOL_SERVER : DEFAULT_OPS_SERVER;
  }
  return u;
}

var stickySaveAt = 0;
var stickySaveKey = '';
var stickySaveTimer = null;

/**
 * sticky 只是「下次优先试哪个地址」的提示，不需要每次请求都落盘。
 * markFailoverSuccess 每个成功请求都会调到这里；不节流会把 chrome.storage
 * 写成每秒上百次（实测 ~165 次/秒），LevelDB 持续膨胀，SW 消息与遥测上报被拖死。
 * 规则：同一组地址 10 秒内只写一次；地址变化立即写。
 */
function saveFailoverSticky() {
  var key = String((failoverSticky.pool && failoverSticky.pool.base) || '')
    + '|' + String((failoverSticky.ops && failoverSticky.ops.base) || '');
  var now = Date.now();
  if (key === stickySaveKey && (now - stickySaveAt) < 10000) {
    if (!stickySaveTimer) {
      var wait = 10000 - (now - stickySaveAt);
      stickySaveTimer = setTimeout(function () {
        stickySaveTimer = null;
        saveFailoverSticky();
      }, wait);
    }
    return;
  }
  stickySaveKey = key;
  stickySaveAt = now;
  try {
    chrome.storage.local.set({ [STICKY_STORAGE_KEY]: JSON.stringify({
      pool: failoverSticky.pool,
      ops: failoverSticky.ops,
    }) });
  } catch (e) {}
}

function normalizeServerUrl(u, fallback) {
  var s = String(u || '').trim().replace(/\/$/, '');
  if (!s) return fallback;
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  // :443 冗余，去掉以免部分环境异常
  s = s.replace(/^(https:\/\/[^/:]+):443$/i, '$1');
  return s.replace(/\/$/, '');
}

function isLanUrl(u) {
  // 独立测试 OPS 跑在本机回环地址，必须被当作“本地地址”，
  // 否则 forceLanIfWanDisabled 会把它改写回生产 192.168.0.100:15680。
  var host = String(u || '').replace(/^https?:\/\//i, '').split('/')[0];
  if (/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host)) return true;
  return /192\.168\.0\.100(?::\d+)?$/i.test(String(u || '').replace(/^https?:\/\//i, '').split('/')[0])
    || /^https?:\/\/192\.168\.0\.100(?::\d+)?$/i.test(String(u || ''));
}

// B2↔I1（2026-10-15 号池来源切换）：外网 haochi1 仅映射 78 主池；
// 号池配置为非 78 池（如 79 兼职池）时内网不通禁止回退 78 外网兜底——
// 宁可 POOL_unreachable 歇等，不得跨池错领。OPS 外网兜底不受影响。
function isDefaultPool78(u) {
  return /:15678$/i.test(normalizeServerUrl(u, ''));
}

function canFallBackToWan(kind, preferred) {
  if (!WAN_FAILOVER_ENABLED) return false;
  if (!isLanUrl(preferred)) return false;
  if (kind !== 'pool') return true;
  return isDefaultPool78(preferred);
}

function refreshServersFromStorage() {
  try {
    chrome.storage.local.get(['pool_server', 'ops_server'], function (r) {
      var nextPool = forceLanIfWanDisabled('pool', r.pool_server);
      var nextOps = TEST_OPS_LOCKED ? DEFAULT_OPS_SERVER : forceLanIfWanDisabled('ops', r.ops_server);
      cachedPoolServer = nextPool;
      cachedOpsServer = nextOps;
      // storage 里若残留外网地址，写回内网，避免面板显示外网但实际走内网
      try {
        var patch = {};
        if (nextPool !== normalizeServerUrl(r.pool_server, DEFAULT_POOL_SERVER)) patch.pool_server = nextPool;
        if (nextOps !== normalizeServerUrl(r.ops_server, DEFAULT_OPS_SERVER)) patch.ops_server = nextOps;
        if (Object.keys(patch).length) chrome.storage.local.set(patch);
      } catch (eFix) {}
      // 启动时加载 sticky 持久化状态（SW 被回收后恢复）
      loadFailoverSticky();
      console.log('[调度-SW] servers pool=', cachedPoolServer, 'ops=', cachedOpsServer,
        'wanFailover=', WAN_FAILOVER_ENABLED,
        'fallback pool=', FALLBACK_POOL_SERVER, 'ops=', FALLBACK_OPS_SERVER);
    });
  } catch (e) {}
}
refreshServersFromStorage();

// 测试副本：扩展重载后，已经打开的 X 页面仍会跑旧 content script。
// 旧脚本可能还连着生产 OPS，必须在 build 变化时把页面刷新到新脚本。
function reloadStaleTabsOnTestBuildChange() {
  if (!TEST_OPS_LOCKED) return;
  var current = '';
  try { current = String(chrome.runtime.getManifest().version || ''); } catch (eVer) { return; }
  if (!current) return;
  try {
    chrome.storage.local.get(['sg_test_build_seen'], function (r) {
      var seen = String((r && r.sg_test_build_seen) || '');
      try { chrome.storage.local.set({ sg_test_build_seen: current }); } catch (eSet) {}
      if (seen === current) return;
      setTimeout(function () {
        try {
          chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*', 'https://www.x.com/*'] }, function (tabs) {
            var n = 0;
            (tabs || []).forEach(function (t) {
              try { chrome.tabs.reload(t.id); n += 1; } catch (eReload) {}
            });
            console.log('[调度-SW] build changed', seen || '(none)', '->', current, 'reloaded', n, 'tabs');
          });
        } catch (eQuery) {}
      }, 1500);
    });
  } catch (e) {}
}
reloadStaleTabsOnTestBuildChange();

try {
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    if (changes.pool_server) {
      cachedPoolServer = forceLanIfWanDisabled('pool', changes.pool_server.newValue);
      failoverSticky.pool = { base: '', until: 0 };
      clearWanCooldown('pool');
      saveFailoverSticky();
    }
    if (changes.ops_server) {
      cachedOpsServer = TEST_OPS_LOCKED ? DEFAULT_OPS_SERVER : forceLanIfWanDisabled('ops', changes.ops_server.newValue);
      failoverSticky.ops = { base: '', until: 0 };
      clearWanCooldown('ops');
      saveFailoverSticky();
      // 锁定状态下把存储改回测试地址，防止面板/历史值把它带回生产
      try {
        if (TEST_OPS_LOCKED && normalizeServerUrl(changes.ops_server.newValue, '') !== DEFAULT_OPS_SERVER) {
          chrome.storage.local.set({ ops_server: DEFAULT_OPS_SERVER });
        }
      } catch (eLockOps) {}
    }
  });
} catch (eStCh) {}

function cloneFetchOpts(options, timeoutMs) {
  var src = options || {};
  var opts = {};
  for (var k in src) {
    if (Object.prototype.hasOwnProperty.call(src, k) && k !== 'signal') opts[k] = src[k];
  }
  try { opts.signal = AbortSignal.timeout(timeoutMs); } catch (e) {}
  return opts;
}

function candidatesFor(kind) {
  var preferred = kind === 'pool' ? cachedPoolServer : cachedOpsServer;
  var wan = kind === 'pool' ? FALLBACK_POOL_SERVER : FALLBACK_OPS_SERVER;
  var lanDefault = kind === 'pool' ? DEFAULT_POOL_SERVER : DEFAULT_OPS_SERVER;
  var sticky = failoverSticky[kind] || { base: '', until: 0 };
  var now = Date.now();
  var list = [];

  function push(u) {
    u = normalizeServerUrl(u, '');
    if (!u) return;
    if (list.indexOf(u) < 0) list.push(u);
  }

  // 4.6.181：本地默认只走内网。关外网时若 storage 仍是 haochi1/kongzhi1，直接改走 LAN，不先卡 WAN_TRY_MS
  if (!WAN_FAILOVER_ENABLED && !isLanUrl(preferred)) {
    preferred = lanDefault;
  }

  // 4.6.175：preferred 为内网时始终内网优先。外网 sticky 只作次选——
  // 外网挂死时若 sticky 置顶，每心跳先卡 WAN_TRY_MS（8s），多开会拖垮 SW → 监控假离线。
  push(preferred);
  if (WAN_FAILOVER_ENABLED && sticky.base && sticky.until > now && sticky.base !== preferred) {
    // 冷静期内 sticky 若是外网也跳过
    if (!(wanInCooldown(kind) && !isLanUrl(sticky.base))) push(sticky.base);
  }
  // 外网 fallback（仅开关开、preferred 是内网、号池为 78 主池时；OPS 同理）
  // 4.6.180：外网近期失败则跳过，推博主不再被 haochi1 超时拖死
  if (canFallBackToWan(kind, preferred) && !wanInCooldown(kind)) push(wan);
  // 开关开且 preferred 仍是外网时，再补内网默认作次选
  if (WAN_FAILOVER_ENABLED && !isLanUrl(preferred)) {
    push(lanDefault);
  }
  return list;
}

function markFailoverSuccess(kind, base, preferred) {
  if (!isLanUrl(base)) {
    // 外网其实通了 → 清冷静期
    clearWanCooldown(kind);
  }
  failoverSticky[kind] = {
    base: base,
    until: Date.now() + (base !== preferred && isLanUrl(preferred) ? FAILOVER_STICKY_MS : 15000),
  };
  saveFailoverSticky();
}

function fetchJsonWithFailover(kind, path, options) {
  var preferred = kind === 'pool' ? cachedPoolServer : cachedOpsServer;
  var list = candidatesFor(kind);
  var tag = kind === 'pool' ? 'POOL' : 'OPS';
  var idx = 0;
  var customTimeout = options && options.timeoutMs;

  function attempt() {
    if (idx >= list.length) {
      return Promise.resolve({ ok: false, error: tag + '_unreachable', tried: list.slice() });
    }
    var base = list[idx++];
    var timeoutMs = customTimeout || (isLanUrl(base) ? LAN_TRY_MS : WAN_TRY_MS);
    var opts = cloneFetchOpts(options, timeoutMs);
    delete opts.timeoutMs;
    return fetch(base + path, opts)
      .then(function (r) {
        return r.json().then(function (j) {
          markFailoverSuccess(kind, base, preferred);
          if (base !== preferred) {
            console.warn('[' + tag + '] failover OK via ' + base + path);
          }
          return j;
        }).catch(function () {
          // HTTP 通了但非 JSON：说明不是我们的服务（如路由器页/网关错误页），继续试下一个
          console.warn('[' + tag + '] ' + base + path + ' -> bad_json, 尝试下一地址');
          return attempt();
        });
      })
      .catch(function (e) {
        console.warn('[' + tag + '] ' + base + path + ' -> ' + (e && e.message ? e.message : e));
        // sticky 指向的地址失败则立刻清掉，避免下一拍继续先撞死链
        try {
          var st = failoverSticky[kind] || {};
          if (st.base && st.base === base) {
            failoverSticky[kind] = { base: '', until: 0 };
            saveFailoverSticky();
          }
        } catch (eClr) {}
        try {
          if (!isLanUrl(base)) markWanDead(kind);
        } catch (eCd) {}
        return attempt();
      });
  }

  return attempt();
}

function poolFetch(path, options) {
  return fetchJsonWithFailover('pool', path, options);
}

function opsFetch(path, options) {
  return fetchJsonWithFailover('ops', path, options);
}

// E5 原创内容池取图：与 opsFetch 共用同一组 OPS base / failover 序列，
// GET 后返回 {blob, type} 而非 JSON（SW 环境下 Response.blob 可用）
function opsFetchRaw(path) {
  var preferred = cachedOpsServer;
  var list = candidatesFor('ops');
  var idx = 0;

  function attempt() {
    if (idx >= list.length) {
      return Promise.reject(new Error('OPS_unreachable'));
    }
    var base = list[idx++];
    var timeoutMs = isLanUrl(base) ? LAN_TRY_MS : WAN_TRY_MS;
    var opts = cloneFetchOpts(null, timeoutMs);
    return fetch(base + path, opts)
      .then(function (r) {
        if (!r.ok) throw new Error('http_' + r.status);
        return r.blob().then(function (blob) {
          markFailoverSuccess('ops', base, preferred);
          return { blob: blob, type: blob.type };
        });
      })
      .catch(function (e) {
        console.warn('[OPS] ' + base + path + ' -> ' + (e && e.message ? e.message : e));
        try {
          var st = failoverSticky.ops || {};
          if (st.base && st.base === base) {
            failoverSticky.ops = { base: '', until: 0 };
            saveFailoverSticky();
          }
        } catch (eClr) {}
        try {
          if (!isLanUrl(base)) markWanDead('ops');
        } catch (eCd) {}
        return attempt();
      });
  }

  return attempt();
}

// ====== 4.6.70 OPS 台账/记账出箱（失败重试，防本地推进后 OPS 永久落后） ======
function loadOpsOutbox(cb) {
  try {
    chrome.storage.local.get([OPS_OUTBOX_KEY], function (r) {
      var list = [];
      try {
        list = Array.isArray(r && r[OPS_OUTBOX_KEY]) ? r[OPS_OUTBOX_KEY] : [];
      } catch (e) { list = []; }
      cb(list);
    });
  } catch (e) {
    cb([]);
  }
}

function saveOpsOutbox(list, cb) {
  try {
    chrome.storage.local.set({ [OPS_OUTBOX_KEY]: list || [] }, function () {
      if (typeof cb === 'function') cb();
    });
  } catch (e) {
    if (typeof cb === 'function') cb();
  }
}

function enqueueOpsOutboxEntry(entry, sendResponse) {
  if (!entry || !entry.type) {
    if (sendResponse) sendResponse({ ok: false, msg: 'bad_entry' });
    return;
  }
  loadOpsOutbox(function (list) {
    var botHandle = String(entry.botHandle || '').replace(/^@/, '').toLowerCase();
    var payload = entry.payload || {};
    var type = String(entry.type);
    // 4.6.71：同键去重 — record 按 bot+target+round；roster 同 bot 只留最新全量
    if (type === 'dm_record') {
      var th = String(payload.target_handle || '').replace(/^@/, '').toLowerCase();
      var rn = Number(payload.round_number) || 0;
      list = list.filter(function (it) {
        if (!it || it.type !== 'dm_record') return true;
        var ib = String(it.botHandle || '').replace(/^@/, '').toLowerCase();
        var ith = String((it.payload && it.payload.target_handle) || '').replace(/^@/, '').toLowerCase();
        var irn = Number(it.payload && it.payload.round_number) || 0;
        return !(ib === botHandle && ith === th && irn === rn);
      });
    } else if (type === 'dm_roster') {
      list = list.filter(function (it) {
        if (!it || it.type !== 'dm_roster') return true;
        var ib = String(it.botHandle || '').replace(/^@/, '').toLowerCase();
        return ib !== botHandle;
      });
    }
    var item = {
      id: 'ob_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e5),
      type: type,
      payload: payload,
      botHandle: botHandle,
      tries: 0,
      nextAt: Date.now(),
      enqueuedAt: entry.enqueuedAt || Date.now()
    };
    list.push(item);
    if (list.length > OPS_OUTBOX_MAX_LEN) list = list.slice(list.length - OPS_OUTBOX_MAX_LEN);
    saveOpsOutbox(list, function () {
      console.warn('[调度-SW] outbox enqueue type=' + item.type + ' len=' + list.length);
      try {
        if (chrome.alarms) chrome.alarms.create(OPS_OUTBOX_ALARM, { when: Date.now() + 5000 });
      } catch (eA) {}
      if (sendResponse) sendResponse({ ok: true, id: item.id, len: list.length });
    });
  });
}

function flushOpsOutbox(done) {
  var finish = typeof done === 'function' ? done : function () {};
  loadOpsOutbox(function (list) {
    if (!list.length) {
      finish({ ok: true, flushed: 0 });
      return;
    }
    var now = Date.now();
    var keep = [];
    var chain = Promise.resolve();
    var flushed = 0;
    var deferred = 0;

    function backoffMs(tries) {
      var t = Math.max(0, Number(tries) || 0);
      if (t <= 1) return 15000;
      if (t === 2) return 60000;
      if (t === 3) return 180000;
      return 300000;
    }

    list.forEach(function (item) {
      chain = chain.then(function () {
        if (!item) return;
        if ((item.nextAt || 0) > now) {
          keep.push(item);
          deferred++;
          return;
        }
        if ((item.tries || 0) >= OPS_OUTBOX_MAX_TRIES) {
          console.warn('[调度-SW] outbox drop max tries', item.type, item.id);
          return;
        }
        var p = item.payload || {};
        var req;
        if (item.type === 'dm_record') {
          req = opsFetch('/api/plugin/dm/record', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              bot_id: p.bot_id || item.botHandle || '',
              target_handle: p.target_handle || '',
              round_number: p.round_number || 1,
              message_content: p.message_content || '',
              result: p.result || 'success'
            }),
            timeoutMs: 12000
          });
        } else if (item.type === 'dm_roster') {
          if (item.botHandle && !p.botHandle) p.botHandle = item.botHandle;
          if (item.botHandle && !p.bot_id) p.bot_id = item.botHandle;
          p.finalize_stale = true;
          p.chunkIndex = 0;
          p.chunkTotal = 1;
          req = opsFetch('/api/plugin/dm/roster', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(p),
            timeoutMs: 20000
          });
        } else {
          return;
        }
        return req.then(function (d) {
          if (d && d.ok) {
            flushed++;
            return;
          }
          // round_duplicate 视作成功
          if (item.type === 'dm_record' && d && d.reason === 'round_duplicate') {
            flushed++;
            return;
          }
          item.tries = (item.tries || 0) + 1;
          item.nextAt = Date.now() + backoffMs(item.tries);
          item.lastError = (d && (d.msg || d.error || d.reason)) || 'fail';
          keep.push(item);
        }).catch(function (e) {
          item.tries = (item.tries || 0) + 1;
          item.nextAt = Date.now() + backoffMs(item.tries);
          item.lastError = String(e && e.message || e);
          keep.push(item);
        });
      });
    });

    chain.then(function () {
      saveOpsOutbox(keep, function () {
        console.log('[调度-SW] outbox flush flushed=' + flushed + ' remain=' + keep.length + ' deferred=' + deferred);
        if (keep.length && chrome.alarms) {
          var next = keep.reduce(function (m, it) {
            var n = Number(it && it.nextAt) || (Date.now() + 60000);
            return n < m ? n : m;
          }, Date.now() + 300000);
          try { chrome.alarms.create(OPS_OUTBOX_ALARM, { when: Math.max(Date.now() + 5000, next) }); } catch (eA2) {}
        }
        finish({ ok: true, flushed: flushed, remain: keep.length });
      });
    }).catch(function () {
      finish({ ok: false });
    });
  });
}

function normalizeBotId(raw) {
  var s = String(raw || '').trim();
  if (!s) return '';
  if (s.charAt(0) !== '@') s = '@' + s;
  return s;
}

/** 与 OPS normalizeHandle 对齐：拒保留字 / 纯数字假号，防幽灵建号 */
var GHOST_RESERVED_HANDLES = {
  account: 1, home: 1, explore: 1, settings: 1, messages: 1, notifications: 1,
  search: 1, compose: 1, i: 1, intent: 1, share: 1, login: 1, signup: 1, logout: 1,
  unknown: 1, null: 1, undefined: 1, demouniquetest: 1, navcheck: 1,
  plugin_smoke: 1, smoke: 1, test: 1, guest: 1, demo: 1, admin: 1, root: 1
};

function handleFromBotId(botId) {
  var s = String(botId || '')
    .replace(/^@+/, '')
    .replace(/#guard$/i, '')
    .toLowerCase()
    .trim();
  var hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(0, hash).trim();
  if (!s || GHOST_RESERVED_HANDLES[s]) return '';
  if (/^\d{4,5}$/.test(s)) return '';
  if (!/^[a-z0-9_]{1,15}$/.test(s)) return '';
  return s;
}

function isRegistrableBotId(botId) {
  return !!handleFromBotId(botId);
}

/** 引擎 send_report → OPS lite 心跳（≥15s/账号节流；禁止空字段覆盖全量） */
function forwardLiteHeartbeat(payload) {
  payload = payload || {};
  function send(botId) {
    botId = normalizeBotId(botId);
    if (!botId) return;
    var handle = handleFromBotId(botId);
    if (!handle) return;
    var now = Date.now();
    if (liteHeartbeatThrottle[handle] && now - liteHeartbeatThrottle[handle] < 15000) return;
    liteHeartbeatThrottle[handle] = now;

    var body = {
      bot_id: botId,
      heartbeat_kind: 'lite',
    };
    var eng = String(payload.engine || '').toLowerCase().trim();
    var status = String(payload.status || '').toLowerCase().trim();
    // 关注/私信引擎每 5s 都会 send_report，且常带 engine=follow/chat；
    // 未在跑时禁止写成 running_module，否则会盖掉调度 full 心跳的 idle/nurture。
    var runningHint =
      status === 'running' ||
      status === 'active' ||
      status.indexOf('running') >= 0;
    var idleHint =
      status === 'idle' ||
      status === 'stopped' ||
      status === 'pause' ||
      status === 'paused' ||
      status.indexOf('idle') >= 0;

    if (eng && eng !== 'idle' && eng !== 'coor' && runningHint && !idleHint) {
      body.engine = eng;
      body.running_module = eng;
      noteLiveEngine(botId, { engine: eng, status: status }, false);
    } else if (eng === 'idle' || idleHint) {
      var live = getLiveEngine(handle);
      if (!live || live === eng) {
        body.engine = 'idle';
        body.running_module = null;
        noteLiveEngine(botId, { engine: eng, status: 'idle' }, false);
      }
      // 其他模块正在跑：本模块空闲心跳只 touch last_seen，不覆盖 engine
    } else {
      // 仅 touch last_seen：不带 engine / running_module
    }
    // 不传 stage / why_idle / followed_today / follow_limit / auto_mode（避免空覆盖）
    opsFetch('/api/plugin/account/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(function () {});
  }

  var botId = payload.bot_id || payload.worker_id || '';
  if (botId) {
    send(botId);
    return;
  }
  try {
    chrome.storage.local.get(['my_handle', 'worker_id'], function (r) {
      send(r.worker_id || r.my_handle || '');
    });
  } catch (e) {}
}

// ==================== 资料克隆临时媒体（内存 + chrome.storage 持久化，防 SW 回收丢图） ====================
var profileCloneMediaCache = Object.create(null);
var PROFILE_CLONE_MEDIA_TTL_MS = 10 * 60 * 1000;
var PROFILE_CLONE_MEDIA_PREFIX = 'sg_pc_media_';

function pruneProfileCloneMedia() {
  var now = Date.now();
  Object.keys(profileCloneMediaCache).forEach(function (id) {
    var e = profileCloneMediaCache[id];
    if (!e || (now - (e.at || 0)) > PROFILE_CLONE_MEDIA_TTL_MS) {
      delete profileCloneMediaCache[id];
    }
  });
}

function pcMediaStorageKey(id) {
  return PROFILE_CLONE_MEDIA_PREFIX + String(id || '');
}

// ==================== 调度命令转发（仅发给 sender tab，Fix #5） ====================
function notifyContent(command, tabId, done) {
  function sendOne(id, cb) {
    try {
      chrome.tabs.sendMessage(id, { action: command }, function (r) {
        var err = chrome.runtime.lastError;
        if (err) cb({ ok: false, error: err.message || String(err) });
        else cb({ ok: true, response: r || null });
      });
    } catch (e) {
      cb({ ok: false, error: e.message || String(e) });
    }
  }
  if (tabId) {
    sendOne(tabId, function (res) {
      if (typeof done === 'function') done(res.ok, res.error || null, 1);
    });
    return;
  }
  chrome.tabs.query({ url: ['https://*.x.com/*', 'https://*.twitter.com/*'] }, function (tabs) {
    if (!tabs || !tabs.length) {
      if (typeof done === 'function') done(false, '无 X 标签页', 0);
      return;
    }
    var left = tabs.length;
    var okN = 0;
    var lastErr = null;
    tabs.forEach(function (tab) {
      sendOne(tab.id, function (res) {
        if (res.ok) okN++;
        else lastErr = res.error;
        left--;
        if (left <= 0 && typeof done === 'function') {
          done(okN > 0, okN > 0 ? null : lastErr, okN);
        }
      });
    });
  });
}

// ==================== 遥测队列（顶层，供 alarms 与 message 监听共用） ====================
function queueTelemetryBatch(events) {
  if (!events || !events.length) return;
  try {
    chrome.storage.local.get(['sg_telemetry_queue'], function (r) {
      var queue = Array.isArray(r.sg_telemetry_queue) ? r.sg_telemetry_queue : [];
      queue.push({ ts: Date.now(), events: events });
      if (queue.length > 100) queue = queue.slice(-100);
      chrome.storage.local.set({ sg_telemetry_queue: queue });
    });
  } catch (e) {}
}

/**
 * 启动时合并重复批次。
 * 旧失败分支会 unshift 同一批次，队列里可能堆着成百上千份完全相同的 events；
 * 不先合并，重载后要一条条补传很久。重复批次内容一致，保留最新一份即可。
 */
function sanitizeTelemetryQueue() {
  try {
    chrome.storage.local.get(['sg_telemetry_queue'], function (r) {
      var queue = Array.isArray(r.sg_telemetry_queue) ? r.sg_telemetry_queue : [];
      if (queue.length < 2) return;
      var seen = {};
      var out = [];
      for (var i = queue.length - 1; i >= 0; i--) {
        var item = queue[i];
        var evs = (item && item.events) || [];
        var key = evs.length
          ? String(evs[0].client_event_id || evs[0]._id || '') + '#' + evs.length
          : 'empty';
        if (seen[key]) continue;
        seen[key] = 1;
        out.unshift(item);
      }
      if (out.length !== queue.length) {
        chrome.storage.local.set({ sg_telemetry_queue: out }, function () {
          console.warn('[调度-SW] 遥测队列去重 ' + queue.length + ' → ' + out.length);
        });
      }
    });
  } catch (e) {}
}

sanitizeTelemetryQueue();

function flushTelemetryQueue() {
  try {
    chrome.storage.local.get(['sg_telemetry_queue'], function (r) {
      var queue = Array.isArray(r.sg_telemetry_queue) ? r.sg_telemetry_queue.slice() : [];
      if (!queue.length) return;
      var item = queue.shift();
      opsFetch('/api/plugin/log/batch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: item.events || [] }),
      }).then(function (res) {
        if (res && res.ok) {
          // 成功必须把「已出队的剩余队列」写回存储再继续。
          // 旧实现直接递归 flushTelemetryQueue()，而函数开头重新读存储，
          // 读到的仍是未改动的旧队列 → 同一条批次被无限重发（现场实测 ~165 次/秒），
          // OPS 最新事件永远停在旧批次上，页面新事件也进不来。
          try {
            chrome.storage.local.set({ sg_telemetry_queue: queue }, function () {
              if (queue.length) flushTelemetryQueue();
            });
          } catch (eSaveQ) {
            if (queue.length) flushTelemetryQueue();
          }
        } else {
          // 失败时存储里本来就没删过这一条，不能再 unshift，
          // 否则每失败一次队列就多一份同一批次，越积越大。
          // 保持原样，等下一次 alarm / 页面 nudge 再试。
        }
      }).catch(function () {
        // 同失败分支：不要重复 unshift。
      });
    });
  } catch (e) {}
}

// ==================== 消息监听 ====================
chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {

  // ----- 资料克隆媒体临时仓（内存 + storage，防跳页 SW 被杀丢缓存） -----
  if (request.action === 'profile_clone_media_put') {
    pruneProfileCloneMedia();
    var putId = String(request.id || '');
    if (!putId) {
      sendResponse({ ok: false, error: 'no_id' });
      return true;
    }
    var putEntry = {
      banner: request.banner || null,
      avatar: request.avatar || null,
      at: Date.now()
    };
    profileCloneMediaCache[putId] = putEntry;
    var putKey = pcMediaStorageKey(putId);
    var putObj = {};
    putObj[putKey] = putEntry;
    chrome.storage.local.set(putObj, function () {
      var err = chrome.runtime.lastError;
      try {
        console.log('[bg] profile_clone_media_put', putId,
          'banner=', !!(request.banner && (request.banner.dataUrl || request.banner.buffer)),
          'avatar=', !!(request.avatar && (request.avatar.dataUrl || request.avatar.buffer)),
          'persist=', !err);
      } catch (eL) {}
      sendResponse({ ok: !err, id: putId, error: err ? err.message : null });
    });
    return true;
  }
  if (request.action === 'profile_clone_media_get') {
    pruneProfileCloneMedia();
    var getId = String(request.id || '');
    if (!getId) {
      sendResponse({ ok: false, error: 'no_id' });
      return true;
    }
    var mem = profileCloneMediaCache[getId];
    if (mem) {
      sendResponse({ ok: true, id: getId, banner: mem.banner || null, avatar: mem.avatar || null, from: 'memory' });
      return true;
    }
    chrome.storage.local.get([pcMediaStorageKey(getId)], function (r) {
      var entry = r && r[pcMediaStorageKey(getId)];
      if (!entry) {
        sendResponse({ ok: false, error: 'miss' });
        return;
      }
      if (entry.at && (Date.now() - entry.at) > PROFILE_CLONE_MEDIA_TTL_MS) {
        chrome.storage.local.remove([pcMediaStorageKey(getId)]);
        sendResponse({ ok: false, error: 'expired' });
        return;
      }
      profileCloneMediaCache[getId] = entry;
      sendResponse({
        ok: true,
        id: getId,
        banner: entry.banner || null,
        avatar: entry.avatar || null,
        from: 'storage'
      });
    });
    return true;
  }
  if (request.action === 'profile_clone_media_clear') {
    var clearId = request.id != null ? String(request.id) : '';
    if (clearId) {
      delete profileCloneMediaCache[clearId];
      chrome.storage.local.remove([pcMediaStorageKey(clearId)], function () {
        sendResponse({ ok: true });
      });
    } else {
      profileCloneMediaCache = Object.create(null);
      chrome.storage.local.get(null, function (all) {
        var keys = Object.keys(all || {}).filter(function (k) {
          return k.indexOf(PROFILE_CLONE_MEDIA_PREFIX) === 0;
        });
        if (keys.length) chrome.storage.local.remove(keys);
        sendResponse({ ok: true });
      });
    }
    return true;
  }
  if (request.action === 'profile_clone_media_has') {
    pruneProfileCloneMedia();
    var hasId = String(request.id || '');
    if (!hasId) {
      sendResponse({ ok: true, has: false });
      return true;
    }
    if (profileCloneMediaCache[hasId]) {
      sendResponse({ ok: true, has: true, from: 'memory' });
      return true;
    }
    chrome.storage.local.get([pcMediaStorageKey(hasId)], function (r) {
      var entry = r && r[pcMediaStorageKey(hasId)];
      var alive = !!(entry && (!entry.at || (Date.now() - entry.at) <= PROFILE_CLONE_MEDIA_TTL_MS));
      sendResponse({ ok: true, has: alive, from: alive ? 'storage' : '' });
    });
    return true;
  }
  // BG 代拉 twimg（内容脚本 CORS/失败时兜底；须已开闸或 mode=on）
  if (request.action === 'profile_clone_fetch_url') {
    var fetchUrl = String(request.url || '');
    if (!fetchUrl) {
      sendResponse({ ok: false, error: 'no_url' });
      return true;
    }
    readMediaLoadMode().then(function (mode) {
      var needGate = /twimg\.com/i.test(fetchUrl) && mode !== 'on';
      if (needGate && mediaGateRef <= 0) {
        sendResponse({ ok: false, error: 'media_gate_closed' });
        return;
      }
      fetch(fetchUrl, { credentials: 'omit', cache: 'no-cache' })
        .then(function (resp) {
          if (!resp.ok) throw new Error('http_' + resp.status);
          return resp.blob();
        })
        .then(function (blob) {
          return blob.arrayBuffer().then(function (buf) {
            var mime = blob.type || 'image/jpeg';
            var u8 = new Uint8Array(buf);
            var chunk = 0x8000;
            var str = '';
            for (var i = 0; i < u8.length; i += chunk) {
              str += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
            }
            var dataUrl = 'data:' + mime + ';base64,' + btoa(str);
            sendResponse({ ok: true, dataUrl: dataUrl, mime: mime, size: blob.size });
          });
        })
        .catch(function (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
        });
    });
    return true;
  }

  // ----- 服务器地址配置 -----
  if (request.action === 'get_servers') {
    chrome.storage.local.get(['pool_server', 'ops_server'], function (r) {
      var pool = forceLanIfWanDisabled('pool', r.pool_server);
      var ops = TEST_OPS_LOCKED ? DEFAULT_OPS_SERVER : forceLanIfWanDisabled('ops', r.ops_server);
      var stickyPool = (WAN_FAILOVER_ENABLED && failoverSticky.pool && failoverSticky.pool.until > Date.now())
        ? failoverSticky.pool.base : '';
      var stickyOps = (!TEST_OPS_LOCKED && WAN_FAILOVER_ENABLED && failoverSticky.ops && failoverSticky.ops.until > Date.now())
        ? failoverSticky.ops.base : '';
      sendResponse({
        ok: true,
        pool_server: pool,
        ops_server: ops,
        wan_failover: WAN_FAILOVER_ENABLED,
        defaults: { pool_server: DEFAULT_POOL_SERVER, ops_server: DEFAULT_OPS_SERVER },
        fallbacks: { pool_server: FALLBACK_POOL_SERVER, ops_server: FALLBACK_OPS_SERVER },
        active: {
          pool_server: stickyPool || pool,
          ops_server: stickyOps || ops,
        },
      });
    });
    return true;
  }
  if (request.action === 'set_servers') {
    var nextPool = forceLanIfWanDisabled('pool', request.pool_server);
    var nextOps = TEST_OPS_LOCKED ? DEFAULT_OPS_SERVER : forceLanIfWanDisabled('ops', request.ops_server);
    chrome.storage.local.set({ pool_server: nextPool, ops_server: nextOps }, function () {
      cachedPoolServer = nextPool;
      cachedOpsServer = nextOps;
      sendResponse({
        ok: true,
        pool_server: nextPool,
        ops_server: nextOps,
        wan_failover: WAN_FAILOVER_ENABLED,
      });
    });
    return true;
  }

  // ----- 调度控制（只发给 sender tab） -----
  // 守箱脉冲：X 在后台标签页不渲染会话正文，必须先把标签激活。
  // focusWindow=true 只在“激活标签后仍 hidden”时由内容脚本追加请求，避免每次都抢窗口焦点。
  if (request.action === 'sg_activate_tab') {
    const tabId = sender.tab && sender.tab.id;
    if (!tabId) {
      sendResponse({ ok: false, visible: false, error: 'no_tab' });
      return true;
    }
    // 4.9.117：最小化的窗口在 Windows 上完全不渲染，守箱会一条都打不开。
    // 旧实现（4.9.58）为了避免“每隔几十秒弹一次窗”直接拒绝恢复，
    // 结果用户把 Chrome 最小化去做别的事，守箱就永久停在 page_hidden_deferred。
    // 现在折中：
    //   1) 只有内容脚本已经确认“确实有活”（未读 / 对方最后发言 / 台账到期）才会走到这里；
    //   2) 恢复窗口时不抢焦点（focused:false）；
    //   3) 10 分钟内最多恢复一次，恢复后窗口就保持展开，不会反复弹。
    var lastRestoreAt = lastWindowRestoreAt;
    var MIN_RESTORE_INTERVAL_MS = MIN_WINDOW_RESTORE_INTERVAL_MS;
    const guardMinimized = function (next) {
      const winId = sender.tab && sender.tab.windowId;
      if (winId == null || !chrome.windows || !chrome.windows.get) { next(); return; }
      try {
        chrome.windows.get(winId, function (win) {
          void chrome.runtime.lastError;
          if (!win || win.state !== 'minimized') { next(); return; }
          if (request.allowWindowRestore === false) {
            sendResponse({
              ok: false, visible: false, error: 'window_minimized',
              minimized: true, tab_id: tabId, window_id: winId,
              window_state: 'minimized', tab_active: false, no_raise: true
            });
            return;
          }
          var nowMs = Date.now();
          if (lastRestoreAt && (nowMs - lastRestoreAt) < MIN_RESTORE_INTERVAL_MS) {
            sendResponse({
              ok: false, visible: false, error: 'window_minimized_throttled',
              minimized: true, tab_id: tabId, window_id: winId,
              window_state: 'minimized', tab_active: false,
              restore_wait_ms: MIN_RESTORE_INTERVAL_MS - (nowMs - lastRestoreAt),
              no_raise: true
            });
            return;
          }
          lastRestoreAt = nowMs;
          lastWindowRestoreAt = nowMs;
          try {
            chrome.windows.update(winId, { state: 'normal', focused: false }, function () {
              void chrome.runtime.lastError;
              // 窗口从最小化恢复后，渲染进程要过一拍才会把 visibilityState 翻成 visible。
              // 这里等 700ms 再继续激活标签，避免内容脚本立刻检查仍是 hidden 而白等一拍。
              setTimeout(next, 700);
            });
          } catch (eRestore) {
            sendResponse({
              ok: false, visible: false, error: 'window_restore_failed',
              minimized: true, tab_id: tabId, window_id: winId,
              window_state: 'minimized', tab_active: false, no_raise: true
            });
          }
        });
      } catch (eWinGuard) { next(); }
    };
    // 4.9.58：已经在前台标签就什么都不做。
    // 旧实现每拍都 tabs.update({active:true})，在 Windows 上会把 Chrome 窗口提到最前，
    // 现场表现就是“插件每隔几十秒把窗口弹出来”。
    // 4.9.117：tab_active=true 不代表页面可见。窗口最小化时标签仍是 active，
    // 旧代码在这里直接回 ok:true，内容脚本随后看到 visibilityState=hidden
    // 又回到 page_hidden_deferred，窗口永远不会被恢复。
    // 因此先过 guardMinimized，只有窗口真的不是最小化才走“已激活”快路径。
    if (sender.tab && sender.tab.active) {
      guardMinimized(function () {
      sendResponse({
        ok: true,
        visible: true,
        tab_active: true,
        tab_id: tabId,
        window_id: (sender.tab && sender.tab.windowId) == null ? '' : sender.tab.windowId,
        window_focus: 'already_active',
        no_raise: true
      });
      });
      return true;
    }
    guardMinimized(function () {
    var doActivateTab = function () {
    chrome.tabs.update(tabId, { active: true }, function (updated) {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, visible: false, error: chrome.runtime.lastError.message });
        return;
      }
      const winId = (updated && updated.windowId != null)
        ? updated.windowId
        : (sender.tab && sender.tab.windowId);
      const done = function (extra) {
        sendResponse(Object.assign({
          ok: true,
          tab_id: tabId,
          window_id: winId == null ? '' : winId,
          tab_active: !!(updated && updated.active),
          window_focused: doActivateTab.windowFocused === undefined ? null : !!doActivateTab.windowFocused,
          window_state: doActivateTab.windowState || '',
          no_raise: true
        }, extra || {}));
      };
      // 4.9.36：默认绝不抢窗口焦点。守箱每拍都 3 次 windows.update({focused:true})
      // 会把 Chrome 反复弹到前台，打断用户其它工作；只允许显式 allowWindowFocus 的
      // 手动诊断入口请求一次。仍 hidden 时由内容脚本记 page_hidden_deferred。
      if (request.focusWindow && request.allowWindowFocus !== true) {
        done({ window_focus: 'disabled_by_default' });
        return;
      }
      if (request.focusWindow && winId != null && chrome.windows && chrome.windows.update) {
        // 只 focused:true 无法把“最小化”的窗口恢复出来，visibilityState 仍然是 hidden。
        // 顺序执行 normal → focused → 再激活标签，覆盖最小化/被遮挡/焦点被抢三种情况。
        const focusAgain = function () {
          chrome.windows.update(winId, { focused: true }, function (win2) {
            const err2 = chrome.runtime.lastError;
            if (err2) {
              sendResponse({
                ok: false,
                error: err2.message,
                tab_id: tabId,
                window_id: winId
              });
              return;
            }
            chrome.tabs.update(tabId, { active: true }, function (tab2) {
              // 4.9.16：窗口从最小化恢复后，渲染进程要过一拍才会把 visibilityState 翻成 visible。
              // 之前这里立刻回包，content script 马上检查仍是 hidden，连续三拍误判“后台延后”。
              // Service Worker 的 timer 不受后台标签节流影响，在这里等 700ms 再回包。
              setTimeout(function () {
                done({
                  window_state: (win2 && win2.state) || 'normal',
                  tab_active: !!(tab2 && tab2.active),
                  focus_sequence: 'normal_focused_active',
                  settle_ms: 700
                });
              }, 700);
            });
          });
        };
        try {
          // 只有最小化才需要 state:'normal'；对最大化窗口设 normal 会把它缩回去。
          chrome.windows.get(winId, function (current) {
            if (chrome.runtime.lastError || !current || current.state !== 'minimized') {
              focusAgain();
              return;
            }
            chrome.windows.update(winId, { state: 'normal' }, function () {
              focusAgain();
            });
          });
          return;
        } catch (eFocus) {}
      }
      done();
    });
    };
    // 4.9.117：窗口不在前台 ≠ 不能渲染。
    // 旧实现只要 window.focused===false 就直接回 window_not_focused，
    // 结果用户只要在别的软件里工作，守箱就一个会话都打不开，
    // OPS 每分钟只有 page_hidden_deferred，看起来像“对方没回”。
    // 正确做法：只切窗口内的标签（tabs.update active），不调用 windows.update(focused)，
    // 这样标签变成该窗口的当前标签、页面恢复渲染，但 Chrome 窗口不会被提到最前。
    // 只有窗口最小化（真的不渲染）才延后。
    var preWinId = (sender.tab && sender.tab.windowId);
    if (preWinId != null && chrome.windows && chrome.windows.get) {
      try {
        chrome.windows.get(preWinId, function (winPre) {
          void chrome.runtime.lastError;
          if (winPre && winPre.state === 'minimized') {
            sendResponse({
              ok: false,
              visible: false,
              error: 'window_minimized',
              minimized: true,
              tab_id: tabId,
              window_id: preWinId,
              window_state: 'minimized',
              no_raise: true
            });
            return;
          }
          // 记录窗口是否在前台，只做诊断用；不因此拒绝激活标签。
          doActivateTab.windowFocused = !!(winPre && winPre.focused);
          doActivateTab.windowState = (winPre && winPre.state) || '';
          doActivateTab();
        });
        return true;
      } catch (eWinPre) {}
    }
    doActivateTab();
    });
    return true;
  }
  function replyDeliver(ok, error, n) {
    sendResponse({ ok: !!ok, delivered: !!ok, error: error || null, tabs: n || 0 });
  }
  if (request.action === 'sg_scheduler_start') {
    notifyContent('sg_scheduler_start', sender.tab?.id, replyDeliver);
    return true;
  }
  // 停止：广播所有 x.com tab，避免只停点按钮的那一页
  if (request.action === 'sg_scheduler_pause') {
    notifyContent('sg_scheduler_pause', null, replyDeliver);
    return true;
  }
  if (request.action === 'sg_scheduler_status') {
    if (sender.tab?.id) {
      chrome.tabs.sendMessage(sender.tab.id, { action: 'sg_scheduler_status' }, function (r) {
        if (chrome.runtime.lastError) sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        else sendResponse(r || {});
      });
    } else {
      sendResponse({ ok: false, error: '无 tab' });
    }
    return true;
  }
  if (request.action === 'sg_manual_follow' || request.action === 'sg_manual_chat' || request.action === 'sg_manual_nurture' || request.action === 'sg_manual_repost') {
    notifyContent(request.action, sender.tab?.id, replyDeliver);
    return true;
  }
  if (request.action === 'sg_nurture_only') {
    notifyContent('sg_nurture_only', sender.tab?.id, replyDeliver);
    return true;
  }
  if (request.action === 'sg_nurture_throttled') {
    notifyContent('sg_nurture_throttled', sender.tab?.id, replyDeliver);
    return true;
  }
  if (request.action === 'sg_test_chat_first') {
    notifyContent('sg_test_chat_first', sender.tab?.id, replyDeliver);
    return true;
  }

  // ----- 心跳 / 状态上报（本地缓存 + OPS lite） -----
  if (request.action === 'send_report') {
    chrome.storage.local.set({
      last_heartbeat: request.payload,
      last_heartbeat_time: Date.now(),
    });
    try { forwardLiteHeartbeat(request.payload); } catch (eLite) {}
    sendResponse({ status: 'success' });
    return true;
  }

  // ----- 号池操作 -----
  if (request.action === 'pool_pop') {
    poolFetch('/pool/pop?worker_id=' + encodeURIComponent(request.worker_id || 'unknown'))
      .then(function (d) { sendResponse(d); });
    return true;
  }
  if (request.action === 'pool_done') {
    poolFetch('/pool/done', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: request.id }),
    }).then(function (d) { sendResponse(d); });
    return true;
  }
  if (request.action === 'pool_fail') {
    poolFetch('/pool/fail', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: request.id }),
    }).then(function (d) { sendResponse(d); });
    return true;
  }
  if (request.action === 'pool_dead') {
    poolFetch('/pool/dead', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: request.id }),
    }).then(function (d) { sendResponse(d); });
    return true;
  }
  if (request.action === 'pool_dead_by_handle') {
    poolFetch('/pool/dead_by_handle', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: request.handle }),
    }).then(function (d) { sendResponse(d); });
    return true;
  }
  if (request.action === 'pool_push') {
    poolFetch('/pool/push', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: request.handle, source: request.source || '' }),
    }).then(function (d) { sendResponse(d); });
    return true;
  }
  if (request.action === 'pool_push_batch') {
    poolFetch('/pool/push_batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handles: request.handles || [] }),
    }).then(function (d) { sendResponse(d); });
    return true;
  }
  if (request.action === 'pool_status') {
    poolFetch('/pool/status').then(function (d) { sendResponse(d); });
    return true;
  }
  if (request.action === 'pool_health') {
    poolFetch('/health').then(function (d) { sendResponse(d); });
    return true;
  }

  // ----- 链接管理 -----
  if (request.action === 'pool_links') {
    opsFetch('/api/links').then(function (d) { sendResponse(d); });
    return true;
  }
  if (request.action === 'pool_links_save') {
    opsFetch('/api/links', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ links: request.links || [] }),
    }).then(function (d) { sendResponse(d); });
    return true;
  }

  // ----- 配置 -----
  if (request.action === 'fetch_remote_config') {
    var cfgQ = request.bot_id ? ('?bot_id=' + encodeURIComponent(request.bot_id)) : '';
    opsFetch('/api/config/all' + cfgQ).then(function (d) { sendResponse(d); });
    return true;
  }
  if (request.action === 'fetch_nurture_comments') {
    opsFetch('/api/nurture/comments').then(function (d) { sendResponse(d); });
    return true;
  }

  // ----- 话术 -----
  if (request.action === 'scripts_pool' || request.action === 'fetch_script_pool') {
    opsFetch('/api/scripts/pool?pool=' + encodeURIComponent(request.pool || 'dating')).then(function (d) { sendResponse(d); });
    return true;
  }

  // ----- 日志上报 -----
  if (request.action === 'log_action' || request.action === 'report_log' || request.action === 'chat_log_action') {
    // 内容页有两套调用：sendLogToNAS 用 {action, payload:{...}}，老调用用顶层字段。
    // 旧实现只读顶层，payload 形式的 bot_id/target/action_type 全是 undefined，
    // OPS 每次都回 "bot_id, target, action_type are required"。
    var lg = (request.payload && typeof request.payload === 'object') ? request.payload : request;
    console.log('[bg] log_action recv:', lg.action_type, 'target:', lg.target, 'bot:', lg.bot_id);
    opsFetch('/api/plugin/log', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bot_id: lg.bot_id || request.bot_id || '',
        target: lg.target || request.target || '',
        action_type: lg.action_type || request.action_type || '',
        detail: lg.detail || request.detail || '',
        message: lg.message || request.message || '',
      }),
    }).then(function(r) {
      console.log('[bg] log_action resp:', JSON.stringify(r));
      // 只有 OPS 真的 ok 才回 success；否则让内容页进补发队列，
      // 不能像旧实现那样“永远 success”，把没入库的战报当成已上报。
      sendResponse({ status: (r && r.ok) ? 'success' : 'failed', result: r || null });
    }).catch(function(e) {
      console.warn('[bg] log_action FAIL:', e.message);
      sendResponse({ status: 'failed', error: e.message || 'ops_unreachable' });
    });
    return true;
  }
  if (request.action === 'report_daily_stats') {
    var payload = request.payload || {};
    opsFetch('/api/plugin/account/daily-stats', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function () {
      flushRetryQueue();
    }).catch(function () {
      queueRetry(payload);
    });
    sendResponse({ status: 'success' });
    return true;
  }

  function queueRetry(payload) {
    try {
      chrome.storage.local.get(['sg_daily_stats_queue'], function (r) {
        var queue = Array.isArray(r.sg_daily_stats_queue) ? r.sg_daily_stats_queue : [];
        if (queue.length >= 50) queue.shift();
        queue.push({ ts: Date.now(), data: payload });
        chrome.storage.local.set({ sg_daily_stats_queue: queue });
      });
    } catch (e) {}
  }

  function flushRetryQueue() {
    try {
      chrome.storage.local.get(['sg_daily_stats_queue'], function (r) {
        var queue = Array.isArray(r.sg_daily_stats_queue) ? r.sg_daily_stats_queue.slice() : [];
        if (!queue.length) return;
        var item = queue.pop();
        chrome.storage.local.set({ sg_daily_stats_queue: queue }, function () {
          opsFetch('/api/plugin/account/daily-stats', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(item.data),
          }).then(function () {
            flushRetryQueue();
          }).catch(function () {
            chrome.storage.local.get(['sg_daily_stats_queue'], function (r2) {
              var q2 = Array.isArray(r2.sg_daily_stats_queue) ? r2.sg_daily_stats_queue : [];
              q2.push(item);
              chrome.storage.local.set({ sg_daily_stats_queue: q2 });
            });
          });
        });
      });
    } catch (e) {}
    flushTelemetryQueue();
  }

  // queueTelemetryBatch / flushTelemetryQueue 已移至顶层（供 alarms 与 message 监听共用）

  // ----- OPS 活动上报 -----
  if (request.action === 'ops_activity_report') {
    opsFetch('/api/plugin/activity/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.payload || {}),
    }).then(function (d) { sendResponse(d); }).catch(function () { sendResponse({ ok: false }); });
    return true;
  }
  if (request.action === 'telemetry_emit') {
    var evts = (request.payload && request.payload.events) || [];
    if (!evts.length) {
      sendResponse({ ok: true, count: 0 });
      return true;
    }
    var handle = '';
    try {
      handle = (evts[0].account_handle || '').replace(/^@/, '').replace(/#guard$/i, '').toLowerCase();
    } catch (eH) {}
    var responded = false;
    function reply(d) {
      if (responded) return;
      responded = true;
      try { sendResponse(d); } catch (eR) {}
    }
    // 硬兜底：防 opsFetch 异常路径不回调 → 页侧 flushing 闩死
    var replyTimer = setTimeout(function () {
      queueTelemetryBatch(evts);
      reply({ ok: false, error: 'sw_emit_timeout', queued: true });
    }, 15000);
    opsFetch('/api/plugin/log/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: evts, account_handle: handle }),
    }).then(function (d) {
      try { clearTimeout(replyTimer); } catch (eC) {}
      try { noteTelemetryResult(d, evts.length, 200); } catch (eNote1) {}
      if (!d || !d.ok) queueTelemetryBatch(evts);
      reply(d || { ok: false });
    }).catch(function () {
      try { clearTimeout(replyTimer); } catch (eC2) {}
      try { noteTelemetryResult({ ok: false, error: 'network_error' }, evts.length, 0); } catch (eNote2) {}
      queueTelemetryBatch(evts);
      reply({ ok: false, queued: true });
    });
    return true;
  }
  if (request.action === 'telemetry_last_result') {
    try {
      chrome.storage.local.get(['sg_telemetry_last_result'], function (r) {
        sendResponse((r && r.sg_telemetry_last_result) || lastTelemetryResult);
      });
    } catch (eLastRes) {
      sendResponse(lastTelemetryResult);
    }
    return true;
  }
  if (request.action === 'telemetry_snapshot') {
    var snap = request.payload || {};
    function postSnapshot(s) {
      opsFetch('/api/plugin/log/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(s),
        timeoutMs: 30000,
      }).then(function (d) { sendResponse(d || { ok: false }); }).catch(function (e) {
        sendResponse({ ok: false, error: (e && e.message) || 'network_error' });
      });
    }
    if (!snap.account_handle || snap.account_handle === 'unknown') {
      try {
        chrome.storage.local.get(['matrix_my_handle'], function (r) {
          if (r && r.matrix_my_handle && r.matrix_my_handle !== 'unknown') {
            snap.account_handle = r.matrix_my_handle;
          }
          postSnapshot(snap);
        });
      } catch (eSt) {
        postSnapshot(snap);
      }
    } else {
      postSnapshot(snap);
    }
    return true;
  }
  if (request.action === 'ops_follow_back_from_followers') {
    opsFetch('/api/plugin/follow-back/from-followers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.payload || {}),
    }).then(function (d) { sendResponse(d); }).catch(function () { sendResponse({ ok: false }); });
    return true;
  }
  if (request.action === 'ops_activity_check') {
    opsFetch('/api/plugin/activity/check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.payload || {}),
    }).then(function (d) { sendResponse(d); }).catch(function () { sendResponse({ ok: false }); });
    return true;
  }
  if (request.action === 'report_followed') {
    // 兼容旧 payload → OPS activity/report 标准字段
    var d = request.data || request.payload || {};
    var accountHandle = d.account_handle || d.bot_id || '';
    var targetHandle = d.target_handle || d.target || '';
    if (!targetHandle && d.handle && accountHandle) {
      var ah = String(accountHandle).replace(/^@/, '').replace(/#guard$/i, '').toLowerCase();
      var hh = String(d.handle).replace(/^@/, '').toLowerCase();
      if (hh && hh !== ah) targetHandle = d.handle;
    }
    opsFetch('/api/plugin/activity/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_handle: accountHandle,
        target_handle: targetHandle,
        action_type: 'follow',
        result: 'success',
        source: 'plugin',
        meta: {
          follow_count: d.count,
          day_count: d.day_count,
          type: d.tp || d.type || 'AUTO',
          blogger_handle: String(d.blogger || d.blogger_handle || '').replace(/^@/, '').toLowerCase()
        }
      }),
    }).then(function (res) { sendResponse({ status: 'success', ok: true, ops: res }); })
      .catch(function () { sendResponse({ status: 'success', ok: false }); });
    return true;
  }

  // ----- DM 相关 -----
  if (request.action === 'ops_account_register') {
    var regBot = request.bot_id || '';
    if (!isRegistrableBotId(regBot)) {
      sendResponse({ ok: false, error: 'invalid_bot_id', msg: '拒绝注册：无效或保留 handle' });
      return true;
    }
    opsFetch('/api/plugin/account/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot_id: regBot }),
    }).then(function (d) { sendResponse(d); }).catch(function () { sendResponse({ ok: false }); });
    return true;
  }
  if (request.action === 'ops_account_frozen') {
    opsFetch('/api/plugin/account/frozen', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bot_id: request.bot_id || '',
        reason: request.reason || '',
      }),
    }).then(function (d) { sendResponse(d); }).catch(function () { sendResponse({ ok: false }); });
    return true;
  }
  // H9：来源号被动检测上报（E1 抓取遇冻结/不存在页）
  if (request.action === 'ops_repost_source_status') {
    opsFetch('/api/plugin/repost-source-status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: request.source || '',
        status: request.status || '',
        note: request.note || '',
      }),
    }).then(function (d) { sendResponse(d); }).catch(function () { sendResponse({ ok: false }); });
    return true;
  }
  // ----- E5 原创内容池：claim / report / 取图（取图经 opsFetchRaw，禁止裸 IP） -----
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
    // SW 跨域取图 → dataURL 回内容脚本（内容脚本只传相对路径，基址由 SW 拼）
    var cpPath = String(request.url || '');
    if (cpPath.indexOf('/') !== 0) cpPath = '/' + cpPath;
    opsFetchRaw(cpPath)
      .then(function (res) {
        return new Promise(function (resolve, reject) {
          var fr = new FileReader();
          fr.onloadend = function () { resolve({ ok: true, dataUrl: fr.result, type: res.type, size: res.blob.size }); };
          fr.onerror = reject;
          fr.readAsDataURL(res.blob);
        });
      })
      .then(function (d) { sendResponse(d); })
      .catch(function (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); });
    return true;
  }
  if (request.action === 'ops_dm_record') {
    opsFetch('/api/plugin/dm/record', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bot_id: request.bot_id || '',
        target_handle: request.target_handle || '',
        round_number: request.round_number || 1,
        message_content: request.message_content || '',
        result: request.result || 'success',
        ledger_backfill: request.ledger_backfill === true,
      }),
    }).then(function (d) { sendResponse(d); }).catch(function () { sendResponse({ ok: false }); });
    return true;
  }
  if (request.action === 'ops_dm_roster') {
    var rosterBody = request.payload || request.body || {};
    // 4.6.70：一律用本号 handle 作 botKey，禁止 worker 串号
    var rosterBot = String(
      rosterBody.botHandle || rosterBody.bot_handle || request.bot_id || rosterBody.bot_id || ''
    ).replace(/^@/, '').toLowerCase().trim();
    if (rosterBot) {
      rosterBody.bot_id = rosterBot;
      rosterBody.botHandle = rosterBot;
    }
    opsFetch('/api/plugin/dm/roster', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rosterBody),
      timeoutMs: 20000
    }).then(function (d) { sendResponse(d); }).catch(function () { sendResponse({ ok: false }); });
    return true;
  }
  if (request.action === 'ops_outbox_enqueue') {
    enqueueOpsOutboxEntry(request.entry || request, sendResponse);
    return true;
  }
  if (request.action === 'ops_outbox_flush') {
    flushOpsOutbox(function (r) { sendResponse(r || { ok: false }); });
    return true;
  }
  if (request.action === 'ops_dm_roster_get') {
    // 4.6.67：拉 OPS 台账 pending 回灌本地队列
    var rosterHandle = String(request.handle || request.bot_id || '').replace(/^@/, '').trim();
    if (!rosterHandle) {
      sendResponse({ ok: false, msg: 'handle required' });
      return false;
    }
    opsFetch('/api/plugin/dm/roster/' + encodeURIComponent(rosterHandle))
      .then(function (d) { sendResponse(d); })
      .catch(function () { sendResponse({ ok: false }); });
    return true;
  }
  if (request.action === 'ops_health_event') {
    opsFetch('/api/plugin/health/event', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.payload || request.body || {}),
    }).then(function (d) { sendResponse(d); }).catch(function () { sendResponse({ ok: false }); });
    return true;
  }
  if (request.action === 'ops_dm_rounds') {
    opsFetch('/api/plugin/dm/rounds/' + encodeURIComponent(request.handle || 'unknown'))
      .then(function (d) { sendResponse(d); }).catch(function () { sendResponse({ ok: false }); });
    return true;
  }
  if (request.action === 'ops_leads_discover') {
    opsFetch('/api/plugin/leads/discover', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot_id: request.bot_id || '', handles: request.handles || [] }),
    }).then(function (d) { sendResponse(d); }).catch(function () { sendResponse({ ok: false }); });
    return true;
  }
  if (request.action === 'ops_dm_check') {
    // 4.6.123：只读校验，网络失败 2s 后退避重试 1 次（§C2-18 / H2）；后端业务性 ok:false 不重试直接透传
    var dmCheckBody = JSON.stringify(request.payload || {});
    var dmCheckOpts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: dmCheckBody };
    var dmCheckT0 = Date.now();
    // 不可达统一标记 ops_unreachable，与前端 frontend_timeout 区分，禁一笔糊涂账
    var dmCheckUnreachable = function () { return { ok: false, reason: 'ops_unreachable', msg: 'ops_unreachable' }; };
    opsFetch('/api/plugin/dm/check', dmCheckOpts).then(function (d) { sendResponse(d); }).catch(function () {
      // 快失败（瞬时断网/连接拒绝）才值得重试；慢失败（failover 已耗尽内外网）重试也赶不上前端 12s 预算
      if (Date.now() - dmCheckT0 > 5000) { sendResponse(dmCheckUnreachable()); return; }
      setTimeout(function () {
        opsFetch('/api/plugin/dm/check', dmCheckOpts)
          .then(function (d2) { sendResponse(d2); })
          .catch(function () { sendResponse(dmCheckUnreachable()); });
      }, 2000);
    });
    return true;
  }
  if (request.action === 'ops_dm_next') {
    opsFetch('/api/plugin/dm/next', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.payload || {}),
    }).then(function (d) { sendResponse(d); }).catch(function () { sendResponse({ ok: false }); });
    return true;
  }
  if (request.action === 'ops_dm_result') {
    opsFetch('/api/plugin/dm/result', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.payload || {}),
    }).then(function (d) { sendResponse(d); }).catch(function () { sendResponse({ ok: false }); });
    return true;
  }

  // ----- 账号信息 -----
  if (request.action === 'set_my_handle') {
    var handleSet = { my_handle: request.handle, worker_id: request.worker_id };
    if (request.bit_id) handleSet.matrix_bit_id = String(request.bit_id);
    chrome.storage.local.set(handleSet);
    sendResponse({ ok: true });
    return true;
  }
  if (request.action === 'get_my_handle') {
    chrome.storage.local.get(['my_handle', 'matrix_bit_id'], function (r) {
      sendResponse({ handle: r.my_handle || '', bit_id: r.matrix_bit_id || '' });
    });
    return true;
  }
  if (request.action === 'ops_account_heartbeat') {
    var hbBody = request.payload || {};
    if (!hbBody.bot_id) hbBody.bot_id = request.bot_id || '';
    if (!isRegistrableBotId(hbBody.bot_id)) {
      sendResponse({ ok: false, error: 'invalid_bot_id' });
      return true;
    }
    try { noteLiveEngine(hbBody.bot_id, hbBody, true); } catch (eNote) {}
    opsFetch('/api/plugin/account/heartbeat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(hbBody),
    }).then(function (d) { sendResponse(d); }).catch(function () { sendResponse({ ok: false }); });
    return true;
  }
  if (request.action === 'ops_repost_targets_push') {
    opsFetch('/api/plugin/account/repost-targets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bot_id: request.bot_id || '',
        targets: Array.isArray(request.targets) ? request.targets : []
      }),
    }).then(function (d) { sendResponse(d); }).catch(function () { sendResponse({ ok: false }); });
    return true;
  }
  if (request.action === 'ops_remote_command_claim') {
    opsFetch('/api/plugin/account/command-claim', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot_id: request.bot_id || '' }),
    }).then(function (d) { sendResponse(d); }).catch(function () { sendResponse({ ok: false }); });
    return true;
  }
  if (request.action === 'ops_remote_command_ack') {
    opsFetch('/api/plugin/account/command-ack', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bot_id: request.bot_id || '',
        command: request.command || '',
        ok: request.ok !== false,
        auto_mode: !!request.auto_mode,
        running_module: request.running_module == null ? null : request.running_module,
      }),
    }).then(function (d) { sendResponse(d); }).catch(function () { sendResponse({ ok: false }); });
    return true;
  }
  if (request.action === 'ops_scrm_chat_gate') {
    opsFetch('/api/plugin/scrm/chat-gate', { method: 'GET' })
      .then(function (d) { sendResponse(d || { ok: false, allow_chat: false, reason: 'SCRM未上报' }); })
      .catch(function () { sendResponse({ ok: false, allow_chat: false, reason: 'SCRM状态过期' }); });
    return true;
  }
  // 4.6.173：舰队重活并发租约
  if (request.action === 'ops_fleet_lease') {
    opsFetch('/api/plugin/fleet/lease', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bot_id: request.bot_id || '',
        kind: request.kind || 'chat',
        ttl_ms: request.ttl_ms || 180000,
      }),
    }).then(function (d) { sendResponse(d || { ok: false, granted: false }); })
      .catch(function () { sendResponse({ ok: false, granted: false, reason: 'ops_unreachable' }); });
    return true;
  }
  if (request.action === 'ops_fleet_release') {
    opsFetch('/api/plugin/fleet/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bot_id: request.bot_id || '',
        kind: request.kind || '',
      }),
    }).then(function (d) { sendResponse(d || { ok: false }); })
      .catch(function () { sendResponse({ ok: false }); });
    return true;
  }

  // ----- 缓存自愈（方案 B） -----
  if (request.action === 'sg_request_heal') {
    // 4.6.154：同 tab 多探针（白屏/内存/关注/养号）同拍并发时共享同一在途自愈，
    // 否则两路各自 tabs.create 却只有一个能 tabs.remove 旧 id → 每次并发净漏 1 页
    var healTabId = sender && sender.tab && sender.tab.id;
    if (healTabId && healInFlight[healTabId]) {
      healInFlight[healTabId].then(function (r) { sendResponse(r); }, function (e) {
        sendResponse({ ok: false, error: (e && e.message) || String(e) });
      });
      return true;
    }
    var healP = handleHealRequest(request, sender);
    if (healTabId) {
      healInFlight[healTabId] = healP;
      var clearHealInFlight = function () {
        if (healInFlight[healTabId] === healP) delete healInFlight[healTabId];
      };
      healP.then(clearHealInFlight, clearHealInFlight);
    }
    healP.then(function (r) { sendResponse(r); });
    return true;
  }
  if (request.action === 'sg_purge_cache') {
    purgeXCache().then(function (r) { sendResponse(r); }).catch(function (e) {
      sendResponse({ ok: false, error: (e && e.message) || String(e) });
    });
    return true;
  }

  // ----- 媒体开闸（P3：默禁 twimg 图，克隆/转帖短时放行） -----
  if (request.action === 'media_gate_open') {
    mediaGateOpen(request.reason || 'task').then(function (r) { sendResponse(r); });
    return true;
  }
  if (request.action === 'media_gate_close') {
    mediaGateClose(request.reason || 'task').then(function (r) { sendResponse(r); });
    return true;
  }
  if (request.action === 'media_gate_status') {
    // 只读；禁止把 SW 冷启动 ref=0 写回 storage
    sendResponse({
      ok: true,
      ref: mediaGateRef,
      mode: mediaLoadModeCache,
      dnr: !!(chrome.declarativeNetRequest && chrome.declarativeNetRequest.updateDynamicRules),
      fallback: 'main_world'
    });
    return true;
  }
  if (request.action === 'get_installation_id') {
    ensureInstallationId().then(function (id) {
      sendResponse({ ok: true, id: id });
    });
    return true;
  }

  // ----- Ping -----
  if (request.action === 'ping') {
    sendResponse({ status: 'pong' });
    return true;
  }

  // 未处理的消息
  return false;
});

// ==================== 缓存自愈（方案 B + 媒体清扫 + 错峰） ====================
var X_CACHE_ORIGINS_DOC = [
  'https://x.com',
  'https://twitter.com'
];
var X_CACHE_ORIGINS_TWIMG = [
  'https://pbs.twimg.com',
  'https://abs.twimg.com',
  'https://video.twimg.com',
  'https://ton.twimg.com'
];
var X_CACHE_ORIGINS = X_CACHE_ORIGINS_DOC.concat(X_CACHE_ORIGINS_TWIMG);
var HEAL_MIN_INTERVAL_MS = 10 * 60 * 1000;
var HEAL_WINDOW_MS = 60 * 60 * 1000;
var HEAL_WINDOW_MAX = 2;
var HEAL_DEFER_AFTER_PURGE_MS = 2.5 * 60 * 1000;
var CACHE_PURGE_ALARM = 'sg_cache_purge';
var CRASH_SCAN_ALARM = 'sg_crash_scan';
var CACHE_PURGE_PERIOD_MIN = 45;
var CACHE_PURGE_MIN_INTERVAL_MS = 15 * 60 * 1000;
var CACHE_PURGE_JITTER_MIN = 12;
var CACHE_PURGE_JITTER_MAX = 20;

var MEDIA_BLOCK_RULE_ID = 9101;
var MEDIA_STATIC_RULESET = 'twimg_block';
var MEDIA_GATE_WALL_MS = 3 * 60 * 1000;
var mediaGateRef = 0;
var mediaGateTimer = null;
var mediaLoadModeCache = 'on';

function setStaticTwimgBlock(wantBlock) {
  if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateEnabledRulesets) {
    return Promise.resolve({ ok: false, error: 'no_static_rulesets' });
  }
  return new Promise(function (resolve) {
    var opts = wantBlock
      ? { enableRulesetIds: [MEDIA_STATIC_RULESET] }
      : { disableRulesetIds: [MEDIA_STATIC_RULESET] };
    chrome.declarativeNetRequest.updateEnabledRulesets(opts, function () {
      var err = chrome.runtime.lastError;
      if (err) {
        console.warn('[调度-SW] static DNR ruleset fail:', err.message);
        resolve({ ok: false, error: err.message });
      } else {
        resolve({ ok: true, blocked: wantBlock });
      }
    });
  });
}

// ---------- K3 页面瘦身·第三针：X 遥测 DNR（随 sg_page_slim 启停，不看 force） ----------
var XTELEM_STATIC_RULESET = 'x_telemetry_block';
var _xTelemDnrOn = null;

function setStaticXTelemBlock(wantBlock) {
  if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateEnabledRulesets) {
    return Promise.resolve({ ok: false, error: 'no_static_rulesets' });
  }
  // 4.6.194：幂等缓存——config-sync 每分钟写 sg_page_slim 会触发 onChanged，
  // 状态没变时不重复调 updateEnabledRulesets（50 实例下省掉每分钟一枪）。
  if (_xTelemDnrOn === !!wantBlock) {
    return Promise.resolve({ ok: true, blocked: !!wantBlock, cached: true });
  }
  return new Promise(function (resolve) {
    var opts = wantBlock
      ? { enableRulesetIds: [XTELEM_STATIC_RULESET] }
      : { disableRulesetIds: [XTELEM_STATIC_RULESET] };
    chrome.declarativeNetRequest.updateEnabledRulesets(opts, function () {
      var err = chrome.runtime.lastError;
      if (err) {
        _xTelemDnrOn = null;
        console.warn('[调度-SW] x-telemetry DNR fail:', err.message);
        resolve({ ok: false, error: err.message });
      } else {
        _xTelemDnrOn = !!wantBlock;
        resolve({ ok: true, blocked: wantBlock });
      }
    });
  });
}

function applySlimDnrRules() {
  return new Promise(function (resolve) {
    try {
      chrome.storage.local.get(['sg_page_slim'], function (st) {
        var on = String((st && st.sg_page_slim) || '0') === '1';
        setStaticXTelemBlock(on).then(function (r) {
          console.log('[调度-SW] x-telemetry block=', on, 'ok=', !!(r && r.ok));
          resolve(r);
        });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

function hashSeed(s) {
  var h = 2166136261;
  s = String(s || '');
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function ensureInstallationId() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(['sg_installation_id'], function (r) {
      if (r && r.sg_installation_id) {
        resolve(String(r.sg_installation_id));
        return;
      }
      var id = 'i' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
      chrome.storage.local.set({ sg_installation_id: id }, function () {
        resolve(id);
      });
    });
  });
}

function resolvePurgeSeed() {
  return ensureInstallationId().then(function (iid) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(['matrix_bit_id', 'my_handle', 'sg_installation_id'], function (r) {
        var seed = (r && r.matrix_bit_id) || (r && r.my_handle) || (r && r.sg_installation_id) || iid;
        resolve(String(seed || iid));
      });
    });
  });
}

function readMediaLoadMode() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(['sg_media_load_mode'], function (st) {
      var mode = String((st && st.sg_media_load_mode) || 'off').toLowerCase();
      if (mode !== 'on' && mode !== 'off' && mode !== 'auto') mode = 'off';
      // 4.3.14：停禁图 — auto 按 on
      // 4.4.0：重启禁图 — auto 仍按 on 兼容旧配置；新默认 off
      if (mode === 'auto') mode = 'on';
      mediaLoadModeCache = mode;
      resolve(mode);
    });
  });
}

/** 仅清 HTTP + CacheStorage；不清 cookies / localStorage。opts.force 跳过 15min 防抖 */
function purgeXCache(opts) {
  opts = opts || {};
  var force = !!opts.force;
  return new Promise(function (resolve) {
    if (!chrome.browsingData || !chrome.browsingData.remove) {
      console.warn('[调度-SW] browsingData 不可用，跳过清缓存');
      resolve({ ok: false, error: 'browsingData_unavailable' });
      return;
    }
    chrome.storage.local.get(['sg_cache_last_purge_at', 'sg_media_load_mode'], function (st) {
      var lastAt = (st && st.sg_cache_last_purge_at) || 0;
      var now = Date.now();
      if (!force && lastAt && now - lastAt < CACHE_PURGE_MIN_INTERVAL_MS) {
        resolve({ ok: true, skipped: true, reason: 'rate_limit_purge', at: lastAt });
        return;
      }
      var mode = String((st && st.sg_media_load_mode) || 'off').toLowerCase();
      if (mode !== 'on' && mode !== 'off' && mode !== 'auto') mode = 'off';
      if (mode === 'auto') mode = 'on';
      var includeTwimg = opts.includeTwimg;
      if (includeTwimg == null) {
        // auto/off：定期只清文档域，避免逼下次开闸狂下 twimg（O2）
        includeTwimg = mode === 'on' || !!opts.forceTwimg;
      }
      var origins = includeTwimg ? X_CACHE_ORIGINS : X_CACHE_ORIGINS_DOC;
      chrome.browsingData.remove(
        { origins: origins },
        { cache: true, cacheStorage: true },
        function () {
          var err = chrome.runtime.lastError;
          if (err) {
            console.error('[调度-SW] purgeXCache fail:', err.message);
            resolve({ ok: false, error: err.message });
            return;
          }
          var at = Date.now();
          chrome.storage.local.set({ sg_cache_last_purge_at: at });
          console.log('[调度-SW] purgeXCache ok @', at, 'twimg=', includeTwimg, 'mode=', mode);
          resolve({ ok: true, at: at, includeTwimg: includeTwimg, mode: mode });
        }
      );
    });
  });
}

function readHealState() {
  return new Promise(function (resolve) {
    chrome.storage.local.get([
      'sg_heal_last_at', 'sg_heal_window', 'sg_heal_last_mode', 'sg_heal_shell_window'
    ], function (r) {
      resolve({
        lastAt: r.sg_heal_last_at || 0,
        window: Array.isArray(r.sg_heal_window) ? r.sg_heal_window : [],
        shellWindow: Array.isArray(r.sg_heal_shell_window) ? r.sg_heal_shell_window : [],
        lastMode: r.sg_heal_last_mode || 'reload'
      });
    });
  });
}

function writeHealSuccess(now, mode, reason) {
  return readHealState().then(function (st) {
    var window = (st.window || []).filter(function (t) { return now - t < HEAL_WINDOW_MS; });
    // soft_reload 不烧硬 heal 窗，否则 loading_shell 梯度第 3 步 recreate 被 HEAL_WINDOW_MAX=2 挡死
    if (mode !== 'soft_reload') {
      window.push(now);
    }
    var shellWindow = (st.shellWindow || []).filter(function (t) { return now - t < HEAL_WINDOW_MS; });
    if (String(reason || '').indexOf('loading_shell') === 0) shellWindow.push(now);
    var persistMode = mode === 'recreate' ? 'recreate' : 'reload';
    return new Promise(function (resolve) {
      chrome.storage.local.set({
        sg_heal_last_at: now,
        sg_heal_window: window,
        sg_heal_shell_window: shellWindow,
        sg_heal_last_mode: persistMode
      }, function () { resolve(); });
    });
  });
}

function checkHealAllowed(pausedTill, request) {
  var now = Date.now();
  var pt = parseInt(pausedTill, 10) || 0;
  if (pt > now) {
    return Promise.resolve({ ok: false, skipped: true, reason: 'paused' });
  }
  var reason = String((request && request.reason) || '');
  var shellEsc = reason.indexOf('loading_shell') === 0;
  return readHealState().then(function (st) {
    var shellCount = (st.shellWindow || []).filter(function (t) { return now - t < HEAL_WINDOW_MS; }).length;
    // loading_shell 梯度：90s 即可升档；硬白屏/recreate 仍 10min
    var minInterval = shellEsc ? (90 * 1000) : HEAL_MIN_INTERVAL_MS;
    if (st.lastAt && now - st.lastAt < minInterval) {
      return { ok: false, skipped: true, reason: 'rate_limit_interval' };
    }
    var recent = (st.window || []).filter(function (t) { return now - t < HEAL_WINDOW_MS; });
    if (recent.length >= HEAL_WINDOW_MAX) {
      // 壳路径已两档仍卡：允许 recreate 突破硬窗（否则永远到不了第 3 档）
      if (!(shellEsc && shellCount >= 2)) {
        return { ok: false, skipped: true, reason: 'rate_limit_window' };
      }
    }
    return {
      ok: true,
      lastMode: st.lastMode,
      lastAt: st.lastAt,
      shellCount: shellCount
    };
  });
}

/** 方案 C：关旧 tab → 同窗同 URL 新建（清掉卡死的渲染进程/堆；登录与 localStorage 保留） */
function recreateXTab(tabId) {
  return new Promise(function (resolve) {
    chrome.tabs.get(tabId, function (tab) {
      var getErr = chrome.runtime.lastError;
      if (getErr || !tab) {
        resolve({ ok: false, error: (getErr && getErr.message) || 'tab_gone' });
        return;
      }
      var url = tab.url || '';
      if (!/^https:\/\/(x|twitter)\.com\//i.test(url)) {
        url = 'https://x.com/home';
      }
      // 4.9.38：重建标签页绝不能把窗口顶到前台。
      // 旧实现 active=tab.active，只要原标签是活动页，新建的标签就会激活窗口，
      // 现场就是 Chrome 每隔几十秒自己弹出来。只有窗口本来就在前台才允许 active。
      // 4.9.110：即使窗口在前台，“active=true”在 Windows 上仍会把窗口提到最前。
      // 现场用户正在别的应用里打字，Chrome 却每隔几十秒弹出来一次。
      // 守箱不需要这个新标签可见（它自己会请求激活），所以重建一律 active:false，
      // 由用户或守箱的显式激活流程决定何时切到前台。
      var applyCreate = function (win) {
        chrome.storage.local.get(['sg_chat_window'], function (wr) {
          void chrome.runtime.lastError;
          var tabUrl = tabUrlForChatHours(url, wr && wr.sg_chat_window, Date.now(), SG_TEST_24H);
          var winFocused = !!(win && win.focused);
          var createOpts = {
            url: tabUrl,
            active: false
          };
          if (tab.windowId != null) createOpts.windowId = tab.windowId;
          if (typeof tab.index === 'number') createOpts.index = tab.index;
          chrome.tabs.create(createOpts, function (newTab) {
            var createErr = chrome.runtime.lastError;
            if (createErr || !newTab || !newTab.id) {
              resolve({ ok: false, error: (createErr && createErr.message) || 'create_fail' });
              return;
            }
            chrome.tabs.remove(tabId, function () {
              var rmErr = chrome.runtime.lastError;
              if (rmErr) {
                console.warn('[调度-SW] recreate: 旧 tab 关闭失败（新 tab 已开）', rmErr.message);
              }
              resolve({ ok: true, newTabId: newTab.id, windowId: newTab.windowId, url: tabUrl, window_focused: winFocused });
            });
          });
        });
      };
      if (tab.windowId != null && chrome.windows && chrome.windows.get) {
        try {
          chrome.windows.get(tab.windowId, function (win) {
            void chrome.runtime.lastError;
            applyCreate(win || null);
          });
          return;
        } catch (eWinGet) {}
      }
      applyCreate(null);
    });
  });
}

/**
 * 4.6.154：recreate 后核销同窗残留 x 页。
 * 多探针同拍请求自愈时，tabs.create 各自成功、tabs.remove 只有一个能删旧 id → 每并发净漏 1 页；
 * 单实例=单账号，同窗非 active/非 pinned 的其它 x 页都是漏出来的旧页，必须关掉。
 */
function sweepSiblingXTabs(keepTabId, windowId) {
  return new Promise(function (resolve) {
    if (windowId == null || !chrome.tabs || !chrome.tabs.query) { resolve(0); return; }
    chrome.tabs.query({ windowId: windowId }, function (tabs) {
      if (chrome.runtime.lastError || !Array.isArray(tabs)) { resolve(0); return; }
      var victims = tabs.filter(function (t) {
        if (!t || t.id == null || t.id === keepTabId) return false;
        if (t.active || t.pinned) return false;
        return /^https:\/\/(x|twitter)\.com\//i.test(t.url || '');
      }).map(function (t) { return t.id; });
      if (!victims.length) { resolve(0); return; }
      chrome.tabs.remove(victims, function () {
        void chrome.runtime.lastError;
        console.log('[调度-SW] heal 清理同窗旧 x 页:', victims.join(','), 'window=', windowId, 'keep=', keepTabId);
        resolve(victims.length);
      });
    });
  });
}

/** 4.6.154：同 tab 自愈在途去重（白屏/内存/关注/养号多探针并发） */
var healInFlight = Object.create(null);

/**
 * soft_reload：不 bypassCache、不 purge（loading_shell 首次）
 * purge_reload：purge + bypassCache reload（同小时第 2 次 loading_shell）
 * reload：bypassCache reload（真白屏首次）
 * recreate：关 tab 重建
 */
function chooseHealMode(request, gate) {
  if (request && (request.mode === 'recreate' || request.forceRecreate === true)) return 'recreate';
  var reason = String((request && request.reason) || '');
  if (reason === 'memory' || reason === 'lag' || reason === 'force_recreate') return 'recreate';
  if (reason === 'aw_snap' || reason === 'renderer_crash') return 'recreate';

  if (reason.indexOf('loading_shell') === 0) {
    var sc = (gate && gate.shellCount) || 0;
    if (sc <= 0) return 'soft_reload';
    if (sc === 1) return 'purge_reload';
    return 'recreate';
  }

  if (reason.indexOf('white_screen') === 0) {
    if (gate && gate.lastMode === 'reload' && gate.lastAt && (Date.now() - gate.lastAt) < HEAL_WINDOW_MS) {
      return 'recreate';
    }
    return 'reload';
  }
  return 'reload';
}

function doTabReload(tabId, bypassCache) {
  return new Promise(function (resolve) {
    chrome.tabs.reload(tabId, { bypassCache: !!bypassCache }, function () {
      var err = chrome.runtime.lastError;
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true });
    });
  });
}

function handleHealRequest(request, sender) {
  var reason = (request && request.reason) || 'unknown';
  var tabId = sender && sender.tab && sender.tab.id;
  if (!tabId) {
    console.warn('[调度-SW] heal denied: no_tab reason=', reason);
    return Promise.resolve({ ok: false, skipped: true, reason: 'no_tab' });
  }
  if (request && (request.challenge === true || request.block_heal === true)) {
    console.warn('[调度-SW] heal denied: challenge reason=', reason, 'tab=', tabId);
    return Promise.resolve({ ok: false, skipped: true, reason: 'challenge' });
  }
  // 4.9.38：后台标签页不渲染是浏览器的正常行为，不是白屏。
  // 内容脚本明确告知 hidden 时直接拒绝，避免 heal→recreate 把窗口顶到前台。
  if (request && request.hidden === true && reason.indexOf('white_screen') === 0) {
    console.warn('[调度-SW] heal denied: hidden_no_heal reason=', reason, 'tab=', tabId);
    return Promise.resolve({ ok: false, skipped: true, reason: 'hidden_no_heal' });
  }
  return checkHealAllowed(request && request.pausedTill, request).then(function (gate) {
    if (!gate.ok) {
      console.warn('[调度-SW] heal denied:', gate.reason, 'req=', reason, 'tab=', tabId);
      return gate;
    }
    var mode = chooseHealMode(request, gate);

    // 刚 purge 过则推迟 recreate，避免连环握手（heal_deferred_net）
    var maybeDefer = Promise.resolve(null);
    if (mode === 'recreate') {
      maybeDefer = new Promise(function (resolve) {
        chrome.storage.local.get(['sg_cache_last_purge_at'], function (st) {
          var lastPurge = (st && st.sg_cache_last_purge_at) || 0;
          if (lastPurge && Date.now() - lastPurge < HEAL_DEFER_AFTER_PURGE_MS) {
            console.warn('[调度-SW] heal deferred net: recent purge, reason=', reason);
            resolve({ ok: false, skipped: true, reason: 'heal_deferred_net' });
          } else {
            resolve(null);
          }
        });
      });
    }

    return maybeDefer.then(function (deferred) {
      if (deferred) return deferred;

      var needPurge = mode === 'purge_reload' || mode === 'recreate';
      var bypassCache = mode !== 'soft_reload';
      var purgeOpts = needPurge
        ? { includeTwimg: mode === 'recreate' || mode === 'purge_reload' }
        : null;

      var purgePromise = needPurge
        ? purgeXCache(purgeOpts)
        : Promise.resolve({ ok: true, skipped: true, reason: 'no_purge' });

      return purgePromise.then(function (purgeRes) {
        if (mode === 'recreate') {
          return recreateXTab(tabId).then(function (rec) {
            if (!rec || !rec.ok) {
              console.error('[调度-SW] heal recreate fail:', rec && rec.error, 'fallback reload tab=', tabId);
              return doTabReload(tabId, true).then(function (rr) {
                if (!rr.ok) {
                  return { ok: false, error: (rec && rec.error) || rr.error, purged: !!(purgeRes && purgeRes.ok && !purgeRes.skipped) };
                }
                var now = Date.now();
                return writeHealSuccess(now, 'reload', reason).then(function () {
                  return {
                    ok: true, reason: reason, mode: 'reload',
                    fallbackFrom: 'recreate',
                    purged: !!(purgeRes && purgeRes.ok && !purgeRes.skipped), at: now
                  };
                });
              });
            }
            var nowR = Date.now();
            // 4.6.154：新页开好后核销同窗残留 x 页（并发自愈/历史遗留都可能堆页）
            return sweepSiblingXTabs(rec.newTabId, rec.windowId).then(function (closed) {
              return writeHealSuccess(nowR, 'recreate', reason).then(function () {
                console.log('[调度-SW] heal recreate reason=', reason, 'old=', tabId, 'new=', rec.newTabId, 'swept=', closed);
                return {
                  ok: true, reason: reason, mode: 'recreate',
                  newTabId: rec.newTabId, sweptTabs: closed,
                  purged: !!(purgeRes && purgeRes.ok && !purgeRes.skipped), at: nowR
                };
              });
            });
          });
        }

        return doTabReload(tabId, bypassCache).then(function (rr) {
          if (!rr.ok) {
            console.error('[调度-SW] heal reload fail:', rr.error);
            return { ok: false, error: rr.error, purged: !!(purgeRes && purgeRes.ok && !purgeRes.skipped) };
          }
          var now = Date.now();
          return writeHealSuccess(now, mode, reason).then(function () {
            console.log('[调度-SW] heal', mode, 'reason=', reason, 'tab=', tabId,
              'purged=', !!(purgeRes && purgeRes.ok && !purgeRes.skipped), 'bypass=', bypassCache);
            return {
              ok: true, reason: reason, mode: mode,
              purged: !!(purgeRes && purgeRes.ok && !purgeRes.skipped),
              bypassCache: bypassCache, at: now
            };
          });
        });
      });
    });
  });
}

function persistMediaGateState(extra) {
  extra = extra || {};
  var payload = {
    sg_media_gate_ref: mediaGateRef,
    sg_media_load_mode: mediaLoadModeCache || 'off'
  };
  if (extra.dnrBlocked != null) payload.sg_media_dnr_blocked = !!extra.dnrBlocked;
  if (extra.dnrOk != null) payload.sg_media_dnr_ok = !!extra.dnrOk;
  return new Promise(function (resolve) {
    chrome.storage.local.set(payload, function () { resolve(); });
  });
}

// ---------- 媒体闸：静态 DNR（主，对齐 ImageBlocker/uBlock）+ 动态备份 ----------
function applyMediaDnrRules() {
  if (!chrome.declarativeNetRequest) {
    return persistMediaGateState({ dnrOk: false, dnrBlocked: false }).then(function () {
      return { ok: false, error: 'dnr_unavailable', ref: mediaGateRef, mode: mediaLoadModeCache, fallback: 'main_world' };
    });
  }
  return readMediaLoadMode().then(function (mode) {
    var wantBlock = mode !== 'on' && mediaGateRef <= 0;
    var staticP = setStaticTwimgBlock(wantBlock);
    var dynamicP = new Promise(function (resolve) {
      if (!chrome.declarativeNetRequest.updateDynamicRules) {
        resolve({ ok: false, error: 'no_dynamic' });
        return;
      }
      chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [MEDIA_BLOCK_RULE_ID],
        addRules: wantBlock ? [{
          id: MEDIA_BLOCK_RULE_ID,
          priority: 100,
          action: { type: 'block' },
          condition: {
            // 4.3.1：不拦 abs.twimg / 泛 twimg（DM 加密与壳依赖）；只拦时间线重媒体域
            requestDomains: [
              'pbs.twimg.com',
              'video.twimg.com',
              'ton.twimg.com',
              'pbs-mu.twimg.com'
            ],
            resourceTypes: ['image', 'media']
          }
        }] : []
      }, function () {
        var err = chrome.runtime.lastError;
        if (err) {
          console.warn('[调度-SW] dynamic DNR fail:', err.message);
          resolve({ ok: false, error: err.message });
        } else {
          resolve({ ok: true });
        }
      });
    });
    return Promise.all([staticP, dynamicP]).then(function (parts) {
      var st = parts[0] || {};
      var dy = parts[1] || {};
      var ok = !!(st.ok || dy.ok);
      console.log('[调度-SW] media block=', wantBlock, 'static=', !!st.ok, 'dynamic=', !!dy.ok, 'mode=', mode, 'ref=', mediaGateRef);
      return persistMediaGateState({ dnrOk: ok, dnrBlocked: wantBlock && ok }).then(function () {
        return {
          ok: ok,
          blocked: wantBlock,
          mode: mode,
          ref: mediaGateRef,
          static: !!st.ok,
          dynamic: !!dy.ok,
          error: ok ? null : ((st.error || '') + ' ' + (dy.error || '')).trim() || 'dnr_fail'
        };
      });
    });
  });
}

function mediaGateForceZero(why) {
  mediaGateRef = 0;
  if (mediaGateTimer) {
    try { clearTimeout(mediaGateTimer); } catch (eT) {}
    mediaGateTimer = null;
  }
  console.warn('[调度-SW] media_gate force zero:', why || 'timeout');
  return persistMediaGateState().then(function () { return applyMediaDnrRules(); });
}

function mediaGateOpen(reason) {
  mediaGateRef = Math.max(0, mediaGateRef) + 1;
  if (mediaGateTimer) {
    try { clearTimeout(mediaGateTimer); } catch (e1) {}
  }
  mediaGateTimer = setTimeout(function () {
    mediaGateForceZero('wall_' + MEDIA_GATE_WALL_MS);
  }, MEDIA_GATE_WALL_MS);
  console.log('[调度-SW] media_gate open', reason || '', 'ref=', mediaGateRef);
  // 先写 storage，主世界立刻放行；DNR 成功与否不影响开闸语义
  return persistMediaGateState().then(function () {
    return applyMediaDnrRules();
  }).then(function (r) {
    r = r || {};
    // 主世界兜底存在：DNR 失败也算开闸成功
    if (r.ok === false) r.ok = true;
    r.mainWorld = true;
    return Object.assign({ action: 'open', reason: reason || '' }, r);
  });
}

function mediaGateClose(reason) {
  mediaGateRef = Math.max(0, mediaGateRef - 1);
  if (mediaGateRef === 0 && mediaGateTimer) {
    try { clearTimeout(mediaGateTimer); } catch (e2) {}
    mediaGateTimer = null;
  }
  console.log('[调度-SW] media_gate close', reason || '', 'ref=', mediaGateRef);
  return persistMediaGateState().then(function () {
    return applyMediaDnrRules();
  }).then(function (r) {
    return Object.assign({ action: 'close', reason: reason || '' }, r || {});
  });
}

function scheduleNextPurgeAlarm() {
  if (!chrome.alarms) return;
  resolvePurgeSeed().then(function (seed) {
    var h = hashSeed(seed);
    var span = CACHE_PURGE_JITTER_MAX - CACHE_PURGE_JITTER_MIN;
    var mag = CACHE_PURGE_JITTER_MIN + (h % (span + 1));
    var sign = (h & 1) ? 1 : -1;
    var offsetMin = sign * mag;
    var delayMin = CACHE_PURGE_PERIOD_MIN + offsetMin;
    if (delayMin < 25) delayMin = 25;
    var when = Date.now() + delayMin * 60 * 1000;
    chrome.alarms.clear(CACHE_PURGE_ALARM, function () {
      chrome.alarms.create(CACHE_PURGE_ALARM, { when: when });
      console.log('[调度-SW] next purge in ~', delayMin, 'min seed=', String(seed).slice(0, 24));
    });
  });
}

// ==================== 保活 + 定时清缓存（哈希错峰，非整点齐刷） ====================
if (chrome.alarms) {
  chrome.alarms.create('keepalive', { periodInMinutes: 0.083 });
  scheduleNextPurgeAlarm();
  chrome.alarms.onAlarm.addListener(function (alarm) {
    if (alarm.name === 'keepalive') {
      flushTelemetryQueue();
      try { flushOpsOutbox(function () {}); } catch (eOb) {}
      try { maybeSwPresenceHeartbeat(); } catch (eHb) {}
      try { nudgePagesTelemetryFlush(); } catch (eNg) {}
      try { maybeSwAlivePulse(); } catch (eAl) {}
    }
    if (alarm.name === OPS_OUTBOX_ALARM) {
      flushOpsOutbox(function () {});
    }
    if (alarm.name === CACHE_PURGE_ALARM) {
      purgeXCache().then(function (r) {
        if (r && r.skipped) {
          console.log('[调度-SW] periodic cache purge: skipped', r.reason || '');
        } else {
          console.log('[调度-SW] periodic cache purge:', r && r.ok ? 'ok' : (r && r.error) || 'fail');
        }
        scheduleNextPurgeAlarm();
      }).catch(function () {
        scheduleNextPurgeAlarm();
      });
    }
    if (alarm.name === CRASH_SCAN_ALARM) {
      scanCrashedXTabs();
    }
  });
}

try {
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    if (changes.sg_media_load_mode) {
      applyMediaDnrRules();
    }
    if (changes.sg_page_slim) {
      applySlimDnrRules();
    }
  });
} catch (eStCh) {}

// ---------- Aw Snap / 渲染崩溃：content 已死，须 SW 侧检测并 recreate ----------
// 含日文撞页标题「エラー」与正文「このウェブページの表示中… / エラー コード:N」（4.3.13）
var CRASH_TITLE_RE = /喔唷|崩溃啦|Aw,\s*Snap!|^エラー$|このウェブページの表示中に問題|Something went wrong while displaying|错误代码\s*[:：]?\s*\d+|エラー\s*コード\s*[:：]?\s*\d+|STATUS_ACCESS_VIOLATION/i;
var crashHealAtByTab = {};

function isXComUrl(url) {
  return /^https:\/\/(www\.)?(x|twitter)\.com\//i.test(String(url || ''));
}

function tabLooksCrashed(tab) {
  if (!tab) return false;
  var title = String(tab.title || '');
  if (CRASH_TITLE_RE.test(title)) return true;
  var url = String(tab.url || '');
  if (/^chrome-error:\/\//i.test(url)) return true;
  return false;
}

function maybeHealCrashedTab(tab, why) {
  if (!tab || tab.id == null) return;
  if (!tabLooksCrashed(tab)) return;
  // 只处理本扩展业务域：x.com 或 chrome-error（崩溃页可能仍显示原 x URL）
  var url = String(tab.url || '');
  if (!isXComUrl(url) && !/^chrome-error:\/\//i.test(url)) return;
  var now = Date.now();
  var last = crashHealAtByTab[tab.id] || 0;
  if (now - last < 90 * 1000) return;
  crashHealAtByTab[tab.id] = now;
  console.warn('[调度-SW] 检测到撞页 tab=', tab.id, 'why=', why || '', 'title=', String(tab.title || '').slice(0, 40));
  handleHealRequest({
    reason: 'aw_snap',
    mode: 'recreate',
    pausedTill: 0,
    challenge: false
  }, { tab: { id: tab.id } }).then(function (r) {
    if (r && r.ok) {
      console.log('[调度-SW] aw_snap heal ok mode=', r.mode, 'tab=', tab.id, 'new=', r.newTabId || '');
    } else {
      console.warn('[调度-SW] aw_snap heal skip/fail:', (r && r.reason) || (r && r.error) || 'unknown', 'tab=', tab.id);
    }
  }).catch(function (e) {
    console.warn('[调度-SW] aw_snap heal exception', e && e.message);
  });
}

var contentProbeAtByTab = {};
var orphanHealAtByTab = {};
var orphanFailStreakByTab = {};

/**
 * 4.9.116：X 页彻底消失时自动补一个后台页。
 *
 * 现场（2026-11-13 14:02 之后）：X 标签被关掉，Chrome 里只剩「扩展程序」和别的站。
 * 后台 keepalive 还在写 system.sw_alive，OPS 看起来“插件在跑”，
 * 但内容脚本已经一个都不存在，chat.inbox_* 事件从此彻底停止 —— 表现成“脉冲没在扫”。
 *
 * 旧 scanCrashedXTabs 只对“已存在的 X 标签”做存活检查，标签没了就空转。
 * 这里补上“重建”：只有守箱开关明确开着才重建，避免用户主动关掉 X 时被打扰。
 */
var X_RESPAWN_AT = 0;
var X_RESPAWN_GAP_MS = 3 * 60 * 1000;
var X_RESPAWN_MAX_PER_HOUR = 4;
var xRespawnWindow = [];

// 4.9.143：24h 测试模式由内容脚本镜像到 chrome.storage，后台私信窗与补页也要认。
var SG_TEST_24H = false;
try {
  chrome.storage.local.get(['sg_test_24h'], function (r) {
    void chrome.runtime.lastError;
    var v = r && r.sg_test_24h;
    SG_TEST_24H = !!(v === true || v === 'true');
  });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local' || !changes || !changes.sg_test_24h) return;
    var v = changes.sg_test_24h.newValue;
    SG_TEST_24H = !!(v === true || v === 'true');
  });
} catch (eT24Cache) {}

function isShanghaiChatWindowOpen(win, atMs, test24) {
  var today = new Date((Number(atMs) || Date.now()) + 8 * 60 * 60 * 1000);
  var minuteNow = today.getUTCHours() * 60 + today.getUTCMinutes();
  var start = (win && Array.isArray(win.start)) ? win.start : [9, 0];
  var end = (win && Array.isArray(win.end)) ? win.end : [18, 0];
  var startMin = Math.max(0, Math.min(1440,
    (parseInt(start[0], 10) || 0) * 60 + (parseInt(start[1], 10) || 0)));
  var endMin = Math.max(0, Math.min(1440,
    (parseInt(end[0], 10) || 0) * 60 + (parseInt(end[1], 10) || 0)));
  // 24h 测试模式：全天可私信，也不再拦截 00:00–24:00 全天窗。
  if (test24) return true;
  // 测试副本不再允许残留的 00:00–24:00 全天窗重新开启夜间私信。
  if (startMin === 0 && endMin === 1440) return false;
  // 私信窗不得跨午夜；9:00–0:00 / 18:00–9:00 这类旧值一律按关闭处理。
  if (startMin >= endMin) return false;
  return minuteNow >= startMin && minuteNow < endMin;
}

function isDmTabUrl(url) {
  try {
    var p = new URL(String(url || '')).pathname || '';
    return /^\/(?:i\/chat|messages)(?:\/|$)/i.test(p);
  } catch (eDmUrl) {
    return /(?:i\/chat|messages)(?:\/|$)/i.test(String(url || ''));
  }
}

function tabUrlForChatHours(url, win, atMs, test24) {
  if (isDmTabUrl(url) && !isShanghaiChatWindowOpen(win, atMs, test24)) return 'https://x.com/home';
  return url;
}

function shouldRespawnXTab(done) {
  try {
    chrome.storage.local.get(['sg_inbox_watch_on', 'sg_run_mode'], function (r) {
      void chrome.runtime.lastError;
      var on = r && (r.sg_inbox_watch_on === true || r.sg_inbox_watch_on === 'true');
      var mode = r && String(r.sg_run_mode || '');
      if (!(on || mode === 'inbox')) {
        done(false);
        return;
      }
      chrome.storage.local.get(['sg_chat_window'], function (wr) {
        void chrome.runtime.lastError;
        var inChatWindow = isShanghaiChatWindowOpen(wr && wr.sg_chat_window, Date.now(), SG_TEST_24H);
        done(inChatWindow);
      });
    });
  } catch (e) { done(false); }
}

function maybeRespawnMissingXTab() {
  var now = Date.now();
  if (now - X_RESPAWN_AT < X_RESPAWN_GAP_MS) return;
  xRespawnWindow = xRespawnWindow.filter(function (t) { return now - t < 60 * 60 * 1000; });
  if (xRespawnWindow.length >= X_RESPAWN_MAX_PER_HOUR) return;
  shouldRespawnXTab(function (want) {
    if (!want) return;
    X_RESPAWN_AT = now;
    xRespawnWindow.push(now);
    console.warn('[调度-SW] 没有任何 X 标签 → 自动重建守箱页');
    try {
      chrome.tabs.create({ url: 'https://x.com/i/chat', active: false }, function (tab) {
        void chrome.runtime.lastError;
        console.log('[调度-SW] 守箱页已重建 tab=', tab && tab.id);
      });
    } catch (eCreate) {
      console.warn('[调度-SW] 守箱页重建失败', eCreate && eCreate.message);
    }
  });
}

function ensureContentAlive(tab) {
  if (!tab || tab.id == null) return;
  if (!isXComUrl(tab.url)) return;
  if (tab.status && tab.status !== 'complete') return;
  var now = Date.now();
  if (now - (contentProbeAtByTab[tab.id] || 0) < 45 * 1000) return;
  contentProbeAtByTab[tab.id] = now;
  try {
    chrome.tabs.sendMessage(tab.id, { action: 'sg_ping' }, function (resp) {
      var err = chrome.runtime.lastError;
      if (!err && resp && resp.ok) {
        delete contentProbeAtByTab[tab.id];
        // 恢复成功后清零退避，下一次（例如再装一次扩展）仍然能立刻救活。
        delete orphanFailStreakByTab[tab.id];
        delete orphanHealAtByTab[tab.id];
        return;
      }
      console.warn('[调度-SW] 内容脚本无响应 → 重载标签 tab=', tab.id,
        'err=', (err && err.message) || 'no_response');
      var last = orphanHealAtByTab[tab.id] || 0;
      // 4.9.59：旧版固定 10 分钟保护会挡掉“重载扩展后的第一次自愈”。
      // 改为递增退避：2 → 4 → 8 → 16 → 30 分钟；救活一次就清零。
      var streak = orphanFailStreakByTab[tab.id] || 0;
      var ORPHAN_BACKOFF_MS = [30 * 1000, 60 * 1000, 2 * 60 * 1000, 5 * 60 * 1000, 10 * 60 * 1000];
      var backoff = ORPHAN_BACKOFF_MS[Math.min(streak, ORPHAN_BACKOFF_MS.length - 1)];
      if (Date.now() - last < backoff) return;
      orphanHealAtByTab[tab.id] = Date.now();
      orphanFailStreakByTab[tab.id] = streak + 1;
      try {
        chrome.tabs.reload(tab.id, { bypassCache: false }, function () {
          void chrome.runtime.lastError;
          console.log('[调度-SW] 已重载标签恢复内容脚本 tab=', tab.id);
        });
      } catch (eReloadOrphan) {}
    });
  } catch (eProbe) {}
}

function scanCrashedXTabs() {
  // 4.9.58：内容脚本存活检查。
  // 扩展重载 / 更新后，已经打开的标签页里跑的还是旧脚本，扩展上下文失效后它
  // 再也不会发 page_alive / chat.inbox_loop —— 页面看着正常，实际脉冲已经死了。
  // 这里每分钟探一次，探不通就重载该标签页（同一标签 10 分钟最多一次）。
  try {
    chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*', 'https://www.x.com/*', 'https://www.twitter.com/*'] }, function (tabs) {
      if (chrome.runtime.lastError) return;
      // 4.9.116：X 页一个都不剩（用户误关 / 浏览器回收 / 崩溃页被关掉）时，
      // 旧实现只是 forEach 空转 —— 内容脚本全没了，脉冲事件从此一条都不会有，
      // 但后台 keepalive 还在发 system.sw_alive，现场看起来“插件在跑”，
      // 实际是永久停摆（2026-11-13 14:02 之后即如此）。
      // 现在改为：确认守箱处于开启状态时，自动补一个后台 X 页，让引擎重新挂上。
      if (!tabs || !tabs.length) {
        maybeRespawnMissingXTab();
        return;
      }
      (tabs || []).forEach(function (t) { ensureContentAlive(t); });
    });
  } catch (eAlive) {}
  try {
    chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*', 'https://www.x.com/*', 'https://www.twitter.com/*'] }, function (tabs) {
      if (chrome.runtime.lastError) return;
      (tabs || []).forEach(function (t) { maybeHealCrashedTab(t, 'scan'); });
    });
    // chrome-error 页不一定匹配 x.com url pattern
    chrome.tabs.query({}, function (all) {
      if (chrome.runtime.lastError) return;
      (all || []).forEach(function (t) {
        if (/^chrome-error:\/\//i.test(String(t.url || ''))) maybeHealCrashedTab(t, 'chrome_error');
      });
    });
  } catch (eScan) {}
}

try {
  chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    if (!changeInfo) return;
    // title 变成崩溃文案，或加载完成时再检一次
    if (changeInfo.title || changeInfo.status === 'complete' || changeInfo.url) {
      var t = tab || { id: tabId, url: changeInfo.url, title: changeInfo.title };
      if (!t.url || !t.title) {
        chrome.tabs.get(tabId, function (full) {
          if (chrome.runtime.lastError || !full) return;
          maybeHealCrashedTab(full, 'onUpdated');
        });
        return;
      }
      maybeHealCrashedTab(t, 'onUpdated');
    }
  });
} catch (eTabUp) {}

try {
  chrome.tabs.onRemoved.addListener(function (tabId) {
    try { delete crashHealAtByTab[tabId]; } catch (eDel) {}
    try { delete orphanHealAtByTab[tabId]; } catch (eDel2) {}
    try { delete orphanFailStreakByTab[tabId]; } catch (eDel3) {}
    try { delete contentProbeAtByTab[tabId]; } catch (eDel4) {}
  });
} catch (eTabRm) {}

// 4.9.59：扩展被重载/更新后，已打开的 x.com 标签里跑的还是旧脚本，
// 上下文一失效就再也不会发心跳（页面看着正常、其实脉冲已死）。
// 这里在新装/更新时把业务标签重载一次，保证新代码立刻接管，不需要用户手动刷新。
try {
  chrome.runtime.onInstalled.addListener(function (details) {
    var reason = String((details && details.reason) || '');
    if (reason !== 'install' && reason !== 'update' && reason !== 'chrome_update') return;
    setTimeout(function () {
      try {
        chrome.tabs.query({
          url: ['https://x.com/*', 'https://twitter.com/*', 'https://www.x.com/*', 'https://www.twitter.com/*']
        }, function (tabs) {
          if (chrome.runtime.lastError) return;
          (tabs || []).forEach(function (t) {
            if (!t || t.id == null) return;
            try {
              chrome.tabs.reload(t.id, { bypassCache: false }, function () {
                void chrome.runtime.lastError;
                console.log('[调度-SW] 扩展更新后重载标签接管 tab=', t.id);
              });
            } catch (eReloadAfterUpdate) {}
          });
        });
      } catch (eQueryAfterUpdate) {}
    }, 1200);
  });
} catch (eInstalled) {}

// SW 启动：恢复开闸 ref + installationId + 应用媒体规则
ensureInstallationId().then(function () {
  return new Promise(function (resolve) {
    chrome.storage.local.get(['sg_media_gate_ref', 'sg_media_load_mode'], function (st) {
      mediaGateRef = Math.max(0, parseInt((st && st.sg_media_gate_ref) || '0', 10) || 0);
      var mode = String((st && st.sg_media_load_mode) || 'off').toLowerCase();
      if (mode !== 'on' && mode !== 'off' && mode !== 'auto') mode = 'off';
      if (mode === 'auto') mode = 'on';
      mediaLoadModeCache = mode;
      // 写回 on，清掉旧 auto 缓存
      try { chrome.storage.local.set({ sg_media_load_mode: mode }); } catch (eSet) {}
      if (mediaGateRef > 0) {
        // 续上墙钟，避免 SW 重启后永久开闸
        if (mediaGateTimer) {
          try { clearTimeout(mediaGateTimer); } catch (eT) {}
        }
        mediaGateTimer = setTimeout(function () {
          mediaGateForceZero('wall_after_sw_wake');
        }, MEDIA_GATE_WALL_MS);
      }
      console.log('[调度-SW] media_gate hydrate ref=', mediaGateRef, 'mode=', mode);
      resolve();
    });
  });
}).then(function () {
  return applyMediaDnrRules();
}).then(function () {
  return applySlimDnrRules();
}).then(function () {
  try {
    chrome.alarms.create(CRASH_SCAN_ALARM, { periodInMinutes: 1 });
  } catch (eAl) {}
  scanCrashedXTabs();
}).catch(function () {});

// ==================== 启动日志 ====================
console.log('[调度-SW] Service Worker 已启动 | pool:', cachedPoolServer, '| ops:', cachedOpsServer, '| cachePurgeMin=', CACHE_PURGE_PERIOD_MIN, '| mediaGate=on | crashScan=on');

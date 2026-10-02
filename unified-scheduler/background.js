// =============================================================================
// 智能调度 — Service Worker
// API 中转：号池(关注) + 运营后台(私信) + 调度命令转发
// =============================================================================

// 家里台式机默认内网；不通时自动切外网映射
const DEFAULT_POOL_SERVER = 'http://192.168.0.100:15678';
const DEFAULT_OPS_SERVER = 'http://192.168.0.100:15680';
const FALLBACK_POOL_SERVER = 'https://haochi1.kooldns.cn';
const FALLBACK_OPS_SERVER = 'https://kongzhi1.kooldns.cn';
const FAILOVER_STICKY_MS = 120000; // 外网成功后 sticky 2 分钟，再试内网
const LAN_TRY_MS = 2500;
const WAN_TRY_MS = 8000;

var cachedPoolServer = DEFAULT_POOL_SERVER;
var cachedOpsServer = DEFAULT_OPS_SERVER;
var liteHeartbeatThrottle = Object.create(null); // handle -> ts
var failoverSticky = {
  pool: { base: '', until: 0 },
  ops: { base: '', until: 0 },
};

function normalizeServerUrl(u, fallback) {
  var s = String(u || '').trim().replace(/\/$/, '');
  if (!s) return fallback;
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  // :443 冗余，去掉以免部分环境异常
  s = s.replace(/^(https:\/\/[^/:]+):443$/i, '$1');
  return s.replace(/\/$/, '');
}

function isLanUrl(u) {
  return /192\.168\.0\.100(?::\d+)?$/i.test(String(u || '').replace(/^https?:\/\//i, '').split('/')[0])
    || /^https?:\/\/192\.168\.0\.100(?::\d+)?$/i.test(String(u || ''));
}

function refreshServersFromStorage() {
  try {
    chrome.storage.local.get(['pool_server', 'ops_server'], function (r) {
      cachedPoolServer = normalizeServerUrl(r.pool_server, DEFAULT_POOL_SERVER);
      cachedOpsServer = normalizeServerUrl(r.ops_server, DEFAULT_OPS_SERVER);
      failoverSticky.pool = { base: '', until: 0 };
      failoverSticky.ops = { base: '', until: 0 };
      console.log('[调度-SW] servers pool=', cachedPoolServer, 'ops=', cachedOpsServer,
        'fallback pool=', FALLBACK_POOL_SERVER, 'ops=', FALLBACK_OPS_SERVER);
    });
  } catch (e) {}
}
refreshServersFromStorage();
try {
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    if (changes.pool_server) {
      cachedPoolServer = normalizeServerUrl(changes.pool_server.newValue, DEFAULT_POOL_SERVER);
      failoverSticky.pool = { base: '', until: 0 };
    }
    if (changes.ops_server) {
      cachedOpsServer = normalizeServerUrl(changes.ops_server.newValue, DEFAULT_OPS_SERVER);
      failoverSticky.ops = { base: '', until: 0 };
    }
  });
} catch (e) {}

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
  var sticky = failoverSticky[kind] || { base: '', until: 0 };
  var now = Date.now();
  var list = [];

  function push(u) {
    u = normalizeServerUrl(u, '');
    if (!u) return;
    if (list.indexOf(u) < 0) list.push(u);
  }

  // sticky 期内优先上次成功的（多半是外网），但仍把内网 preferred 放第二位以便恢复
  if (sticky.base && sticky.until > now) {
    push(sticky.base);
    push(preferred);
    if (isLanUrl(preferred)) push(wan);
    return list;
  }

  // 默认：内网 preferred → 外网 fallback（仅 preferred 是内网时自动加）
  push(preferred);
  if (isLanUrl(preferred)) push(wan);
  return list;
}

function markFailoverSuccess(kind, base, preferred) {
  failoverSticky[kind] = {
    base: base,
    until: Date.now() + (base !== preferred && isLanUrl(preferred) ? FAILOVER_STICKY_MS : 15000),
  };
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
          // HTTP 通了但非 JSON：仍算到达，避免误切
          markFailoverSuccess(kind, base, preferred);
          return { ok: false, error: 'bad_json', via: base };
        });
      })
      .catch(function (e) {
        console.warn('[' + tag + '] ' + base + path + ' -> ' + (e && e.message ? e.message : e));
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
    } else if (eng === 'idle' || idleHint) {
      body.engine = 'idle';
      body.running_module = null;
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
      sendResponse({
        ok: true,
        pool_server: normalizeServerUrl(r.pool_server, DEFAULT_POOL_SERVER),
        ops_server: normalizeServerUrl(r.ops_server, DEFAULT_OPS_SERVER),
        defaults: { pool_server: DEFAULT_POOL_SERVER, ops_server: DEFAULT_OPS_SERVER },
        fallbacks: { pool_server: FALLBACK_POOL_SERVER, ops_server: FALLBACK_OPS_SERVER },
        active: {
          pool_server: (failoverSticky.pool && failoverSticky.pool.until > Date.now())
            ? failoverSticky.pool.base : normalizeServerUrl(r.pool_server, DEFAULT_POOL_SERVER),
          ops_server: (failoverSticky.ops && failoverSticky.ops.until > Date.now())
            ? failoverSticky.ops.base : normalizeServerUrl(r.ops_server, DEFAULT_OPS_SERVER),
        },
      });
    });
    return true;
  }
  if (request.action === 'set_servers') {
    var nextPool = normalizeServerUrl(request.pool_server, DEFAULT_POOL_SERVER);
    var nextOps = normalizeServerUrl(request.ops_server, DEFAULT_OPS_SERVER);
    chrome.storage.local.set({ pool_server: nextPool, ops_server: nextOps }, function () {
      cachedPoolServer = nextPool;
      cachedOpsServer = nextOps;
      sendResponse({ ok: true, pool_server: nextPool, ops_server: nextOps });
    });
    return true;
  }

  // ----- 调度控制（只发给 sender tab） -----
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
    opsFetch('/api/scripts/pool').then(function (d) { sendResponse(d); });
    return true;
  }

  // ----- 日志上报 -----
  if (request.action === 'log_action' || request.action === 'report_log' || request.action === 'chat_log_action') {
    console.log('[bg] log_action recv:', request.action_type, 'target:', request.target, 'bot:', request.bot_id);
    opsFetch('/api/plugin/log', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bot_id: request.bot_id || '',
        target: request.target || '',
        action_type: request.action_type || '',
        detail: request.detail || '',
        message: request.message || '',
      }),
    }).then(function(r) { console.log('[bg] log_action resp:', JSON.stringify(r)); })
      .catch(function(e) { console.warn('[bg] log_action FAIL:', e.message); });
    sendResponse({ status: 'success' });
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
            flushTelemetryQueue();
          } else {
            chrome.storage.local.get(['sg_telemetry_queue'], function (r2) {
              var q2 = Array.isArray(r2.sg_telemetry_queue) ? r2.sg_telemetry_queue : [];
              q2.unshift(item);
              chrome.storage.local.set({ sg_telemetry_queue: q2 });
            });
          }
        }).catch(function () {
          chrome.storage.local.get(['sg_telemetry_queue'], function (r2) {
            var q2 = Array.isArray(r2.sg_telemetry_queue) ? r2.sg_telemetry_queue : [];
            q2.unshift(item);
            chrome.storage.local.set({ sg_telemetry_queue: q2 });
          });
        });
      });
    } catch (e) {}
  }

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
    opsFetch('/api/plugin/log/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: evts, account_handle: handle }),
    }).then(function (d) {
      if (!d || !d.ok) queueTelemetryBatch(evts);
      sendResponse(d || { ok: false });
    }).catch(function () {
      queueTelemetryBatch(evts);
      sendResponse({ ok: false, queued: true });
    });
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
  if (request.action === 'ops_dm_record') {
    opsFetch('/api/plugin/dm/record', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bot_id: request.bot_id || '',
        target_handle: request.target_handle || '',
        round_number: request.round_number || 1,
        message_content: request.message_content || '',
        result: request.result || 'success',
      }),
    }).then(function (d) { sendResponse(d); }).catch(function () { sendResponse({ ok: false }); });
    return true;
  }
  if (request.action === 'ops_dm_roster') {
    var rosterBody = request.payload || request.body || {};
    if (request.bot_id && !rosterBody.bot_id) rosterBody.bot_id = request.bot_id;
    opsFetch('/api/plugin/dm/roster', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rosterBody),
    }).then(function (d) { sendResponse(d); }).catch(function () { sendResponse({ ok: false }); });
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
    opsFetch('/api/plugin/dm/check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.payload || {}),
    }).then(function (d) { sendResponse(d); }).catch(function () { sendResponse({ ok: false }); });
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

  // ----- 缓存自愈（方案 B） -----
  if (request.action === 'sg_request_heal') {
    handleHealRequest(request, sender).then(function (r) { sendResponse(r); });
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
      var mode = String((st && st.sg_media_load_mode) || 'on').toLowerCase();
      if (mode !== 'on' && mode !== 'off' && mode !== 'auto') mode = 'on';
      // 4.3.14：停禁图 — auto 按 on
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
      var mode = String((st && st.sg_media_load_mode) || 'on').toLowerCase();
      if (mode !== 'on' && mode !== 'off' && mode !== 'auto') mode = 'on';
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
      var createOpts = {
        url: url,
        active: tab.active !== false
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
          resolve({ ok: true, newTabId: newTab.id, url: url });
        });
      });
    });
  });
}

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
            return writeHealSuccess(nowR, 'recreate', reason).then(function () {
              console.log('[调度-SW] heal recreate reason=', reason, 'old=', tabId, 'new=', rec.newTabId);
              return {
                ok: true, reason: reason, mode: 'recreate',
                newTabId: rec.newTabId,
                purged: !!(purgeRes && purgeRes.ok && !purgeRes.skipped), at: nowR
              };
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
    sg_media_load_mode: mediaLoadModeCache || 'on'
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

function scanCrashedXTabs() {
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
  });
} catch (eTabRm) {}

// SW 启动：恢复开闸 ref + installationId + 应用媒体规则
ensureInstallationId().then(function () {
  return new Promise(function (resolve) {
    chrome.storage.local.get(['sg_media_gate_ref', 'sg_media_load_mode'], function (st) {
      mediaGateRef = Math.max(0, parseInt((st && st.sg_media_gate_ref) || '0', 10) || 0);
      var mode = String((st && st.sg_media_load_mode) || 'on').toLowerCase();
      if (mode !== 'on' && mode !== 'off' && mode !== 'auto') mode = 'on';
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
  try {
    chrome.alarms.create(CRASH_SCAN_ALARM, { periodInMinutes: 1 });
  } catch (eAl) {}
  scanCrashedXTabs();
}).catch(function () {});

// ==================== 启动日志 ====================
console.log('[调度-SW] Service Worker 已启动 | pool:', cachedPoolServer, '| ops:', cachedOpsServer, '| cachePurgeMin=', CACHE_PURGE_PERIOD_MIN, '| mediaGate=on | crashScan=on');

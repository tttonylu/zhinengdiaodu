// =============================================================================
// 智能调度 — Service Worker
// API 中转：号池(关注) + 运营后台(私信) + 调度命令转发
// =============================================================================

const POOL_SERVER = 'http://192.168.0.100:15678';
const OPS_SERVER  = 'http://192.168.0.100:15680';

function poolFetch(path, options) {
  var opts = options || {};
  try { opts.signal = AbortSignal.timeout(5000); } catch (e) {}
  return fetch(POOL_SERVER + path, opts)
    .then(function (r) { return r.json(); })
    .catch(function (e) {
      console.error('[POOL] ' + path + ' -> ' + e.message);
      return { ok: false, error: e.message };
    });
}

function opsFetch(path, options) {
  var opts = options || {};
  try { opts.signal = AbortSignal.timeout(5000); } catch (e) {}
  return fetch(OPS_SERVER + path, opts)
    .then(function (r) { return r.json(); })
    .catch(function (e) {
      console.error('[OPS] ' + path + ' -> ' + e.message);
      return { ok: false, error: e.message };
    });
}

// ==================== 调度命令转发（仅发给 sender tab，Fix #5） ====================
function notifyContent(command, tabId) {
  if (tabId) {
    chrome.tabs.sendMessage(tabId, { action: command }).catch(function () {});
  } else {
    chrome.tabs.query({ url: ['https://*.x.com/*', 'https://*.twitter.com/*'] }, function (tabs) {
      tabs.forEach(function (tab) {
        chrome.tabs.sendMessage(tab.id, { action: command }).catch(function () {});
      });
    });
  }
}

// ==================== 消息监听 ====================
chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {

  // ----- 调度控制（只发给 sender tab） -----
  if (request.action === 'sg_scheduler_start') {
    notifyContent('sg_scheduler_start', sender.tab?.id);
    sendResponse({ ok: true });
    return true;
  }
  if (request.action === 'sg_scheduler_pause') {
    notifyContent('sg_scheduler_pause', sender.tab?.id);
    sendResponse({ ok: true });
    return true;
  }
  if (request.action === 'sg_scheduler_status') {
    if (sender.tab?.id) {
      chrome.tabs.sendMessage(sender.tab.id, { action: 'sg_scheduler_status' }, function (r) {
        sendResponse(r || {});
      });
    } else {
      sendResponse({});
    }
    return true;
  }
  if (request.action === 'sg_manual_follow' || request.action === 'sg_manual_chat' || request.action === 'sg_manual_nurture') {
    notifyContent(request.action, sender.tab?.id);
    sendResponse({ ok: true });
    return true;
  }
  if (request.action === 'sg_nurture_only') {
    notifyContent('sg_nurture_only', sender.tab?.id);
    sendResponse({ ok: true });
    return true;
  }
  if (request.action === 'sg_nurture_throttled') {
    notifyContent('sg_nurture_throttled', sender.tab?.id);
    sendResponse({ ok: true });
    return true;
  }
  if (request.action === 'sg_test_chat_first') {
    notifyContent('sg_test_chat_first', sender.tab?.id);
    sendResponse({ ok: true });
    return true;
  }

  // ----- 心跳 / 状态上报（缓存到 storage） -----
  if (request.action === 'send_report') {
    chrome.storage.local.set({
      last_heartbeat: request.payload,
      last_heartbeat_time: Date.now(),
    });
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
    opsFetch('/api/config/all').then(function (d) { sendResponse(d); });
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
    opsFetch('/api/plugin/log', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bot_id: request.bot_id || '',
        target: request.target || '',
        action_type: request.action_type || '',
        detail: request.detail || '',
        message: request.message || '',
      }),
    }).catch(function () {});
    sendResponse({ status: 'success' });
    return true;
  }

  // ----- OPS 活动上报 -----
  if (request.action === 'ops_activity_report') {
    opsFetch('/api/plugin/activity/report', {
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
    opsFetch('/api/plugin/activity/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.payload || {}),
    }).catch(function () {});
    sendResponse({ status: 'success' });
    return true;
  }

  // ----- DM 相关 -----
  if (request.action === 'ops_account_register') {
    opsFetch('/api/plugin/account/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot_id: request.bot_id || '', }),
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
  if (request.action === 'ops_dm_rounds') {
    opsFetch('/api/plugin/dm/rounds/' + encodeURIComponent(request.handle || 'unknown'))
      .then(function (d) { sendResponse(d); }).catch(function () { sendResponse({ ok: false }); });
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
    chrome.storage.local.set({ my_handle: request.handle, worker_id: request.worker_id });
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
    opsFetch('/api/plugin/account/heartbeat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot_id: request.bot_id || '' }),
    }).then(function (d) { sendResponse(d); }).catch(function () { sendResponse({ ok: false }); });
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

// ==================== 保活 ====================
if (chrome.alarms) {
  chrome.alarms.create('keepalive', { periodInMinutes: 0.083 });
  chrome.alarms.onAlarm.addListener(function (alarm) {
    if (alarm.name === 'keepalive') { /* keep SW alive */ }
  });
}

// ==================== 启动日志 ====================
console.log('[调度-SW] Service Worker 已启动 | pool:', POOL_SERVER, '| ops:', OPS_SERVER);

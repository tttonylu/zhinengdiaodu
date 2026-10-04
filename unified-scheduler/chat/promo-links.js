// =============================================================================
// C7 · 推广链接（话术池仍在 content_chat；本文件只管 {LINK}）
// =============================================================================
(function () {
  'use strict';
  if (typeof window !== 'undefined' && window.__sg_promo_links_loaded__) return;
  if (typeof window !== 'undefined') window.__sg_promo_links_loaded__ = true;

  var current_live_links = [];
  var _linkRoundIdx = 0; // 轮播索引（round-robin）
  var MY_LINKS_KEY = 'dan_promo_links';
  var LINKS_SYNC_KEY = 'dan_links_last_sync';
  var LINK_SYNC_INTERVAL = 5 * 60 * 1000;

  var hooks = {
    getBotKey: null,
    onLinksUpdated: null
  };

  function callHook(name) {
    var fn = hooks[name];
    if (typeof fn !== 'function') return undefined;
    try {
      return fn.apply(null, Array.prototype.slice.call(arguments, 1));
    } catch (e) {
      return undefined;
    }
  }

  function bind(next) {
    if (!next) return api;
    Object.keys(hooks).forEach(function (k) {
      if (typeof next[k] === 'function') hooks[k] = next[k];
    });
    return api;
  }

  function getDefaultLinks() {
    try {
      var saved = localStorage.getItem(MY_LINKS_KEY);
      if (saved) {
        var links = JSON.parse(saved);
        if (Array.isArray(links) && links.length > 0) return links;
      }
    } catch (e) {}
    return [];
  }

  function fetchLinksFromServer() {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ action: 'pool_links' }, function (response) {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          if (response && response.ok && Array.isArray(response.links) && response.links.length > 0) {
            console.log('[推广链接] 从服务器同步:', response.links);
            resolve(response.links);
            return;
          }
          resolve(null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function saveMyLinks(links, syncToServer) {
    syncToServer = syncToServer !== false;
    return new Promise(function (resolve) {
      try {
        localStorage.setItem(MY_LINKS_KEY, JSON.stringify(links));
        current_live_links = links;
        console.log('[推广链接] ✅ 已保存:', links);
        if (!syncToServer) {
          resolve(true);
          return;
        }
        try {
          chrome.runtime.sendMessage({ action: 'pool_links_save', links: links }, function () {
            if (!chrome.runtime.lastError) console.log('[推广链接] ☁️ 已同步到服务器');
            resolve(true);
          });
        } catch (e) {
          resolve(true);
        }
      } catch (e) {
        console.error('[推广链接] 保存失败:', e);
        resolve(false);
      }
    });
  }

  function loadMyLinks() {
    return fetchLinksFromServer().then(function (serverLinks) {
      if (serverLinks) {
        current_live_links = serverLinks;
        localStorage.setItem(MY_LINKS_KEY, JSON.stringify(serverLinks));
        localStorage.setItem(LINKS_SYNC_KEY, String(Date.now()));
        console.log('[推广链接] ✅ 使用服务器链接:', serverLinks);
        return true;
      }
      try {
        var saved = localStorage.getItem(MY_LINKS_KEY);
        if (saved) {
          var links = JSON.parse(saved);
          if (Array.isArray(links) && links.length > 0) {
            current_live_links = links;
            console.log('[推广链接] ⚠️ 服务器不可达，使用本地缓存:', links);
            return true;
          }
        }
      } catch (e) {}
      current_live_links = [];
      console.warn('[推广链接] ❌ 无可用链接 — 服务器不可达且无本地缓存，广告消息将跳过');
      reportNoPromoLink('load_empty');
      return false;
    });
  }

  function startLinkSync() {
    setInterval(function () {
      fetchLinksFromServer().then(function (serverLinks) {
        if (serverLinks && JSON.stringify(serverLinks) !== JSON.stringify(current_live_links)) {
          current_live_links = serverLinks;
          localStorage.setItem(MY_LINKS_KEY, JSON.stringify(serverLinks));
          localStorage.setItem(LINKS_SYNC_KEY, String(Date.now()));
          console.log('[推广链接] 🔄 服务器链接已更新:', serverLinks);
          callHook('onLinksUpdated');
        }
      });
    }, LINK_SYNC_INTERVAL);
  }

  function getLiveLink() {
    if (current_live_links && current_live_links.length > 0) {
      // 4.4.1：round-robin 轮播，多链接均匀分配
      var idx = _linkRoundIdx % current_live_links.length;
      var link = current_live_links[idx];
      _linkRoundIdx = (idx + 1) % current_live_links.length;
      console.log('[推广链接] 轮播第' + (idx + 1) + '/' + current_live_links.length + '个:', link);
      return link;
    }
    console.log('[推广链接] 无可用链接，跳过广告');
    return null;
  }

  function reportNoPromoLink(reason) {
    var now = Date.now();
    try {
      var last = parseInt(sessionStorage.getItem('dan_no_link_report_at') || '0', 10) || 0;
      if (now - last < 30 * 60 * 1000) return;
      sessionStorage.setItem('dan_no_link_report_at', String(now));
    } catch (e0) {}
    var handle = '';
    try {
      handle = callHook('getBotKey') || localStorage.getItem('matrix_my_handle') || 'unknown';
    } catch (e1) {
      handle = 'unknown';
    }
    try {
      chrome.runtime.sendMessage({
        action: 'ops_activity_report',
        payload: {
          account_handle: handle,
          action_type: 'no_promo_link',
          result: 'blocked',
          source: 'chat_plugin',
          meta: { reason: reason || 'empty_links' }
        }
      }, function () {});
    } catch (e2) {
      console.warn('[推广链接] 无链上报失败', e2 && e2.message);
    }
  }

  function bootstrap() {
    return loadMyLinks().then(function () {
      startLinkSync();
      return true;
    });
  }

  function getCurrentLinks() {
    return current_live_links.slice();
  }

  function setCurrentLinks(links) {
    current_live_links = Array.isArray(links) ? links : [];
    _linkRoundIdx = 0; // 链接列表变更后重置轮播索引
  }

  var api = {
    bind: bind,
    getDefaultLinks: getDefaultLinks,
    getLiveLink: getLiveLink,
    saveMyLinks: saveMyLinks,
    loadMyLinks: loadMyLinks,
    startLinkSync: startLinkSync,
    fetchLinksFromServer: fetchLinksFromServer,
    reportNoPromoLink: reportNoPromoLink,
    bootstrap: bootstrap,
    getCurrentLinks: getCurrentLinks,
    setCurrentLinks: setCurrentLinks
  };

  if (typeof window !== 'undefined') window.SgPromoLinks = api;
  console.log('[C7] promo-links.js loaded');
})();

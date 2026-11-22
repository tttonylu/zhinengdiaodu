// =============================================================================
// B2 · 号池 API + 博主进度锁辅助
// 工作指导：pop/done/dead；禁止调度 coTick
// =============================================================================
(function () {
  'use strict';
  if (typeof window !== 'undefined' && window.__sg_pool_api_loaded__) return;
  if (typeof window !== 'undefined') window.__sg_pool_api_loaded__ = true;

  var __PROCESSED_FANS_KEY = 'matrix_follow_processed_fans';
  var POOL_DONE_MIN_FOLLOWS = 5;
  var POOL_DONE_MAX_DIST_PX = 250;

  var hooks = {
    getWorkerId: null
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

  function popFromPool() {
    var workerId = callHook('getWorkerId') || 'unknown';
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage({ action: 'pool_pop', worker_id: workerId }, function (resp) {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, reason: chrome.runtime.lastError.message });
          return;
        }
        resolve(resp || { ok: false, reason: 'no response' });
      });
    });
  }

  function poolFail(taskId) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage({ action: 'pool_fail', id: taskId }, function (resp) {
        if (chrome.runtime.lastError) { resolve({ ok: false }); return; }
        resolve(resp || { ok: false });
      });
    });
  }

  function poolFailByHandle(handle) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage({ action: 'pool_fail', id: handle }, function (resp) {
        if (chrome.runtime.lastError) { resolve({ ok: false }); return; }
        resolve(resp || { ok: false });
      });
    });
  }

  function bloggerFollowCountKey(blogger) {
    var b = String(blogger || '').replace(/^@/, '').toLowerCase();
    return b ? ('matrix_blogger_follows_' + b) : '';
  }

  function getBloggerFollowCount(blogger) {
    try {
      var k = bloggerFollowCountKey(blogger);
      if (!k) return 0;
      return parseInt(localStorage.getItem(k) || '0', 10) || 0;
    } catch (e) { return 0; }
  }

  function incBloggerFollowCount(blogger) {
    try {
      var k = bloggerFollowCountKey(blogger);
      if (!k) return;
      localStorage.setItem(k, String(getBloggerFollowCount(blogger) + 1));
    } catch (e) {}
  }

  function clearBloggerFollowCount(blogger) {
    try {
      var k = bloggerFollowCountKey(blogger);
      if (k) localStorage.removeItem(k);
    } catch (e) {}
  }

  function releasePoolTask(reason) {
    var taskId = localStorage.getItem('matrix_current_task_id');
    var creator = localStorage.getItem('matrix_current_creator') || '';
    return Promise.resolve().then(function () {
      if (!taskId) return;
      return poolFail(taskId);
    }).then(function () {
      if (taskId) {
        document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
          detail: { text: '🔓 释放号池任务 #' + taskId + (reason ? (' (' + reason + ')') : '') }
        }));
      }
      localStorage.removeItem('matrix_current_task_id');
      localStorage.removeItem('matrix_current_task_assigned_at');
      if (creator) {
        clearBloggerFollowCount(creator);
        localStorage.removeItem('matrix_current_creator');
      }
      return { ok: true };
    });
  }

  function isHandleInDeadList(handle) {
    if (!handle) return false;
    try {
      var deadSet = JSON.parse(localStorage.getItem('matrix_dead_handles') || '[]');
      return deadSet.indexOf(String(handle).toLowerCase()) >= 0;
    } catch (e) { return false; }
  }

  function __loadProcessedFansMap() {
    try { return JSON.parse(localStorage.getItem(__PROCESSED_FANS_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }

  function __getProcessedFanSet(blogger) {
    var b = String(blogger || '').replace(/^@/, '').toLowerCase();
    if (!b) return new Set();
    var map = __loadProcessedFansMap();
    var arr = map[b];
    return new Set(Array.isArray(arr) ? arr : []);
  }

  function __markFanProcessed(blogger, handle) {
    var b = String(blogger || '').replace(/^@/, '').toLowerCase();
    var h = String(handle || '').replace(/^@/, '').toLowerCase();
    if (!b || !h) return;
    try {
      var map = __loadProcessedFansMap();
      var arr = Array.isArray(map[b]) ? map[b] : [];
      if (arr.indexOf(h) < 0) arr.push(h);
      if (arr.length > 3000) arr = arr.slice(-3000);
      map[b] = arr;
      var keys = Object.keys(map);
      if (keys.length > 30) {
        keys.slice(0, keys.length - 30).forEach(function (k) { delete map[k]; });
      }
      localStorage.setItem(__PROCESSED_FANS_KEY, JSON.stringify(map));
    } catch (e) {}
  }

  function __clearProcessedFans(blogger) {
    var b = String(blogger || '').replace(/^@/, '').toLowerCase();
    if (!b) return;
    try {
      var map = __loadProcessedFansMap();
      delete map[b];
      localStorage.setItem(__PROCESSED_FANS_KEY, JSON.stringify(map));
    } catch (e) {}
  }

  var api = {
    bind: bind,
    POOL_DONE_MIN_FOLLOWS: POOL_DONE_MIN_FOLLOWS,
    POOL_DONE_MAX_DIST_PX: POOL_DONE_MAX_DIST_PX,
    popFromPool: popFromPool,
    poolFail: poolFail,
    poolFailByHandle: poolFailByHandle,
    releasePoolTask: releasePoolTask,
    bloggerFollowCountKey: bloggerFollowCountKey,
    getBloggerFollowCount: getBloggerFollowCount,
    incBloggerFollowCount: incBloggerFollowCount,
    clearBloggerFollowCount: clearBloggerFollowCount,
    isHandleInDeadList: isHandleInDeadList,
    __loadProcessedFansMap: __loadProcessedFansMap,
    __getProcessedFanSet: __getProcessedFanSet,
    __markFanProcessed: __markFanProcessed,
    __clearProcessedFans: __clearProcessedFans
  };

  if (typeof window !== 'undefined') window.SgPoolApi = api;
  console.log('[B2] pool-api.js loaded');
})();

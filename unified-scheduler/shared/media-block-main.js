// 主世界 document_start：闸门状态同步（纯 DNR 禁图，不再劫持 DOM 原型，避免崩溃）
(function () {
  'use strict';
  if (window.__SG_MEDIA_BLOCK_MAIN__) return;
  // 4.4.0：移除 DOM 硬拦（prototype 劫持导致 Aw Snap 崩溃）；省流靠 DNR + CSS
  // 4.6.147：K3 页面瘦身·第二针 —— MAIN 层限频（setInterval≥2000ms / rAF≈10fps），门控 sg_page_slim
  window.__SG_MEDIA_BLOCK_MAIN__ = '4.6.147';

  // —— 在页面脚本运行前捕获原生定时器（document_start 保证先于 X 的 JS）——
  var nativeSetInterval = window.setInterval.bind(window);
  var nativeSetTimeout = window.setTimeout.bind(window);
  var nativeClearTimeout = window.clearTimeout.bind(window);
  var nativeRAF = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : null;

  // 门控：sg_page_slim_force 优先（'1'/'0' 强制），否则读 sg_page_slim；3s 短缓存避免高频读 LS
  var slimCache = { v: false, at: 0 };
  function slimOn() {
    var now = Date.now();
    if (now - slimCache.at < 3000) return slimCache.v;
    slimCache.at = now;
    var v = false;
    try {
      var f = localStorage.getItem('sg_page_slim_force');
      if (f === '1') v = true;
      else if (f === '0') v = false;
      else v = localStorage.getItem('sg_page_slim') === '1';
    } catch (e) {}
    slimCache.v = v;
    return v;
  }
  window.__sgPageSlimOn = slimOn;

  // setInterval：slim 时最小间隔钳到 2000ms（X 大量秒级轮询是主线程空转大户）
  window.setInterval = function (fn, ms) {
    var args = Array.prototype.slice.call(arguments);
    if (slimOn()) {
      var t = (typeof args[1] === 'number' && isFinite(args[1])) ? args[1] : 0;
      if (t < 2000) args[1] = 2000;
    }
    return nativeSetInterval.apply(window, args);
  };

  // rAF：slim 时合并至 ~10fps（100ms 一帧，走原生 setTimeout 调度）
  // Blink 中 rAF 与 timeout 共用 timer id 池，clearTimeout 可取消 rAF，反向亦成立
  if (nativeRAF) {
    window.requestAnimationFrame = function (cb) {
      if (!slimOn()) return nativeRAF(cb);
      if (typeof cb !== 'function') return 0;
      return nativeSetTimeout(function () {
        try { cb(Date.now()); } catch (e) {}
      }, 100);
    };
    window.cancelAnimationFrame = function (id) {
      try { nativeClearTimeout(id); } catch (e) {}
    };
  }

  var gate = { mode: 'on', allow: true };
  window.__SG_MEDIA_GATE__ = gate;

  function emitState() {
    try {
      window.postMessage({
        type: '__sg_media_gate_state',
        mode: gate.mode,
        allow: !!gate.allow,
        ver: window.__SG_MEDIA_BLOCK_MAIN__
      }, '*');
    } catch (e) {}
  }

  function onGateChanged() {
    emitState();
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data) return;
    if (e.data.type === '__sg_media_gate') {
      if (e.data.mode != null) gate.mode = String(e.data.mode || 'auto').toLowerCase();
      if (e.data.allow != null) gate.allow = !!e.data.allow;
      onGateChanged();
      return;
    }
    if (e.data.type === '__sg_media_gate_ping') emitState();
  });

  emitState();
  try { console.log('[SG禁图] main gate-only (DNR mode, no DOM patches)', window.__SG_MEDIA_BLOCK_MAIN__); } catch (eL2) {}
})();

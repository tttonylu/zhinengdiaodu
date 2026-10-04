// 隔离世界 document_start：同步开闸状态 + 拦隔离世界 fetch(twimg) + 等待 MAIN allow
(function () {
  'use strict';
  if (window.__SG_MEDIA_BLOCK_SYNC__) return;
  window.__SG_MEDIA_BLOCK_SYNC__ = true;

  var cached = { mode: 'on', allow: true };

  function push(mode, allow) {
    cached.mode = mode || 'on';
    cached.allow = !!allow;
    try {
      window.postMessage({
        type: '__sg_media_gate',
        mode: cached.mode,
        allow: cached.allow
      }, '*');
    } catch (e) {}
    try {
      var root = document.documentElement;
      if (root) {
        if (cached.mode !== 'on' && !cached.allow) root.classList.add('sg-media-blocked');
        else root.classList.remove('sg-media-blocked');
      }
    } catch (eC) {}
  }

  // 4.3.14：默认放行媒体（不再首屏默禁盖 CSS）
  push('on', true);

  function syncFromStorage() {
    try {
      chrome.storage.local.get(['sg_media_load_mode', 'sg_media_gate_ref'], function (st) {
        var mode = String((st && st.sg_media_load_mode) || 'off').toLowerCase();
        if (mode !== 'on' && mode !== 'off' && mode !== 'auto') mode = 'off';
        if (mode === 'auto') mode = 'on';
        var ref = parseInt((st && st.sg_media_gate_ref) || '0', 10) || 0;
        var allow = mode === 'on' || ref > 0;
        push(mode, allow);
      });
    } catch (e) {
      push('off', false);
    }
  }

  // 4.3.2：隔离世界也不再 hook fetch 拦 twimg（与 MAIN 一致，避免误伤）
  // 克隆/转帖拉图走 BG 开闸 + DNR；时间线省流靠 DNR image/media + MAIN DOM 拦

  /** 开闸后等到 MAIN 确认 allow（或超时按 storage 判定） */
  window.__sgWaitMediaAllow = function (timeoutMs) {
    timeoutMs = timeoutMs || 5000;
    return new Promise(function (resolve) {
      if (cached.allow || cached.mode === 'on') {
        resolve(true);
        return;
      }
      var done = false;
      function finish(v) {
        if (done) return;
        done = true;
        try { window.removeEventListener('message', onMsg); } catch (e0) {}
        try { clearTimeout(tid); } catch (e1) {}
        resolve(!!v);
      }
      function onMsg(e) {
        if (e.source !== window || !e.data) return;
        if (e.data.type === '__sg_media_gate_state' && e.data.allow) finish(true);
        if (e.data.type === '__sg_media_gate' && e.data.allow) finish(true);
      }
      window.addEventListener('message', onMsg);
      syncFromStorage();
      try { window.postMessage({ type: '__sg_media_gate_ping' }, '*'); } catch (eP) {}
      var tid = setTimeout(function () {
        if (cached.allow || cached.mode === 'on') {
          finish(true);
          return;
        }
        try {
          chrome.storage.local.get(['sg_media_load_mode', 'sg_media_gate_ref'], function (st) {
            var mode = String((st && st.sg_media_load_mode) || 'off').toLowerCase();
            if (mode === 'auto') mode = 'on';
            var ref = parseInt((st && st.sg_media_gate_ref) || '0', 10) || 0;
            finish(mode === 'on' || ref > 0);
          });
        } catch (eS) {
          finish(false);
        }
      }, timeoutMs);
    });
  };

  syncFromStorage();
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      if (changes.sg_media_load_mode || changes.sg_media_gate_ref) syncFromStorage();
    });
  } catch (eCh) {}

  // 只读状态，禁止把 SW 内存 0 写回 storage（会误关闸）
  try {
    chrome.runtime.sendMessage({ action: 'media_gate_status' }, function (r) {
      void chrome.runtime.lastError;
      if (!r) return;
      var mode = String(r.mode || cached.mode || 'auto').toLowerCase();
      // 以 storage ref 为准；status.ref 仅作参考
      syncFromStorage();
      if (r.mode) {
        try { chrome.storage.local.set({ sg_media_load_mode: mode }); } catch (eM) {}
      }
    });
  } catch (eMsg) {}

  setInterval(syncFromStorage, 15000);
})();

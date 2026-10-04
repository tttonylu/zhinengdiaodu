// 主世界 document_start：闸门状态同步（纯 DNR 禁图，不再劫持 DOM 原型，避免崩溃）
(function () {
  'use strict';
  if (window.__SG_MEDIA_BLOCK_MAIN__) return;
  // 4.4.0：移除 DOM 硬拦（prototype 劫持导致 Aw Snap 崩溃）；省流靠 DNR + CSS
  window.__SG_MEDIA_BLOCK_MAIN__ = '4.4.0';

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

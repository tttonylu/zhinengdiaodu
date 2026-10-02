// 主世界 document_start：闸门状态同步；默认放行媒体（仅 off 时装 DOM 硬拦）
(function () {
  'use strict';
  if (window.__SG_MEDIA_BLOCK_MAIN__) return;
  // 4.3.14：默认 on；仅 mode=off 时装轻量 DOM 拦（无 MutationObserver）
  window.__SG_MEDIA_BLOCK_MAIN__ = '4.3.14';

  var gate = { mode: 'on', allow: true };
  window.__SG_MEDIA_GATE__ = gate;
  var hardPatchesInstalled = false;

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

  /** 仅 off 且未开闸时做 DOM 硬拦 */
  function hardDomBlock() {
    return gate.mode === 'off' && !gate.allow;
  }

  function isAllowlistedTwimg(u) {
    if (/abs\.twimg\.com/i.test(u)) return true;
    if (/profile_images|profile_banners|emoji\/v2|default_profile|hashflags/i.test(u)) return true;
    return false;
  }

  function shouldBlockUrl(url) {
    if (!hardDomBlock()) return false;
    var u = String(url || '');
    if (!u || u.indexOf('data:') === 0 || u.indexOf('blob:') === 0) return false;
    if (!/twimg\.com/i.test(u) && !/amplify_video|ext_tw_video_thumb|tweet_video/i.test(u)) return false;
    if (isAllowlistedTwimg(u)) return false;
    if (/video\.twimg\.com|ton\.twimg\.com|pbs-mu\.twimg\.com/i.test(u)) return true;
    if (/amplify_video|ext_tw_video_thumb|tweet_video|\/media\//i.test(u)) return true;
    if (/pbs\.twimg\.com/i.test(u)) return true;
    return false;
  }

  function patchSrcSetter(proto, prop) {
    if (!proto) return;
    try {
      var desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (!desc || !desc.set) return;
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set: function (v) {
          if (shouldBlockUrl(v)) return;
          desc.set.call(this, v);
        }
      });
    } catch (e) {}
  }

  function installHardDomPatchesOnce() {
    if (hardPatchesInstalled) return;
    hardPatchesInstalled = true;
    try {
      patchSrcSetter(window.HTMLImageElement && window.HTMLImageElement.prototype, 'src');
      patchSrcSetter(window.HTMLImageElement && window.HTMLImageElement.prototype, 'srcset');
      patchSrcSetter(window.HTMLVideoElement && window.HTMLVideoElement.prototype, 'src');
      patchSrcSetter(window.HTMLVideoElement && window.HTMLVideoElement.prototype, 'poster');
      patchSrcSetter(window.HTMLSourceElement && window.HTMLSourceElement.prototype, 'src');
    } catch (eImg) {}
    try {
      var vProto = window.HTMLVideoElement && window.HTMLVideoElement.prototype;
      if (vProto) {
        var soDesc = Object.getOwnPropertyDescriptor(vProto, 'srcObject');
        if (soDesc && soDesc.set) {
          Object.defineProperty(vProto, 'srcObject', {
            configurable: true,
            enumerable: soDesc.enumerable,
            get: soDesc.get,
            set: function (v) {
              if (hardDomBlock() && v) return;
              soDesc.set.call(this, v);
            }
          });
        }
      }
    } catch (eSo) {}
    try {
      var elProto = window.Element && window.Element.prototype;
      if (elProto && elProto.setAttribute) {
        var rawSet = elProto.setAttribute;
        elProto.setAttribute = function (name, value) {
          var n = String(name || '').toLowerCase();
          var tag = String(this.tagName || '').toUpperCase();
          if ((n === 'src' || n === 'srcset' || n === 'poster') &&
              (tag === 'IMG' || tag === 'SOURCE' || tag === 'VIDEO') &&
              shouldBlockUrl(value)) {
            return;
          }
          return rawSet.apply(this, arguments);
        };
      }
    } catch (eSa) {}
    try { console.log('[SG禁图] MAIN hard DOM patches on (mode=off)'); } catch (eL) {}
  }

  function onGateChanged() {
    if (gate.mode === 'off') installHardDomPatchesOnce();
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

  // 不 hook fetch/XHR；不挂 MutationObserver（省流靠 DNR + CSS）
  emitState();
  try { console.log('[SG禁图] main gate-only', window.__SG_MEDIA_BLOCK_MAIN__); } catch (eL2) {}
})();

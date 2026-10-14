// =============================================================================
// E5 原创内容池客户端：claim / report / 取图（经 background SW，不直连 OPS）
// =============================================================================
(function () {
  'use strict';
  if (window.ContentPoolClient) return;

  function send(message) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(message, function (resp) {
          void chrome.runtime.lastError;
          resolve(resp || { ok: false });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    });
  }

  function isPoolMode(cfg) {
    return !!(cfg && cfg.contentPoolMode === true);
  }

  function dataUrlToBlob(dataUrl) {
    var m = /^data:([^;,]+);base64,(.*)$/.exec(String(dataUrl || ''));
    if (!m) throw new Error('bad dataUrl');
    var bin = atob(m[2]);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: m[1] });
  }

  var ContentPoolClient = {
    /** 领单；无到期返回 null，异常返回 {error} */
    async claim(handle, nowJst) {
      var r = await send({ action: 'ops_content_pool_claim', bot_id: handle || '', now: nowJst || '' });
      if (!r || !r.ok) return { error: (r && r.error) || 'claim_fail' };
      return r.item || null;
    },

    async report(id, result, meta) {
      meta = meta || {};
      return send({
        action: 'ops_content_pool_report',
        bot_id: meta.botId || '',
        id: id, result: result,
        external_post_id: meta.externalPostId || '',
        fail_reason: meta.failReason || '',
      });
    },

    /** 相对路径数组 → Blob[]；任一失败整体失败（对齐 E1 图优先：缺图整条放弃） */
    async fetchMedia(relUrls) {
      var out = [];
      for (var i = 0; i < relUrls.length; i++) {
        var r = await send({ action: 'ops_content_pool_media', url: relUrls[i] });
        if (!r || !r.ok || !r.dataUrl) throw new Error((r && r.error) || 'media_fail');
        out.push(dataUrlToBlob(r.dataUrl));
      }
      return out;
    },

    _test: { isPoolMode: isPoolMode, dataUrlToBlob: dataUrlToBlob },
  };

  window.ContentPoolClient = ContentPoolClient;
})();

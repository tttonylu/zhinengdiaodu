// =============================================================================
// 资料克隆：转帖来源号列表第一个 → 本号 displayName/bio/avatar/banner；整号只成功一次
// 跨 location 跳转用 session job 续跑（MV3 content 会随导航重注）
// 4.1.24：点 editProfileAvatar/Header → file → 裁剪 Apply；图失败可补跑
// 4.1.67：Apply 必须成功才算媒体成功；刮不到头像不得假 mediaDone；菜单「上传」兜底
// 4.1.69：关自动翻译污染——?lang=ja + 点「显示原文」+ 优先日文；forceRerun 整份重克隆
// 4.2.4：源页拉图进 BG 临时仓；设置页先条幅后头像；abort 世代号；mediaPartial 复用缓存
// 4.2.6：媒体仓改 base64 + chrome.storage 持久化（防 SW 回收丢图）；BG 代拉 twimg 兜底
// 4.2.7：恢复「选横幅/头像 file input」主路径（对齐独立版）；相机按钮仅兜底；Apply 有窗必点
// 4.2.8：apply 卡在 /home 根因——硬跳 settings + 看门狗纠偏；暂停不挡 apply 续跑；TTL 用 updatedAt
// 4.2.9：纠偏勿刷新 TTL / 限次放弃；幽灵 running 清掉，避免调度永久「资料克隆中」
// =============================================================================
(function () {
  'use strict';
  if (window.ProfileClone) return;

  var NAME = 'profile_clone';
  var MAX_ATTEMPTS = 3;
  var JOB_STALE_MS = 4 * 60 * 1000;
  var MAX_APPLY_NUDGE = 12; // ~30s，失败则放行调度
  var MAX_DAY = 2;
  var _bootScheduled = false;
  var _busyLocal = false;
  var _abortGen = 0;
  var _aborted = false;
  var _applyNudgeTimer = null;
  var _applyNudgeCount = 0;
  var _lastUploadErr = '';

  function K() {
    return typeof SKeys !== 'undefined' ? SKeys : {};
  }

  function normHandle(h) {
    return String(h || '').replace(/^@/, '').replace(/#guard$/i, '').toLowerCase().trim();
  }

  function myHandle() {
    try {
      var h = localStorage.getItem((K().LK_MY_HANDLE) || 'matrix_my_handle') || '';
      h = normHandle(h);
      if (h && h !== 'unknown') return h;
    } catch (e0) {}
    try {
      var el = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
      if (el && el.href) return normHandle(el.href.split('/').pop());
    } catch (e1) {}
    return 'unknown';
  }

  function stateKey(handle) {
    var prefix = (K().LK_PROFILE_CLONE_STATE_PREFIX) || 'sg_profile_clone_state_';
    return prefix + (normHandle(handle) || 'unknown');
  }

  function loadJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (e) { return fallback; }
  }

  function saveJson(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  function emptyState() {
    return {
      done: false,
      skipped: false,
      failed: false,
      source: '',
      attempts: 0,
      at: 0,
      lastError: '',
      mediaPartial: false,
      textDone: false,
      mediaDone: false,
      lastPayload: null,
      reason: '',
      forceRerun: false
    };
  }

  function getState(handle) {
    return Object.assign(emptyState(), loadJson(stateKey(handle || myHandle()), {}) || {});
  }

  function setState(partial, handle) {
    var h = handle || myHandle();
    var cur = getState(h);
    var next = Object.assign({}, cur, partial || {}, { at: Date.now() });
    saveJson(stateKey(h), next);
    return next;
  }

  function getDayCount() {
    try {
      var h = myHandle();
      var st = JSON.parse(localStorage.getItem('matrix_stats_' + h) || '{}');
      return Number(st.day_count) || 1;
    } catch (e1) { return 1; }
  }

  function getSourceHandle() {
    try {
      if (typeof RepostTracker !== 'undefined' && RepostTracker.getTargets) {
        var list = RepostTracker.getTargets() || [];
        if (list[0]) return normHandle(list[0]);
      }
    } catch (e0) {}
    try {
      var raw = JSON.parse(localStorage.getItem((K().LK_REPOST_TARGETS) || 'sg_repost_targets') || '[]');
      if (Array.isArray(raw) && raw[0]) return normHandle(raw[0]);
    } catch (e1) {}
    return '';
  }

  function jobKey() {
    return (K().SK_PROFILE_CLONE_JOB) || 'sg_profile_clone_job';
  }

  function runFlagKey() {
    return (K().SK_PROFILE_CLONE_RUNNING) || 'sg_profile_clone_running';
  }

  function loadJob() {
    try {
      var raw = sessionStorage.getItem(jobKey());
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  function saveJob(job) {
    try {
      if (!job) sessionStorage.removeItem(jobKey());
      else sessionStorage.setItem(jobKey(), JSON.stringify(job));
    } catch (e) {}
  }

  function setRunning(on) {
    try {
      if (on) sessionStorage.setItem(runFlagKey(), 'true');
      else sessionStorage.removeItem(runFlagKey());
    } catch (e) {}
    try {
      if (typeof EngineUtils !== 'undefined') {
        if (on) EngineUtils.start(NAME);
        else EngineUtils.stop(NAME);
      }
    } catch (e2) {}
  }

  function jobAgeMs(job) {
    if (!job) return Infinity;
    return Date.now() - (job.updatedAt || job.startedAt || 0);
  }

  function jobIsFresh(job) {
    return !!(job && job.step && jobAgeMs(job) <= JOB_STALE_MS);
  }

  /** 清幽灵旗：无 job / 过期 job 不得挡住调度 */
  function reconcileGhostClone(why) {
    var job = loadJob();
    if (job && !jobIsFresh(job)) {
      try { console.warn('[资料克隆] 过期 job 清理', why || '', job.step, Math.round(jobAgeMs(job) / 1000) + 's'); } catch (e0) {}
      // 只清 job/旗，不反复 markFailed（isRunning 会被 coTick 高频调用）
      clearJob('stale_reconcile');
      return true;
    }
    if (!job) {
      var flagged = false;
      try { flagged = sessionStorage.getItem(runFlagKey()) === 'true'; } catch (e1) {}
      try {
        if (!flagged && typeof EngineUtils !== 'undefined' && EngineUtils.isRunning) {
          flagged = !!EngineUtils.isRunning(NAME);
        }
      } catch (e2) {}
      try {
        if (!flagged && localStorage.getItem('sg_profile_clone_running') === 'true') flagged = true;
      } catch (e3) {}
      if (flagged) {
        try { console.warn('[资料克隆] 幽灵 running 清理', why || ''); } catch (e4) {}
        setRunning(false);
        stopApplyNudge();
        _applyNudgeCount = 0;
        return true;
      }
    }
    return false;
  }

  function isRunning() {
    // 先清幽灵，避免 coTick 永久「资料克隆中」
    try { reconcileGhostClone('isRunning'); } catch (eR) {}
    var job = loadJob();
    if (jobIsFresh(job)) return true;
    try {
      if (sessionStorage.getItem(runFlagKey()) === 'true') {
        // 有旗无活 job → 上面已清；此处仅双检
        if (!job) return false;
        return jobIsFresh(job);
      }
    } catch (e0) {}
    try {
      if (typeof EngineUtils !== 'undefined' && EngineUtils.isRunning && EngineUtils.isRunning(NAME)) {
        if (!jobIsFresh(job)) {
          try { EngineUtils.stop(NAME); } catch (eS) {}
          return false;
        }
        return true;
      }
    } catch (e1) {}
    return false;
  }

  function emit(type, detail) {
    try {
      if (typeof SgTelemetry !== 'undefined' && SgTelemetry.emit) {
        SgTelemetry.emit(type, detail || {});
      }
    } catch (e) {}
    try {
      console.log('[资料克隆]', type, detail || {});
    } catch (e2) {}
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function go(url, opts) {
    opts = opts || {};
    // apply 进设置页必须硬跳：避开 PageRouter 连跳冷却
    if (!opts.hard) {
      try {
        if (typeof PageRouter !== 'undefined' && PageRouter.jumpTo) {
          if (PageRouter.jumpTo(url)) return true;
        }
      } catch (e0) {}
    }
    // 4.6.102：硬跳也走 Gate 排队，禁止裸 href 连环握手
    try {
      if (typeof SchedulerGate !== 'undefined' && SchedulerGate.goRaw) {
        return !!SchedulerGate.goRaw(url, { force: true });
      }
    } catch (eGate) {}
    try {
      if (typeof SchedulerGate !== 'undefined' && SchedulerGate.prepareLeave) {
        SchedulerGate.prepareLeave();
      }
    } catch (ePrep) {}
    try {
      window.location.href = url;
      return true;
    } catch (e1) { return false; }
  }

  function stopApplyNudge() {
    if (_applyNudgeTimer) {
      try { clearInterval(_applyNudgeTimer); } catch (e) {}
      _applyNudgeTimer = null;
    }
  }

  /** apply 卡在非设置页时有限次硬拉回；禁止刷新 TTL（否则永不过期挡调度） */
  function ensureApplyNudge() {
    if (_applyNudgeTimer) return;
    _applyNudgeTimer = setInterval(function () {
      try {
        if (_aborted || _busyLocal) return;
        var job = loadJob();
        if (!job || job.step !== 'apply') {
          stopApplyNudge();
          _applyNudgeCount = 0;
          return;
        }
        if (!jobIsFresh(job)) {
          reconcileGhostClone('nudge_stale');
          return;
        }
        if (onEditProfile()) {
          _applyNudgeCount = 0;
          return;
        }
        _applyNudgeCount += 1;
        if (_applyNudgeCount > MAX_APPLY_NUDGE) {
          try { console.warn('[资料克隆] apply 纠偏超限，放弃并放行调度'); } catch (eM) {}
          stopApplyNudge();
          _applyNudgeCount = 0;
          markFailed('apply_nav_stuck');
          return;
        }
        // 不刷新 updatedAt —— 纠偏不得延长 TTL
        setRunning(true);
        if (_applyNudgeCount === 1) stopOtherEnginesForClone();
        try {
          console.log('[资料克隆] apply 纠偏', _applyNudgeCount + '/' + MAX_APPLY_NUDGE,
            location.pathname, '→ /settings/profile');
        } catch (eL) {}
        go('https://x.com/settings/profile', { hard: true });
      } catch (eN) {}
    }, 2500);
  }

  function touchJob(job) {
    if (!job) return job;
    job.updatedAt = Date.now();
    saveJob(job);
    return job;
  }

  function statusLabel() {
    var st = getState();
    if (isRunning()) return '进行中';
    if (st.done && st.mediaDone) return '已完成';
    if (st.done && st.mediaPartial) return '已完成(图部分)';
    if (st.done) return '已完成';
    if (st.skipped) return '无来源跳过';
    if (st.failed) return '失败(' + (st.attempts || 0) + ')';
    if (st.mediaPartial || st.textDone) return '待补图(' + (st.attempts || 0) + '/' + MAX_ATTEMPTS + ')';
    if (st.attempts > 0) return '待重试(' + st.attempts + '/' + MAX_ATTEMPTS + ')';
    return '未跑';
  }

  function needsRun() {
    var st = getState();
    if (st.skipped || st.failed) return false;
    if (st.attempts >= MAX_ATTEMPTS) return false;
    // OPS/控制台强制整份重跑：不受 Day≤2 限制
    if (st.forceRerun && !st.done) return true;
    var needMedia = !!(st.mediaPartial || (st.textDone && !st.mediaDone));
    if (st.done && !needMedia) return false;
    if (st.done && needMedia && st.mediaDone) return false;
    var day = getDayCount();
    if (day > MAX_DAY && !needMedia && !st.textDone) return false;
    if (st.done && needMedia) return true;
    if (!st.done) return day <= MAX_DAY || !!st.textDone;
    return false;
  }

  function clearJob(why) {
    saveJob(null);
    setRunning(false);
    _busyLocal = false;
    _applyNudgeCount = 0;
    stopApplyNudge();
    try { console.log('[资料克隆] clearJob', why || ''); } catch (e) {}
  }

  function isUserPaused() {
    try {
      var k = (K().LK_USER_PAUSED) || 'sg_user_paused';
      return localStorage.getItem(k) === '1';
    } catch (e) { return false; }
  }

  function mediaMsg(action, payload) {
    return new Promise(function (resolve) {
      try {
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
          resolve({ ok: false, error: 'no_chrome' });
          return;
        }
        chrome.runtime.sendMessage(Object.assign({ action: action }, payload || {}), function (r) {
          void chrome.runtime.lastError;
          resolve(r || { ok: false });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    });
  }

  function mediaGateOpen(reason) {
    return mediaMsg('media_gate_open', { reason: reason || 'profile_clone' });
  }

  function mediaGateClose(reason) {
    return mediaMsg('media_gate_close', { reason: reason || 'profile_clone' });
  }

  /** 开闸后等头像/横幅节点（禁图时须先开闸再刮 URL） */
  async function waitForProfileMedia(timeoutMs) {
    var start = Date.now();
    var limit = timeoutMs || 8000;
    while (Date.now() - start < limit) {
      try {
        var primary = document.querySelector('[data-testid="primaryColumn"]') || document;
        var av = primary.querySelector('[data-testid^="UserAvatar-Container-"] img');
        if (av && (av.currentSrc || av.src)) return true;
        if (primary.querySelector('a[href$="/header_photo"] img')) return true;
      } catch (e) {}
      await sleep(400);
    }
    return false;
  }

  async function blobToWire(blob) {
    if (!blob) return null;
    // 用 dataUrl/base64：SW 重启 + sendMessage 结构化克隆都更稳（ArrayBuffer 易丢）
    var dataUrl = await new Promise(function (resolve, reject) {
      try {
        var r = new FileReader();
        r.onload = function () { resolve(r.result); };
        r.onerror = function () { reject(r.error || new Error('read_fail')); };
        r.readAsDataURL(blob);
      } catch (e) { reject(e); }
    });
    return {
      dataUrl: String(dataUrl || ''),
      mime: blob.type || 'image/jpeg',
      size: blob.size || 0
    };
  }

  function wireToBlob(wire) {
    if (!wire) return null;
    try {
      if (wire.dataUrl) {
        var parts = String(wire.dataUrl).split(',');
        var mimeMatch = parts[0] && parts[0].match(/data:([^;]+)/);
        var mime = (mimeMatch && mimeMatch[1]) || wire.mime || 'image/jpeg';
        var b64 = parts[1] || '';
        if (!b64) return null;
        var bin = atob(b64);
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return new Blob([arr], { type: mime });
      }
      // 兼容旧 ArrayBuffer 载荷
      var buf = wire.buffer;
      if (!buf) return null;
      if (!(buf instanceof ArrayBuffer) && buf.byteLength == null && Array.isArray(buf)) {
        buf = new Uint8Array(buf).buffer;
      }
      return new Blob([buf], { type: wire.mime || 'image/jpeg' });
    } catch (e) { return null; }
  }

  async function putMediaCache(id, bannerBlob, avatarBlob) {
    if (!id) return false;
    var banner = await blobToWire(bannerBlob);
    var avatar = await blobToWire(avatarBlob);
    try {
      console.log('[资料克隆] media_put', id,
        'banner=', banner && banner.size, 'avatar=', avatar && avatar.size);
    } catch (eL) {}
    var r = await mediaMsg('profile_clone_media_put', { id: id, banner: banner, avatar: avatar });
    if (!(r && r.ok)) {
      try { console.warn('[资料克隆] media_put 失败', r && r.error); } catch (eW) {}
    }
    return !!(r && r.ok);
  }

  async function getMediaCache(id) {
    if (!id) return null;
    var r = await mediaMsg('profile_clone_media_get', { id: id });
    if (!r || !r.ok) {
      try { console.warn('[资料克隆] media_get miss', id, r && r.error); } catch (eM) {}
      return null;
    }
    var out = {
      banner: wireToBlob(r.banner),
      avatar: wireToBlob(r.avatar)
    };
    try {
      console.log('[资料克隆] media_get', id, 'from=', r.from || '?',
        'banner=', out.banner && out.banner.size, 'avatar=', out.avatar && out.avatar.size);
    } catch (eL2) {}
    return out;
  }

  async function hasMediaCache(id) {
    if (!id) return false;
    var r = await mediaMsg('profile_clone_media_has', { id: id });
    return !!(r && r.ok && r.has);
  }

  function clearMediaCache(id) {
    mediaMsg('profile_clone_media_clear', id ? { id: id } : {}).catch(function () {});
  }

  function abort(why) {
    _abortGen += 1;
    _aborted = true;
    stopApplyNudge();
    try {
      var job = loadJob();
      if (job && job.payload && job.payload.mediaCacheId) clearMediaCache(job.payload.mediaCacheId);
      else clearMediaCache(null);
    } catch (e) { clearMediaCache(null); }
    clearJob(why || 'abort');
    try { console.log('[资料克隆] abort', why || '', 'gen=', _abortGen); } catch (e2) {}
  }

  function allowNurtureAfter() {
    if (_aborted) return false;
    if (isUserPaused()) return false;
    return true;
  }

  function markSkipped(reason) {
    setState({
      done: true,
      skipped: true,
      failed: false,
      reason: reason || 'skip',
      lastError: '',
      forceRerun: false
    });
    clearJob('skip');
  }

  function markFailed(err, mediaPartial) {
    var st = getState();
    var attempts = (st.attempts || 0) + 1;
    var exhausted = attempts >= MAX_ATTEMPTS;
    setState({
      attempts: attempts,
      failed: exhausted,
      done: false,
      lastError: String(err || 'fail').slice(0, 200),
      mediaPartial: !!mediaPartial
    });
    clearJob('fail');
    emit('profile.clone_fail', { error: String(err || ''), attempts: attempts, exhausted: exhausted });
  }

  function markDone(extra) {
    setState(Object.assign({
      done: true,
      skipped: false,
      failed: false,
      lastError: '',
      reason: 'ok',
      mediaDone: !(extra && extra.mediaPartial),
      textDone: true,
      mediaPartial: !!(extra && extra.mediaPartial),
      forceRerun: false
    }, extra || {}));
    clearJob('done');
    emit('profile.clone_done', extra || {});
  }

  function markTextPartial(payload, err) {
    var st = getState();
    var attempts = (st.attempts || 0) + 1;
    var exhausted = attempts >= MAX_ATTEMPTS;
    setState({
      attempts: attempts,
      textDone: true,
      mediaDone: false,
      mediaPartial: true,
      done: exhausted,
      failed: false,
      lastError: String(err || 'media_partial').slice(0, 200),
      lastPayload: payload || st.lastPayload || null,
      reason: exhausted ? 'media_give_up' : 'media_retry'
    });
    clearJob('media_partial');
    emit('profile.clone_fail', { error: 'media_partial', attempts: attempts, exhausted: exhausted });
  }

  async function fetchBlobViaBg(url) {
    var r = await mediaMsg('profile_clone_fetch_url', { url: url });
    if (!r || !r.ok || !r.dataUrl) throw new Error((r && r.error) || 'bg_fetch_fail');
    return wireToBlob({ dataUrl: r.dataUrl, mime: r.mime, size: r.size });
  }

  async function fetchBlob(url) {
    // 内容脚本 fetch → omit+cors → BG 代拉（host_permissions）
    var blob = null;
    var lastErr = null;
    try {
      var r = await fetch(url);
      if (!r.ok) throw new Error('fetch_' + r.status);
      blob = await r.blob();
    } catch (e1) {
      lastErr = e1;
      try {
        var r2 = await fetch(url, { credentials: 'omit', mode: 'cors', cache: 'no-cache' });
        if (!r2.ok) throw new Error('fetch_' + r2.status);
        blob = await r2.blob();
      } catch (e2) {
        lastErr = e2;
      }
    }
    if (!blob || blob.size < 500) {
      try {
        blob = await fetchBlobViaBg(url);
        try { console.log('[资料克隆] BG 代拉成功', url.slice(0, 80), blob && blob.size); } catch (eBg) {}
      } catch (e3) {
        lastErr = e3;
        blob = null;
      }
    }
    if (!blob) throw lastErr || new Error('fetch_fail');
    if (!blob.type || blob.type === 'application/octet-stream') {
      var t = /\.png(\?|$)/i.test(url) ? 'image/png' : 'image/jpeg';
      try { blob = new Blob([blob], { type: t }); } catch (eT) {}
    }
    return blob;
  }

  function upgradeImgUrl(src) {
    if (!src) return '';
    var s = String(src);
    try {
      if (s.indexOf('//') === 0) s = 'https:' + s;
      s = s
        .replace(/_normal\.(jpg|jpeg|png|webp)/i, '_400x400.$1')
        .replace(/_reasonably_small\.(jpg|jpeg|png|webp)/i, '_400x400.$1')
        .replace(/_mini\./i, '_400x400.')
        .replace(/_bigger\./i, '_400x400.')
        .replace(/_x96\./i, '_400x400.')
        .replace(/_200x200\./i, '_400x400.');
      if (/profile_banners/i.test(s)) {
        s = s.replace(/\/\d{2,4}x\d{2,4}(\?|$)/, '/1500x500$1');
      }
      var u = new URL(s, location.href);
      if (/twimg\.com/i.test(u.hostname)) {
        try { u.searchParams.set('name', 'orig'); } catch (eN) {}
      }
      return u.href;
    } catch (e) {
      return s.replace(/_normal\./, '_400x400.');
    }
  }

  function pickBestImgUrl(candidates, kind) {
    var best = '';
    var bestScore = -1;
    kind = kind || '';
    for (var i = 0; i < candidates.length; i++) {
      var u = upgradeImgUrl(candidates[i]);
      if (!u || /default_profile/i.test(u)) continue;
      if (kind === 'avatar' && !/profile_images/i.test(u)) continue;
      if (kind === 'banner' && !/profile_banners/i.test(u)) continue;
      var score = 0;
      if (/profile_images/i.test(u)) score += 10;
      if (/profile_banners/i.test(u)) score += 10;
      if (/_400x400|_bigger|name=orig|1500x500/i.test(u)) score += 5;
      if (score > bestScore) { bestScore = score; best = u; }
    }
    return best;
  }

  /** 为 twimg 头像/横幅生成多组候选 URL，避免单尺寸 404 */
  function buildImgFallbacks(url, kind) {
    var list = [];
    if (!url) return list;
    var s = String(url);
    function push(x) {
      if (!x || list.indexOf(x) >= 0) return;
      list.push(x);
    }
    try {
      if (s.indexOf('//') === 0) s = 'https:' + s;
      var u = new URL(s, location.href);
      var base = u.origin + u.pathname;
      var query = u.search;
      push(s);
      if (query) push(base);
      if (query.indexOf('name=') < 0) push(base + (query ? '&' : '?') + 'name=orig');

      if (/profile_images/i.test(base)) {
        var avVariants = ['_400x400', '_bigger', '_normal', '_200x200', '_x96', '_mini', '_reasonably_small'];
        var avRe = /_(normal|bigger|mini|reasonably_small|x96|200x200|400x400)\.(jpg|jpeg|png|webp)$/i;
        avVariants.forEach(function (v) {
          var r = base.replace(avRe, v + '.$2');
          if (r !== base) {
            push(r);
            push(r + '?name=orig');
          }
        });
        var stripped = base.replace(avRe, '.$2');
        if (stripped !== base) {
          push(stripped);
          push(stripped + '?name=orig');
        }
      } else if (/profile_banners/i.test(base)) {
        var banVariants = ['1500x500', '600x200', '300x100'];
        var banRe = /\/(\d{2,4}x\d{2,4})(\?|$)/;
        banVariants.forEach(function (v) {
          var r = base.replace(banRe, '/' + v + '$2');
          if (r !== base) {
            push(r);
            push(r + '?name=orig');
          }
        });
        var banStripped = base.replace(banRe, '');
        if (banStripped !== base) push(banStripped);
      }
    } catch (e) {
      push(s);
    }
    return list;
  }

  function hasJapanese(s) {
    return /[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/.test(String(s || ''));
  }

  function cleanProfileText(s) {
    var t = String(s || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    t = t.replace(/\s*(Translated from[^\n.]*|翻译自[^\n.]*|翻譯自[^\n.]*|翻訳元[^\n.]*)\s*/gi, ' ');
    t = t.replace(/\s*(Show original|See original|查看原文|顯示原文|原文を表示|원문 보기)\s*/gi, ' ');
    t = t.replace(/\s*(Translate bio|翻译简介|翻訳する)\s*/gi, ' ');
    return t.replace(/\s+/g, ' ').trim();
  }

  function scoreProfileText(s) {
    var t = cleanProfileText(s);
    if (!t) return -1;
    var score = t.length;
    if (hasJapanese(t)) score += 1000;
    if (/[\u4e00-\u9fff]/.test(t) && !hasJapanese(t)) score += 50; // 纯中文次优
    // 明显英译且无日文：降权
    if (!hasJapanese(t) && /^[A-Za-z0-9\s.,!?'"\-_/&@:;()]+$/.test(t) && t.length > 8) score -= 200;
    return score;
  }

  function pickBestProfileText(cands) {
    var best = '';
    var bestScore = -1;
    for (var i = 0; i < (cands || []).length; i++) {
      var t = cleanProfileText(cands[i]);
      var sc = scoreProfileText(t);
      if (sc > bestScore) { bestScore = sc; best = t; }
    }
    return best;
  }

  /** 自动翻译开着时点「显示原文」，避免刮到英译简介/昵称 */
  async function revealOriginalProfileText(root) {
    root = root || document;
    var clicked = 0;
    var nodes = root.querySelectorAll('button, [role="button"], a, span[role="button"]');
    for (var i = 0; i < nodes.length; i++) {
      var lab = ((nodes[i].innerText || nodes[i].getAttribute('aria-label') || '') + '').replace(/\s+/g, ' ').trim();
      if (!lab || lab.length > 80) continue;
      if (/Translate|翻译|翻訳|번역/i.test(lab) && !/original|原文|원문/i.test(lab)) continue;
      if (/Show original|See original|查看原文|顯示原文|原文を表示|원문 보기/i.test(lab)) {
        try {
          nodes[i].click();
          clicked++;
          await sleep(500);
        } catch (eC) {}
        if (clicked >= 3) break;
      }
    }
    if (clicked) await sleep(700);
    return clicked > 0;
  }

  function sourceProfileUrl(handle) {
    return 'https://x.com/' + normHandle(handle) + '?lang=ja';
  }

  /** 只在主栏刮源号；禁止侧栏/导航本号头像污染；优先日文原文 */
  async function scrapeFromDom(sourceHandle) {
    var displayName = '';
    var bio = '';
    var avatarUrl = '';
    var bannerUrl = '';
    var expectMedia = false;
    var source = normHandle(sourceHandle || getSourceHandle());
    var me = myHandle();

    if (!source || !onSourceProfile(source)) {
      try { console.warn('[资料克隆] scrape 拒绝：不在源号主页 path=' + (location.pathname || '')); } catch (e0) {}
      return { displayName: '', bio: '', avatarUrl: '', bannerUrl: '', expectMedia: false };
    }

    var primary = null;
    try { primary = document.querySelector('[data-testid="primaryColumn"]'); } catch (eP) {}
    if (!primary) primary = document;

    try { await revealOriginalProfileText(primary); } catch (eRev) {}

    try {
      var nameCands = [];
      var nameRoot = primary.querySelector('[data-testid="UserName"]');
      if (nameRoot) {
        var jaNodes = nameRoot.querySelectorAll('[lang="ja"], [lang^="ja-"]');
        for (var ji = 0; ji < jaNodes.length; ji++) {
          var jt = cleanProfileText(jaNodes[ji].innerText || '');
          if (jt && jt.charAt(0) !== '@') nameCands.push(jt);
        }
        var spans = nameRoot.querySelectorAll('span');
        for (var i = 0; i < spans.length; i++) {
          var t = cleanProfileText(spans[i].innerText || '');
          if (!t || t.charAt(0) === '@') continue;
          if (/^\d/.test(t) && t.indexOf(' ') < 0) continue;
          if (/followers|following|posts|posts?/i.test(t)) continue;
          nameCands.push(t);
        }
      }
      try {
        var ogTitle = document.querySelector('meta[property="og:title"]');
        if (ogTitle && ogTitle.content) {
          var ot = cleanProfileText(String(ogTitle.content).split(/[(@·|]/)[0]);
          if (ot) nameCands.push(ot);
        }
      } catch (eOt) {}
      displayName = pickBestProfileText(nameCands).slice(0, 50);
    } catch (eN) {}

    try {
      var bioCands = [];
      var bioEl = primary.querySelector('[data-testid="UserDescription"]');
      if (bioEl) {
        var bioJa = bioEl.querySelectorAll('[lang="ja"], [lang^="ja-"]');
        for (var bj = 0; bj < bioJa.length; bj++) {
          bioCands.push(bioJa[bj].innerText || '');
        }
        bioCands.push(bioEl.innerText || '');
      }
      try {
        var ogDesc = document.querySelector('meta[property="og:description"], meta[name="description"]');
        if (ogDesc && ogDesc.content) bioCands.push(ogDesc.content);
      } catch (eOd) {}
      bio = pickBestProfileText(bioCands).slice(0, 160);
    } catch (eB) {}

    try {
      var avCands = [];
      var sawSourceAvatar = false;
      var sawDefaultOnly = false;
      var containers = primary.querySelectorAll('[data-testid^="UserAvatar-Container-"]');
      for (var ci = 0; ci < containers.length; ci++) {
        var tid = containers[ci].getAttribute('data-testid') || '';
        var h = normHandle(tid.replace(/^UserAvatar-Container-/i, ''));
        if (h !== source) continue;
        sawSourceAvatar = true;
        var imgs = containers[ci].querySelectorAll('img');
        for (var ii = 0; ii < imgs.length; ii++) {
          var src = imgs[ii].currentSrc || imgs[ii].src || '';
          if (!src) continue;
          if (/default_profile/i.test(src)) { sawDefaultOnly = true; continue; }
          if (/profile_images/i.test(src)) avCands.push(src);
        }
      }
      var photoLinks = primary.querySelectorAll('a[href$="/photo"], a[href*="/photo"]');
      for (var pi = 0; pi < photoLinks.length; pi++) {
        var href = (photoLinks[pi].getAttribute('href') || '').toLowerCase();
        if (href.indexOf('/' + source + '/photo') < 0) continue;
        sawSourceAvatar = true;
        var pimg = photoLinks[pi].querySelector('img');
        var psrc = pimg ? (pimg.currentSrc || pimg.src || '') : '';
        if (psrc && /default_profile/i.test(psrc)) sawDefaultOnly = true;
        else if (psrc) avCands.push(psrc);
      }
      try {
        var metas = document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]');
        for (var mi = 0; mi < metas.length; mi++) {
          var mc = metas[mi].getAttribute('content') || '';
          if (mc && /profile_images/i.test(mc) && !/default_profile/i.test(mc)) avCands.push(mc);
        }
      } catch (eOg) {}
      avatarUrl = pickBestImgUrl(avCands, 'avatar');
      if (!avatarUrl && sawSourceAvatar && !sawDefaultOnly) expectMedia = true;
      if (avatarUrl && me && me !== source) {
        // URL 无法区分账号，依赖选择器已绑 source
      }
    } catch (eA) {}

    try {
      var banCands = [];
      var hdrLinks = primary.querySelectorAll('a[href$="/header_photo"], a[href*="/header_photo"]');
      for (var hi = 0; hi < hdrLinks.length; hi++) {
        var hh = (hdrLinks[hi].getAttribute('href') || '').toLowerCase();
        if (hh.indexOf('/' + source + '/header_photo') < 0 && hdrLinks.length > 1) continue;
        if (hdrLinks.length === 1 || hh.indexOf('/' + source + '/header_photo') >= 0) {
          var himg = hdrLinks[hi].querySelector('img');
          if (himg && (himg.currentSrc || himg.src)) banCands.push(himg.currentSrc || himg.src);
          try {
            var sty = window.getComputedStyle(hdrLinks[hi]);
            var m = (sty && sty.backgroundImage || '').match(/url\(["']?(https?:[^"')]+)/);
            if (m) banCands.push(m[1]);
          } catch (eS) {}
          var stAttr = hdrLinks[hi].getAttribute('style') || '';
          var m2 = stAttr.match(/url\(["']?(https?:[^"')]+)/);
          if (m2) banCands.push(m2[1]);
          try {
            var kids = hdrLinks[hi].querySelectorAll('div, span');
            for (var ki = 0; ki < Math.min(kids.length, 12); ki++) {
              var ks = window.getComputedStyle(kids[ki]);
              var km = (ks && ks.backgroundImage || '').match(/url\(["']?(https?:[^"')]+)/);
              if (km && /profile_banners/i.test(km[1])) banCands.push(km[1]);
            }
          } catch (eK) {}
        }
      }
      var banImgs = primary.querySelectorAll('img[src*="profile_banners"], div[style*="profile_banners"]');
      for (var bi = 0; bi < banImgs.length; bi++) {
        var el = banImgs[bi];
        if (el.src && /profile_banners/i.test(el.src)) banCands.push(el.src);
        var st2 = el.getAttribute('style') || '';
        var m3 = st2.match(/url\(["']?(https?:[^"')]+)/);
        if (m3 && /profile_banners/i.test(m3[1])) banCands.push(m3[1]);
      }
      bannerUrl = pickBestImgUrl(banCands, 'banner');
    } catch (eBan) {}

    if (avatarUrl || bannerUrl) expectMedia = false;

    try {
      console.log('[资料克隆] scrape @' + source
        + ' name=' + (displayName || '').slice(0, 20)
        + ' bioLen=' + (bio || '').length
        + ' jpName=' + hasJapanese(displayName)
        + ' jpBio=' + hasJapanese(bio)
        + ' av=' + (avatarUrl ? avatarUrl.slice(0, 60) : '')
        + ' ban=' + (bannerUrl ? bannerUrl.slice(0, 60) : '')
        + ' expectMedia=' + !!expectMedia);
    } catch (eL) {}

    return {
      displayName: displayName,
      bio: bio,
      avatarUrl: avatarUrl,
      bannerUrl: bannerUrl,
      expectMedia: !!expectMedia
    };
  }

  function pathHandle() {
    try {
      var m = (location.pathname || '').match(/^\/([A-Za-z0-9_]+)\/?$/);
      return m ? normHandle(m[1]) : '';
    } catch (e) { return ''; }
  }

  function onSourceProfile(source) {
    var ph = pathHandle();
    return ph && source && ph === normHandle(source);
  }

  function onEditProfile() {
    var p = (location.pathname || '').toLowerCase();
    return p.indexOf('/settings/profile') >= 0;
  }

  function setNativeValue(el, value) {
    if (!el) return false;
    try {
      var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) {
      try {
        el.focus();
        document.execCommand('selectAll', false);
        document.execCommand('insertText', false, value);
        return true;
      } catch (e2) { return false; }
    }
  }

  async function waitFor(sel, timeout) {
    var start = Date.now();
    while (Date.now() - start < (timeout || 15000)) {
      var el = document.querySelector(sel);
      if (el) return el;
      await sleep(300);
    }
    return null;
  }

  async function waitForFileInputNear(btn, prevCount, kind, timeout) {
    var start = Date.now();
    while (Date.now() - start < (timeout || 10000)) {
      var inputs = document.querySelectorAll('input[type="file"]');
      // 点击后新出现的 input 最可信
      if (inputs.length > prevCount) {
        return inputs[inputs.length - 1];
      }
      // 在按钮祖先内找
      if (btn) {
        var scope = btn;
        for (var up = 0; up < 10 && scope; up++) {
          try {
            var near = scope.querySelector && scope.querySelector('input[type="file"]');
            if (near) return near;
          } catch (eN) {}
          scope = scope.parentElement;
        }
      }
      await sleep(250);
    }
    // X 编辑页常见顺序：先横幅(header) 后头像(avatar)
    var all = document.querySelectorAll('input[type="file"]');
    if (!all.length) return null;
    if (kind === 'banner') return all[0];
    return all[all.length - 1];
  }

  /** 设置页已有 file input：按文案/顺序选横幅（独立版同逻辑） */
  function findBannerInput(allInputs) {
    var list = allInputs || document.querySelectorAll('input[type="file"]');
    for (var i = 0; i < list.length; i++) {
      var fi = list[i];
      var parent = fi.closest ? fi.closest('div') : null;
      var ariaLabel = (fi.getAttribute('aria-label') || '').toLowerCase();
      var parentText = parent ? String(parent.innerText || '').toLowerCase().substring(0, 200) : '';
      if (parentText.indexOf('header') >= 0 || parentText.indexOf('banner') >= 0 || parentText.indexOf('cover') >= 0
        || parentText.indexOf('背景') >= 0 || parentText.indexOf('横幅') >= 0
        || ariaLabel.indexOf('header') >= 0 || ariaLabel.indexOf('banner') >= 0 || ariaLabel.indexOf('cover') >= 0) {
        return fi;
      }
    }
    if (list.length >= 1) return list[0];
    return null;
  }

  /** 设置页已有 file input：选头像（排除横幅槽） */
  function findAvatarInput(allInputs, bannerInput) {
    var list = allInputs || document.querySelectorAll('input[type="file"]');
    for (var i = 0; i < list.length; i++) {
      var fi = list[i];
      if (fi === bannerInput) continue;
      var parent = fi.closest ? fi.closest('div') : null;
      var ariaLabel = (fi.getAttribute('aria-label') || '').toLowerCase();
      var parentText = parent ? String(parent.innerText || '').toLowerCase().substring(0, 200) : '';
      if (parentText.indexOf('avatar') >= 0 || parentText.indexOf('头像') >= 0
        || parentText.indexOf('profile') >= 0 || parentText.indexOf('photo') >= 0
        || parentText.indexOf('照片') >= 0 || parentText.indexOf('pick a') >= 0
        || parentText.indexOf('choose') >= 0
        || ariaLabel.indexOf('avatar') >= 0 || ariaLabel.indexOf('photo') >= 0 || ariaLabel.indexOf('头像') >= 0) {
        return fi;
      }
    }
    for (var j = 0; j < list.length; j++) {
      if (list[j] !== bannerInput) return list[j];
    }
    return null;
  }

  async function waitForPageFileInput(kind, timeout) {
    var start = Date.now();
    while (Date.now() - start < (timeout || 8000)) {
      var all = document.querySelectorAll('input[type="file"]');
      var banner = findBannerInput(all);
      var input = kind === 'banner' ? banner : findAvatarInput(all, banner);
      if (input && !input.disabled) {
        try {
          if (input.offsetParent !== null || input.getClientRects().length) return input;
        } catch (eVis) { return input; }
      }
      await sleep(400);
    }
    var all2 = document.querySelectorAll('input[type="file"]');
    var b2 = findBannerInput(all2);
    return kind === 'banner' ? b2 : findAvatarInput(all2, b2);
  }

  async function assignFile(input, blob, filename) {
    if (!input || !blob) return false;
    try {
      var type = blob.type || 'image/jpeg';
      var file = new File([blob], filename || 'media.jpg', { type: type });
      var dt = new DataTransfer();
      dt.items.add(file);
      // 与独立版一致：原生 setter 绕过 React value tracker
      var proto = Object.getPrototypeOf(input);
      var desc = proto && Object.getOwnPropertyDescriptor(proto, 'files');
      if (desc && desc.set) {
        desc.set.call(input, dt.files);
      } else {
        try {
          input.files = dt.files;
        } catch (eSet) {
          try {
            Object.defineProperty(input, 'files', { value: dt.files, configurable: true });
          } catch (eDef) { return false; }
        }
      }
      input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      try { input.dispatchEvent(new FocusEvent('focus', { bubbles: true })); } catch (eF) {}
      try { input.dispatchEvent(new FocusEvent('blur', { bubbles: true })); } catch (eB) {}
      return true;
    } catch (e) { return false; }
  }

  async function clickApplyCrop() {
    var sels = [
      '[data-testid="applyButton"]',
      '[data-testid="confirmationSheetConfirm"]',
      'button[data-testid="applyButton"]'
    ];
    for (var i = 0; i < sels.length; i++) {
      var btn = document.querySelector(sels[i]);
      if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
        btn.click();
        await sleep(1600);
        return true;
      }
    }
    var buttons = document.querySelectorAll('[role="dialog"] button, [role="dialog"] [role="button"], button');
    for (var j = 0; j < buttons.length; j++) {
      var lab = ((buttons[j].innerText || buttons[j].getAttribute('aria-label') || '') + '').trim();
      if (/^(Apply|应用|套用|適用|Done|完成|적용)$/i.test(lab) || /^(Apply|Done)\b/i.test(lab)) {
        if (buttons[j].disabled || buttons[j].getAttribute('aria-disabled') === 'true') continue;
        buttons[j].click();
        await sleep(1600);
        return true;
      }
    }
    return false;
  }

  /** 点相机后若弹出「上传/更换」菜单则点进去 */
  async function clickMediaMenuIfPresent() {
    await sleep(400);
    var nodes = document.querySelectorAll(
      '[role="menuitem"], [role="menu"] [role="button"], [data-testid="Dropdown"] [role="menuitem"], [data-testid="sheetDialog"] [role="button"]'
    );
    for (var i = 0; i < nodes.length; i++) {
      var lab = ((nodes[i].innerText || nodes[i].getAttribute('aria-label') || '') + '').trim();
      if (!lab) continue;
      if (/remove|删除|削除|Remove current/i.test(lab) && !/upload|add|更换|上传|Change/i.test(lab)) continue;
      if (/upload|add (a )?photo|change photo|更换|上传|写真を(追加|アップロード)|メディアを追加|Add (a )?banner|Change banner/i.test(lab)) {
        try { nodes[i].click(); } catch (eC) {}
        await sleep(700);
        return true;
      }
    }
    return false;
  }

  async function waitForCropUi(timeout) {
    var start = Date.now();
    while (Date.now() - start < (timeout || 8000)) {
      if (document.querySelector('[data-testid="applyButton"], [data-testid="confirmationSheetConfirm"]')) return true;
      var dialogs = document.querySelectorAll('[role="dialog"]');
      for (var i = 0; i < dialogs.length; i++) {
        var t = (dialogs[i].innerText || '');
        if (/Apply|应用|套用|適用|Done|完成/i.test(t)) return true;
      }
      await sleep(250);
    }
    return false;
  }

  async function resolveMediaBlob(kind, urlOrBlob) {
    var blob = null;
    var url = '';
    if (urlOrBlob && typeof urlOrBlob === 'object' && typeof urlOrBlob.size === 'number') {
      blob = urlOrBlob;
    } else {
      url = String(urlOrBlob || '');
      if (!url) {
        _lastUploadErr = 'url_empty';
        return null;
      }
      if (kind === 'avatar' && /profile_banners/i.test(url)) {
        console.warn('[资料克隆] 拒绝：banner URL 误入 avatar 槽');
        _lastUploadErr = 'url_type_avatar_reject';
        return null;
      }
      if (kind === 'banner' && /profile_images/i.test(url) && !/profile_banners/i.test(url)) {
        console.warn('[资料克隆] 拒绝：avatar URL 误入 banner 槽');
        _lastUploadErr = 'url_type_banner_reject';
        return null;
      }
      var gateHeld = false;
      try {
        var gateResult = await mediaGateOpen('profile_clone_apply');
        if (gateResult && gateResult.ok !== false) gateHeld = true;
        if (gateHeld && typeof window.__sgWaitMediaAllow === 'function') {
          try { await window.__sgWaitMediaAllow(4000); } catch (eWa) {}
        }
        if (!gateHeld) {
        console.warn('[资料克隆] 开闸失败，跳过 URL 拉图', kind);
        _lastUploadErr = 'gate_fail';
        return null;
      }
        var fallbacks = buildImgFallbacks(url, kind);
        var lastFetchErr = '';
        for (var fi = 0; fi < fallbacks.length; fi++) {
          var tryUrl = fallbacks[fi];
          try {
            blob = await fetchBlob(tryUrl);
            if (blob && blob.size >= 500) {
              try { console.log('[资料克隆] 下载成功', kind, tryUrl.slice(0, 80), blob.size); } catch (eL) {}
              break;
            }
          } catch (eFetch) {
            blob = null;
            lastFetchErr = String((eFetch && eFetch.message) || eFetch).slice(0, 60);
          }
        }
        if ((!blob || blob.size < 500) && lastFetchErr && !_lastUploadErr) {
          _lastUploadErr = 'fetch_fail:' + lastFetchErr;
        }
      } finally {
        if (gateHeld) {
          try { await mediaGateClose('profile_clone_apply'); } catch (eG) {}
        }
      }
    }
    if (!blob || blob.size < 500) {
      console.warn('[资料克隆] 图太小/下载失败', kind, blob && blob.size, 'err=', _lastUploadErr);
      if (!_lastUploadErr) _lastUploadErr = 'blob_small';
      return null;
    }
    return blob;
  }

  /** 注入后：有裁剪窗则必须 Apply；无窗则视为独立版路径成功 */
  async function finishMediaAfterAssign(kind) {
    var hasCrop = await waitForCropUi(7000);
    if (!hasCrop) {
      await sleep(800);
      hasCrop = await waitForCropUi(3000);
    }
    if (hasCrop) {
      var applied = await clickApplyCrop();
      if (!applied) {
        await sleep(900);
        applied = await clickApplyCrop();
      }
      if (!applied) {
        console.warn('[资料克隆] Apply 失败', kind);
        return false;
      }
      await sleep(1000);
      return true;
    }
    try { console.log('[资料克隆] 无裁剪窗，已注入 file（独立版路径）', kind); } catch (eL) {}
    await sleep(600);
    return true;
  }

  /** 主路径：直接选设置页横幅/头像 file input（对齐独立版） */
  async function uploadViaPageFileInput(kind, blob) {
    var input = await waitForPageFileInput(kind, 8000);
    if (!input) {
      try { console.warn('[资料克隆] 页面无', kind, 'file input'); } catch (e0) {}
      _lastUploadErr = 'page_no_input';
      return false;
    }
    try {
      console.log('[资料克隆] 选中', kind, 'input',
        'accept=', input.getAttribute('accept') || '',
        'aria=', (input.getAttribute('aria-label') || '').slice(0, 40));
    } catch (eL) {}
    var ok = await assignFile(input, blob, kind === 'banner' ? 'banner.jpg' : 'avatar.jpg');
    if (!ok) {
      console.warn('[资料克隆] 注入 file 失败(页面input)', kind);
      _lastUploadErr = 'page_assign_fail';
      return false;
    }
    var done = await finishMediaAfterAssign(kind);
    if (!done) _lastUploadErr = 'page_finish_fail';
    return done;
  }

  /** 兜底：点相机/编辑按钮再找 file input */
  async function uploadViaEditButton(kind, blob) {
    var btnSel = kind === 'banner'
      ? '[data-testid="editProfileHeader"], [data-testid="addBannerButton"]'
      : '[data-testid="editProfileAvatar"], [data-testid="addAvatarButton"]';
    var prevCount = document.querySelectorAll('input[type="file"]').length;
    var btn = document.querySelector(btnSel);
    if (!btn) {
      // 再试 aria / 文案
      var cams = document.querySelectorAll('button, [role="button"], div[role="button"]');
      for (var i = 0; i < cams.length; i++) {
        var al = ((cams[i].getAttribute('aria-label') || cams[i].innerText || '') + '').toLowerCase();
        if (kind === 'banner' && /banner|header|cover|横幅|背景|ヘッダー/.test(al)) { btn = cams[i]; break; }
        if (kind === 'avatar' && /avatar|photo|头像|写真|プロフィール写真/.test(al) && !/banner|header|横幅/.test(al)) {
          btn = cams[i]; break;
        }
      }
    }
    if (!btn) {
      console.warn('[资料克隆] 无编辑按钮', kind, btnSel);
      _lastUploadErr = 'btn_no_button';
      return false;
    }
    try { btn.click(); } catch (eC) {}
    await sleep(500);
    await clickMediaMenuIfPresent();

    var input = await waitForFileInputNear(btn, prevCount, kind, 10000);
    if (!input) {
      try { btn.click(); } catch (eC2) {}
      await clickMediaMenuIfPresent();
      input = await waitForFileInputNear(btn, prevCount, kind, 8000);
    }
    if (!input) {
      console.warn('[资料克隆] 无 file input(按钮路径)', kind);
      _lastUploadErr = 'btn_no_input';
      return false;
    }

    var ok = await assignFile(input, blob, kind === 'banner' ? 'banner.jpg' : 'avatar.jpg');
    if (!ok) {
      console.warn('[资料克隆] 注入 file 失败(按钮)', kind);
      _lastUploadErr = 'btn_assign_fail';
      return false;
    }
    var done = await finishMediaAfterAssign(kind);
    if (!done) _lastUploadErr = 'btn_finish_fail';
    return done;
  }

  async function uploadProfileMedia(kind, urlOrBlob) {
    var blob = await resolveMediaBlob(kind, urlOrBlob);
    if (!blob) {
      if (!_lastUploadErr) _lastUploadErr = 'blob_null';
      return false;
    }

    // 1) 主路径：直接选页面上的横幅/头像 input（独立版原逻辑）
    if (await uploadViaPageFileInput(kind, blob)) {
      try { console.log('[资料克隆] 上传成功(页面input)', kind); } catch (e1) {}
      _lastUploadErr = '';
      return true;
    }
    // 2) 兜底：点编辑按钮
    if (await uploadViaEditButton(kind, blob)) {
      try { console.log('[资料克隆] 上传成功(编辑按钮)', kind); } catch (e2) {}
      _lastUploadErr = '';
      return true;
    }
    console.warn('[资料克隆] 上传失败', kind, 'err=', _lastUploadErr);
    if (!_lastUploadErr) _lastUploadErr = 'upload_fail';
    return false;
  }

  async function applyPayload(payload) {
    payload = payload || {};
    var st0 = getState();
    var skipText = !!st0.textDone;
    var textOk = skipText;
    var mediaOk = true;
    var mediaTried = false;
    var hadMedia = !!(payload.avatarUrl || payload.bannerUrl);
    var expectMedia = !!payload.expectMedia && !hadMedia;

    var nameInput =
      document.querySelector('input[name="displayName"]') ||
      document.querySelector('input[name="name"]') ||
      document.querySelector('textarea[name="displayName"]') ||
      await waitFor('input[name="displayName"], input[name="name"]', 12000);

    var bioInput =
      document.querySelector('textarea[name="description"]') ||
      document.querySelector('textarea[name="bio"]') ||
      await waitFor('textarea[name="description"], textarea[name="bio"]', 4000);

    if (!skipText) {
      if (payload.displayName && nameInput) {
        var wantName = cleanProfileText(String(payload.displayName)).slice(0, 50);
        if (setNativeValue(nameInput, wantName)) {
          await sleep(250);
          var gotN = cleanProfileText(nameInput.value || '');
          if (gotN === wantName || (wantName && gotN.indexOf(wantName.slice(0, Math.min(8, wantName.length))) >= 0)) {
            textOk = true;
          } else if (setNativeValue(nameInput, wantName)) {
            textOk = true;
          }
        }
      }
      if (payload.bio != null && payload.bio !== '' && bioInput) {
        var wantBio = cleanProfileText(String(payload.bio)).slice(0, 160);
        if (setNativeValue(bioInput, wantBio)) {
          await sleep(300);
          var gotB = cleanProfileText(bioInput.value || '');
          if (gotB === wantBio || (wantBio && gotB.indexOf(wantBio.slice(0, Math.min(12, wantBio.length))) >= 0)) {
            textOk = true;
          } else {
            // 二次写入（部分 React 受控框首次吞值）
            setNativeValue(bioInput, '');
            await sleep(120);
            if (setNativeValue(bioInput, wantBio)) textOk = true;
          }
        }
      } else if (payload.bio != null && payload.bio !== '' && !bioInput) {
        console.warn('[资料克隆] 简介框未找到，bio 未写入');
      }
    }

    if (!payload.displayName && (payload.bio == null || payload.bio === '') && !hadMedia && !expectMedia) {
      return { ok: true, noop: true, mediaPartial: false };
    }
    if (!nameInput && !bioInput && !hadMedia && !skipText) {
      throw new Error('edit_form_miss');
    }

    // 纠偏：若 URL 类型与字段反了则交换
    if (payload.avatarUrl && /profile_banners/i.test(payload.avatarUrl)
      && payload.bannerUrl && /profile_images/i.test(payload.bannerUrl)) {
      var tmp = payload.avatarUrl;
      payload.avatarUrl = payload.bannerUrl;
      payload.bannerUrl = tmp;
    } else if (payload.avatarUrl && /profile_banners/i.test(payload.avatarUrl) && !payload.bannerUrl) {
      payload.bannerUrl = payload.avatarUrl;
      payload.avatarUrl = '';
    } else if (payload.bannerUrl && /profile_images/i.test(payload.bannerUrl) && !/profile_banners/i.test(payload.bannerUrl) && !payload.avatarUrl) {
      payload.avatarUrl = payload.bannerUrl;
      payload.bannerUrl = '';
    }
    hadMedia = !!(payload.avatarUrl || payload.bannerUrl || payload.bannerCached || payload.avatarCached);

    // 优先用源页已缓存的 Blob（storage 持久化）；先条幅后头像
    var cached = null;
    if (payload.mediaCacheId) {
      try { cached = await getMediaCache(payload.mediaCacheId); } catch (eC) { cached = null; }
      if (!cached || (!(cached.banner && cached.banner.size >= 500) && !(cached.avatar && cached.avatar.size >= 500))) {
        try {
          console.warn('[资料克隆] 缓存不可用，回退 URL', payload.mediaCacheId,
            'bannerUrl=', !!(payload.bannerUrl), 'avatarUrl=', !!(payload.avatarUrl));
        } catch (eW) {}
      }
    }

    if (payload.bannerUrl || (cached && cached.banner && cached.banner.size >= 500)) {
      mediaTried = true;
      var bannerSrc = (cached && cached.banner && cached.banner.size >= 500) ? cached.banner : payload.bannerUrl;
      if (!(await uploadProfileMedia('banner', bannerSrc))) mediaOk = false;
    }
    if (_aborted) return { ok: false, aborted: true };
    if (payload.avatarUrl || (cached && cached.avatar && cached.avatar.size >= 500)) {
      mediaTried = true;
      var avatarSrc = (cached && cached.avatar && cached.avatar.size >= 500) ? cached.avatar : payload.avatarUrl;
      if (!(await uploadProfileMedia('avatar', avatarSrc))) mediaOk = false;
    }
    if (_aborted) return { ok: false, aborted: true };

    var saveBtn =
      document.querySelector('[data-testid="Profile_Save_Button"]') ||
      document.querySelector('[data-testid="settingsDetailSave"]') ||
      null;
    if (!saveBtn) {
      var buttons = document.querySelectorAll('button, [role="button"]');
      for (var j = 0; j < buttons.length; j++) {
        var lab = ((buttons[j].innerText || buttons[j].getAttribute('aria-label') || '') + '').trim();
        if (/^(Save|保存|儲存|저장)$/i.test(lab) || lab === '保存する') {
          saveBtn = buttons[j];
          break;
        }
      }
    }
    if (saveBtn && !saveBtn.disabled && saveBtn.getAttribute('aria-disabled') !== 'true') {
      saveBtn.click();
      await sleep(2800);
      textOk = true;
    } else if (!textOk && !mediaTried && !skipText) {
      throw new Error('save_miss');
    }

    if (!textOk && !skipText && mediaTried && !mediaOk) throw new Error('media_only_fail');
    if (!textOk && !skipText && !mediaTried && !expectMedia) throw new Error('nothing_applied');

    var mediaPartial = (hadMedia && mediaTried && !mediaOk) || expectMedia;
    return {
      ok: true,
      mediaPartial: mediaPartial,
      mediaOk: hadMedia ? mediaOk : !expectMedia,
      textOk: textOk || skipText,
      hadMedia: hadMedia,
      expectMedia: expectMedia
    };
  }

  function finishAndMaybeNurture(job, result) {
    if (_aborted) {
      try { console.log('[资料克隆] abort 后跳过收尾/养号'); } catch (eA) {}
      return;
    }
    var nurtureUrl = (job && job.nurtureUrl) || 'https://x.com/home';
    var cacheId = job && job.payload && job.payload.mediaCacheId;
    var terminalOk = false;
    var mediaPartial = false;

    if (result && result.noop) {
      if (cacheId) clearMediaCache(cacheId);
      markDone({ reason: 'noop', source: (job && job.source) || '', mediaPartial: false, mediaDone: true });
      terminalOk = true;
    } else if (result && result.ok && result.mediaPartial) {
      // 补图未完成：禁止跳首页，否则会与下一轮 scrape 形成「源号↔主页」死循环
      markTextPartial(job && job.payload, 'media_upload_fail:' + (_lastUploadErr || 'unknown'));
      mediaPartial = true;
      try { console.log('[资料克隆] mediaPartial，不拉养号，等待下次直进 apply/重刮'); } catch (eMp) {}
    } else if (result && result.ok) {
      if (cacheId) clearMediaCache(cacheId);
      markDone({
        source: (job && job.source) || getState().source || '',
        mediaPartial: false,
        mediaDone: true,
        textDone: true,
        lastPayload: null
      });
      terminalOk = true;
    }

    // 仅终态（成功 / 耗尽失败已在 mark* 里清 job）才允许养号；补图中绝不 nurtureAfter
    var wantNurture = !!(job && job.nurtureAfter) && allowNurtureAfter() && terminalOk && !mediaPartial;
    if (wantNurture) {
      setTimeout(function () {
        if (!allowNurtureAfter()) return;
        try {
          if (typeof window.__sgStartNurtureDirect === 'function') {
            window.__sgStartNurtureDirect(nurtureUrl);
          } else {
            window.dispatchEvent(new CustomEvent('sg-nurture-command', {
              detail: { command: 'start', targetUrl: nurtureUrl }
            }));
          }
        } catch (e) {}
      }, 600);
    }
  }

  async function stepScrape(job) {
    var gen = _abortGen;
    if (_aborted) {
      clearJob('scrape_aborted');
      return;
    }
    // 手动克隆（nurtureAfter=false）不受 sg_user_paused 拦截，否则会「必须先点自动」
    if (isUserPaused() && job && job.nurtureAfter !== false) {
      clearJob('scrape_paused');
      return;
    }
    if (!onSourceProfile(job.source)) {
      go(sourceProfileUrl(job.source));
      return;
    }

    var gateHeld = false;
    try {
      // L3：先开闸 → 等 MAIN allow → 等 DOM 出图 → 刮 URL → fetch → finally 关闸
      var gateResult = await mediaGateOpen('profile_clone');
      if (gateResult && gateResult.ok !== false) gateHeld = true;
      if (gateHeld && typeof window.__sgWaitMediaAllow === 'function') {
        try { await window.__sgWaitMediaAllow(5000); } catch (eWa) {}
      }
      try { window.scrollTo(0, 0); } catch (eSc) {}
      await sleep(2400);
      if (_aborted || gen !== _abortGen) return;
      try { await waitForProfileMedia(8000); } catch (eW) {}
      if (_aborted || gen !== _abortGen) return;

      var payload = await scrapeFromDom(job.source);
      if (!payload.avatarUrl && !payload.bannerUrl) {
        await sleep(1600);
        if (_aborted || gen !== _abortGen) return;
        var again = await scrapeFromDom(job.source);
        if (again.avatarUrl || again.bannerUrl || again.displayName || again.bio) payload = again;
      }
      if (!payload.displayName && !payload.bio && !payload.avatarUrl && !payload.bannerUrl && !payload.expectMedia) {
        markFailed('scrape_empty');
        if (allowNurtureAfter() && job.nurtureAfter) {
          setTimeout(function () {
            if (!allowNurtureAfter()) return;
            try {
              if (typeof window.__sgStartNurtureDirect === 'function') {
                window.__sgStartNurtureDirect(job.nurtureUrl || 'https://x.com/home');
              }
            } catch (e) {}
          }, 400);
        }
        return;
      }

      // 源页拉图进 BG 临时仓（跨跳页）
      var mediaId = 'pc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      var bannerBlob = null;
      var avatarBlob = null;
      if (payload.bannerUrl) {
        try {
          bannerBlob = await fetchBlob(payload.bannerUrl);
          try { console.log('[资料克隆] 源页已拉条幅', bannerBlob && bannerBlob.size); } catch (eB) {}
        } catch (eBanner) {
          try { console.warn('[资料克隆] 源页拉条幅失败', eBanner && eBanner.message); } catch (eB2) {}
        }
      }
      if (_aborted || gen !== _abortGen) return;
      if (payload.avatarUrl) {
        try {
          avatarBlob = await fetchBlob(payload.avatarUrl);
          try { console.log('[资料克隆] 源页已拉头像', avatarBlob && avatarBlob.size); } catch (eA) {}
        } catch (eAvatar) {
          try { console.warn('[资料克隆] 源页拉头像失败', eAvatar && eAvatar.message); } catch (eA2) {}
        }
      }
      if (_aborted || gen !== _abortGen) return;

      if (bannerBlob || avatarBlob) {
        var putOk = await putMediaCache(mediaId, bannerBlob, avatarBlob);
        if (putOk) {
          payload.mediaCacheId = mediaId;
          payload.bannerCached = !!bannerBlob;
          payload.avatarCached = !!avatarBlob;
        } else {
          try { console.warn('[资料克隆] media_put 失败，设置页将回退 URL fetch'); } catch (eP) {}
        }
      }
      if ((payload.avatarUrl || payload.bannerUrl) && !bannerBlob && !avatarBlob) {
        payload.expectMedia = true;
      }

      try { setState({ lastPayload: payload, source: job.source }); } catch (eSp) {}
      job.step = 'apply';
      job.payload = payload;
      job.updatedAt = Date.now();
      saveJob(job);
      if (_aborted || gen !== _abortGen) return;
      ensureApplyNudge();
      stopOtherEnginesForClone();
      go('https://x.com/settings/profile', { hard: true });
    } finally {
      if (gateHeld) {
        try { await mediaGateClose('profile_clone'); } catch (eG) {}
      }
    }
  }

  async function stepApply(job) {
    var gen = _abortGen;
    if (_aborted) {
      clearJob('apply_aborted');
      return;
    }
    if (isUserPaused() && job && job.nurtureAfter !== false) {
      clearJob('apply_paused');
      return;
    }
    if (!onEditProfile()) {
      touchJob(job);
      setRunning(true);
      ensureApplyNudge();
      stopOtherEnginesForClone();
      try { console.log('[资料克隆] apply 需设置页，当前', location.pathname); } catch (ePath) {}
      go('https://x.com/settings/profile', { hard: true });
      return;
    }
    ensureApplyNudge();
    // 等设置页 file input / 表单就绪（独立版也会等）
    await sleep(2200);
    if (_aborted || gen !== _abortGen) return;
    var formReady = await waitFor('input[name="displayName"], input[name="name"], input[type="file"]', 12000);
    if (!formReady) {
      try { console.warn('[资料克隆] 设置页表单未就绪'); } catch (eR) {}
    }
    await sleep(600);
    if (_aborted || gen !== _abortGen) return;
    try {
      var result = await applyPayload(job.payload || {});
      if (_aborted || gen !== _abortGen) return;
      finishAndMaybeNurture(job, result);
    } catch (e) {
      markFailed((e && e.message) || 'apply_fail');
      if (allowNurtureAfter() && job.nurtureAfter) {
        setTimeout(function () {
          if (!allowNurtureAfter()) return;
          try {
            if (typeof window.__sgStartNurtureDirect === 'function') {
              window.__sgStartNurtureDirect(job.nurtureUrl || 'https://x.com/home');
            }
          } catch (e2) {}
        }, 400);
      }
    }
  }

  async function resumeJob() {
    if (_busyLocal) return;
    if (_aborted) {
      clearJob('resume_aborted');
      return;
    }
    var job = loadJob();
    if (!job || !job.step) return;
    // 暂停只挡 scrape/自动闸；已进入 apply 必须续跑写设置页（否则卡在 /home）
    if (isUserPaused() && job.nurtureAfter !== false && job.step !== 'apply') {
      try { console.log('[资料克隆] 用户暂停，跳过自动克隆 resume'); } catch (eP) {}
      return;
    }
    // TTL 用 updatedAt：纠偏跳转会刷新，避免误 stale
    if (Date.now() - (job.updatedAt || job.startedAt || 0) > JOB_STALE_MS) {
      markFailed('stale');
      if (allowNurtureAfter() && job.nurtureAfter) {
        try {
          if (typeof window.__sgStartNurtureDirect === 'function') {
            window.__sgStartNurtureDirect(job.nurtureUrl || 'https://x.com/home');
          }
        } catch (e) {}
      }
      return;
    }
    if (job.step === 'apply') ensureApplyNudge();
    _busyLocal = true;
    setRunning(true);
    try {
      if (job.step === 'scrape') await stepScrape(job);
      else if (job.step === 'apply') await stepApply(job);
    } catch (e) {
      markFailed((e && e.message) || 'resume_fail');
      if (allowNurtureAfter() && job.nurtureAfter) {
        try {
          if (typeof window.__sgStartNurtureDirect === 'function') {
            window.__sgStartNurtureDirect(job.nurtureUrl || 'https://x.com/home');
          }
        } catch (e2) {}
      }
    } finally {
      _busyLocal = false;
    }
  }

  function stopOtherEnginesForClone() {
    try {
      window.dispatchEvent(new CustomEvent('sg-nurture-command', { detail: { command: 'stop' } }));
    } catch (e0) {}
    try {
      window.dispatchEvent(new CustomEvent('sg-follow-command', { detail: { command: 'stop' } }));
    } catch (e1) {}
    try {
      window.dispatchEvent(new CustomEvent('sg-chat-command', { detail: { command: 'stop' } }));
    } catch (e2) {}
    try {
      window.dispatchEvent(new CustomEvent('sg-repost-command', { detail: { command: 'stop', reason: 'profile_clone' } }));
    } catch (e3) {}
  }

  function startScrapeJob(source, nurtureUrl, st, opts) {
    opts = opts || {};
    var nurtureAfter = opts.nurtureAfter !== false; // 默认 true（养号闸）；手动克隆传 false
    var job = {
      step: 'scrape',
      source: source,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      nurtureAfter: nurtureAfter,
      nurtureUrl: nurtureUrl || 'https://x.com/home',
      payload: null
    };
    saveJob(job);
    setRunning(true);
    emit('profile.clone_start', {
      source: source,
      day: getDayCount(),
      media_retry: !!(st && (st.mediaPartial || st.textDone)),
      force: !!(st && st.forceRerun),
      reuse: false,
      nurtureAfter: nurtureAfter
    });
    go(sourceProfileUrl(source));
  }

  function ensureBeforeNurture(nurtureUrl, opts) {
    opts = opts || {};
    nurtureUrl = nurtureUrl || 'https://x.com/home';
    var nurtureAfter = opts.nurtureAfter !== false;
    // 手动强制：忽略 needsRun（resetAll 后仍应可跑）
    var force = !!opts.force;

    if (isRunning() && loadJob()) {
      return { started: false, busy: true };
    }
    if (!force && !needsRun()) {
      return { started: false, skipped: true };
    }

    var source = getSourceHandle();
    var st = getState();
    if (!source) {
      markSkipped('no_source');
      emit('profile.clone_done', { skipped: true, reason: 'no_source' });
      return { started: false, skipped: true, reason: 'no_source' };
    }
    if (source === myHandle()) {
      markSkipped('source_is_self');
      return { started: false, skipped: true, reason: 'source_is_self' };
    }

    if (st.done && (st.mediaPartial || (st.textDone && !st.mediaDone))) {
      setState({ done: false, failed: false });
      st = getState();
    }
    if (st.done && !st.mediaDone && !st.mediaPartial) {
      setState({ done: false, textDone: true, mediaPartial: true, failed: false });
      st = getState();
    }

    stopOtherEnginesForClone();
    _aborted = false;
    var gen = _abortGen;
    var ignorePause = !nurtureAfter || force; // 手动克隆不吃「须先点自动」
    var lp = st.lastPayload;
    var wantReuse = !!(lp && (st.mediaPartial || (st.textDone && !st.mediaDone))
      && (lp.mediaCacheId || lp.avatarUrl || lp.bannerUrl)
      && !st.forceRerun && !force);

    setState({ source: source, lastError: '' });
    setRunning(true);

    if (wantReuse && lp.mediaCacheId) {
      hasMediaCache(lp.mediaCacheId).then(function (has) {
        if (_aborted || gen !== _abortGen) return;
        if (!ignorePause && isUserPaused()) return;
        if (has) {
          var job = {
            step: 'apply',
            source: source,
            startedAt: Date.now(),
            updatedAt: Date.now(),
            nurtureAfter: nurtureAfter,
            nurtureUrl: nurtureUrl,
            payload: lp
          };
          saveJob(job);
          emit('profile.clone_start', {
            source: source,
            day: getDayCount(),
            media_retry: true,
            reuse: true,
            nurtureAfter: nurtureAfter
          });
          try { console.log('[资料克隆] 复用媒体缓存直进设置页', lp.mediaCacheId); } catch (eR) {}
          ensureApplyNudge();
          stopOtherEnginesForClone();
          go('https://x.com/settings/profile', { hard: true });
        } else {
          startScrapeJob(source, nurtureUrl, st, { nurtureAfter: nurtureAfter });
        }
      });
      return { started: true, source: source, reusePending: true };
    }

    startScrapeJob(source, nurtureUrl, st, { nurtureAfter: nurtureAfter });
    return { started: true, source: source };
  }

  function scheduleBoot() {
    if (_bootScheduled) return;
    _bootScheduled = true;
    setTimeout(function () {
      try {
        reconcileGhostClone('boot');
        var job0 = loadJob();
        if (job0 && job0.step === 'apply' && jobIsFresh(job0)) ensureApplyNudge();
        else if (!job0) setRunning(false);
        resumeJob();
      } catch (e) {}
    }, 900);
  }

  window.ProfileClone = {
    needsRun: needsRun,
    isRunning: isRunning,
    getState: getState,
    getSourceHandle: getSourceHandle,
    statusLabel: statusLabel,
    ensureBeforeNurture: ensureBeforeNurture,
    resume: resumeJob,
    abort: abort,
    /** 控制台强制清状态后补图：ProfileClone.resetMedia() */
    resetMedia: function () {
      clearMediaCache(null);
      setState({
        done: false,
        failed: false,
        skipped: false,
        textDone: true,
        mediaDone: false,
        mediaPartial: true,
        attempts: 0,
        lastError: '',
        lastPayload: null,
        forceRerun: true
      });
      return getState();
    },
    /** 整份重克隆（名/简介/头像/横幅）；Day>2 也跑：ProfileClone.resetAll() */
    resetAll: function () {
      clearMediaCache(null);
      setState({
        done: false,
        failed: false,
        skipped: false,
        textDone: false,
        mediaDone: false,
        mediaPartial: false,
        attempts: 0,
        lastError: '',
        lastPayload: null,
        reason: '',
        forceRerun: true
      });
      return getState();
    },
    MAX_ATTEMPTS: MAX_ATTEMPTS
  };
  scheduleBoot();
})();

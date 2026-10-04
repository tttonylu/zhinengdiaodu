// =============================================================================
// 智能调度 — 控制面板 UI（双圆形按钮 + 可展开详情面板）
// 按钮1：启动/暂停（圆形，一键切换）
// 按钮2：详情面板（圆形齿轮，点击展开/收起浮动面板）
// =============================================================================

(function () {
  'use strict';

  if (document.getElementById('sg-fab-run')) return;

  var CACHE_KEY = 'sg_panel_data_cache';

  // 从本地缓存加载数据
  var data = (function () {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return {};
  })();

  var runBtn = null;      // 启动/暂停按钮
  var gearBtn = null;     // 设置按钮
  var detailPanel = null; // 详情浮动面板
  var panelOpen = false;
  var didDrag = false;
  var activeTab = 'quota'; // quota | logs | settings

  // 保存数据到本地缓存
  function saveCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    } catch (e) {}
  }

  // ==================== 工具函数 ====================

  function getSwitches() {
    try {
      var raw = localStorage.getItem('sg_module_switches');
      return raw ? JSON.parse(raw) : { nurture: true, follow: true, chat: true, repost: true };
    } catch (e) { return { nurture: true, follow: true, chat: true, repost: true }; }
  }

  function updateToggleBtns(sw) {
    var m = ['nu', 'fw', 'ch', 'rp'];
    var k = ['nurture', 'follow', 'chat', 'repost'];
    var labels = ['养号', '关注', '私信', '转帖'];
    for (var i = 0; i < m.length; i++) {
      var btn = document.getElementById('btn-toggle-' + m[i]);
      if (!btn) continue;
      if (sw[k[i]] !== false) {
        btn.classList.add('sg-toggle-on');
        btn.classList.remove('sg-toggle-off');
        btn.textContent = labels[i] + ' ON';
      } else {
        btn.classList.add('sg-toggle-off');
        btn.classList.remove('sg-toggle-on');
        btn.textContent = labels[i] + ' OFF';
      }
    }
  }

  function setSwitch(module, val) {
    var sw = getSwitches();
    sw[module] = val;
    localStorage.setItem('sg_module_switches', JSON.stringify(sw));
    updateToggleBtns(sw);
  }

  function getRepostTargetList() {
    var list = [];
    try {
      if (typeof RepostTracker !== 'undefined' && RepostTracker.getTargets) {
        list = RepostTracker.getTargets() || [];
      } else {
        list = JSON.parse(localStorage.getItem('sg_repost_targets') || '[]') || [];
      }
    } catch (e) { list = []; }
    if (!Array.isArray(list)) list = [];
    return list.map(function (h) {
      return String(h || '').replace(/^@/, '').toLowerCase().trim();
    }).filter(Boolean);
  }

  function refreshRepostTargetsRow() {
    var countEl = document.getElementById('v-rp-tg-count');
    var listEl = document.getElementById('v-rp-tg-list');
    var list = getRepostTargetList();
    if (countEl) countEl.textContent = String(list.length);
    if (listEl) {
      if (!list.length) {
        listEl.innerHTML = '<span style="color:#f0883e">暂无来源</span>';
      } else {
        listEl.innerHTML = list.map(function (h) {
          return '<button type="button" class="sg-rp-tg-chip" data-handle="' + h + '" '
            + 'style="font-size:9px;background:#21262d;color:#58a6ff;border:1px solid #30363d;'
            + 'border-radius:3px;padding:1px 5px;cursor:pointer;margin:1px">'
            + '@' + h + '</button>';
        }).join('');
      }
    }
  }

  function pullRepostTargetsFromOps() {
    var msg = document.getElementById('sg-cmd-msg');
    var setMsg = function (text, color) {
      if (!msg) return;
      msg.textContent = text;
      msg.style.color = color || '#8b949e';
    };
    if (typeof ConfigSync === 'undefined' || !ConfigSync.fetchRemote) {
      setMsg('ConfigSync 未就绪', '#f85149');
      return;
    }
    setMsg('拉取中…', '#d29922');
    var settled = false;
    var finish = function () {
      if (settled) return;
      settled = true;
      try { window.removeEventListener('sg-config-synced', onSynced); } catch (eR) {}
      try { refreshRepostTargetsRow(); } catch (e3) {}
      var n = getRepostTargetList().length;
      if (n) setMsg('已同步 ' + n + ' 个', '#3fb950');
      else setMsg('仍无来源', '#f0883e');
    };
    var onSynced = function () { finish(); };
    try { window.addEventListener('sg-config-synced', onSynced); } catch (eA) {}
    try { ConfigSync.fetchRemote(); } catch (eF) {
      setMsg('拉取失败', '#f85149');
      settled = true;
      return;
    }
    setTimeout(finish, 3500);
  }

  function loadBtnPos(key, defaultPos) {
    try {
      var p = JSON.parse(localStorage.getItem(key) || '{}');
      if (p && p.left) return p;
    } catch (e) {}
    return defaultPos;
  }

  function saveBtnPos(btn, key) {
    if (!btn) return;
    localStorage.setItem(key, JSON.stringify({
      left: btn.style.left,
      top: btn.style.top
    }));
  }

  function getStatusClass() {
    var d = data || {};
    var cls = 'sg-status-idle';

    var soft = d.softRisk;
    var fz = d.chatFreeze;
    var hasErr = d.isWorkTime === false && d.autoMode;
    var hasWarn = (soft && soft.active) || (fz && fz.frozen) ||
      (d.diagFreeze && d.diagFreeze.on) ||
      (d.autoMode && d.whyIdle && !d.runningModule);

    var moduleBusy = !!(d.runningModule || d.followRunning || d.chatRunning ||
      d.nurtureRunning || d.repostRunning);
    var engineBusy = !!(d.engine && d.engine !== 'idle' && d.engine !== 'manual' &&
      d.engine !== 'coor');
    var running = moduleBusy || engineBusy;

    if (hasErr) cls = 'sg-status-err';
    else if (hasWarn) cls = 'sg-status-warn';
    else if (running) cls = 'sg-status-run';
    else cls = 'sg-status-idle';

    return cls;
  }

  function updateRunBtnStatus() {
    if (!runBtn) return;
    var d = data || {};
    var isRunning = !!(d.autoMode || d.runningModule || d.followRunning ||
      d.chatRunning || d.nurtureRunning || d.repostRunning);
    var statusCls = getStatusClass();

    runBtn.classList.remove('sg-status-run', 'sg-status-idle', 'sg-status-warn', 'sg-status-err');
    runBtn.classList.remove('sg-fab-running', 'sg-fab-stopped');
    runBtn.classList.add(statusCls);

    if (isRunning) {
      runBtn.classList.add('sg-fab-running');
      runBtn.innerHTML = '<span class="sg-fab-icon">⏸</span>';
      runBtn.title = '点击暂停调度';
    } else {
      runBtn.classList.add('sg-fab-stopped');
      runBtn.innerHTML = '<span class="sg-fab-icon">▶</span>';
      runBtn.title = '点击启动调度';
    }
  }

  function flashCmd(ok, text) {
    var el = document.getElementById('sg-cmd-msg');
    if (!el) return;
    el.textContent = text || (ok ? '已发送' : '发送失败');
    el.style.color = ok ? '#3fb950' : '#f85149';
    clearTimeout(flashCmd._t);
    flashCmd._t = setTimeout(function () {
      if (el) el.textContent = '';
    }, 2500);
  }

  function sendCmd(action, label) {
    try {
      window.dispatchEvent(new CustomEvent('sg-page-cmd', { detail: { action: action } }));
      flashCmd(true, (label || action) + '：已下发');
    } catch (e) {
      flashCmd(false, (label || action) + '：' + (e && e.message ? e.message : '页面未响应'));
    }
  }

  function onTick(e) {
    var next = (e && e.detail) || {};
    for (var k in next) {
      if (Object.prototype.hasOwnProperty.call(next, k) && next[k] !== undefined) {
        data[k] = next[k];
      }
    }
    try { window._sgLastTick = data; } catch (eLt) {}
    saveCache();
    render();
  }

  function collectDiagExtra() {
    var extra = {
      moduleSwitches: getSwitches(),
      debtOnly: false,
      url: window.location.href
    };
    try { extra.debtOnly = sessionStorage.getItem('sg_debt_only') === 'true'; } catch (eD) {}
    try {
      if (typeof window.__matrix_console__ !== 'undefined' && window.__matrix_console__.diag) {
        extra.diag = window.__matrix_console__.diag();
      }
    } catch (eDiag) {}
    try {
      if (data && data.chatDiag) extra.chatDiag = data.chatDiag;
    } catch (eCd) {}
    return extra;
  }

  function refreshTelemetryRecent() {
    if (typeof SgTelemetry === 'undefined' || !SgTelemetry.getRecentSummaries) return;
    SgTelemetry.getRecentSummaries(5).then(function (lines) {
      var row = document.getElementById('row-tel-recent');
      var el = document.getElementById('v-tel-recent');
      if (!row || !el) return;
      if (!lines || !lines.length) {
        row.style.display = 'none';
        return;
      }
      row.style.display = 'block';
      el.innerHTML = lines.map(function (l) { return '<div>' + String(l).replace(/</g, '&lt;') + '</div>'; }).join('');
    });
  }

  function updateDryRunBtn() {
    var btn = document.getElementById('btn-dry-run');
    if (!btn) return;
    var on = false;
    try { on = sessionStorage.getItem('sg_chat_dry_run') === 'true'; } catch (e) {}
    btn.style.color = on ? '#d2a8ff' : '#8b949e';
    btn.style.borderColor = on ? '#8957e5' : '#30363d';
    btn.textContent = on ? '干跑ON' : '干跑预览';
  }

  function updateTest24hBtn() {
    var btn = document.getElementById('btn-24h-test');
    if (!btn) return;
    var on = false;
    try { on = localStorage.getItem('sg_test_24h') === 'true'; } catch (e) {}
    btn.style.color = on ? '#3fb950' : '#8b949e';
    btn.style.borderColor = on ? '#238636' : '#30363d';
    btn.textContent = on ? '24h测试ON' : '24h测试';
  }

  function updateTestMonitorUi() {
    var btn = document.getElementById('btn-test-monitor');
    var rowStats = document.getElementById('row-test-monitor');
    var rowLog = document.getElementById('row-test-monitor-log');
    var statsEl = document.getElementById('v-test-monitor-stats');
    if (!btn) return;
    var on = false;
    var sess = null;
    try {
      if (typeof SgTestMonitor !== 'undefined') {
        on = SgTestMonitor.isActive();
        sess = SgTestMonitor.getSession();
      }
    } catch (e) {}
    btn.style.color = on ? '#3fb950' : '#8b949e';
    btn.style.borderColor = on ? '#238636' : '#30363d';
    btn.textContent = on ? '日志常态ON' : '日志常态';
    var hasData = sess && sess.records && sess.records.length > 0;
    var showData = on || hasData;
    if (rowStats) rowStats.style.display = showData ? 'flex' : 'none';
    if (rowLog) rowLog.style.display = on ? 'block' : 'none';
    var rowBtns = document.getElementById('row-test-monitor-btns');
    if (rowBtns) rowBtns.style.display = showData ? 'flex' : 'none';
    if (statsEl && sess && sess.summary) {
      var s = sess.summary;
      statsEl.textContent = '记录 ' + (sess.records ? sess.records.length : 0)
        + ' · 错误 ' + (sess.errors ? sess.errors.length : 0)
        + ' · 状态变 ' + (s.state_changes || 0);
    }
    if (rowLog && on && typeof SgTestMonitor !== 'undefined' && SgTestMonitor.getRecent) {
      var recent = SgTestMonitor.getRecent(3);
      if (!recent || !recent.length) {
        rowLog.innerHTML = '<div style="color:#484f58">等待事件…</div>';
        return;
      }
      rowLog.innerHTML = recent.map(function (r) {
        var hint = '';
        if (r.type === 'state_change' && r.data && r.data.diff) {
          var keys = Object.keys(r.data.diff);
          if (keys.length) hint = keys[0] + ':' + JSON.stringify(r.data.diff[keys[0]]);
        } else if (r.type === 'lifecycle' && r.data) {
          hint = r.data.event || '';
        } else if (r.type === 'telemetry' && r.data) {
          hint = r.data.label_zh || r.data.event_id || '';
        } else if (r.type === 'diagnostic' && r.data) {
          hint = r.data.text || '';
        } else if (r.type === 'error' && r.data) {
          hint = r.data.message || '';
        }
        hint = String(hint).slice(0, 60).replace(/</g, '&lt;');
        return '<div><span style="color:#58a6ff">' + r.type + '</span> ' + hint + '</div>';
      }).join('');
    }
  }

  function updateDebtOnlyBtn() {
    var btn = document.getElementById('btn-debt-only');
    if (!btn) return;
    try { sessionStorage.setItem('sg_debt_only', 'false'); } catch (e) {}
    btn.disabled = true;
    btn.style.opacity = '0.45';
    btn.style.color = '#8b949e';
    btn.style.borderColor = '#30363d';
    btn.textContent = '已关清债';
    btn.title = '清债/赶工已停用：软风控内短扫回复';
  }

  function updateNewAcctReadyUi() {
    try {
      var el = document.getElementById('v-newacct-detail');
      if (!el) return;
      var row = document.getElementById('row-newacct-detail');
      var h = (localStorage.getItem('matrix_my_handle') || '').replace(/^@/, '').replace(/#guard$/i, '').toLowerCase();
      var day = 1;
      try { day = parseInt((JSON.parse(localStorage.getItem('matrix_stats_' + h) || '{}')).day_count, 10) || 1; } catch (eD) {}

      if (day >= 2) {
        if (row) row.style.display = 'none';
        return;
      }
      if (row) row.style.display = '';

      var manuallyReady = false;
      try { manuallyReady = localStorage.getItem('sg_newacct_ready_' + h) === '1'; } catch (eM) {}
      if (manuallyReady) {
        el.textContent = '已就绪（手动）';
        el.style.color = '#3fb950';
        return;
      }

      var profileOk = false;
      try {
        var pcs = localStorage.getItem('sg_profile_clone_state_' + h);
        if (pcs) {
          var st = JSON.parse(pcs);
          if (st && (st.done || st.textDone)) profileOk = true;
        }
      } catch (eP) {}

      var postOk = false;
      try {
        if (typeof RepostTracker !== 'undefined' && RepostTracker.hasPostedOk) postOk = !!RepostTracker.hasPostedOk();
        else postOk = localStorage.getItem('sg_repost_posted_ok_' + h) === '1';
      } catch (ePost) {}

      if (profileOk && postOk) {
        el.textContent = '已就绪';
        el.style.color = '#3fb950';
      } else {
        var parts = [];
        if (!profileOk) parts.push('资料');
        if (!postOk) parts.push('发帖');
        el.textContent = '缺' + parts.join('+');
        el.style.color = '#f85149';
      }
    } catch (e) {}
  }

  function guardChatDayOrFlash(label) {
    return true;
  }

  function waitForBody(fn) {
    if (document.body) { fn(); return; }
    setTimeout(function () { waitForBody(fn); }, 100);
  }

  // ==================== 拖拽支持 ====================

  function makeDraggable(btn, storageKey) {
    var dragEl = null, dragStartX = 0, dragStartY = 0, dragOrigX = 0, dragOrigY = 0;
    var DRAG_THRESH = 4;

    function onDown(e) {
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
      e.preventDefault();
      dragEl = btn;
      didDrag = false;
      var clientX = e.touches ? e.touches[0].clientX : e.clientX;
      var clientY = e.touches ? e.touches[0].clientY : e.clientY;
      dragStartX = clientX;
      dragStartY = clientY;
      dragOrigX = parseInt(btn.style.left, 10) || 0;
      dragOrigY = parseInt(btn.style.top, 10) || 0;
      btn.style.transition = 'none';
    }

    function onMove(e) {
      if (!dragEl) return;
      var clientX = e.touches ? e.touches[0].clientX : e.clientX;
      var clientY = e.touches ? e.touches[0].clientY : e.clientY;
      var dx = clientX - dragStartX, dy = clientY - dragStartY;
      if (!didDrag && (Math.abs(dx) > DRAG_THRESH || Math.abs(dy) > DRAG_THRESH)) didDrag = true;
      if (!didDrag) return;
      dragEl.style.left = Math.max(0, dragOrigX + dx) + 'px';
      dragEl.style.top = Math.max(0, dragOrigY + dy) + 'px';
      var maxX = window.innerWidth - dragEl.offsetWidth;
      if (parseInt(dragEl.style.left, 10) > maxX) dragEl.style.left = maxX + 'px';
      var maxY = window.innerHeight - dragEl.offsetHeight;
      if (parseInt(dragEl.style.top, 10) > maxY) dragEl.style.top = maxY + 'px';

      // 面板跟随齿轮按钮
      if (btn === gearBtn && panelOpen && detailPanel) {
        positionDetailPanel();
      }
    }

    function onUp() {
      if (!dragEl) return;
      dragEl.style.transition = '';
      if (didDrag) saveBtnPos(dragEl, storageKey);
      dragEl = null;
      setTimeout(function () { didDrag = false; }, 0);
    }

    btn.addEventListener('mousedown', onDown);
    btn.addEventListener('touchstart', onDown, { passive: false });
    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchend', onUp);
  }

  function clampToViewport(btn) {
    if (!btn) return;
    var btnW = btn.offsetWidth || 28;
    var btnH = btn.offsetHeight || 28;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var left = parseInt(btn.style.left, 10) || 0;
    var top = parseInt(btn.style.top, 10) || 0;
    if (left < 0) left = 12;
    if (top < 0) top = 12;
    if (left > vw - btnW) left = Math.max(0, vw - btnW - 12);
    if (top > vh - btnH) top = Math.max(0, vh - btnH - 12);
    btn.style.left = left + 'px';
    btn.style.top = top + 'px';
  }

  function resetBtnPositions() {
    if (!runBtn || !gearBtn) return;
    runBtn.style.left = '12px';
    runBtn.style.top = '50px';
    gearBtn.style.left = '12px';
    gearBtn.style.top = '84px';
    try {
      localStorage.removeItem('sg_fab_run_pos');
      localStorage.removeItem('sg_fab_gear_pos');
    } catch (e) {}
    if (panelOpen && detailPanel) positionDetailPanel();
  }

  // ==================== 详情面板 ====================

  function positionDetailPanel() {
    if (!detailPanel || !gearBtn) return;
    var gearRect = gearBtn.getBoundingClientRect();
    var panelW = 280;
    var panelH = Math.min(detailPanel.scrollHeight || 400, window.innerHeight * 0.7);

    // 默认在齿轮按钮右边
    var left = gearRect.right + 8;
    var top = gearRect.top;

    // 如果右边放不下，放左边
    if (left + panelW > window.innerWidth - 8) {
      left = gearRect.left - panelW - 8;
    }
    // 如果左边也放不下，贴右边缘
    if (left < 8) left = 8;

    // 垂直方向：如果下面放不下，向上对齐
    if (top + panelH > window.innerHeight - 8) {
      top = window.innerHeight - panelH - 8;
    }
    if (top < 8) top = 8;

    detailPanel.style.left = left + 'px';
    detailPanel.style.top = top + 'px';
  }

  function toggleDetailPanel() {
    if (!detailPanel) {
      buildDetailPanel();
    }
    panelOpen = !panelOpen;
    if (panelOpen) {
      detailPanel.classList.add('sg-show');
      gearBtn.classList.add('sg-panel-open');
      positionDetailPanel();
      refreshPanelData();
    } else {
      detailPanel.classList.remove('sg-show');
      gearBtn.classList.remove('sg-panel-open');
    }
  }

  function closeDetailPanel() {
    if (detailPanel && panelOpen) {
      panelOpen = false;
      detailPanel.classList.remove('sg-show');
      gearBtn.classList.remove('sg-panel-open');
    }
  }

  function switchDetailTab(tab) {
    activeTab = tab;
    if (!detailPanel) return;
    var tabs = detailPanel.querySelectorAll('.sg-tab-btn');
    var panels = detailPanel.querySelectorAll('.sg-tab-panel');
    tabs.forEach(function (t) {
      if (t.dataset.tab === tab) {
        t.classList.add('sg-tab-active');
      } else {
        t.classList.remove('sg-tab-active');
      }
    });
    panels.forEach(function (p) {
      if (p.id === 'sg-tab-' + tab) {
        p.style.display = 'block';
      } else {
        p.style.display = 'none';
      }
    });
  }

  function refreshPanelData() {
    try { updateToggleBtns(getSwitches()); } catch (e) {}
    try { updateDebtOnlyBtn(); updateDryRunBtn(); updateTest24hBtn(); updateTestMonitorUi(); } catch (e) {}
    try { refreshRepostTargetsRow(); } catch (e) {}
    try { refreshTelemetryRecent(); } catch (e) {}
    try { updateNewAcctReadyUi(); } catch (e) {}
    try {
      chrome.runtime.sendMessage({ action: 'get_servers' }, function (r) {
        if (!r || !r.ok) return;
        var opsEl = document.getElementById('sg-ops-url');
        var poolEl = document.getElementById('sg-pool-url');
        if (opsEl) opsEl.value = r.ops_server || '';
        if (poolEl) poolEl.value = r.pool_server || '';
      });
    } catch (e) {}
  }

  function buildDetailPanel() {
    detailPanel = document.createElement('div');
    detailPanel.id = 'sg-detail-panel';
    detailPanel.className = 'sg-detail-panel';
    detailPanel.innerHTML = ''
      + '<div class="sg-panel-header">'
      + '  <span class="sg-panel-title">智能调度</span>'
      + '  <span class="sg-panel-version" id="v-ext-ver-detail">--</span>'
      + '</div>'
      + '<div class="sg-panel-tabs">'
      + '  <button type="button" class="sg-tab-btn sg-tab-active" data-tab="quota">📊 明细</button>'
      + '  <button type="button" class="sg-tab-btn" data-tab="logs">📋 日志</button>'
      + '  <button type="button" class="sg-tab-btn" data-tab="settings">⚙ 设置</button>'
      + '</div>'
      + '<div class="sg-panel-body">'

      // ===== 标签页1：明细配额 =====
      + '  <div class="sg-tab-panel" id="sg-tab-quota">'
      + '    <div class="sg-quota-section">'
      + '      <div class="sg-quota-title">关注</div>'
      + '      <div class="sg-quota-row">'
      + '        <span class="sg-quota-label">今日已关注</span>'
      + '        <span class="sg-quota-val" id="v-quota-follow">0 / 200</span>'
      + '      </div>'
      + '      <div class="sg-progress"><div class="sg-fill" id="v-quota-follow-bar" style="width:0%"></div></div>'
      + '      <div class="sg-quota-row">'
      + '        <span class="sg-quota-label">当前轮次</span>'
      + '        <span class="sg-quota-val" id="v-quota-round">--</span>'
      + '      </div>'
      + '    </div>'

      + '    <div class="sg-quota-section">'
      + '      <div class="sg-quota-title">私信</div>'
      + '      <div class="sg-quota-row">'
      + '        <span class="sg-quota-label">状态</span>'
      + '        <span class="sg-quota-val" id="v-quota-chat">--</span>'
      + '      </div>'
      + '      <div class="sg-quota-row" id="row-chat-min-detail" style="display:none">'
      + '        <span class="sg-quota-label">私信时长</span>'
      + '        <span class="sg-quota-val" id="v-chat-min-detail">--</span>'
      + '      </div>'
      + '      <div class="sg-quota-row" id="row-chat-debt-detail" style="display:none">'
      + '        <span class="sg-quota-label">债务</span>'
      + '        <span class="sg-quota-val" id="v-chat-debt-detail">--</span>'
      + '      </div>'
      + '      <div class="sg-quota-row">'
      + '        <span class="sg-quota-label">话术池</span>'
      + '        <span class="sg-quota-val" id="v-script-pool-detail">--</span>'
      + '      </div>'
      + '    </div>'

      + '    <div class="sg-quota-section">'
      + '      <div class="sg-quota-title">养号</div>'
      + '      <div class="sg-quota-row">'
      + '        <span class="sg-quota-label">今日点赞</span>'
      + '        <span class="sg-quota-val" id="v-quota-nurture">--</span>'
      + '      </div>'
      + '    </div>'

      + '    <div class="sg-quota-section">'
      + '      <div class="sg-quota-title">转帖</div>'
      + '      <div class="sg-quota-row">'
      + '        <span class="sg-quota-label">今日转帖</span>'
      + '        <span class="sg-quota-val" id="v-quota-repost">--</span>'
      + '      </div>'
      + '      <div class="sg-quota-row">'
      + '        <span class="sg-quota-label">来源数量</span>'
      + '        <span class="sg-quota-val" id="v-rp-tg-count">0</span>'
      + '      </div>'
      + '      <div id="v-rp-tg-list" style="margin-top:4px;display:flex;flex-wrap:wrap;gap:1px;min-height:1.2em"></div>'
      + '      <div class="sg-btns" style="margin-top:6px">'
      + '        <button type="button" class="sg-outline" id="btn-rp-pull" style="font-size:9px">拉取来源</button>'
      + '        <button type="button" class="sg-outline" id="btn-rp-manual" style="font-size:9px;border-color:#58a6ff;color:#58a6ff">只转帖</button>'
      + '      </div>'
      + '    </div>'

      + '    <div class="sg-quota-section">'
      + '      <div class="sg-quota-title">账号</div>'
      + '      <div class="sg-quota-row">'
      + '        <span class="sg-quota-label">天数</span>'
      + '        <span class="sg-quota-val" id="v-quota-day">Day 1</span>'
      + '      </div>'
      + '      <div class="sg-quota-row" id="row-newacct-detail">'
      + '        <span class="sg-quota-label">新号就绪</span>'
      + '        <span class="sg-quota-val" id="v-newacct-detail">--</span>'
      + '      </div>'
      + '      <div class="sg-quota-row" id="row-pc-detail" style="display:none">'
      + '        <span class="sg-quota-label">资料克隆</span>'
      + '        <span class="sg-quota-val" id="v-pc-detail">--</span>'
      + '      </div>'
      + '      <div class="sg-quota-row">'
      + '        <span class="sg-quota-label">引擎状态</span>'
      + '        <span class="sg-quota-val" id="v-quota-engine">--</span>'
      + '      </div>'
      + '    </div>'

      + '    <div id="sg-cmd-msg" class="sg-cmd-msg"></div>'
      + '  </div>'

      // ===== 标签页2：日志报错 =====
      + '  <div class="sg-tab-panel" id="sg-tab-logs" style="display:none">'
      + '    <div class="sg-quota-section">'
      + '      <div class="sg-quota-title">诊断工具</div>'
      + '      <div class="sg-btns" style="margin-top:4px">'
      + '        <button class="sg-outline" id="btn-diag-upload" style="font-size:9px">上报诊断</button>'
      + '        <button class="sg-outline" id="btn-diag-copy" style="font-size:9px">复制诊断</button>'
      + '        <button class="sg-outline" id="btn-diag-unfreeze" style="font-size:9px;display:none;border-color:#f85149;color:#f85149">解除冻结</button>'
      + '        <button class="sg-outline" id="btn-reply-trace" style="font-size:9px" title="链路诊断">回复链路</button>'
      + '      </div>'
      + '      <div id="sg-diag-freeze-bar" style="display:none;margin:6px 0 0;padding:6px;border:1px solid #f85149;border-radius:4px;background:rgba(248,81,73,.12);font-size:9px;color:#f85149;line-height:1.4"></div>'
      + '    </div>'

      + '    <div class="sg-quota-section">'
      + '      <div class="sg-quota-title">日志监控</div>'
      + '      <div class="sg-btns" style="margin-top:4px">'
      + '        <button class="sg-outline" id="btn-open-log" style="font-size:9px;width:100%">打开日志监视器</button>'
      + '      </div>'
      + '      <div class="sg-btns" style="margin-top:4px">'
      + '        <button class="sg-outline" id="btn-test-monitor" style="font-size:9px;width:100%">日志常态</button>'
      + '      </div>'
      + '      <div class="sg-row" id="row-test-monitor" style="display:none;margin-top:4px">'
      + '        <span class="lbl">日志统计</span>'
      + '        <span class="val" id="v-test-monitor-stats" style="font-size:9px;color:#8b949e">记录 0</span>'
      + '      </div>'
      + '      <div id="row-test-monitor-log" style="display:none;font-size:9px;color:#8b949e;line-height:1.5;max-height:60px;overflow:hidden;margin:4px 0 6px;padding-left:6px;border-left:2px solid rgba(56,139,253,0.45)"></div>'
      + '      <div class="sg-btns" id="row-test-monitor-btns" style="margin-top:4px;display:none">'
      + '        <button class="sg-outline" id="btn-test-export" style="font-size:9px">导出</button>'
      + '        <button class="sg-outline" id="btn-test-upload" style="font-size:9px">补传</button>'
      + '        <button class="sg-outline" id="btn-test-clear" style="font-size:9px">清空</button>'
      + '      </div>'
      + '    </div>'

      + '    <div class="sg-quota-section" id="row-tel-recent" style="display:none">'
      + '      <div class="sg-quota-title">最近日志</div>'
      + '      <div id="v-tel-recent" style="font-size:9px;color:#8b949e;line-height:1.5;margin-top:4px;max-height:80px;overflow:hidden"></div>'
      + '    </div>'
      + '  </div>'

      // ===== 标签页3：设置 =====
      + '  <div class="sg-tab-panel" id="sg-tab-settings" style="display:none">'
      + '    <div class="sg-quota-section">'
      + '      <div class="sg-quota-title">模块开关</div>'
      + '      <div class="sg-module-grid">'
      + '        <button class="sg-toggle-btn" id="btn-toggle-nu">养号 ON</button>'
      + '        <button class="sg-toggle-btn" id="btn-toggle-fw">关注 ON</button>'
      + '        <button class="sg-toggle-btn" id="btn-toggle-ch">私信 ON</button>'
      + '        <button class="sg-toggle-btn" id="btn-toggle-rp">转帖 ON</button>'
      + '      </div>'
      + '    </div>'

      + '    <div class="sg-quota-section">'
      + '      <div class="sg-quota-title">手动模式</div>'
      + '      <div class="sg-btns" style="margin-top:4px">'
      + '        <button class="sg-outline" id="btn-fw">只关注</button>'
      + '        <button class="sg-outline" id="btn-ch">只私信</button>'
      + '        <button class="sg-outline" id="btn-ch-test" title="私信测试">私信测试</button>'
      + '      </div>'
      + '      <div class="sg-btns" style="margin-top:4px">'
      + '        <button class="sg-outline" id="btn-nu">纯养号</button>'
      + '        <button class="sg-outline" id="btn-rp">只转帖</button>'
      + '        <button class="sg-outline" id="btn-dry-run" title="干跑预览">干跑预览</button>'
      + '      </div>'
      + '      <div class="sg-btns" style="margin-top:4px">'
      + '        <button class="sg-outline" id="btn-24h-test" title="24h测试模式">24h测试</button>'
      + '        <button class="sg-outline" id="btn-debt-only" disabled>已关清债</button>'
      + '      </div>'
      + '      <div class="sg-btns" style="margin-top:4px">'
      + '        <button class="sg-outline" id="btn-mark-ready" title="标记新号为已就绪" style="font-size:9px;border-color:#3fb950;color:#3fb950">标记就绪</button>'
      + '        <button class="sg-outline" id="btn-mark-posted" title="标记本号已发过帖" style="font-size:9px;border-color:#3fb950;color:#3fb950">标记已发帖</button>'
      + '      </div>'
      + '    </div>'

      + '    <div class="sg-quota-section">'
      + '      <div class="sg-quota-title">服务器地址</div>'
      + '      <div style="margin-top:4px;display:flex;flex-direction:column;gap:4px">'
      + '        <label style="display:block;font-size:9px;color:#8b949e">OPS'
      + '          <input id="sg-ops-url" type="text" spellcheck="false" '
      + '            style="width:100%;box-sizing:border-box;margin-top:2px;padding:3px 6px;border-radius:3px;border:1px solid #30363d;background:#0d1117;color:#c9d1d9;font-size:9px">'
      + '        </label>'
      + '        <label style="display:block;font-size:9px;color:#8b949e">号池'
      + '          <input id="sg-pool-url" type="text" spellcheck="false" '
      + '            style="width:100%;box-sizing:border-box;margin-top:2px;padding:3px 6px;border-radius:3px;border:1px solid #30363d;background:#0d1117;color:#c9d1d9;font-size:9px">'
      + '        </label>'
      + '        <button type="button" id="sg-save-servers" class="sg-outline" style="width:100%;padding:3px 0;font-size:9px">保存地址</button>'
      + '        <span id="sg-servers-hint" style="font-size:8px;color:#8b949e;line-height:1.4">默认内网；不通自动：号池 haochi1 / OPS kongzhi1</span>'
      + '        <span id="sg-servers-msg" style="font-size:9px;min-height:1.2em"></span>'
      + '      </div>'
      + '    </div>'
      + '  </div>'

      + '</div>';

    document.body.appendChild(detailPanel);

    // 标签页切换
    var tabBtns = detailPanel.querySelectorAll('.sg-tab-btn');
    tabBtns.forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        switchDetailTab(btn.dataset.tab);
      });
    });

    // 点击面板内部不冒泡到 body
    detailPanel.addEventListener('click', function (e) {
      e.stopPropagation();
    });

    // 绑定各种按钮事件
    bindDetailEvents();

    // 版本号
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
        var verEl = document.getElementById('v-ext-ver-detail');
        if (verEl) verEl.textContent = 'v' + chrome.runtime.getManifest().version;
      }
    } catch (e) {}
  }

  function bindDetailEvents() {
    // 模块开关
    bindElClick('btn-toggle-nu', function () {
      var sw = getSwitches(); setSwitch('nurture', sw.nurture === false);
    });
    bindElClick('btn-toggle-fw', function () {
      var sw = getSwitches(); setSwitch('follow', sw.follow === false);
    });
    bindElClick('btn-toggle-ch', function () {
      var sw = getSwitches(); setSwitch('chat', sw.chat === false);
    });
    bindElClick('btn-toggle-rp', function () {
      var sw = getSwitches(); setSwitch('repost', sw.repost === false);
    });

    // 手动模式
    bindElClick('btn-fw', function () { sendCmd('sg_manual_follow', '只关注'); });
    bindElClick('btn-ch', function () {
      if (guardChatDayOrFlash('只私信')) return;
      sendCmd('sg_manual_chat', '只私信');
    });
    bindElClick('btn-ch-test', function () {
      if (!guardChatDayOrFlash('私信测试')) return;
      try {
        sessionStorage.setItem('sg_chat_force_inbox', 'true');
        sessionStorage.removeItem('sg_debt_only');
        window.dispatchEvent(new CustomEvent('sg-chat-test-command'));
        flashCmd(true, '私信测试：已触发');
      } catch (e) {
        flashCmd(false, '私信测试触发失败');
      }
    });
    bindElClick('btn-dry-run', function () {
      try {
        var on = sessionStorage.getItem('sg_chat_dry_run') === 'true';
        sessionStorage.setItem('sg_chat_dry_run', on ? 'false' : 'true');
        flashCmd(true, on ? '干跑 OFF' : '干跑 ON');
        updateDryRunBtn();
      } catch (e) { flashCmd(false, '干跑切换失败'); }
    });
    bindElClick('btn-24h-test', function () {
      try {
        var on = localStorage.getItem('sg_test_24h') === 'true';
        localStorage.setItem('sg_test_24h', on ? 'false' : 'true');
        flashCmd(true, on ? '24h测试 OFF' : '24h测试 ON');
        updateTest24hBtn();
      } catch (e) { flashCmd(false, '24h测试切换失败'); }
    });
    bindElClick('btn-debt-only', function () {
      flashCmd(false, '清债已停用（软风控短扫）');
      updateDebtOnlyBtn();
    });
    bindElClick('btn-nu', function () { sendCmd('sg_nurture_only', '纯养号'); });
    bindElClick('btn-rp', function () { sendCmd('sg_manual_repost', '只转帖'); });
    bindElClick('btn-mark-ready', function () {
      try {
        var h = (localStorage.getItem('matrix_my_handle') || '').replace(/^@/, '').replace(/#guard$/i, '').toLowerCase();
        if (!h || h === 'unknown') { flashCmd(false, '未识别账号'); return; }
        localStorage.setItem('sg_newacct_ready_' + h, '1');
        flashCmd(true, '已标记新号就绪');
        updateNewAcctReadyUi();
      } catch (e) { flashCmd(false, '标记失败'); }
    });
    bindElClick('btn-mark-posted', function () {
      try {
        var hs = [];
        if (typeof RepostTracker !== 'undefined' && RepostTracker.markOwnPosted) {
          hs = RepostTracker.markOwnPosted() || [];
        } else {
          var h = (localStorage.getItem('matrix_my_handle') || '').replace(/^@/, '').replace(/#guard$/i, '').toLowerCase().trim();
          if (h && h !== 'unknown') { localStorage.setItem('sg_repost_posted_ok_' + h, '1'); hs = [h]; }
        }
        if (!hs.length) { flashCmd(false, '未识别账号'); return; }
        flashCmd(true, '已标记已发帖');
        updateNewAcctReadyUi();
      } catch (e) { flashCmd(false, '标记失败'); }
    });

    // 转帖
    bindElClick('btn-rp-pull', function () { pullRepostTargetsFromOps(); });
    bindElClick('btn-rp-manual', function () { sendCmd('sg_manual_repost', '手动只转帖'); });

    // 诊断
    bindElClick('btn-diag-upload', function () {
      if (typeof SgTelemetry === 'undefined' || !SgTelemetry.uploadSnapshot) {
        flashCmd(false, '观测模块未加载'); return;
      }
      if (SgTelemetry.getBotId && SgTelemetry.getBotId() === 'unknown') {
        flashCmd(false, '账号未识别'); return;
      }
      flashCmd(true, '打包中…');
      SgTelemetry.uploadSnapshot(collectDiagExtra()).then(function (result) {
        var sid = result && result.response && result.response.snapshot_id;
        flashCmd(true, sid ? ('已上报 #' + sid) : '诊断已上报');
        refreshTelemetryRecent();
      }).catch(function (err) {
        var msg = '上报失败';
        if (err && err.message === 'account_unknown') msg = '账号未识别';
        else if (err && err.message === 'upload_in_progress') msg = '上次上报进行中';
        else if (err && err.response) {
          if (err.response.error === 'account_not_registered') msg = '账号未注册 OPS';
          else if (err.response.msg) msg = String(err.response.msg);
          else if (err.response.error) msg = String(err.response.error);
        } else if (err && err.message) msg = err.message;
        flashCmd(false, msg);
      });
    });
    bindElClick('btn-diag-unfreeze', function () {
      try {
        if (typeof SgDiagContract !== 'undefined' && SgDiagContract.clearFreeze) {
          SgDiagContract.clearFreeze('panel');
        } else if (typeof window.__sgDiagUnfreeze === 'function') {
          window.__sgDiagUnfreeze('panel');
        } else {
          sessionStorage.removeItem('sg_diag_freeze');
        }
        flashCmd(true, '已解除诊断冻结');
        var bar = document.getElementById('sg-diag-freeze-bar');
        var btn = document.getElementById('btn-diag-unfreeze');
        if (bar) bar.style.display = 'none';
        if (btn) btn.style.display = 'none';
      } catch (e) { flashCmd(false, '解冻失败'); }
    });
    bindElClick('btn-diag-copy', function () {
      if (typeof SgTelemetry === 'undefined' || !SgTelemetry.copySnapshotText) {
        flashCmd(false, '观测模块未加载'); return;
      }
      SgTelemetry.copySnapshotText(collectDiagExtra()).then(function () {
        flashCmd(true, '已复制到剪贴板');
      }).catch(function (err) {
        var msg = '复制失败';
        if (err && err.message === 'account_unknown') msg = '账号未识别';
        flashCmd(false, msg);
      });
    });
    bindElClick('btn-reply-trace', function (ev) {
      var handle = '';
      try { handle = sessionStorage.getItem('current_target') || ''; } catch (eCT) {}
      if (!handle) {
        try {
          var replyKey = (typeof SKeys !== 'undefined' && SKeys.LK_CHAT_REPLY_STATE) ? SKeys.LK_CHAT_REPLY_STATE : 'dan_reply_state';
          var rsFallback = JSON.parse(sessionStorage.getItem(replyKey) || localStorage.getItem(replyKey) || 'null');
          if (rsFallback && rsFallback.target) handle = rsFallback.target;
        } catch (eRSF) {}
      }
      if (!handle) { flashCmd(false, '无当前目标：先跑一轮私信'); return; }
      var bridge = window.__sgChatBridge || {};
      var useAsync = ev && ev.shiftKey && typeof bridge.debugTraceReplyChainAsync === 'function';
      if (!useAsync && typeof bridge.debugTraceReplyChain !== 'function') {
        flashCmd(false, '私信模块未就绪'); return;
      }
      if (useAsync) {
        flashCmd(true, '闭环诊断中…');
        bridge.debugTraceReplyChainAsync(handle, { navigate: true }).then(function (result) {
          var trace = (result && result.final) || result;
          if (result && result.pending) { flashCmd(true, '已导航，重载后继续…'); return; }
          if (!trace || trace.error) { flashCmd(false, '闭环诊断失败'); return; }
          flashCmd(true, '闭环完成 · ' + (trace.verdict || ''));
        }).catch(function (eAsync) {
          flashCmd(false, '闭环诊断异常');
        });
        return;
      }
      var trace = null;
      try { trace = bridge.debugTraceReplyChain(handle); } catch (eT) { trace = { error: String((eT && eT.message) || eT) }; }
      if (!trace || trace.error) { flashCmd(false, '诊断失败'); return; }
      flashCmd(true, trace.verdict || '诊断完成');
    });

    // 日志
    bindElClick('btn-open-log', function () {
      try {
        if (window.__matrix_console__ && typeof window.__matrix_console__.show === 'function') {
          window.__matrix_console__.show();
          flashCmd(true, '已打开日志监视器');
        } else {
          flashCmd(false, '日志模块未加载');
        }
      } catch (e) { flashCmd(false, '打开日志失败'); }
    });
    bindElClick('btn-test-monitor', function () {
      if (typeof SgTestMonitor === 'undefined') { flashCmd(false, '日志常态未加载'); return; }
      try {
        if (SgTestMonitor.isActive()) {
          flashCmd(true, '日志常态开启中');
        } else {
          SgTestMonitor.start('panel');
          flashCmd(true, '日志常态已恢复');
        }
        updateTestMonitorUi();
      } catch (e) { flashCmd(false, '切换失败'); }
    });
    bindElClick('btn-test-export', function () {
      if (typeof SgTestMonitor === 'undefined' || !SgTestMonitor.downloadJson) {
        flashCmd(false, '日志常态未加载'); return;
      }
      SgTestMonitor.downloadJson().then(function (res) {
        flashCmd(true, res && res.file ? ('已下载 ' + res.file) : '已导出 JSON');
      }).catch(function () { flashCmd(false, '导出失败'); });
    });
    bindElClick('btn-test-upload', function () {
      if (typeof SgTestMonitor === 'undefined' || !SgTestMonitor.uploadOps) {
        flashCmd(false, '日志常态未加载'); return;
      }
      flashCmd(true, '打包中…');
      SgTestMonitor.uploadOps().then(function (result) {
        var sid = result && result.response && result.response.snapshot_id;
        flashCmd(true, sid ? ('日志快照已上报 #' + sid) : '日志快照已上报');
      }).catch(function (err) {
        var msg = '上报失败';
        if (err && err.message) msg = err.message;
        flashCmd(false, msg);
      });
    });
    bindElClick('btn-test-clear', function () {
      if (typeof SgTestMonitor === 'undefined' || !SgTestMonitor.clear) {
        flashCmd(false, '日志常态未加载'); return;
      }
      SgTestMonitor.clear();
      flashCmd(true, '日志记录已清空');
      updateTestMonitorUi();
    });

    // 服务器
    bindElClick('sg-save-servers', function (e) {
      e.stopPropagation();
      var opsEl = document.getElementById('sg-ops-url');
      var poolEl = document.getElementById('sg-pool-url');
      var ops = ((opsEl && opsEl.value) || '').trim();
      var pool = ((poolEl && poolEl.value) || '').trim();
      var msg = document.getElementById('sg-servers-msg');
      function save() {
        chrome.runtime.sendMessage({ action: 'set_servers', ops_server: ops, pool_server: pool }, function (r) {
          if (msg) {
            msg.textContent = (r && r.ok) ? '已保存' : '保存失败';
            msg.style.color = (r && r.ok) ? '#3fb950' : '#f85149';
          }
        });
      }
      try {
        var origins = [];
        [ops, pool].forEach(function (u) {
          try {
            var url = new URL(/^https?:\/\//i.test(u) ? u : 'http://' + u);
            origins.push(url.protocol + '//' + url.host + '/*');
          } catch (e2) {}
        });
        if (origins.length && chrome.permissions && chrome.permissions.request) {
          chrome.permissions.contains({ origins: origins }, function (have) {
            if (have) return save();
            chrome.permissions.request({ origins: origins }, function (granted) {
              if (!granted && msg) {
                msg.textContent = '未授予主机权限，地址可能无法访问';
                msg.style.color = '#e3b341';
              }
              save();
            });
          });
          return;
        }
      } catch (ePerm) {}
      save();
    });

    // 转帖来源列表点击
    var listHost = document.getElementById('v-rp-tg-list');
    if (listHost && !listHost._sgBound) {
      listHost._sgBound = true;
      listHost.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t || !t.getAttribute) return;
        var h = t.getAttribute('data-handle');
        if (!h) return;
        ev.preventDefault();
        try {
          var url = 'https://x.com/' + h + '?lang=ja';
          if (typeof SchedulerGate !== 'undefined' && SchedulerGate.go) SchedulerGate.go('panel', url);
          else location.href = url;
        } catch (eGo) {
          try { location.href = 'https://x.com/' + h + '?lang=ja'; } catch (e2) {}
        }
      });
    }
  }

  function bindElClick(id, fn) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('click', fn);
    return el;
  }

  // ==================== 构建两个悬浮按钮 ====================

  waitForBody(build);

  function build() {
    // 按钮1：启动/暂停
    runBtn = document.createElement('div');
    runBtn.id = 'sg-fab-run';
    runBtn.className = 'sg-fab sg-fab-run sg-status-idle sg-fab-stopped';
    runBtn.innerHTML = '<span class="sg-fab-icon">▶</span>';
    runBtn.title = '点击启动调度（按 ` 键重置按钮位置）';
    document.body.appendChild(runBtn);

    // 按钮2：设置详情
    gearBtn = document.createElement('div');
    gearBtn.id = 'sg-fab-gear';
    gearBtn.className = 'sg-fab sg-fab-gear';
    gearBtn.innerHTML = '<span class="sg-fab-icon">⚙</span>';
    gearBtn.title = '设置与详情（按 ` 键重置按钮位置）';
    document.body.appendChild(gearBtn);

    // 加载位置
    var runPos = loadBtnPos('sg_fab_run_pos', { left: '12px', top: '50px' });
    runBtn.style.left = runPos.left || '12px';
    runBtn.style.top = runPos.top || '50px';

    var gearPos = loadBtnPos('sg_fab_gear_pos', null);
    if (gearPos && gearPos.left) {
      gearBtn.style.left = gearPos.left;
      gearBtn.style.top = gearPos.top;
    } else {
      gearBtn.style.left = runBtn.style.left;
      gearBtn.style.top = (parseInt(runBtn.style.top, 10) + 36) + 'px';
    }

    // 确保按钮在视口内
    setTimeout(function () {
      clampToViewport(runBtn);
      clampToViewport(gearBtn);
      updateRunBtnStatus();
      // 应用状态色到齿轮按钮
      var sc = getStatusClass();
      gearBtn.classList.remove('sg-status-run', 'sg-status-idle', 'sg-status-warn', 'sg-status-err');
      gearBtn.classList.add(sc);
    }, 50);

    // 窗口大小变化时重新约束位置
    window.addEventListener('resize', function () {
      clampToViewport(runBtn);
      clampToViewport(gearBtn);
      if (panelOpen && detailPanel) positionDetailPanel();
    });

    // 快捷键：按 ` 键重置按钮位置
    document.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
      if (e.key === '`' || e.key === '~') {
        e.preventDefault();
        resetBtnPositions();
      }
    });

    // 启动/暂停按钮点击
    runBtn.addEventListener('click', function (e) {
      if (didDrag) return;
      e.stopPropagation();
      var d = data || {};
      var isRunning = !!(d.autoMode || d.runningModule || d.followRunning ||
        d.chatRunning || d.nurtureRunning || d.repostRunning);
      if (isRunning) {
        try {
          data.autoMode = false;
          data.runningModule = '';
          data.engine = 'idle';
          data.followRunning = false;
          data.chatRunning = false;
          data.nurtureRunning = false;
          data.repostRunning = false;
          saveCache();
          updateRunBtnStatus();
        } catch (eUi) {}
        sendCmd('sg_scheduler_pause', '暂停');
      } else {
        sendCmd('sg_scheduler_start', '启动');
      }
    });

    // 设置按钮点击 - 展开/收起详情面板
    gearBtn.addEventListener('click', function (e) {
      if (didDrag) return;
      e.stopPropagation();
      toggleDetailPanel();
    });

    // 点击页面其他地方关闭面板
    document.addEventListener('click', function (e) {
      if (!panelOpen || !detailPanel) return;
      if (detailPanel.contains(e.target)) return;
      if (gearBtn.contains(e.target)) return;
      closeDetailPanel();
    });

    // 拖拽支持
    makeDraggable(runBtn, 'sg_fab_run_pos');
    makeDraggable(gearBtn, 'sg_fab_gear_pos');

    // 事件监听
    window.addEventListener('sg-coordinator-tick', onTick);
    window.addEventListener('sg-scheduler-tick', onTick);
    try {
      window.addEventListener('sg-telemetry', function () {
        if (panelOpen) refreshTelemetryRecent();
      });
    } catch (eTel) {}
    try {
      window.addEventListener('sg-test-monitor-update', function () {
        if (panelOpen) updateTestMonitorUi();
      });
    } catch (eTm) {}
    try {
      window.addEventListener('sg-config-synced', function () {
        if (panelOpen) refreshRepostTargetsRow();
      });
    } catch (eL) {}

    // 立即请求一次状态
    setTimeout(function () {
      try {
        chrome.runtime.sendMessage({ action: 'sg_scheduler_status' }, function (r) {
          if (r && !chrome.runtime.lastError) {
            onTick({ detail: r });
          }
        });
      } catch (e) {}
    }, 300);
  }

  // ==================== 渲染 ====================
  function render() {
    var d = data;
    if (!d) return;

    // 更新启动按钮状态
    updateRunBtnStatus();

    // 设置按钮状态色
    if (gearBtn) {
      var statusCls = getStatusClass();
      gearBtn.classList.remove('sg-status-run', 'sg-status-idle', 'sg-status-warn', 'sg-status-err');
      gearBtn.classList.add(statusCls);
    }

    // 如果面板打开，更新内容
    if (panelOpen && detailPanel) {
      renderDetailQuota(d);
      renderDetailLogs(d);
    }
  }

  function renderDetailQuota(d) {
    // 关注
    var qf = document.getElementById('v-quota-follow');
    if (qf) qf.textContent = (d.followedToday || 0) + ' / ' + (d.followLimit || 200);
    var qfBar = document.getElementById('v-quota-follow-bar');
    if (qfBar) {
      var pct = d.followLimit > 0 ? Math.min(100, ((d.followedToday || 0) / d.followLimit) * 100) : 0;
      qfBar.style.width = pct + '%';
    }
    var qr = document.getElementById('v-quota-round');
    if (qr) {
      if (d.warmupEndAt && d.warmupEndAt > 0 && (d.engine === 'nurture' || d.followPhase === 'warmup')) {
        var left = Math.max(0, Math.ceil((d.warmupEndAt - Date.now()) / 60000));
        qr.textContent = '养号 ' + left + '分后';
      } else {
        qr.textContent = (d.followRound > 0) ? '第' + d.followRound + '轮' : '--';
      }
    }

    // 私信
    var qc = document.getElementById('v-quota-chat');
    if (qc) qc.textContent = d.chatRunning ? '进行中' : '待机';
    var cd = d.chatDiag || null;
    var chatMinRow = document.getElementById('row-chat-min-detail');
    var chatMinEl = document.getElementById('v-chat-min-detail');
    if (chatMinRow && chatMinEl && cd) {
      chatMinRow.style.display = '';
      chatMinEl.textContent = '出' + (cd.chatOutboundTodayMin || 0) + ' / 箱' + (cd.chatInboxTodayMin || 0) + ' / 总' + (cd.chatTotalTodayMin || 0) + '分';
    } else if (chatMinRow) {
      chatMinRow.style.display = 'none';
    }
    var chatDebtRow = document.getElementById('row-chat-debt-detail');
    var chatDebtEl = document.getElementById('v-chat-debt-detail');
    if (chatDebtRow && chatDebtEl && cd) {
      chatDebtRow.style.display = '';
      var debtTxt = 'AD' + (cd.adDebt || 0) + ' K' + (cd.kickDebt || 0) + ' 冰' + (cd.icePending || 0);
      if (cd.replyPending) debtTxt += ' 待回' + cd.replyPending;
      if (cd.chatCooldownLeftMin) debtTxt += ' 冷却' + cd.chatCooldownLeftMin + '分';
      if (cd.slaOverdueCount) debtTxt += ' SLA!' + cd.slaOverdueCount;
      chatDebtEl.textContent = debtTxt;
    } else if (chatDebtRow) {
      chatDebtRow.style.display = 'none';
    }
    var spEl = document.getElementById('v-script-pool-detail');
    if (spEl) {
      var poolMode = 'dating';
      try {
        if (window.RemoteSettings && typeof window.RemoteSettings.chatScriptPool === 'function') {
          poolMode = window.RemoteSettings.chatScriptPool();
        } else {
          var thrPool = JSON.parse(localStorage.getItem('sg_config_thresholds') || '{}') || {};
          poolMode = String(thrPool.chat_script_pool || 'dating').toLowerCase() === 'job' ? 'job' : 'dating';
        }
      } catch (ePool) {}
      spEl.textContent = poolMode === 'job' ? '兼职粉·北京10–19点' : '交友';
      spEl.style.color = poolMode === 'job' ? '#d2a8ff' : '';
    }

    // 养号
    var qn = document.getElementById('v-quota-nurture');
    if (qn) {
      if (d.nurtureDaily) {
        qn.textContent = (d.nurtureDaily.likes || 0) + ' / ' + (d.nurtureDaily.likeBudget || '-');
      } else {
        qn.textContent = '--';
      }
    }

    // 转帖
    var qrp = document.getElementById('v-quota-repost');
    if (qrp) {
      if (d.repostDaily != null) {
        qrp.textContent = (d.repostDaily.used || 0) + ' / ' + (d.repostDaily.cap || '-');
      } else {
        qrp.textContent = '--';
      }
    }

    // 账号信息
    var qday = document.getElementById('v-quota-day');
    if (qday) qday.textContent = 'Day ' + (d.dayCount || 1);

    // 资料克隆
    var pcRow = document.getElementById('row-pc-detail');
    var pcEl = document.getElementById('v-pc-detail');
    if (pcRow && pcEl) {
      var pc = d.profileClone || null;
      var pcLabel = '';
      try {
        if (pc && pc.label) pcLabel = pc.label;
        else if (typeof ProfileClone !== 'undefined' && ProfileClone.statusLabel) pcLabel = ProfileClone.statusLabel();
      } catch (ePcL) {}
      var showPc = !!(pc && (pc.running || pc.needsRun || pc.done || pc.skipped || pc.failed || (pc.attempts > 0)));
      if (!showPc && pcLabel && pcLabel !== '未跑') showPc = true;
      if (showPc) {
        pcRow.style.display = '';
        pcEl.textContent = pcLabel || '--';
        if (pc && pc.running) pcEl.style.color = '#58a6ff';
        else if (pc && pc.failed) pcEl.style.color = '#f85149';
        else if (pc && (pc.done || pc.skipped)) pcEl.style.color = '#3fb950';
        else pcEl.style.color = '#d29922';
      } else {
        pcRow.style.display = 'none';
      }
    }

    // 引擎状态
    var engEl = document.getElementById('v-quota-engine');
    if (engEl) {
      var engText = '空闲';
      var rm = d.runningModule || '';
      if (rm === 'follow' || (!rm && d.followRunning && d.engine !== 'chat')) {
        engText = d.followPhase === 'warmup' ? '养号中' : ('关注轮' + (d.followRound || 1));
      } else if (rm === 'chat' || d.engine === 'chat' || d.chatRunning) {
        engText = '私信中';
      } else if (rm === 'nurture' || d.engine === 'nurture' || d.nurtureRunning) {
        engText = d.nurtureOnly ? '纯养号' : '养号中';
      } else if (rm === 'repost' || d.repostRunning) {
        engText = '转帖中';
      } else if (d.engine === 'coor' || d.autoMode) {
        engText = '自动调度';
      } else if (d.engine === 'manual') {
        engText = '手动模式';
      }
      engEl.textContent = engText;
    }

    updateNewAcctReadyUi();
    try { refreshRepostTargetsRow(); } catch (e) {}
  }

  function renderDetailLogs(d) {
    // 冻结状态
    var freezeBar = document.getElementById('sg-diag-freeze-bar');
    var unfreezeBtn = document.getElementById('btn-diag-unfreeze');
    if (freezeBar || unfreezeBtn) {
      var df = d.diagFreeze;
      if (df && df.on) {
        if (freezeBar) {
          freezeBar.style.display = '';
          freezeBar.textContent = '❄ 诊断冻结 · ' + (df.module || '') + '/' + (df.stage || '') + ' · '
            + (df.hint || df.reason || df.code || '');
        }
        if (unfreezeBtn) unfreezeBtn.style.display = '';
      } else {
        if (freezeBar) freezeBar.style.display = 'none';
        if (unfreezeBtn) unfreezeBtn.style.display = 'none';
      }
    }

    try { updateTestMonitorUi(); } catch (e) {}
    try { refreshTelemetryRecent(); } catch (e) {}
  }
})();

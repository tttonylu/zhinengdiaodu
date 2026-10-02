// =============================================================================
// 智能调度 — 控制面板 UI
// 单组件两态：半透明状态圆点 ↔ 半透明卡片（同位置）
// =============================================================================

(function () {
  'use strict';

  if (document.getElementById('sg-panel')) return;

  var data = {};
  var panel = null;
  var isCollapsed = true;
  var didDrag = false;

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
        btn.style.color = '#3fb950';
        btn.style.borderColor = '#238636';
        btn.textContent = labels[i] + ' ON';
      } else {
        btn.style.color = '#f85149';
        btn.style.borderColor = '#da3633';
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
    var row = document.getElementById('row-rp-tg');
    var el = document.getElementById('v-rp-tg');
    var countEl = document.getElementById('v-rp-tg-count');
    var listEl = document.getElementById('v-rp-tg-list');
    var list = getRepostTargetList();
    if (row && el) {
      row.style.display = 'flex';
      if (!list.length) {
        el.textContent = '空(点拉取)';
        el.style.color = '#f0883e';
        el.title = 'OPS 账号页填写转帖来源后，点「拉取来源」';
      } else {
        el.textContent = list.map(function (h) { return '@' + h; }).join(' ');
        el.title = el.textContent;
        el.style.color = '#8b949e';
      }
    }
    if (countEl) countEl.textContent = String(list.length);
    if (listEl) {
      if (!list.length) {
        listEl.innerHTML = '<span style="color:#f0883e">暂无来源。OPS 填好转帖来源后点「拉取来源」</span>';
      } else {
        listEl.innerHTML = list.map(function (h) {
          return '<button type="button" class="sg-rp-tg-chip" data-handle="' + h + '" '
            + 'title="打开 @' + h + ' 主页（可手动复制）" '
            + 'style="font-size:10px;background:#21262d;color:#58a6ff;border:1px solid #30363d;'
            + 'border-radius:4px;padding:2px 6px;cursor:pointer;margin:1px">'
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
    setMsg('正在从 OPS 拉取来源号…', '#d29922');
    var settled = false;
    var finish = function () {
      if (settled) return;
      settled = true;
      try { window.removeEventListener('sg-config-synced', onSynced); } catch (eR) {}
      try { refreshRepostTargetsRow(); } catch (e3) {}
      var n = getRepostTargetList().length;
      if (n) setMsg('已同步 ' + n + ' 个来源：' + getRepostTargetList().map(function (h) { return '@' + h; }).join(' '), '#3fb950');
      else setMsg('仍无来源（检查 OPS 该号「转帖来源」是否已保存）', '#f0883e');
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

  function loadPanelPos() {
    try {
      var p = JSON.parse(localStorage.getItem('sg_panel_pos') || '{}');
      if (p && p.left) return p;
    } catch (e) {}
    try {
      var f = JSON.parse(localStorage.getItem('sg_float_pos') || '{}');
      if (f && f.left) return f;
    } catch (e2) {}
    return { left: '16px', top: '60px' };
  }

  function savePanelPos() {
    if (!panel) return;
    localStorage.setItem('sg_panel_pos', JSON.stringify({
      left: panel.style.left,
      top: panel.style.top
    }));
  }

  function applyCollapse() {
    if (!panel) return;
    if (isCollapsed) {
      panel.classList.add('sg-mini');
      panel.title = '智能调度（点击展开）';
    } else {
      panel.classList.remove('sg-mini');
      panel.title = '';
    }
  }

  function setCollapsed(next) {
    isCollapsed = !!next;
    localStorage.setItem('sg_panel_collapsed', isCollapsed ? '1' : '0');
    applyCollapse();
  }

  /** 圆点状态色：run / idle / warn / err（自动空闲≠运行中） */
  function updateStatusClass() {
    if (!panel) return;
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

    panel.classList.remove('sg-status-run', 'sg-status-idle', 'sg-status-warn', 'sg-status-err');
    panel.classList.add(cls);
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
    chrome.runtime.sendMessage({ action: action }, function (r) {
      if (chrome.runtime.lastError) {
        flashCmd(false, (label || action) + '：' + chrome.runtime.lastError.message);
        return;
      }
      if (r && r.ok && r.delivered !== false) {
        flashCmd(true, (label || action) + '：已下发');
      } else {
        flashCmd(false, (label || action) + '：' + ((r && r.error) || '页面未响应'));
      }
    });
  }

  function refreshExtVerBadge() {
    try {
      var verEl = document.getElementById('v-ext-ver');
      if (!verEl || typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getManifest) return;
      var manVer = chrome.runtime.getManifest().version;
      verEl.textContent = 'v' + manVer;
      verEl.title = chrome.runtime.getManifest().description || '';
      var build = (typeof window !== 'undefined' && window.__SG_SCHED_BUILD__) ? String(window.__SG_SCHED_BUILD__) : '';
      if (build && manVer && build !== manVer) {
        verEl.textContent = 'v' + manVer + '·请刷新页面';
        verEl.style.color = '#f85149';
        verEl.title = '扩展已是 v' + manVer + '，但本页脚本仍是 v' + build + '。请在 x.com 标签按 Ctrl+Shift+R 强刷（不是只重载扩展）';
      } else {
        verEl.style.color = '';
      }
    } catch (eVer) {}
  }

  function onTick(e) {
    var next = (e && e.detail) || {};
    // 合并字段，避免某一路 tick 缺字段把面板刷成空
    for (var k in next) {
      if (Object.prototype.hasOwnProperty.call(next, k) && next[k] !== undefined) {
        data[k] = next[k];
      }
    }
    try { window._sgLastTick = data; } catch (eLt) {}
    refreshExtVerBadge();
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
      row.style.display = 'flex';
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
    var logEl = document.getElementById('row-test-monitor-log');
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
    if (logEl && on && typeof SgTestMonitor !== 'undefined' && SgTestMonitor.getRecent) {
      var recent = SgTestMonitor.getRecent(3);
      if (!recent || !recent.length) {
        logEl.innerHTML = '<div style="color:#484f58">等待事件…</div>';
        return;
      }
      logEl.innerHTML = recent.map(function (r) {
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

  function bindClick(id, fn) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('click', fn);
    return el;
  }

  function waitForBody(fn) {
    if (document.body) { fn(); return; }
    setTimeout(function () { waitForBody(fn); }, 100);
  }

  waitForBody(build);

  function build() {
    panel = document.createElement('div');
    panel.id = 'sg-panel';
    panel.className = 'sg-status-idle';
    panel.innerHTML = ''
      + '<div class="sg-mini-face" aria-hidden="true"></div>'
      + '<div class="sg-header" id="sg-header-bar">'
      + '  <span class="sg-header-title">智能调度 <span id="v-ext-ver" style="font-size:9px;color:#8b949e;font-weight:normal">--</span></span>'
      + '  <span class="sg-toggle" id="sg-mode-badge">--</span>'
      + '  <button type="button" id="sg-collapse-btn" title="收起">−</button>'
      + '</div>'
      + '<div class="sg-body" id="sg-body">'
      + '  <div class="sg-row"><span class="lbl">引擎</span><span class="val b" id="v-engine">--</span></div>'
      + '  <div class="sg-row" id="row-why" style="display:none"><span class="lbl">原因</span><span class="val" id="v-why" style="font-size:10px;color:#f0883e;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">--</span></div>'
      + '  <div class="sg-row" id="row-soft" style="display:none"><span class="lbl">软风控</span><span class="val y" id="v-soft" style="font-size:10px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">--</span></div>'
      + '  <div class="sg-row" id="row-challenge" style="display:none"><span class="lbl">验证</span><span class="val r" id="v-challenge" style="font-size:10px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">--</span></div>'
      + '  <div class="sg-row" id="row-freeze" style="display:none"><span class="lbl">定格</span><span class="val y" id="v-freeze" style="font-size:10px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">--</span></div>'
      + '  <div class="sg-row" id="row-chat-min" style="display:none"><span class="lbl">私信分</span><span class="val" id="v-chat-min" style="font-size:10px;">--</span></div>'
      + '  <div class="sg-row" id="row-script-pool"><span class="lbl">话术池</span><span class="val" id="v-script-pool" style="font-size:10px;">--</span></div>'
      + '  <div class="sg-row" id="row-chat-debt" style="display:none"><span class="lbl">债</span><span class="val" id="v-chat-debt" style="font-size:10px;">--</span></div>'
      + '  <div class="sg-row" id="row-reply-state" style="display:none"><span class="lbl">回复</span><span class="val" id="v-reply-state" style="font-size:10px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">--</span></div>'
      + '  <div class="sg-row"><span class="lbl">轮次</span><span class="val" id="v-round">--</span></div>'
      + '  <div class="sg-row"><span class="lbl">天数</span><span class="val" id="v-day">--</span></div>'
      + '  <div class="sg-row"><span class="lbl">关注</span><span class="val" id="v-follow">--</span></div>'
      + '  <div class="sg-row"><span class="lbl">养号</span><span class="val" id="v-nurture">--</span></div>'
      + '  <div class="sg-row"><span class="lbl">转帖</span><span class="val" id="v-repost">--</span></div>'
      + '  <div class="sg-row" id="row-pc" style="display:none"><span class="lbl">资料</span><span class="val" id="v-pc" style="font-size:10px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">--</span></div>'
      + '  <div class="sg-row" id="row-rp-tg" style="display:none"><span class="lbl">来源</span><span class="val" id="v-rp-tg" style="font-size:9px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">--</span></div>'
      + '  <div class="sg-divider"></div>'
      + '  <div class="sg-row"><span class="lbl">博主</span><span class="val" id="v-creator" style="font-size:10px;overflow:hidden;text-overflow:ellipsis;max-width:120px;">--</span></div>'
      + '  <div class="sg-progress"><div class="sg-fill" id="v-progress" style="width:0%"></div></div>'
      + '  <div class="sg-warn" id="v-warn"></div>'
      + '  <div class="sg-divider"></div>'
      + '  <div class="sg-row" id="row-tel-recent" style="display:none;flex-direction:column;align-items:flex-start;gap:2px">'
      + '    <span class="lbl" style="width:100%">最近日志</span>'
      + '    <span id="v-tel-recent" style="font-size:9px;color:#8b949e;line-height:1.35;max-height:52px;overflow:hidden;width:100%"></span>'
      + '  </div>'
      + '  <div class="sg-btns">'
      + '    <button class="sg-start" id="btn-auto">自动</button>'
      + '    <button class="sg-stop" id="btn-stop">停止</button>'
      + '  </div>'
      + '  <div class="sg-module-row">'
      + '    <button class="sg-toggle-btn" id="btn-toggle-nu" style="font-size:10px;background:#1a2332;color:#58a6ff;border:1px solid #30363d;border-radius:4px;padding:2px 8px;cursor:pointer;">养号</button>'
      + '    <button class="sg-toggle-btn" id="btn-toggle-fw" style="font-size:10px;background:#1a2332;color:#58a6ff;border:1px solid #30363d;border-radius:4px;padding:2px 8px;cursor:pointer;">关注</button>'
      + '    <button class="sg-toggle-btn" id="btn-toggle-ch" style="font-size:10px;background:#1a2332;color:#58a6ff;border:1px solid #30363d;border-radius:4px;padding:2px 8px;cursor:pointer;">私信</button>'
      + '    <button class="sg-toggle-btn" id="btn-toggle-rp" style="font-size:10px;background:#1a2332;color:#58a6ff;border:1px solid #30363d;border-radius:4px;padding:2px 8px;cursor:pointer;">转帖</button>'
      + '  </div>'
      + '  <details id="sg-repost-panel" class="sg-fold" open>'
      + '    <summary>转帖来源 <span id="v-rp-tg-count" style="color:#58a6ff">0</span></summary>'
      + '    <div id="v-rp-tg-list" style="margin-top:4px;display:flex;flex-wrap:wrap;gap:2px;min-height:1.2em"></div>'
      + '    <div class="sg-btns" style="margin-top:4px">'
      + '      <button type="button" class="sg-outline" id="btn-rp-pull" title="立刻从 OPS 同步该号转帖来源" style="font-size:10px">拉取来源</button>'
      + '      <button type="button" class="sg-outline" id="btn-rp-manual" title="手动跑转帖（自动失败时用）" style="font-size:10px;border-color:#58a6ff;color:#58a6ff">手动只转帖</button>'
      + '    </div>'
      + '    <div style="font-size:9px;color:#8b949e;line-height:1.35;margin-top:2px">点 @号可开主页手抄；自动不通就用「手动只转帖」</div>'
      + '  </details>'
      + '  <div id="sg-cmd-msg" style="font-size:9px;min-height:1.2em;text-align:center;margin-top:2px;color:#8b949e"></div>'
      + '  <div class="sg-divider"></div>'
      + '  <details id="sg-manual" class="sg-fold">'
      + '    <summary>手动模式</summary>'
      + '    <div class="sg-btns" style="margin-top:4px">'
      + '      <button class="sg-outline" id="btn-fw">只关注</button>'
      + '      <button class="sg-outline" id="btn-ch">只私信</button>'
      + '      <button class="sg-outline" id="btn-ch-test" title="私信测试：4.1.0 起默认跟进队列（非蓝点守箱）；可强制开软风控跟进">私信测试</button>'
      + '      <button class="sg-outline" id="btn-debt-only" title="清债已停用" disabled>已关清债</button>'
      + '      <button class="sg-outline" id="btn-dry-run" title="干跑预览：不发信只记录话术">干跑预览</button>'
      + '      <button class="sg-outline" id="btn-24h-test" title="24h 测试模式：私信与工作窗口全天放开">24h测试</button>'
      + '      <button class="sg-outline" id="btn-nu">纯养号</button>'
      + '      <button class="sg-outline" id="btn-rp">只转帖</button>'
      + '    </div>'
      + '  </details>'
      + '  <details id="sg-diag" class="sg-fold">'
      + '    <summary>诊断与日志</summary>'
      + '    <div class="sg-btns" style="margin-top:4px">'
      + '      <button class="sg-outline" id="btn-diag-upload" style="font-size:10px">上报诊断</button>'
      + '      <button class="sg-outline" id="btn-diag-copy" style="font-size:10px">复制诊断</button>'
      + '      <button class="sg-outline" id="btn-diag-unfreeze" style="font-size:10px;display:none;border-color:#f85149;color:#f85149" title="解除诊断冻结，允许调度继续">解除冻结</button>'
      + '      <button class="sg-outline" id="btn-reply-trace" style="font-size:10px" title="链路诊断（快照）。Shift+点击=闭环诊断（自动导航+OPS）。定位 DB→收件箱→会话→闸门 卡点并复制">回复链路</button>'
      + '    <div id="sg-diag-freeze-bar" style="display:none;margin:6px 0 0;padding:6px 8px;border:1px solid #f85149;border-radius:6px;background:rgba(248,81,73,.12);font-size:10px;color:#f85149;line-height:1.4"></div>'
      + '    </div>'
      + '    <div class="sg-btns" style="margin-top:2px">'
      + '      <button class="sg-outline" id="btn-open-log" style="font-size:10px;width:100%" title="打开 X-Matrix 日志监视器">打开日志</button>'
      + '    </div>'
      + '    <div class="sg-btns" style="margin-top:2px">'
      + '      <button class="sg-outline" id="btn-test-monitor" style="font-size:10px;width:100%" title="日志常态：加载即自动记录，关键事件自动上报 OPS，无需手动开启">日志常态</button>'
      + '    </div>'
      + '    <div class="sg-row" id="row-test-monitor" style="display:none">'
      + '      <span class="lbl">日志</span>'
      + '      <span class="val" id="v-test-monitor-stats" style="font-size:9px;color:#8b949e;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">记录 0</span>'
      + '    </div>'
      + '    <div id="row-test-monitor-log" style="display:none;font-size:9px;color:#8b949e;line-height:1.35;max-height:48px;overflow:hidden;margin:2px 0 4px"></div>'
      + '    <div class="sg-btns" id="row-test-monitor-btns" style="margin-top:2px;display:none">'
      + '      <button class="sg-outline" id="btn-test-export" style="font-size:9px">导出日志</button>'
      + '      <button class="sg-outline" id="btn-test-upload" style="font-size:9px">补传快照</button>'
      + '      <button class="sg-outline" id="btn-test-clear" style="font-size:9px">清空</button>'
      + '    </div>'
      + '  </details>'
      + '  <details id="sg-servers" class="sg-fold">'
      + '    <summary>服务器</summary>'
      + '    <div style="margin-top:6px;display:flex;flex-direction:column;gap:4px">'
      + '      <label style="display:block">OPS'
      + '        <input id="sg-ops-url" type="text" spellcheck="false" '
      + '          style="width:100%;box-sizing:border-box;margin-top:2px;padding:3px 6px;border-radius:4px;border:1px solid #30363d;background:#0d1117;color:#c9d1d9;font-size:10px">'
      + '      </label>'
      + '      <label style="display:block">号池'
      + '        <input id="sg-pool-url" type="text" spellcheck="false" '
      + '          style="width:100%;box-sizing:border-box;margin-top:2px;padding:3px 6px;border-radius:4px;border:1px solid #30363d;background:#0d1117;color:#c9d1d9;font-size:10px">'
      + '      </label>'
      + '      <button type="button" id="sg-save-servers" class="sg-outline" style="width:100%;padding:4px 0;font-size:10px">保存地址</button>'
      + '      <span id="sg-servers-hint" style="font-size:9px;color:#8b949e;line-height:1.35">默认内网；不通自动：号池 haochi1 / OPS kongzhi1</span>'
      + '      <span id="sg-servers-msg" style="font-size:9px;min-height:1.2em"></span>'
      + '    </div>'
      + '  </details>'
      + '</div>';
    document.body.appendChild(panel);

    try { refreshExtVerBadge(); } catch (eVer) {}

    // 位置：优先 panel，否则迁移 float
    var savedPos = loadPanelPos();
    panel.style.left = savedPos.left || '16px';
    panel.style.top = savedPos.top || '60px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';

    // 默认收起；仅当明确存了 '0' 时展开
    isCollapsed = localStorage.getItem('sg_panel_collapsed') !== '0';
    applyCollapse();

    bindClick('btn-auto', function () { sendCmd('sg_scheduler_start', '自动'); });
    bindClick('btn-stop', function () { sendCmd('sg_scheduler_pause', '停止'); });
    bindClick('btn-open-log', function () {
      try {
        if (window.__matrix_console__ && typeof window.__matrix_console__.show === 'function') {
          window.__matrix_console__.show();
          flashCmd(true, '已打开日志监视器');
        } else {
          flashCmd(false, '日志模块未加载');
        }
      } catch (e) {
        flashCmd(false, '打开日志失败');
      }
    });
    function panelDayCount() {
      try {
        if (window._sgLastTick && window._sgLastTick.dayCount) return parseInt(window._sgLastTick.dayCount, 10) || 1;
      } catch (e0) {}
      try {
        var h = (localStorage.getItem('matrix_my_handle') || '').replace(/^@/, '').replace(/#guard$/i, '').toLowerCase();
        if (h) return parseInt((JSON.parse(localStorage.getItem('matrix_stats_' + h) || '{}')).day_count, 10) || 1;
      } catch (e1) {}
      return 1;
    }
    function guardChatDayOrFlash(label) {
      var day = panelDayCount();
      if (day >= 3) return true;
      flashCmd(false, 'Day' + day + ' 不私信（Day3起），已拒绝' + (label ? '「' + label + '」' : ''));
      return false;
    }
    bindClick('btn-fw', function () { sendCmd('sg_manual_follow', '只关注'); });
    bindClick('btn-ch', function () {
      if (!guardChatDayOrFlash('只私信')) return;
      sendCmd('sg_manual_chat', '只私信');
    });
    bindClick('btn-ch-test', function () {
      if (!guardChatDayOrFlash('私信测试')) return;
      try {
        sessionStorage.setItem('sg_chat_force_inbox', 'true');
        sessionStorage.removeItem('sg_debt_only');
        // 4.1.0：默认走跟进；仍发测试命令，content 侧 Force 会改 followup
        window.dispatchEvent(new CustomEvent('sg-chat-test-command'));
        flashCmd(true, '私信测试：已触发（跟进/破冰，非蓝点守箱）');
      } catch (e) {
        flashCmd(false, '私信测试触发失败：' + ((e && e.message) || 'unknown'));
      }
    });
    bindClick('btn-debt-only', function () {
      flashCmd(false, '清债已停用（软风控短扫）');
      updateDebtOnlyBtn();
    });
    bindClick('btn-dry-run', function () {
      try {
        var on = sessionStorage.getItem('sg_chat_dry_run') === 'true';
        sessionStorage.setItem('sg_chat_dry_run', on ? 'false' : 'true');
        flashCmd(true, on ? '干跑 OFF' : '干跑 ON');
        updateDryRunBtn();
      } catch (e) { flashCmd(false, '干跑切换失败'); }
    });
    bindClick('btn-24h-test', function () {
      try {
        var on = localStorage.getItem('sg_test_24h') === 'true';
        localStorage.setItem('sg_test_24h', on ? 'false' : 'true');
        flashCmd(true, on ? '24h测试 OFF（恢复时间窗）' : '24h测试 ON（私信全天放开）');
        updateTest24hBtn();
      } catch (e) { flashCmd(false, '24h测试切换失败'); }
    });
    bindClick('btn-diag-upload', function () {
      if (typeof SgTelemetry === 'undefined' || !SgTelemetry.uploadSnapshot) {
        flashCmd(false, '观测模块未加载');
        return;
      }
      if (SgTelemetry.getBotId && SgTelemetry.getBotId() === 'unknown') {
        flashCmd(false, '账号未识别，请先登录/心跳');
        return;
      }
      flashCmd(true, '打包中…');
      SgTelemetry.uploadSnapshot(collectDiagExtra()).then(function (result) {
        var sid = result && result.response && result.response.snapshot_id;
        flashCmd(true, sid ? ('已上报 #' + sid) : '诊断已上报 OPS');
        refreshTelemetryRecent();
      }).catch(function (err) {
        var msg = '上报失败';
        if (err && err.message === 'account_unknown') msg = '账号未识别，请刷新X页面后重试';
        else if (err && err.message === 'upload_in_progress') msg = '上次上报进行中，请稍候';
        else if (err && err.response) {
          if (err.response.error === 'account_not_registered') msg = '账号未注册 OPS';
          else if (err.response.msg) msg = String(err.response.msg);
          else if (err.response.error) msg = String(err.response.error);
        } else if (err && err.message) msg = err.message;
        flashCmd(false, msg);
      });
    });
    bindClick('btn-diag-unfreeze', function () {
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
      } catch (e) {
        flashCmd(false, '解冻失败');
      }
    });
    bindClick('btn-diag-copy', function () {
      if (typeof SgTelemetry === 'undefined' || !SgTelemetry.copySnapshotText) {
        flashCmd(false, '观测模块未加载');
        return;
      }
      SgTelemetry.copySnapshotText(collectDiagExtra()).then(function () {
        flashCmd(true, '已复制到剪贴板');
      }).catch(function (err) {
        var msg = '复制失败';
        if (err && err.message === 'account_unknown') msg = '账号未识别';
        flashCmd(false, msg);
      });
    });
    bindClick('btn-reply-trace', function (ev) {
      var handle = '';
      try { handle = sessionStorage.getItem('current_target') || ''; } catch (eCT) {}
      if (!handle) {
        try {
          var replyKey = (typeof SKeys !== 'undefined' && SKeys.LK_CHAT_REPLY_STATE) ? SKeys.LK_CHAT_REPLY_STATE : 'dan_reply_state';
          var rsFallback = JSON.parse(sessionStorage.getItem(replyKey) || localStorage.getItem(replyKey) || 'null');
          if (rsFallback && rsFallback.target) handle = rsFallback.target;
        } catch (eRSF) {}
      }
      if (!handle) {
        flashCmd(false, '无当前目标：先跑一轮私信，或设置 current_target');
        return;
      }
      var bridge = window.__sgChatBridge || {};
      var useAsync = ev && ev.shiftKey && typeof bridge.debugTraceReplyChainAsync === 'function';
      if (!useAsync && typeof bridge.debugTraceReplyChain !== 'function') {
        flashCmd(false, '私信模块未就绪');
        return;
      }
      if (useAsync) {
        flashCmd(true, '闭环诊断中…（必要时自动导航）');
        bridge.debugTraceReplyChainAsync(handle, { navigate: true }).then(function (result) {
          var trace = (result && result.final) || result;
          console.log('[回复链路-async] @' + handle, result);
          if (result && result.pending) {
            flashCmd(true, '已导航，重载后继续…');
            return;
          }
          if (!trace || trace.error) {
            flashCmd(false, '闭环诊断失败: ' + ((trace && trace.error) || 'unknown'));
            return;
          }
          try { window.__sgReplyTraceResult = trace; } catch (eStoreA) {}
          var copyTextA = '@' + handle + ' [async]\n' + (trace.verdict || ('卡点: ' + (trace.stuckAt || '?')));
          if (trace.chain && trace.chain.length) {
            for (var iA = 0; iA < trace.chain.length; iA++) {
              var stA = trace.chain[iA];
              copyTextA += '\n' + (stA.ok ? '[通过]' : (stA.na ? '[跳过]' : '[失败]')) + ' ' + stA.label
                + (stA.reason ? '：' + stA.reason : '')
                + (stA.suggest ? ' → ' + stA.suggest : '');
            }
          }
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(copyTextA);
          } catch (eClipA) {}
          flashCmd(true, '闭环完成 · ' + (trace.verdict || ''));
        }).catch(function (eAsync) {
          flashCmd(false, '闭环诊断异常: ' + String((eAsync && eAsync.message) || eAsync));
        });
        return;
      }
      var trace = null;
      try { trace = bridge.debugTraceReplyChain(handle); } catch (eT) { trace = { error: String((eT && eT.message) || eT) }; }
      console.log('[回复链路] @' + handle, trace);
      if (!trace || trace.error) {
        flashCmd(false, '诊断失败: ' + ((trace && trace.error) || 'unknown'));
        return;
      }
      try { window.__sgReplyTraceResult = trace; } catch (eStore) {}
      var copyText = '@' + handle + '\n' + (trace.verdict || ('卡点: ' + (trace.stuckAt || '?')));
      if (trace.chain && trace.chain.length) {
        for (var iT = 0; iT < trace.chain.length; iT++) {
          var st = trace.chain[iT];
          copyText += '\n' + (st.ok ? '[通过]' : '[失败]') + ' ' + st.label
            + (st.reason ? '：' + st.reason : '')
            + (st.suggest ? ' → ' + st.suggest : '');
        }
      }
      var copied = false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(copyText);
          copied = true;
        }
      } catch (eClip) {}
      if (!copied) {
        try {
          var ta = document.createElement('textarea');
          ta.value = copyText;
          ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
          document.body.appendChild(ta);
          ta.select();
          copied = document.execCommand('copy');
          document.body.removeChild(ta);
        } catch (eTa) {}
      }
      flashCmd(true, (copied ? '已复制链路 · ' : '') + (trace.verdict || ''));
    });
    bindClick('btn-test-monitor', function () {
      if (typeof SgTestMonitor === 'undefined') {
        flashCmd(false, '日志常态未加载');
        return;
      }
      try {
        if (SgTestMonitor.isActive()) {
          flashCmd(true, '日志常态开启中，关键事件自动上报 OPS');
        } else {
          SgTestMonitor.start('panel');
          flashCmd(true, '日志常态已恢复');
        }
        updateTestMonitorUi();
      } catch (e) { flashCmd(false, '日志常态切换失败'); }
    });
    bindClick('btn-test-export', function () {
      if (typeof SgTestMonitor === 'undefined' || !SgTestMonitor.downloadJson) {
        flashCmd(false, '日志常态未加载');
        return;
      }
      SgTestMonitor.downloadJson().then(function (res) {
        flashCmd(true, res && res.file ? ('已下载 ' + res.file) : '已导出 JSON');
      }).catch(function () { flashCmd(false, '导出失败'); });
    });
    bindClick('btn-test-upload', function () {
      if (typeof SgTestMonitor === 'undefined' || !SgTestMonitor.uploadOps) {
        flashCmd(false, '日志常态未加载');
        return;
      }
      if (typeof SgTelemetry !== 'undefined' && SgTelemetry.getBotId && SgTelemetry.getBotId() === 'unknown') {
        flashCmd(false, '账号未识别');
        return;
      }
      flashCmd(true, '打包中…');
      SgTestMonitor.uploadOps().then(function (result) {
        var sid = result && result.response && result.response.snapshot_id;
        flashCmd(true, sid ? ('日志快照已上报 #' + sid) : '日志快照已上报 OPS');
      }).catch(function (err) {
        var msg = '上报失败';
        if (err && err.message === 'account_unknown') msg = '账号未识别';
        else if (err && err.message === 'telemetry_unavailable') msg = '观测模块未加载';
        else if (err && err.message) msg = err.message;
        flashCmd(false, msg);
      });
    });
    bindClick('btn-test-clear', function () {
      if (typeof SgTestMonitor === 'undefined' || !SgTestMonitor.clear) {
        flashCmd(false, '日志常态未加载');
        return;
      }
      SgTestMonitor.clear();
      flashCmd(true, '日志记录已清空');
      updateTestMonitorUi();
    });
    bindClick('btn-nu', function () { sendCmd('sg_nurture_only', '纯养号'); });
    bindClick('btn-rp', function () { sendCmd('sg_manual_repost', '只转帖'); });

    bindClick('btn-toggle-nu', function () {
      var sw = getSwitches(); setSwitch('nurture', sw.nurture === false);
    });
    bindClick('btn-toggle-fw', function () {
      var sw = getSwitches(); setSwitch('follow', sw.follow === false);
    });
    bindClick('btn-toggle-ch', function () {
      var sw = getSwitches(); setSwitch('chat', sw.chat === false);
    });
    bindClick('btn-toggle-rp', function () {
      var sw = getSwitches(); setSwitch('repost', sw.repost === false);
    });
    bindClick('btn-rp-pull', function () { pullRepostTargetsFromOps(); });
    bindClick('btn-rp-manual', function () { sendCmd('sg_manual_repost', '手动只转帖'); });

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
    try {
      window.addEventListener('sg-config-synced', function () {
        try { refreshRepostTargetsRow(); } catch (eS) {}
      });
    } catch (eL) {}

    try { refreshRepostTargetsRow(); } catch (eRt) {}

    chrome.runtime.sendMessage({ action: 'get_servers' }, function (r) {
      if (!r || !r.ok) return;
      var opsEl = document.getElementById('sg-ops-url');
      var poolEl = document.getElementById('sg-pool-url');
      if (opsEl) opsEl.value = r.ops_server || '';
      if (poolEl) poolEl.value = r.pool_server || '';
    });
    bindClick('sg-save-servers', function (e) {
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
      // 自定义域名需 optional_host_permissions
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

    bindClick('sg-collapse-btn', function (e) {
      e.stopPropagation();
      setCollapsed(true);
    });

    // 收起态点击展开（拖过不展开）
    panel.addEventListener('click', function (e) {
      if (!isCollapsed) return;
      if (didDrag) return;
      if (e.target.tagName === 'BUTTON') return;
      setCollapsed(false);
    });

    // ==================== 拖拽 ====================
    var dragEl = null, dragStartX = 0, dragStartY = 0, dragOrigX = 0, dragOrigY = 0;
    var DRAG_THRESH = 4;

    function canStartDrag(target) {
      if (target.tagName === 'BUTTON' || target.tagName === 'INPUT' || target.tagName === 'SELECT') return false;
      if (target.id === 'sg-collapse-btn') return false;
      if (isCollapsed) return true;
      return !!(target.closest && target.closest('#sg-header-bar'));
    }

    panel.addEventListener('mousedown', function (e) {
      if (!canStartDrag(e.target)) return;
      e.preventDefault();
      dragEl = panel;
      didDrag = false;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragOrigX = parseInt(panel.style.left, 10) || 0;
      dragOrigY = parseInt(panel.style.top, 10) || 0;
      panel.style.transition = 'none';
    });

    panel.addEventListener('touchstart', function (e) {
      if (!canStartDrag(e.target)) return;
      e.preventDefault();
      dragEl = panel;
      didDrag = false;
      dragStartX = e.touches[0].clientX;
      dragStartY = e.touches[0].clientY;
      dragOrigX = parseInt(panel.style.left, 10) || 0;
      dragOrigY = parseInt(panel.style.top, 10) || 0;
      panel.style.transition = 'none';
    }, { passive: false });

    document.addEventListener('mousemove', function (e) {
      if (!dragEl) return;
      var dx = e.clientX - dragStartX, dy = e.clientY - dragStartY;
      if (!didDrag && (Math.abs(dx) > DRAG_THRESH || Math.abs(dy) > DRAG_THRESH)) didDrag = true;
      if (!didDrag) return;
      dragEl.style.left = Math.max(0, dragOrigX + dx) + 'px';
      dragEl.style.top = Math.max(0, dragOrigY + dy) + 'px';
    });

    document.addEventListener('touchmove', function (e) {
      if (!dragEl) return;
      var dx = e.touches[0].clientX - dragStartX, dy = e.touches[0].clientY - dragStartY;
      if (!didDrag && (Math.abs(dx) > DRAG_THRESH || Math.abs(dy) > DRAG_THRESH)) didDrag = true;
      if (!didDrag) return;
      dragEl.style.left = Math.max(0, dragOrigX + dx) + 'px';
      dragEl.style.top = Math.max(0, dragOrigY + dy) + 'px';
    }, { passive: false });

    function endDrag() {
      if (!dragEl) return;
      dragEl.style.transition = '';
      if (didDrag) savePanelPos();
      dragEl = null;
      // 下一帧再清 didDrag，避免紧随其后的 click 误触展开
      setTimeout(function () { didDrag = false; }, 0);
    }

    document.addEventListener('mouseup', endDrag);
    document.addEventListener('touchend', endDrag);

    window.addEventListener('sg-coordinator-tick', onTick);
    window.addEventListener('sg-scheduler-tick', onTick);
    try {
      window.addEventListener('sg-telemetry', function () { refreshTelemetryRecent(); });
    } catch (eTel) {}
    try {
      window.addEventListener('sg-test-monitor-update', function () { updateTestMonitorUi(); });
    } catch (eTm) {}

    setTimeout(function () {
      chrome.runtime.sendMessage({ action: 'sg_scheduler_status' }, function (r) {
        if (r && !chrome.runtime.lastError) {
          onTick({ detail: r });
        }
      });
    }, 800);
  }

  function render() {
    var d = data;
    if (!d) return;

    updateStatusClass();

    var engEl = document.getElementById('v-engine');
    var engText = '空闲';
    var engCls = 'b';
    var rm = d.runningModule || '';
    // 优先真实在跑模块（coor tick 的 engine 恒为 'coor'）
    if (rm === 'follow' || (!rm && d.followRunning && d.engine !== 'chat')) {
      if (d.followPhase === 'warmup') { engText = '养号中'; engCls = 'b'; }
      else { engText = '关注轮' + (d.followRound || 1); engCls = 'y'; }
    } else if (rm === 'chat' || d.engine === 'chat' || d.chatRunning) {
      engText = '私信中'; engCls = 'g';
    } else if (rm === 'nurture' || d.engine === 'nurture' || d.nurtureRunning) {
      engText = d.nurtureOnly || d.engine === 'nurture_only' ? '纯养号' : '养号中';
      engCls = 'b';
    } else if (rm === 'repost' || d.repostRunning) {
      engText = '转帖中'; engCls = 'y';
    } else if (rm === 'profile_clone' || (d.profileClone && d.profileClone.running)) {
      engText = '资料克隆'; engCls = 'b';
    } else if (d.engine === 'follow') {
      if (d.followPhase === 'warmup') { engText = '养号中'; engCls = 'b'; }
      else { engText = '关注轮' + (d.followRound || 1); engCls = 'y'; }
    } else if (d.engine === 'nurture_only') {
      engText = '纯养号'; engCls = 'b';
    } else if (d.engine === 'coor' || d.autoMode) {
      var stageMap = { S0: '静默', S1: '关注+养号', S2: '关注+养号', S3: '全开', S4: '全开' };
      engText = (stageMap[d.stage] || '自动') + '·空闲';
      engCls = 'coor';
    } else if (d.engine === 'manual') {
      engText = d.followRunning ? '关注(手动)' : (d.chatRunning ? '私信(手动)' : '手动');
      engCls = d.followRunning ? 'y' : 'g';
    } else {
      engText = '空闲'; engCls = 'r';
    }
    if (engEl) { engEl.textContent = engText; engEl.className = 'val ' + engCls; }

    var whyRow = document.getElementById('row-why');
    var whyEl = document.getElementById('v-why');
    if (whyRow && whyEl) {
      var why = d.whyIdle || '';
      var diagOn = !!(d.diagFreeze && d.diagFreeze.on);
      var showWhy = diagOn || !!(d.autoMode && why && !d.runningModule && (d.engine === 'idle' || d.engine === 'coor' || !d.followRunning && !d.chatRunning && !d.nurtureRunning && !d.repostRunning));
      if (showWhy) {
        whyRow.style.display = '';
        whyEl.textContent = why;
        whyEl.title = why;
        whyEl.style.color = diagOn ? '#f85149' : '';
      } else {
        whyRow.style.display = 'none';
        whyEl.style.color = '';
      }
    }
    var freezeBar = document.getElementById('sg-diag-freeze-bar');
    var unfreezeBtn = document.getElementById('btn-diag-unfreeze');
    if (freezeBar || unfreezeBtn) {
      var df = d.diagFreeze;
      if (df && df.on) {
        if (freezeBar) {
          freezeBar.style.display = '';
          freezeBar.textContent = '❄ 诊断冻结 · ' + (df.module || '') + '/' + (df.stage || '') + ' · '
            + (df.hint || df.reason || df.code || '')
            + ' · 取证后点「解除冻结」';
        }
        if (unfreezeBtn) unfreezeBtn.style.display = '';
      } else {
        if (freezeBar) freezeBar.style.display = 'none';
        if (unfreezeBtn) unfreezeBtn.style.display = 'none';
      }
    }

    var softRow = document.getElementById('row-soft');
    var softEl = document.getElementById('v-soft');
    if (softRow && softEl) {
      var soft = d.softRisk || null;
      if (soft && soft.active) {
        var softTxt = soft.remainSec + 's | ' + (soft.mode || '?');
        if (soft.mode === 'chat') softTxt += soft.chatDone ? '→养号' : '轮次中';
        softRow.style.display = '';
        softEl.textContent = softTxt;
        softEl.title = softTxt;
      } else {
        softRow.style.display = 'none';
      }
    }

    var chRow = document.getElementById('row-challenge');
    var chEl = document.getElementById('v-challenge');
    if (chRow && chEl) {
      var ch = d.challenge || null;
      if (ch && ch.active) {
        chRow.style.display = '';
        chEl.textContent = ch.msg || (ch.onChallenge ? '人机验证' : '熔断冷却');
        chEl.title = ch.msg || '';
        chEl.className = 'val r';
      } else {
        chRow.style.display = 'none';
      }
    }

    var freezeRow = document.getElementById('row-freeze');
    var freezeEl = document.getElementById('v-freeze');
    if (freezeRow && freezeEl) {
      var fz = d.chatFreeze || null;
      if (fz && fz.frozen) {
        var fzTxt = fz.pending + '/' + fz.total;
        if (fz.rushing) fzTxt += ' | 赶工';
        else if (fz.rushWindow && fz.pending === 0) fzTxt += ' | 已清';
        else if (!fz.rushWindow) fzTxt += ' | 待明日';
        freezeRow.style.display = '';
        freezeEl.textContent = fzTxt;
        freezeEl.title = fzTxt;
      } else {
        freezeRow.style.display = 'none';
      }
    }

    var chatMinRow = document.getElementById('row-chat-min');
    var chatMinEl = document.getElementById('v-chat-min');
    var cd = d.chatDiag || null;
    if (chatMinRow && chatMinEl && cd) {
      chatMinRow.style.display = '';
      chatMinEl.textContent = '出' + (cd.chatOutboundTodayMin || 0) + ' / 箱' + (cd.chatInboxTodayMin || 0) + ' / 总' + (cd.chatTotalTodayMin || 0) + '分';
      chatMinEl.title = 'outbound / inbox / total 分钟';
    } else if (chatMinRow) {
      chatMinRow.style.display = 'none';
    }

    var scriptPoolEl = document.getElementById('v-script-pool');
    if (scriptPoolEl) {
      var poolMode = 'dating';
      try {
        if (window.RemoteSettings && typeof window.RemoteSettings.chatScriptPool === 'function') {
          poolMode = window.RemoteSettings.chatScriptPool();
        } else {
          var thrPool = JSON.parse(localStorage.getItem('sg_config_thresholds') || '{}') || {};
          poolMode = String(thrPool.chat_script_pool || 'dating').toLowerCase() === 'job' ? 'job' : 'dating';
        }
      } catch (ePool) {
        try { poolMode = sessionStorage.getItem('dan_script_pool_mode') || 'dating'; } catch (e2) {}
      }
      scriptPoolEl.textContent = poolMode === 'job' ? '兼职粉·10–19点' : '交友';
      scriptPoolEl.title = poolMode === 'job'
        ? 'chat_script_pool=job；私信北京时间 10:00–19:00'
        : 'chat_script_pool=dating（OPS 全局切换）';
      scriptPoolEl.style.color = poolMode === 'job' ? '#d2a8ff' : '';
    }

    var chatDebtRow = document.getElementById('row-chat-debt');
    var chatDebtEl = document.getElementById('v-chat-debt');
    if (chatDebtRow && chatDebtEl && cd) {
      chatDebtRow.style.display = '';
      var debtTxt = 'AD' + (cd.adDebt || 0) + ' K' + (cd.kickDebt || 0) + ' 冰' + (cd.icePending || 0);
      if (cd.replyPending) debtTxt += ' 待回' + cd.replyPending;
      if (cd.chatCooldownLeftMin) debtTxt += ' 冷却' + cd.chatCooldownLeftMin + '分';
      if (cd.slaOverdueCount) debtTxt += ' SLA!' + cd.slaOverdueCount;
      chatDebtEl.textContent = debtTxt;
      chatDebtEl.title = debtTxt;
    } else if (chatDebtRow) {
      chatDebtRow.style.display = 'none';
    }

    var replyRow = document.getElementById('row-reply-state');
    var replyEl = document.getElementById('v-reply-state');
    if (replyRow && replyEl) {
      var rs = null;
      try { rs = JSON.parse(sessionStorage.getItem('dan_reply_state') || 'null'); } catch (eRS) { rs = null; }
      if (!rs) { try { rs = JSON.parse(localStorage.getItem('dan_reply_state') || 'null'); } catch (eRS2) { rs = null; } }
      if (rs) {
        replyRow.style.display = '';
        var rsTxt = rs.decision || 'unknown';
        if (rs.source) rsTxt += ' · ' + rs.source;
        if (rs.unreadSeen) rsTxt += ' · 未读';
        if (rs.hasReply) rsTxt += ' · 有回复';
        if (rs.composerReady === false) rsTxt += ' · 输入框未就绪';
        if (rs.latest) rsTxt += ' · ' + String(rs.latest).slice(0, 18);
        if (rs.at) {
          var rsAgeMin = Math.round((Date.now() - rs.at) / 60000);
          rsTxt += rsAgeMin > 60 ? ' (' + Math.floor(rsAgeMin / 60) + 'h前)' : (rsAgeMin > 1 ? ' (' + rsAgeMin + '分前)' : '');
        }
        replyEl.textContent = rsTxt;
        replyEl.title = JSON.stringify(rs);
      } else {
        replyRow.style.display = 'none';
      }
    }

    var driftRow = document.getElementById('row-drift-state');
    var driftEl = document.getElementById('v-drift-state');
    if (driftRow && driftEl) {
      var drift = null;
      try { drift = JSON.parse(sessionStorage.getItem('sg_follow_drift') || 'null'); } catch (eD) { drift = null; }
      var driftLog = [];
      try { driftLog = JSON.parse(localStorage.getItem('sg_follow_drift_log') || '[]'); } catch (eDL) { driftLog = []; }
      if (drift) {
        driftRow.style.display = '';
        var driftTxt = 'cnt ' + (drift.count || 0) + ' · ' + String(drift.page || '--') + ' → ' + String(drift.expected || '--');
        if (drift.at) {
          var ageMin = Math.round((Date.now() - drift.at) / 60000);
          driftTxt += ageMin > 60 ? ' (' + Math.floor(ageMin / 60) + 'h前)' : (ageMin > 1 ? ' (' + ageMin + '分前)' : '');
        }
        driftEl.textContent = driftTxt;
        driftEl.title = JSON.stringify({ drift: drift, recent: driftLog.slice(-5) });
      } else {
        driftRow.style.display = 'none';
      }
    }

    updateDebtOnlyBtn();
    updateDryRunBtn();
    updateTest24hBtn();
    refreshTelemetryRecent();

    var roundEl = document.getElementById('v-round');
    if (roundEl) {
      roundEl.textContent = (d.followRound > 0) ? '第' + d.followRound + '轮' : '--';
    }

    var dayEl = document.getElementById('v-day');
    if (dayEl) dayEl.textContent = 'Day ' + (d.dayCount || 1);

    var fwEl = document.getElementById('v-follow');
    if (fwEl) fwEl.textContent = (d.followedToday || 0) + '/' + (d.followLimit || 200);

    var progEl = document.getElementById('v-progress');
    if (progEl) {
      var pct = d.followLimit > 0 ? Math.min(100, ((d.followedToday || 0) / d.followLimit) * 100) : 0;
      progEl.style.width = pct + '%';
    }

    var creatorEl = document.getElementById('v-creator');
    if (creatorEl) {
      var cr = d.currentCreator || d.suspended || '';
      creatorEl.textContent = cr ? '@' + cr : '--';
    }

    var roundEl2 = document.getElementById('v-round');
    if (d.warmupEndAt && d.warmupEndAt > 0 && (d.engine === 'nurture' || d.followPhase === 'warmup')) {
      var left = Math.max(0, Math.ceil((d.warmupEndAt - Date.now()) / 60000));
      if (roundEl2) roundEl2.textContent = '养号 ' + left + '分后';
    }

    var nuEl = document.getElementById('v-nurture');
    if (nuEl) {
      if (d.nurtureOnly) { nuEl.textContent = '独立模式'; nuEl.style.color = '#bc8cff'; }
      else if (d.nurtureRunning) {
        var ns = d.nurtureDaily || {};
        nuEl.textContent = '赞' + (ns.likes || 0) + '/' + (ns.likeBudget || '-');
        nuEl.style.color = '#58a6ff';
      }
      else { nuEl.textContent = '待机'; nuEl.style.color = '#8b949e'; }
    }

    var rpEl = document.getElementById('v-repost');
    if (rpEl) {
      if (d.repostRunning || d.runningModule === 'repost') {
        rpEl.textContent = (d.repostCurrent ? '@' + d.repostCurrent : '运行中');
        rpEl.style.color = '#d29922';
      } else if (d.repostDaily != null) {
        rpEl.textContent = (d.repostDaily.used || 0) + '/' + (d.repostDaily.cap || '-');
        rpEl.style.color = '#8b949e';
      } else {
        rpEl.textContent = '待机';
        rpEl.style.color = '#8b949e';
      }
    }
    try { refreshRepostTargetsRow(); } catch (eRpTg) {}

    var pcRow = document.getElementById('row-pc');
    var pcEl = document.getElementById('v-pc');
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

    var badgeEl = document.getElementById('sg-mode-badge');
    if (badgeEl) {
      if (d.autoMode) { badgeEl.textContent = '●自动'; badgeEl.style.color = '#3fb950'; }
      else { badgeEl.textContent = '●手动'; badgeEl.style.color = '#8b949e'; }
    }

    try { updateToggleBtns(getSwitches()); updateDebtOnlyBtn(); updateDryRunBtn(); updateTest24hBtn(); updateTestMonitorUi(); } catch (e) {}

    var warnEl = document.getElementById('v-warn');
    if (warnEl) {
      warnEl.className = 'sg-warn';
      warnEl.style.display = 'none';
      if (d.isWorkTime === false) {
        warnEl.className = 'sg-warn show err';
        warnEl.textContent = '非工作时间 (21:00-7:00)';
      } else if (d.isWorkTime === true || d.isWorkTime == null) {
        var morningRamp = false;
        try {
          if (typeof TimeUtil !== 'undefined' && TimeUtil.shanghaiParts) {
            var sp = TimeUtil.shanghaiParts();
            if (sp && sp.h >= 7 && sp.h < 8) morningRamp = true;
          }
        } catch (eH) {}
        if (morningRamp) {
          warnEl.className = 'sg-warn show info';
          warnEl.textContent = '早间渐进只养号';
        } else if (d.isChatTime === false && d.dayCount >= 3) {
          warnEl.className = 'sg-warn show info';
          warnEl.textContent = '18:00后不私信';
        } else if (d.dayCount < 3 && d.autoMode) {
          warnEl.className = 'sg-warn show info';
          warnEl.textContent = 'Day' + d.dayCount + '不私信（Day3起）';
        }
      }
    }
    try {
      var chatDayOk = (d.dayCount || 1) >= 3;
      ['btn-ch', 'btn-ch-test'].forEach(function (id) {
        var b = document.getElementById(id);
        if (!b) return;
        b.disabled = !chatDayOk;
        b.style.opacity = chatDayOk ? '' : '0.45';
        b.title = chatDayOk ? (b.getAttribute('data-title-ok') || '') : ('Day' + (d.dayCount || 1) + ' 不私信（Day3起）');
      });
    } catch (eBtn) {}
  }
})();

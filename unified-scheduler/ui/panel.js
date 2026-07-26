// =============================================================================
// 智能调度 — 控制面板 UI
// 右下角卡片 + 收起按钮
// =============================================================================

(function () {
  'use strict';

  if (document.getElementById('sg-panel')) return;

  var collapsed = false;
  var data = {};

  function waitForBody(fn) {
    if (document.body) { fn(); return; }
    setTimeout(function () { waitForBody(fn); }, 100);
  }

  waitForBody(build);

  function build() {
    var panel = document.createElement('div');
    panel.id = 'sg-panel';
    panel.innerHTML = ''
      + '<div class="sg-header" id="sg-header-bar">智能调度'
      + '  <span class="sg-toggle" id="sg-mode-badge">--</span>'
      + '</div>'
      + '<div class="sg-body" id="sg-body">'
      + '  <div class="sg-row"><span class="lbl">引擎</span><span class="val b" id="v-engine">--</span></div>'
      + '  <div class="sg-row"><span class="lbl">轮次</span><span class="val" id="v-round">--</span></div>'
      + '  <div class="sg-row"><span class="lbl">天数</span><span class="val" id="v-day">--</span></div>'
      + '  <div class="sg-row"><span class="lbl">关注</span><span class="val" id="v-follow">--</span></div>'
      + '  <div class="sg-row"><span class="lbl">养号</span><span class="val" id="v-nurture">--</span></div>'
      + '  <div class="sg-divider"></div>'
      + '  <div class="sg-row"><span class="lbl">博主</span><span class="val" id="v-creator" style="font-size:10px;overflow:hidden;text-overflow:ellipsis;max-width:120px;">--</span></div>'
      + '  <div class="sg-progress"><div class="sg-fill" id="v-progress" style="width:0%"></div></div>'
      + '  <div class="sg-warn" id="v-warn"></div>'
      + '  <div class="sg-divider"></div>'
      + '  <div class="sg-btns">'
      + '    <button class="sg-start" id="btn-auto">自动</button>'
      + '    <button class="sg-stop" id="btn-stop">停止</button>'
      + '  </div>'
      + '  <div class="sg-btns" style="margin-top:4px">'
      + '    <button class="sg-outline" id="btn-fw">只关注</button>'
      + '    <button class="sg-outline" id="btn-ch">只私信</button>'
      + '    <button class="sg-outline" id="btn-nu">纯养号</button>'
      + '  </div>'
      + '  <div class="sg-divider"></div>'
      + '  <div style="display:flex;gap:6px;justify-content:center;margin-top:4px;">'
      + '    <button class="sg-toggle-btn" id="btn-toggle-nu" style="font-size:10px;background:#1a2332;color:#58a6ff;border:1px solid #30363d;border-radius:4px;padding:2px 8px;cursor:pointer;">养号</button>'
      + '    <button class="sg-toggle-btn" id="btn-toggle-fw" style="font-size:10px;background:#1a2332;color:#58a6ff;border:1px solid #30363d;border-radius:4px;padding:2px 8px;cursor:pointer;">关注</button>'
      + '    <button class="sg-toggle-btn" id="btn-toggle-ch" style="font-size:10px;background:#1a2332;color:#58a6ff;border:1px solid #30363d;border-radius:4px;padding:2px 8px;cursor:pointer;">私信</button>'
      + '  </div>'
      + '</div>';
    document.body.appendChild(panel);

    // 折叠按钮
    var collapseBtn = document.createElement('button');
    collapseBtn.id = 'sg-collapse-btn';
    collapseBtn.textContent = '⚡';
    collapseBtn.title = '智能调度';
    collapseBtn.style.display = 'none';
    document.body.appendChild(collapseBtn);

    // 点击折叠按钮展开
    collapseBtn.addEventListener('click', function () {
      panel.style.display = 'block';
      panel.classList.remove('collapsed');
      collapseBtn.style.display = 'none';
      collapsed = false;
    });

    // 标题栏点击折叠
    document.getElementById('sg-header-bar').addEventListener('click', function () {
      collapsed = !collapsed;
      if (collapsed) {
        panel.classList.add('collapsed');
        collapseBtn.style.display = 'flex';
      } else {
        panel.classList.remove('collapsed');
        collapseBtn.style.display = 'none';
      }
    });

    // 按钮事件
    document.getElementById('btn-auto').addEventListener('click', function () {
      chrome.runtime.sendMessage({ action: 'sg_scheduler_start' });
    });
    document.getElementById('btn-stop').addEventListener('click', function () {
      chrome.runtime.sendMessage({ action: 'sg_scheduler_pause' });
    });
    document.getElementById('btn-fw').addEventListener('click', function () {
      chrome.runtime.sendMessage({ action: 'sg_manual_follow' });
    });
    document.getElementById('btn-ch').addEventListener('click', function () {
      chrome.runtime.sendMessage({ action: 'sg_manual_chat' });
    });
    document.getElementById('btn-nu').addEventListener('click', function () {
      chrome.runtime.sendMessage({ action: 'sg_nurture_only' });
    });

    // 模块开关事件
    function getSwitches() {
      try {
        var raw = localStorage.getItem('sg_module_switches');
        return raw ? JSON.parse(raw) : { nurture: true, follow: true, chat: true };
      } catch (e) { return { nurture: true, follow: true, chat: true }; }
    }
    function setSwitch(module, val) {
      var sw = getSwitches();
      sw[module] = val;
      localStorage.setItem('sg_module_switches', JSON.stringify(sw));
      updateToggleBtns(sw);
    }
    function updateToggleBtns(sw) {
      var m = ['nu','fw','ch'];
      var k = ['nurture','follow','chat'];
      for (var i = 0; i < 3; i++) {
        var btn = document.getElementById('btn-toggle-' + m[i]);
        if (!btn) continue;
        if (sw[k[i]] !== false) {
          btn.style.color = '#3fb950'; btn.style.borderColor = '#238636'; btn.textContent = ['养号','关注','私信'][i] + ' ON';
        } else {
          btn.style.color = '#f85149'; btn.style.borderColor = '#da3633'; btn.textContent = ['养号','关注','私信'][i] + ' OFF';
        }
      }
    }
    document.getElementById('btn-toggle-nu').addEventListener('click', function () {
      var sw = getSwitches(); setSwitch('nurture', sw.nurture === false);
    });
    document.getElementById('btn-toggle-fw').addEventListener('click', function () {
      var sw = getSwitches(); setSwitch('follow', sw.follow === false);
    });
    document.getElementById('btn-toggle-ch').addEventListener('click', function () {
      var sw = getSwitches(); setSwitch('chat', sw.chat === false);
    });

    // 监听调度器的 tick 事件
    window.addEventListener('sg-scheduler-tick', function (e) {
      data = e.detail || {};
      render();
    });

    // 初始渲染
    setTimeout(function () {
      chrome.runtime.sendMessage({ action: 'sg_scheduler_status' }, function (r) {
        if (r) { data = r; render(); }
      });
    }, 2000);
  }

  function render() {
    var d = data;
    if (!d) return;

    // 引擎状态
    var engEl = document.getElementById('v-engine');
    var engText = '空闲';
    var engCls = 'b';
    if (d.engine === 'follow') {
      if (d.followPhase === 'warmup') { engText = '养号中'; engCls = 'b'; }
      else { engText = '关注轮' + (d.followRound || 1); engCls = 'y'; }
    }
    else if (d.engine === 'nurture') {
      engText = '养号中'; engCls = 'b';
    }
    else if (d.engine === 'chat') {
      engText = '私信中'; engCls = 'g';
    }
    else if (d.engine === 'nurture_only') {
      engText = '纯养号'; engCls = 'b';
    }
    else if (d.engine === 'manual') {
      var r = !!d.followRunning;
      engText = r ? '关注(手动)' : (d.chatRunning ? '私信(手动)' : '手动');
      engCls = r ? 'y' : 'g';
    }
    else { engText = '空闲'; engCls = 'r'; }
    if (engEl) { engEl.textContent = engText; engEl.className = 'val ' + engCls; }

    // 轮次
    var roundEl = document.getElementById('v-round');
    if (roundEl) {
      roundEl.textContent = (d.followRound > 0) ? '第' + d.followRound + '轮' : '--';
    }

    // 天数
    var dayEl = document.getElementById('v-day');
    if (dayEl) dayEl.textContent = 'Day ' + (d.dayCount || 1);

    // 关注
    var fwEl = document.getElementById('v-follow');
    if (fwEl) fwEl.textContent = (d.followedToday || 0) + '/' + (d.followLimit || 200);

    // 进度条
    var progEl = document.getElementById('v-progress');
    if (progEl) {
      var pct = d.followLimit > 0 ? Math.min(100, ((d.followedToday || 0) / d.followLimit) * 100) : 0;
      progEl.style.width = pct + '%';
    }

    // 博主
    var creatorEl = document.getElementById('v-creator');
    if (creatorEl) {
      var cr = d.currentCreator || d.suspended || '';
      creatorEl.textContent = cr ? '@' + cr : '--';
    }

    // 养号结束时间
    var roundEl2 = document.getElementById('v-round');
    if (d.warmupEndAt && d.warmupEndAt > 0 && (d.engine === 'nurture' || d.followPhase === 'warmup')) {
      var left = Math.max(0, Math.ceil((d.warmupEndAt - Date.now()) / 60000));
      if (roundEl2) roundEl2.textContent = '养号 ' + left + '分后';
    }

    // 养号状态
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

    // 模式标记
    var badgeEl = document.getElementById('sg-mode-badge');
    if (badgeEl) {
      if (d.autoMode) { badgeEl.textContent = '●自动'; badgeEl.style.color = '#3fb950'; }
      else { badgeEl.textContent = '●手动'; badgeEl.style.color = '#8b949e'; }
    }

    // 折叠按钮状态
    var collapseBtn = document.getElementById('sg-collapse-btn');
    if (collapseBtn) {
      collapseBtn.className = d.autoMode ? 'auto' : 'paused';
    }

    // 模块开关状态
    try { updateToggleBtns(getSwitches()); } catch (e) {}

    // 时间范围提示
    var warnEl = document.getElementById('v-warn');
    if (warnEl) {
      warnEl.className = 'sg-warn';
      warnEl.style.display = 'none';
      if (!d.isWorkTime) {
        warnEl.className = 'sg-warn show err';
        warnEl.textContent = '非工作时间 (23:00-8:00)';
      } else if (!d.isChatTime && d.dayCount >= 3) {
        warnEl.className = 'sg-warn show info';
        warnEl.textContent = '18:00后不私信';
      } else if (d.dayCount < 3 && d.autoMode) {
        warnEl.className = 'sg-warn show info';
        warnEl.textContent = '新号(Day' + d.dayCount + ')不私信';
      }
    }
  }
})();

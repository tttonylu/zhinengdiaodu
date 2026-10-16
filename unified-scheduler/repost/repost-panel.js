// =============================================================================
// E · 转帖浮层（Repost v3 并入智能调度）
// 右键粉色球开面板；拉取 OPS/调度来源；手动开跑；克隆资料
// 若仍装着独立「X Repost Engine」，请关掉以免双球冲突
// =============================================================================
(function () {
  'use strict';
  if (window.RepostPanel) return;

  var BTN_ID = 'sg-rp-btn';
  var PANEL_ID = 'sg-rp-panel';
  var VER = '4.2.16';

  function T() { return window.RepostTracker; }

  function toast(text, color, duration) {
    try {
      var el = document.getElementById('sg-rp-toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'sg-rp-toast';
        el.style.cssText = 'position:fixed;bottom:80px;right:20px;z-index:2147483646;padding:12px 20px;border-radius:8px;font-size:14px;font-weight:600;color:#fff;max-width:400px;box-shadow:0 4px 12px rgba(0,0,0,.3);transition:opacity .3s;opacity:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;';
        document.body.appendChild(el);
      }
      el.textContent = text;
      el.style.background = color || '#1890ff';
      el.style.opacity = '1';
      clearTimeout(el._t);
      el._t = setTimeout(function () { el.style.opacity = '0'; }, duration || 3000);
    } catch (e) {}
  }

  function getTargets() {
    try {
      if (T() && T().getTargets) return T().getTargets() || [];
    } catch (e) {}
    try {
      return JSON.parse(localStorage.getItem('sg_repost_targets') || '[]') || [];
    } catch (e2) { return []; }
  }

  function setTargets(list) {
    var out = (list || []).map(function (h) {
      return String(h || '').replace(/^@/, '').toLowerCase().trim();
    }).filter(Boolean);
    try {
      if (T() && T().setTargets) T().setTargets(out, { skipPush: true });
      else localStorage.setItem('sg_repost_targets', JSON.stringify(out));
    } catch (e) {
      try { localStorage.setItem('sg_repost_targets', JSON.stringify(out)); } catch (e2) {}
    }
    return out;
  }

  function getConfig() {
    try {
      if (T() && T().getConfig) return T().getConfig();
    } catch (e) {}
    return { postType: 'text_or_image', postsPerHandle: 1, cooldownMin: 40, cooldownMax: 90 };
  }

  function saveConfig(partial) {
    try {
      if (T() && T().setConfig) {
        var cfg = Object.assign({}, getConfig(), partial || {});
        T().setConfig(cfg);
      }
    } catch (e) {}
  }

  function isRunning() {
    try {
      if (window.RepostEngine && RepostEngine.isActive) return !!RepostEngine.isActive();
    } catch (e) {}
    try { return sessionStorage.getItem('sg_repost_running') === 'true'; } catch (e2) { return false; }
  }

  function currentHandle() {
    try {
      if (T() && T().getCurrent) return T().getCurrent() || '';
    } catch (e) {}
    return '';
  }

  function dailyLabel() {
    try {
      var d = T() && T().getDaily ? T().getDaily() : { count: 0 };
      var cap = T() && T().getEffectiveDailyLimit ? T().getEffectiveDailyLimit() : '-';
      return (d.count || 0) + '/' + cap;
    } catch (e) { return '-'; }
  }

  function pullFromOps(cb) {
    var done = false;
    var finish = function () {
      if (done) return;
      done = true;
      try { window.removeEventListener('sg-config-synced', onSync); } catch (e) {}
      var n = getTargets().length;
      if (n) toast('已同步 ' + n + ' 个博主：' + getTargets().map(function (h) { return '@' + h; }).join(' '), '#52c41a', 4000);
      else toast('仍无来源（OPS 该号「转帖来源」保存后，再点拉取）', '#fa8c16', 4500);
      if (typeof cb === 'function') cb(n);
      render();
    };
    var onSync = function () { finish(); };
    if (typeof ConfigSync === 'undefined' || !ConfigSync.fetchRemote) {
      toast('ConfigSync 未就绪', '#f4212e');
      return;
    }
    toast('正在从 OPS 拉取…', '#d29922');
    try { window.addEventListener('sg-config-synced', onSync); } catch (eA) {}
    try { ConfigSync.fetchRemote(); } catch (eF) {
      toast('拉取失败', '#f4212e');
      done = true;
      return;
    }
    setTimeout(finish, 3500);
  }

  function isUserPausedFlag() {
    try {
      if (typeof SchedulerGate !== 'undefined' && SchedulerGate.isUserPaused) {
        return !!SchedulerGate.isUserPaused();
      }
    } catch (e0) {}
    try { return localStorage.getItem('sg_user_paused') === '1'; } catch (e1) { return false; }
  }

  function startManual() {
    if (isUserPausedFlag()) {
      toast('调度已停止，请先点「自动」', '#fa8c16');
      return;
    }
    try {
      if (window.ProfileClone && ProfileClone.isRunning && ProfileClone.isRunning()) {
        toast('资料克隆进行中，调度让路，暂不转帖', '#fa8c16', 4000);
        return;
      }
    } catch (ePc) {}
    var list = getTargets();
    if (!list.length) {
      toast('博主列表为空，先点「拉取来源」或手动添加', '#fa8c16', 4000);
      return;
    }
    try {
      // 页面内直发，不走 chrome.runtime/SW，避免 SW 休眠时「Receiving end does not exist」
      window.dispatchEvent(new CustomEvent('sg-page-cmd', { detail: { action: 'sg_manual_repost' } }));
      toast('已启动手动转帖', '#52c41a');
      setTimeout(render, 400);
    } catch (e) {
      toast('启动失败', '#f4212e');
    }
  }

  function stopManual() {
    try {
      if (window.RepostEngine && RepostEngine.stop) RepostEngine.stop();
    } catch (e) {}
    try {
      window.dispatchEvent(new CustomEvent('sg-repost-command', { detail: { command: 'stop', reason: 'panel' } }));
    } catch (e2) {}
    toast('已停止转帖', '#71767b');
    setTimeout(render, 300);
  }

  function toggleEngine() {
    if (isRunning()) stopManual();
    else startManual();
  }

  function cloneProfile() {
    try {
      if (window.ProfileClone && ProfileClone.isRunning && ProfileClone.isRunning()) {
        toast('资料克隆已在进行中', '#d29922');
        return;
      }
    } catch (eBusy) {}
    var src = '';
    try {
      if (window.ProfileClone && ProfileClone.getSourceHandle) src = ProfileClone.getSourceHandle() || '';
    } catch (e0) {}
    if (!src) {
      var list = getTargets();
      src = list[0] || '';
    }
    if (!src) {
      toast('无来源号，先拉取/添加博主', '#fa8c16');
      return;
    }
    try {
      if (window.ProfileClone && ProfileClone.resetAll) ProfileClone.resetAll();
    } catch (e1) {}
    toast('开始克隆 @' + src + '（手动，不跳首页）…', '#f91880', 4000);
    try {
      if (window.ProfileClone && ProfileClone.ensureBeforeNurture) {
        // nurtureAfter:false 禁止克隆中途跳养号首页；force 不依赖「自动」
        ProfileClone.ensureBeforeNurture('https://x.com/home', { nurtureAfter: false, force: true });
        return;
      }
    } catch (e2) {}
    try {
      if (typeof SchedulerGate !== 'undefined' && SchedulerGate.goRaw) {
        SchedulerGate.goRaw('https://x.com/' + src + '?lang=ja', { force: true });
      } else if (typeof SchedulerGate !== 'undefined' && SchedulerGate.go) {
        SchedulerGate.go('panel', 'https://x.com/' + src + '?lang=ja', { force: true });
      } else location.href = 'https://x.com/' + src + '?lang=ja';
    } catch (e3) {}
  }

  function clearPosted() {
    if (!confirm('确认清除本机已发/跳过帖 ID？\n（博主列表保留）')) return;
    try { localStorage.removeItem('sg_repost_posted_ids'); } catch (e) {}
    try { localStorage.removeItem('sg_repost_skip_ids'); } catch (e2) {}
    toast('已清已发记录', '#52c41a');
  }

  function render() {
    var panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    var targets = getTargets();
    var cfg = getConfig();
    var running = isRunning();
    var cur = currentHandle();
    var pt = cfg.postType || 'text_or_image';
    if (pt === 'text_or_image') pt = 'all';

    var cloneLabel = '';
    var cloneError = '';
    try {
      if (window.ProfileClone && ProfileClone.statusLabel) cloneLabel = ProfileClone.statusLabel() || '';
      if (window.ProfileClone && ProfileClone.getState) {
        var cs = ProfileClone.getState();
        if (cs && cs.lastError) cloneError = cs.lastError;
      }
    } catch (eCl) {}

    panel.innerHTML =
      '<div class="sg-rp-head"><span>Repost v3 <span class="sg-rp-ver">' + VER + '</span></span>'
      + '<span class="sg-rp-st">' + (running ? 'RUNNING' : 'STOP') + '</span></div>'
      + '<div class="sg-rp-info">'
      + '<div><span>当前</span><span class="hl">' + (cur ? '@' + cur : '-') + '</span></div>'
      + '<div><span>绑定</span><span>' + targets.length + '</span></div>'
      + '<div><span>今日</span><span>' + dailyLabel() + '</span></div>'
      + '</div>'
      + (cloneLabel
        ? '<div style="font-size:10px;color:#f91880;margin:0 0 6px">资料克隆：' + cloneLabel + (cloneError ? ' · ' + cloneError : '') + '</div>'
        : '')
      + '<div class="sg-rp-cfg">'
      + '<div><span>类型</span><select id="sg-rp-type">'
      + '<option value="all"' + (pt === 'all' ? ' selected' : '') + '>全部</option>'
      + '<option value="text"' + (pt === 'text' ? ' selected' : '') + '>仅文字</option>'
      + '<option value="image"' + (pt === 'image' ? ' selected' : '') + '>仅图片</option>'
      + '</select></div>'
      + '<div><span>帖数</span><input id="sg-rp-posts" type="number" min="1" max="20" value="'
      + (cfg.postsPerHandle || 1) + '" style="width:44px"></div>'
      + '<div><span>冷却分</span><input id="sg-rp-min" type="number" min="1" max="180" value="'
      + (cfg.cooldownMin || 40) + '" style="width:38px">-<input id="sg-rp-max" type="number" min="1" max="240" value="'
      + (cfg.cooldownMax || 90) + '" style="width:38px"></div>'
      + '</div>'
      + '<div class="sg-rp-list-title">博主 (' + targets.length + ')</div>'
      + '<button type="button" id="sg-rp-pull" class="sg-rp-pull">⬇ 拉取来源（OPS）</button>'
      + '<div class="sg-rp-list">'
      + (targets.length
        ? targets.map(function (h) {
          return '<div class="sg-rp-item"><span>@' + h + '</span><button type="button" data-rm="' + h + '">×</button></div>';
        }).join('')
        : '<div class="sg-rp-empty">暂无博主 · 点上方「拉取来源」</div>')
      + '</div>'
      + '<div class="sg-rp-add"><input id="sg-rp-add-inp" placeholder="输入 handle（不含 @）">'
      + '<button type="button" id="sg-rp-add-btn">+ 添加</button></div>'
      + '<div class="sg-rp-actions">'
      + '<button type="button" id="sg-rp-run">' + (running ? '停止' : '手动转帖') + '</button>'
      + '<button type="button" id="sg-rp-clone">克隆资料</button>'
      + '<button type="button" id="sg-rp-clear">清记录</button>'
      + '</div>'
      + '<div class="sg-rp-hint">智能调度内置 · 勿再开独立 X Repost Engine</div>';

    var typeEl = document.getElementById('sg-rp-type');
    if (typeEl) typeEl.onchange = function (e) {
      var v = e.target.value;
      saveConfig({ postType: v === 'all' ? 'text_or_image' : v });
    };
    var postsEl = document.getElementById('sg-rp-posts');
    if (postsEl) postsEl.onchange = function (e) {
      saveConfig({ postsPerHandle: Math.max(1, parseInt(e.target.value, 10) || 1) });
    };
    var minEl = document.getElementById('sg-rp-min');
    if (minEl) minEl.onchange = function (e) {
      saveConfig({ cooldownMin: Math.max(1, parseInt(e.target.value, 10) || 40) });
    };
    var maxEl = document.getElementById('sg-rp-max');
    if (maxEl) maxEl.onchange = function (e) {
      saveConfig({ cooldownMax: Math.max(1, parseInt(e.target.value, 10) || 90) });
    };

    var pullBtn = document.getElementById('sg-rp-pull');
    if (pullBtn) pullBtn.onclick = function (e) {
      e.stopPropagation();
      pullFromOps();
    };
    var addBtn = document.getElementById('sg-rp-add-btn');
    if (addBtn) addBtn.onclick = function () {
      var inp = document.getElementById('sg-rp-add-inp');
      var h = (inp && inp.value || '').trim().replace(/^@/, '').toLowerCase();
      if (!h) return;
      var list = getTargets();
      if (list.indexOf(h) < 0) list.push(h);
      setTargets(list);
      render();
    };
    var addInp = document.getElementById('sg-rp-add-inp');
    if (addInp) addInp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') addBtn && addBtn.click();
    });

    panel.querySelectorAll('[data-rm]').forEach(function (btn) {
      btn.onclick = function (ev) {
        ev.stopPropagation();
        setTargets(getTargets().filter(function (h) { return h !== btn.getAttribute('data-rm'); }));
        render();
      };
    });

    var runBtn = document.getElementById('sg-rp-run');
    if (runBtn) runBtn.onclick = function (e) {
      e.stopPropagation();
      toggleEngine();
    };
    var cloneBtn = document.getElementById('sg-rp-clone');
    if (cloneBtn) cloneBtn.onclick = function (e) {
      e.stopPropagation();
      cloneProfile();
    };
    var clearBtn = document.getElementById('sg-rp-clear');
    if (clearBtn) clearBtn.onclick = function (e) {
      e.stopPropagation();
      clearPosted();
    };

    panel.onclick = function (e) { e.stopPropagation(); };
    updateDot();
  }

  function updateDot() {
    var btn = document.getElementById(BTN_ID);
    if (!btn) return;
    var dot = btn.querySelector('.sg-rp-dot');
    if (dot) dot.style.background = isRunning() ? '#22c55e' : '#ef4444';
    if (isRunning()) btn.classList.add('sg-rp-running');
    else btn.classList.remove('sg-rp-running');
  }

  function togglePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    var show = !panel.classList.contains('sg-rp-show');
    if (show) {
      if (!getTargets().length) {
        // 打开时空列表先静默尝试同步
        try {
          if (typeof ConfigSync !== 'undefined' && ConfigSync.fetchRemote) ConfigSync.fetchRemote();
        } catch (e) {}
        setTimeout(function () { render(); }, 800);
      }
      render();
    }
    panel.classList.toggle('sg-rp-show', show);
  }

  function inject() {
    if (!document.body || document.getElementById(BTN_ID)) return;

    // 若独立扩展粉色球已在，提示关掉
    if (document.getElementById('mx-btn')) {
      console.warn('[转帖面板] 检测到独立 X Repost Engine（#mx-btn），建议禁用该扩展，只用智能调度');
    }

    var style = document.createElement('style');
    style.textContent = [
      '#' + BTN_ID + '{position:fixed;top:52px;right:12px;width:28px;height:28px;border-radius:50%;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#f91880,#c4125a);box-shadow:0 1px 6px rgba(0,0,0,.2);z-index:2147483640;opacity:.45;transition:all .2s;padding:0}',
      '#' + BTN_ID + ':hover{opacity:1;transform:scale(1.15)}',
      '#' + BTN_ID + ' .sg-rp-dot{position:absolute;top:-1px;right:-1px;width:8px;height:8px;background:#ef4444;border-radius:50%;border:1.5px solid #15202b}',
      '#' + BTN_ID + '.sg-rp-running{opacity:.75;animation:sg-rp-pulse 2s infinite}',
      '@keyframes sg-rp-pulse{0%{box-shadow:0 0 0 0 rgba(249,24,128,.4)}70%{box-shadow:0 0 0 8px rgba(249,24,128,0)}100%{box-shadow:0 0 0 0 rgba(249,24,128,0)}}',
      '#' + PANEL_ID + '{position:fixed;top:88px;right:12px;width:270px;background:#1c2732;border:1px solid #38444d;border-radius:10px;padding:12px;z-index:2147483639;max-height:460px;overflow-y:auto;box-shadow:0 4px 20px rgba(0,0,0,.5);color:#e7e9ea;font-size:12px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:none}',
      '#' + PANEL_ID + '.sg-rp-show{display:block}',
      '.sg-rp-head{display:flex;justify-content:space-between;font-size:14px;font-weight:700;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #38444d}',
      '.sg-rp-ver{font-size:9px;color:#1d9bf0;margin-left:4px}',
      '.sg-rp-st{font-size:10px;color:#71767b}',
      '.sg-rp-info{padding:6px 8px;background:#253341;border-radius:6px;margin-bottom:8px;display:flex;justify-content:space-between}',
      '.sg-rp-info span:first-child{color:#71767b}',
      '.sg-rp-info .hl{color:#1d9bf0}',
      '.sg-rp-cfg{padding:8px;background:#1a2735;border:1px solid #2f3e4e;border-radius:6px;margin-bottom:8px}',
      '.sg-rp-cfg div{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}',
      '.sg-rp-cfg span{color:#71767b;font-size:11px}',
      '.sg-rp-cfg select,.sg-rp-cfg input{background:#253341;color:#e7e9ea;border:1px solid #38444d;border-radius:3px;padding:2px 4px;font-size:11px;text-align:center}',
      '.sg-rp-list-title{font-size:10px;color:#71767b;margin-bottom:4px}',
      '.sg-rp-pull{display:block;width:100%;box-sizing:border-box;margin:0 0 8px;padding:8px 10px;background:#1d9bf0;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:700}',
      '.sg-rp-list{max-height:110px;overflow-y:auto;margin-bottom:6px}',
      '.sg-rp-item{display:flex;justify-content:space-between;padding:4px 6px;background:#253341;border-radius:4px;margin-bottom:3px;font-size:11px}',
      '.sg-rp-item span{color:#1d9bf0}',
      '.sg-rp-item button{background:#f4212e33;color:#f4212e;border:none;border-radius:3px;cursor:pointer;padding:0 5px}',
      '.sg-rp-empty{color:#71767b;text-align:center;padding:10px}',
      '.sg-rp-add{display:flex;gap:4px;margin-bottom:8px}',
      '.sg-rp-add input{flex:1;padding:4px 6px;background:#253341;color:#e7e9ea;border:1px solid #38444d;border-radius:4px;font-size:11px}',
      '.sg-rp-add button{padding:4px 10px;background:#1d9bf0;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;font-weight:600}',
      '.sg-rp-actions{display:flex;gap:4px}',
      '.sg-rp-actions button{flex:1;padding:6px 2px;border:none;border-radius:6px;cursor:pointer;font-size:11px;font-weight:600}',
      '#sg-rp-run{background:#38444d;color:#e7e9ea}',
      '#sg-rp-clone{background:linear-gradient(135deg,#f91880,#c4125a);color:#fff}',
      '#sg-rp-clear{background:#253341;color:#8b949e}',
      '.sg-rp-hint{margin-top:6px;font-size:9px;color:#71767b;line-height:1.35}'
    ].join('');
    document.head.appendChild(style);

    var panel = document.createElement('div');
    panel.id = PANEL_ID;
    document.body.appendChild(panel);

    var btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.innerHTML = '<span class="sg-rp-dot"></span><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#fff" stroke-width="2.5"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>';
    btn.title = '转帖（智能调度）| 左键开/关 | 右键面板';
    btn.onclick = function (e) {
      e.preventDefault();
      toggleEngine();
      updateDot();
    };
    btn.oncontextmenu = function (e) {
      e.preventDefault();
      togglePanel();
    };
    document.body.appendChild(btn);

    document.addEventListener('click', function (e) {
      var p = document.getElementById(PANEL_ID);
      var b = document.getElementById(BTN_ID);
      if (p && p.classList.contains('sg-rp-show') && !p.contains(e.target) && e.target !== b && !(b && b.contains(e.target))) {
        p.classList.remove('sg-rp-show');
      }
    });

    try {
      window.addEventListener('sg-config-synced', function () {
        var p = document.getElementById(PANEL_ID);
        if (p && p.classList.contains('sg-rp-show')) render();
        updateDot();
      });
    } catch (eL) {}

    updateDot();
    setInterval(function () { if (!document.hidden && isRunning()) updateDot(); }, 4000);
  }

  function boot() {
    if (!document.body) {
      setTimeout(boot, 200);
      return;
    }
    inject();
  }

  boot();
  window.RepostPanel = { render: render, pullFromOps: pullFromOps, version: VER };
})();

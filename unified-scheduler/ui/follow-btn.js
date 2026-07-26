// =============================================================================
// 智能调度 — 蓝色 Follow 悬浮按钮（独立注入页面）
// 右下角蓝色圆形按钮：点击启动关注，停止时显示停止按钮
// =============================================================================

(function () {
  'use strict';
  return; // v3.0 停用：功能已合并到面板

  if (document.getElementById('sg-follow-btn')) return;

  function waitForBody(fn) {
    if (document.body) { fn(); return; }
    setTimeout(function () { waitForBody(fn); }, 100);
  }

  waitForBody(build);

  function build() {
    var style = document.createElement('style');
    style.textContent = [
      '#sg-follow-btn {',
      '  position:fixed; top:50%; right:24px;',
      '  width:44px; height:44px; border-radius:50%; border:2px solid rgba(29,155,240,0.4);',
      '  cursor:pointer; display:flex; align-items:center; justify-content:center;',
      '  background:linear-gradient(135deg,#1d9bf0,#0d8ecf);',
      '  box-shadow:0 2px 12px rgba(29,155,240,0.35);',
      '  z-index:2147483640; transition:all .2s;',
      '  transform:translateY(-50%);',
      '}',
      '#sg-follow-btn:hover { transform:translateY(-50%) scale(1.1); box-shadow:0 4px 16px rgba(29,155,240,0.5); }',
      '#sg-follow-btn:active { transform:translateY(-50%) scale(0.95); }',
      '#sg-follow-btn svg { width:22px; height:22px; fill:#fff; }',
      '#sg-follow-btn.running { background:linear-gradient(135deg,#22c55e,#16a34a); border-color:rgba(34,197,94,0.4); box-shadow:0 2px 12px rgba(34,197,94,0.35); }',
      '#sg-follow-btn.running:hover { box-shadow:0 4px 16px rgba(34,197,94,0.5); }',
      '#sg-follow-btn .tooltip {',
      '  position:absolute; right:52px; top:50%; transform:translateY(-50%);',
      '  background:rgba(22,27,34,0.95); color:#c9d1d9; font-size:11px;',
      '  padding:4px 10px; border-radius:4px; white-space:nowrap;',
      '  opacity:0; transition:opacity .2s; pointer-events:none;',
      '  border:1px solid #30363d;',
      '}',
      '#sg-follow-btn:hover .tooltip { opacity:1; }',
    ].join('\n');
    document.head.appendChild(style);

    var btn = document.createElement('button');
    btn.id = 'sg-follow-btn';
    btn.title = '启动关注';
    btn.innerHTML = [
      '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>',
      '<span class="tooltip">启动关注</span>',
    ].join('');

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var isRunning = btn.classList.contains('running');
      if (isRunning) {
        chrome.runtime.sendMessage({ action: 'sg_scheduler_pause' });
        btn.classList.remove('running');
        btn.querySelector('.tooltip').textContent = '启动关注';
        btn.title = '启动关注';
      } else {
        chrome.runtime.sendMessage({ action: 'sg_scheduler_start' });
        btn.classList.add('running');
        btn.querySelector('.tooltip').textContent = '停止调度';
        btn.title = '停止调度';
      }
    });

    document.body.appendChild(btn);

    // 每 5 秒同步状态
    setInterval(function () {
      try {
        chrome.runtime.sendMessage({ action: 'sg_scheduler_status' }, function (r) {
          if (!r) return;
          var active = r.autoMode || (r.engine && r.engine !== 'idle');
          if (active) { btn.classList.add('running'); btn.querySelector('.tooltip').textContent = '停止调度'; }
          else { btn.classList.remove('running'); btn.querySelector('.tooltip').textContent = '启动关注'; }
        });
      } catch (e) {}
    }, 5000);
  }
})();

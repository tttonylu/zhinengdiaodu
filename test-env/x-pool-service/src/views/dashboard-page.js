function renderDashboardPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>号池管理面板</title>
  <style>
    :root {
      --ink: #172026;
      --muted: #64717b;
      --line: #d8e0e5;
      --panel: #ffffff;
      --paper: #f4f7f8;
      --accent: #0b7285;
      --accent-strong: #075766;
      --danger: #ba2f3b;
      --ok: #237a4b;
      --warn: #9a6500;
      --bg-dark: #0b1122;
      --card-dark: #11192d;
      --border-dark: #1a2650;
      --text-dark: #e0e8f8;
      --muted-dark: #4a5578;
      --cyan: #00e5ff;
      --green: #00e676;
      --amber: #ffab00;
      --red: #ff3d5a;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      background: var(--paper);
      font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
    }
    .tabs {
      display: flex; gap: 0; background: #fff;
      border-bottom: 1px solid var(--line); padding: 0 16px;
    }
    .tab-btn {
      padding: 12px 24px; border: none; background: none; cursor: pointer;
      font-size: 14px; font-weight: 600; color: var(--muted);
      border-bottom: 2px solid transparent; transition: all .15s;
    }
    .tab-btn:hover { color: var(--ink); }
    .tab-btn.active { color: var(--accent); border-bottom-color: var(--accent); }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }

    .shell { width: min(1180px, calc(100vw - 32px)); margin: 0 auto; padding: 24px 0 40px; }
    header {
      display: flex; align-items: flex-end; justify-content: space-between;
      gap: 16px; padding-bottom: 16px; border-bottom: 1px solid var(--line);
    }
    h1 { margin: 0; font-size: 26px; line-height: 1.15; font-weight: 720; }
    .subhead { margin: 6px 0 0; color: var(--muted); font-size: 13px; }
    .actions, .toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    button, .button-link, select, textarea, input { font: inherit; }
    button, .button-link {
      min-height: 34px; border: 1px solid var(--line); background: var(--panel);
      color: var(--ink); border-radius: 6px; padding: 0 12px; cursor: pointer;
      text-decoration: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    }
    button.primary { background: var(--accent); color: white; border-color: var(--accent); }
    button.primary:hover { background: var(--accent-strong); }
    button.danger { color: var(--danger); }
    .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 18px 0; }
    .metric {
      background: var(--panel); border: 1px solid var(--line);
      border-radius: 8px; padding: 14px; min-height: 86px;
    }
    .metric span { display: block; color: var(--muted); font-size: 12px; }
    .metric strong { display: block; margin-top: 8px; font-size: 28px; line-height: 1; }
    .workspace { display: grid; grid-template-columns: 330px 1fr; gap: 14px; align-items: start; }
    .side-stack { display: grid; gap: 14px; }
    .panel {
      background: var(--panel); border: 1px solid var(--line);
      border-radius: 8px; padding: 14px;
    }
    .panel h2 { margin: 0 0 12px; font-size: 15px; }
    textarea {
      width: 100%; min-height: 150px; resize: vertical;
      border: 1px solid var(--line); border-radius: 6px; padding: 10px;
      color: var(--ink); background: white;
    }
    input, select {
      min-height: 34px; border: 1px solid var(--line); border-radius: 6px;
      padding: 0 10px; background: white; color: var(--ink);
    }
    .form-row { display: grid; gap: 8px; margin-top: 10px; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; min-width: 820px; }
    th, td { padding: 10px 9px; border-bottom: 1px solid var(--line); text-align: left; font-size: 13px; white-space: nowrap; }
    th { color: var(--muted); font-weight: 650; background: #f8fafb; }
    .status {
      display: inline-flex; min-width: 76px; justify-content: center;
      padding: 3px 8px; border-radius: 999px; font-size: 12px; border: 1px solid var(--line);
    }
    .status.pending { color: var(--warn); background: #fff8e8; border-color: #efd7a3; }
    .status.assigned { color: var(--accent); background: #e8f6f8; border-color: #b7dfe5; }
    .status.completed { color: var(--ok); background: #edf8f1; border-color: #bfe4cc; }
    .status.dead { color: var(--danger); background: #fde8ea; border-color: #f0c4c9; }
    .empty { padding: 28px; text-align: center; color: var(--muted); }
    .toast { min-height: 20px; margin-top: 10px; color: var(--muted); font-size: 13px; }
    code {
      display: block; padding: 8px 10px; margin-top: 8px;
      border: 1px solid var(--line); border-radius: 6px; background: #f8fafb;
      color: var(--accent-strong); overflow-x: auto; font-size: 12px;
    }

    .shell-dark { width: min(1280px, calc(100vw - 32px)); margin: 0 auto; padding: 20px 0 40px; }
    .dark-body { background: var(--bg-dark); color: var(--text-dark); }
    .dark-body .panel { background: var(--card-dark); border: 1px solid var(--border-dark); color: var(--text-dark); }
    .dark-body .panel h2 { color: var(--cyan); }
    .dark-body input, .dark-body select { background: #0d1530; border: 1px solid var(--border-dark); color: var(--text-dark); }
    .dark-body input:focus, .dark-body select:focus { border-color: var(--cyan); }
    .dark-body button { background: var(--card-dark); border: 1px solid var(--border-dark); color: var(--text-dark); }
    .dark-body button:hover { border-color: var(--cyan); color: var(--cyan); }
    .dark-body button.primary { background: var(--cyan); color: #000; border: none; font-weight: 700; }
    .dark-body button.primary:hover { box-shadow: 0 0 12px rgba(0,229,255,.3); }
    .dark-body button.danger { border-color: var(--red); color: var(--red); }
    .dark-body button.danger:hover { background: rgba(255,61,90,.1); }
    .dark-body button:disabled { opacity: .4; }
    .dark-body .subhead { color: var(--muted-dark); }
    .dark-body table { min-width: auto; }
    .dark-body th { background: #0d1530; color: var(--muted-dark); font-size: 11px; border-bottom: 2px solid var(--border-dark); }
    .dark-body td { font-size: 12px; border-bottom: 1px solid rgba(26,38,80,.4); color: var(--text-dark); }
    .dark-body td.mono { font-family: monospace; font-size: 11px; }
    .dark-body tr:hover td { background: rgba(0,229,255,.02); }
    .stat-row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 14px; }
    .stat-card {
      background: var(--card-dark); border: 1px solid var(--border-dark);
      border-radius: 8px; padding: 14px; text-align: center;
    }
    .stat-card .num { font-size: 1.6rem; font-weight: 900; font-family: monospace; }
    .stat-card .lbl { font-size: 11px; color: var(--muted-dark); }
    .filter-bar { display: grid; grid-template-columns: repeat(4, 1fr) auto auto; gap: 8px; align-items: end; }
    .filter-bar label { font-size: 11px; color: var(--muted-dark); display: block; margin-bottom: 2px; }
    .filter-bar input, .filter-bar select { font-size: 13px; padding: 6px 8px; width: 100%; }
    .btn-row { display: flex; gap: 8px; margin-top: 12px; align-items: center; }
    .result-log {
      max-height: 460px; overflow-y: auto; margin-top: 8px;
      font-size: 12px; color: var(--text-dark); font-family: monospace; line-height: 1.7;
      border-top: 1px solid var(--border-dark); padding-top: 8px;
    }
    .result-log .del { color: var(--red); }
    .result-log .keep { color: var(--green); }
    .result-log .err { color: var(--amber); }
    .result-log .info { color: var(--muted-dark); }
    .status-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 4px; }
    .status-dot.on { background: var(--green); box-shadow: 0 0 6px var(--green); }
    .status-dot.off { background: var(--amber); }

    @media (max-width: 840px) {
      header { align-items: flex-start; flex-direction: column; }
      .stats, .stat-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .workspace { grid-template-columns: 1fr; }
      .filter-bar { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>
  <nav class="tabs">
    <button class="tab-btn active" data-tab="pool">号池管理</button>
    <button class="tab-btn" data-tab="activity">活跃检测</button>
  </nav>

  <div class="tab-panel active" id="tab-pool">
    <main class="shell">
      <header>
        <div>
          <h1>号池管理面板</h1>
          <p class="subhead">NAS 独立号池服务，端口 5678</p>
        </div>
        <div class="actions">
          <a class="button-link" id="export-csv" href="/api/export/tasks.csv">导出 CSV</a>
          <button id="refresh-btn" type="button">刷新</button>
        </div>
      </header>
      <section class="stats" aria-label="Pool stats">
        <div class="metric"><span>待领取</span><strong id="stat-pending">0</strong></div>
        <div class="metric"><span>已分配</span><strong id="stat-assigned">0</strong></div>
        <div class="metric"><span>已完成</span><strong id="stat-completed">0</strong></div>
        <div class="metric"><span>死号</span><strong id="stat-dead">0</strong></div>
      </section>
      <section class="workspace">
        <div class="side-stack">
          <form class="panel" id="add-form">
            <h2>添加目标</h2>
            <textarea id="handles-input" placeholder="@alpha&#10;@beta&#10;https://x.com/gamma"></textarea>
            <div class="form-row">
              <input id="source-input" value="manual-dashboard" aria-label="来源">
              <button class="primary" type="submit">加入号池</button>
            </div>
            <div class="toast" id="toast"></div>
          </form>
          <section class="panel">
            <h2>Push 接入</h2>
            <p class="subhead">扩展里的号池服务器填这个 NAS 地址后，页面上的 push 按钮会通过 background.js 推送到下面接口。</p>
            <code id="pool-base-url"></code>
            <code>POST /pool/push</code>
            <code>POST /pool/push_batch</code>
          </section>
        </div>
        <section class="panel">
          <div class="toolbar">
            <h2 style="margin-right:auto;">任务列表</h2>
            <select id="status-filter" aria-label="状态筛选">
              <option value="">全部状态</option>
              <option value="pending">待领取</option>
              <option value="assigned">已分配</option>
              <option value="completed">已完成</option>
              <option value="dead">死号</option>
            </select>
          </div>
          <div class="table-wrap">
            <table id="task-table">
              <thead><tr><th>编号</th><th>账号</th><th>状态</th><th>来源</th><th>领取端</th><th>次数</th><th>更新时间</th><th></th></tr></thead>
              <tbody id="task-rows"></tbody>
            </table>
            <div class="empty" id="empty-state" hidden>号池里还没有任务。</div>
          </div>
        </section>
      </section>
    </main>
  </div>

  <div class="tab-panel" id="tab-activity">
    <main class="shell-dark">
      <header style="border-bottom-color:var(--border-dark);">
        <div><h1 style="color:var(--cyan);">活跃检测</h1><p class="subhead">基于 Twitter GraphQL · Cookie 认证 · 多号轮换</p></div>
        <div class="actions">
          <span class="status-dot off" id="act-dot"></span>
          <span style="font-size:12px;color:var(--muted-dark)" id="act-cookie-status">未配置</span>
        </div>
      </header>
      <section class="stat-row">
        <div class="stat-card"><div class="num" style="color:var(--cyan)" id="act-total">0</div><div class="lbl">号池总数</div></div>
        <div class="stat-card"><div class="num" style="color:var(--amber)" id="act-pending">0</div><div class="lbl">待领取</div></div>
        <div class="stat-card"><div class="num" style="color:var(--green)" id="act-completed">0</div><div class="lbl">已完成</div></div>
        <div class="stat-card"><div class="num" style="color:var(--red)" id="act-dead">0</div><div class="lbl">死号</div></div>
      </section>
      <section class="panel">
        <h2>Cookie 管理 <span style="font-size:11px;color:var(--muted-dark);float:right" id="cookie-count">0 个</span></h2>
        <div id="cookie-list" style="max-height:140px;overflow-y:auto;margin-bottom:8px;font-size:12px;color:var(--muted-dark)">加载中...</div>
        <div style="display:flex;gap:6px;margin-bottom:6px">
          <input id="cookie-name" placeholder="账号名称" style="flex:1;font-size:12px">
          <button onclick="addCookieFromUI()" style="font-size:12px;white-space:nowrap">保存</button>
        </div>
        <input id="auth-token-input" placeholder="auth_token (40位16进制)" style="font-size:12px;margin-bottom:4px">
        <input id="ct0-input" placeholder="ct0 (32位16进制，可选)" style="font-size:12px;margin-bottom:4px">
        <div style="font-size:10px;color:var(--muted-dark);margin-bottom:4px">
          也支持直接粘贴整段 ~~~~ 账号包，会自动提取
        </div>
      </section>
      <section class="panel">
        <h2>检测配置</h2>
        <div class="filter-bar">
          <label>未发帖小时<span style="color:var(--muted-dark)"> (超时判死)</span>
            <input id="act-hours" type="number" value="72" min="1" max="720">
          </label>
          <label>最低粉丝数
            <input id="act-min-followers" type="number" value="300" min="0">
          </label>
          <label>最高粉丝数<span style="color:var(--muted-dark)"> (0=不限)</span>
            <input id="act-max-followers" type="number" value="20000" min="0">
          </label>
          <label>关注上限规则<span style="font-size:10px;color:var(--muted-dark)"><br>上限 = 基础 + 粉丝 × 倍率</span>
            <input id="act-following-base" type="number" value="50" min="0" style="width:50%;display:inline" title="基础上限">
            <input id="act-following-rate" type="number" value="0.01" min="0" step="0.01" style="width:45%;display:inline" title="倍率">
          </label>
          <label>批次数量
            <input id="act-limit" type="number" value="3000" min="1" max="5000">
          </label>
        </div>
        <div class="btn-row">
          <button id="act-preview-btn" onclick="activityPreview()">预览 (不删除)</button>
          <button class="primary" id="act-run-btn" onclick="activityRun()">执行活跃检测</button>
          <span style="font-size:11px;color:var(--amber);margin-left:8px" id="act-running-msg"></span>
        </div>
      </section>
      <section class="panel" style="margin-top:12px">
        <h2>检测日志</h2>
        <div id="act-result-summary" style="font-size:12px;color:var(--muted-dark);margin-bottom:6px">点击预览或执行开始检测</div>
        <div class="result-log" id="act-result-log"></div>
      </section>
    </main>
  </div>

  <script>
    document.querySelectorAll('.tab-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
        document.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.remove('active'); });
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
        if (btn.dataset.tab === 'activity') { loadActivityStats(); loadCookies(); }
      });
    });

    // ====== 号池管理 ======
    var rowsEl = document.getElementById('task-rows');
    var emptyEl = document.getElementById('empty-state');
    var filterEl = document.getElementById('status-filter');
    var toastEl = document.getElementById('toast');
    document.getElementById('pool-base-url').textContent = window.location.origin;

    function text(v) { return v == null || v === '' ? '-' : String(v); }
    function setToast(m) { toastEl.textContent = m; }
    function statusText(s) {
      if (s === 'pending') return '待领取';
      if (s === 'assigned') return '已分配';
      if (s === 'completed') return '已完成';
      if (s === 'dead') return '死号';
      return s || '-';
    }
    function renderStats(stats) {
      document.getElementById('stat-pending').textContent = stats.pending || 0;
      document.getElementById('stat-assigned').textContent = stats.assigned || 0;
      document.getElementById('stat-completed').textContent = stats.completed || 0;
      document.getElementById('stat-dead').textContent = stats.dead || 0;
    }
    function renderRows(tasks) {
      rowsEl.innerHTML = '';
      emptyEl.hidden = tasks.length !== 0;
      for (var i = 0; i < tasks.length; i++) {
        var task = tasks[i];
        var tr = document.createElement('tr');
        var cells = [task.id, task.handle, task.status, task.source, task.worker_id, task.attempts, task.updated_at];
        for (var j = 0; j < cells.length; j++) {
          var td = document.createElement('td');
          var v = cells[j];
          if (v === task.status) {
            var badge = document.createElement('span');
            badge.className = 'status ' + task.status;
            badge.textContent = statusText(task.status);
            td.appendChild(badge);
          } else if (v === task.handle) {
            var strong = document.createElement('strong');
            strong.textContent = text(v);
            td.appendChild(strong);
          } else {
            td.textContent = text(v);
          }
          tr.appendChild(td);
        }
        var actionTd = document.createElement('td');
        var delBtn = document.createElement('button');
        delBtn.className = 'danger';
        delBtn.type = 'button';
        delBtn.dataset.delete = task.id;
        delBtn.textContent = '删除';
        actionTd.appendChild(delBtn);
        tr.appendChild(actionTd);
        rowsEl.appendChild(tr);
      }
    }
    async function loadTasks() {
      var q = filterEl.value ? '?status=' + encodeURIComponent(filterEl.value) : '';
      var r = await fetch('/api/tasks' + q);
      var d = await r.json();
      renderStats(d.stats || {});
      renderRows(d.tasks || []);
    }
    document.getElementById('refresh-btn').addEventListener('click', loadTasks);
    filterEl.addEventListener('change', loadTasks);
    document.getElementById('add-form').addEventListener('submit', async function(e) {
      e.preventDefault();
      var handles = document.getElementById('handles-input').value;
      var source = document.getElementById('source-input').value;
      var r = await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handles: handles, source: source }) });
      var d = await r.json();
      setToast('已添加 ' + d.inserted + ' 个，跳过 ' + d.skipped + ' 个。');
      if (d.ok) document.getElementById('handles-input').value = '';
      await loadTasks();
    });
    rowsEl.addEventListener('click', async function(e) {
      var id = e.target && e.target.dataset ? e.target.dataset.delete : '';
      if (!id) return;
      await fetch('/api/tasks/' + encodeURIComponent(id), { method: 'DELETE' });
      await loadTasks();
    });

    // ====== 活跃检测 (fetch streaming) ======
    var abortCtrl = null;

    async function loadActivityStats() {
      try {
        var r = await fetch('/pool/status');
        var s = await r.json();
        document.getElementById('act-total').textContent = (s.pending||0)+(s.assigned||0)+(s.completed||0)+(s.dead||0);
        document.getElementById('act-pending').textContent = s.pending || 0;
        document.getElementById('act-completed').textContent = s.completed || 0;
        document.getElementById('act-dead').textContent = s.dead || 0;
      } catch(e) {}
      try {
        var h = await fetch('/health');
        if (h.ok) {
          document.getElementById('act-dot').className = 'status-dot on';
          document.getElementById('act-cookie-status').textContent = '服务在线';
        }
      } catch(e) {
        document.getElementById('act-dot').className = 'status-dot off';
        document.getElementById('act-cookie-status').textContent = '离线';
      }
    }

    function setRunning(msg) {
      document.getElementById('act-running-msg').textContent = msg || '';
      document.getElementById('act-preview-btn').disabled = !!msg;
      document.getElementById('act-run-btn').disabled = !!msg;
    }

    function clearLog() {
      document.getElementById('act-result-log').innerHTML = '';
    }

    function appendLog(text, cls) {
      var log = document.getElementById('act-result-log');
      var div = document.createElement('div');
      div.className = cls || '';
      div.textContent = text;
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
    }

    async function startStream(url, isRun) {
      if (abortCtrl) { abortCtrl.abort(); }
      abortCtrl = new AbortController();
      clearLog();
      setRunning(isRun ? '检测中...' : '预览中...');
      var summary = document.getElementById('act-result-summary');
      summary.textContent = '连接中...';
      appendLog('连接中...', 'info');

      try {
        var resp = await fetch(url, { signal: abortCtrl.signal });
        if (!resp.ok) {
          var errBody;
          try { errBody = await resp.json(); } catch(_) { errBody = { msg: 'HTTP ' + resp.status }; }
          summary.textContent = '错误: ' + (errBody.msg || '未知');
          appendLog('请求失败: ' + (errBody.msg || resp.status), 'err');
          setRunning('');
          return;
        }

        var reader = resp.body.getReader();
        var decoder = new TextDecoder();
        var buf = '';

        while (true) {
          var chunk = await reader.read();
          if (chunk.done) break;
          buf += decoder.decode(chunk.value, { stream: true });

          var lines = buf.split('\\n');
          buf = lines.pop() || '';
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.indexOf('data: ') !== 0) continue;
            var jsonStr = line.substring(6);
            var d;
            try { d = JSON.parse(jsonStr); } catch(_) { continue; }

            if (d.type === 'start') {
              summary.textContent = '共 ' + d.total + ' 个账号待检测';
              appendLog('开始检测 ' + d.total + ' 个账号...', 'info');
              continue;
            }
            if (d.type === 'done') {
              summary.textContent = '完成: ' + d.checked + ' 扫描, ' + d.deleted + ' 删除';
              if (isRun) appendLog('===== 完成: ' + d.checked + ' 扫描, ' + d.deleted + ' 删除 =====', 'keep');
              else appendLog('===== 完成: ' + d.checked + ' 扫描, ' + d.deleted + ' 待删除 =====', 'info');
              setRunning('');
              loadActivityStats();
              return;
            }

            var icon = d.action === 'deleted' ? '✗' : '✓';
            if (d.action === 'deleted' && isRun) icon = '✗ 已删';
            if (d.action === 'would_delete') icon = '✗';
            if (d.action === 'skipped') icon = '→';
            var cls = (d.action === 'deleted' || d.action === 'would_delete') ? 'del' : 'keep';
            if (d.action === 'skipped') cls = 'info';
            var info = '';
            if (d.followersCount != null) {
              info = String(d.followersCount).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',') + '粉 / ' +
                String(d.followingCount || 0).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',') + '关';
            }
            var tweet = d.lastTweetAt ? ' 发帖: ' + new Date(d.lastTweetAt).toLocaleString('zh-CN') : '';
            var reason = d.reason ? ' — ' + d.reason : '';
            appendLog(icon + ' @' + String(d.handle || '?').replace(/^@/, '') + ' ' + info + tweet + reason + '  [' + d.checked + '/' + d.total + ']', cls);
          }
        }
        summary.textContent = '连接已关闭';
        appendLog('连接已关闭', 'info');
      } catch(e) {
        if (e.name !== 'AbortError') {
          summary.textContent = '连接失败: ' + e.message;
          appendLog('连接失败: ' + e.message, 'err');
        }
      }
      setRunning('');
      abortCtrl = null;
    }

    function activityPreview() {
      var hours = document.getElementById('act-hours').value || 72;
      var minF = document.getElementById('act-min-followers').value || 300;
      var maxF = document.getElementById('act-max-followers').value || 20000;
      var base = document.getElementById('act-following-base').value || 50;
      var rate = document.getElementById('act-following-rate').value || 0.01;
      var limit = document.getElementById('act-limit').value || 400;
      var url = '/pool/activity-check/preview-stream?hours=' + encodeURIComponent(hours) +
        '&min_followers=' + encodeURIComponent(minF) +
        '&max_followers=' + encodeURIComponent(maxF) +
        '&following_limit_base=' + encodeURIComponent(base) +
        '&following_limit_rate=' + encodeURIComponent(rate) +
        '&limit=' + encodeURIComponent(limit);
      startStream(url, false);
    }

    function activityRun() {
      if (!confirm('确定要执行活跃检测吗？不活跃的账号将被彻底删除。\\n\\n建议先用"预览"确认结果。')) return;
      var hours = document.getElementById('act-hours').value || 72;
      var minF = document.getElementById('act-min-followers').value || 300;
      var maxF = document.getElementById('act-max-followers').value || 20000;
      var base = document.getElementById('act-following-base').value || 50;
      var rate = document.getElementById('act-following-rate').value || 0.01;
      var limit = document.getElementById('act-limit').value || 400;
      var url = '/pool/activity-check/stream?hours=' + encodeURIComponent(hours) +
        '&min_followers=' + encodeURIComponent(minF) +
        '&max_followers=' + encodeURIComponent(maxF) +
        '&following_limit_base=' + encodeURIComponent(base) +
        '&following_limit_rate=' + encodeURIComponent(rate) +
        '&limit=' + encodeURIComponent(limit);
      startStream(url, true);
    }

    // ====== Cookie 管理 ======
    async function loadCookies() {
      try {
        var r = await fetch('/pool/cookies');
        var d = await r.json();
        if (!d.ok) return;
        var list = d.cookies || [];
        document.getElementById('cookie-count').textContent = list.length + ' 个';
        var html = '';
        for (var i = 0; i < list.length; i++) {
          var c = list[i];
          var hasAuth = c.cookie && c.cookie.indexOf('auth_token=') >= 0;
          var dot = hasAuth ? '<span class="status-dot on"></span>' : '<span class="status-dot off"></span>';
          var shortCookie = (c.cookie || '').substring(0, 50) + '...';
          html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:3px 0;border-bottom:1px solid rgba(26,38,80,.3)">' +
            '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + dot + ' <b>' + (c.name || '?') + '</b> <span style="font-size:10px;color:var(--muted-dark)">' + shortCookie + '</span></span>' +
            '<span style="font-size:10px;margin:0 6px" id="cookie-status-' + (c.name || '').replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_') + '"></span>' +
            '<button data-testcookie="' + (c.name || '').replace(/"/g, '&quot;') + '" style="font-size:11px;padding:1px 6px;margin-right:4px" title="检测Cookie是否有效">检测</button>' +
            '<button data-delcookie="' + (c.name || '').replace(/"/g, '&quot;') + '" class="danger" style="font-size:11px;padding:1px 6px">X</button>' +
            '</div>';
        }
        document.getElementById('cookie-list').innerHTML = html || '<div style="color:var(--muted-dark)">暂无 Cookie</div>';
        document.getElementById('act-cookie-status').textContent = list.length > 0 ? list.length + '号池' : '未配置';
        document.getElementById('act-dot').className = list.length > 0 ? 'status-dot on' : 'status-dot off';
      } catch(e) {}
    }

    document.getElementById('cookie-list').addEventListener('click', function(e) {
      var name = e.target && e.target.dataset ? e.target.dataset.delcookie : '';
      if (name) delCookie(name);
      name = e.target && e.target.dataset ? e.target.dataset.testcookie : '';
      if (name) testCookie(name);
    });

    async function testCookie(name) {
      var cookies = [];
      try {
        var r = await fetch('/pool/cookies');
        var d = await r.json();
        if (d.ok) cookies = d.cookies || [];
      } catch(e) { return; }

      var cookie = '';
      for (var i = 0; i < cookies.length; i++) {
        if (cookies[i].name === name) { cookie = cookies[i].cookie; break; }
      }
      if (!cookie) return;

      var statusId = 'cookie-status-' + name.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_');
      var el = document.getElementById(statusId);
      if (el) el.textContent = '检测中...';

      try {
        var r = await fetch('/pool/cookies/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cookie: cookie })
        });
        var d = await r.json();
        if (el) {
          if (d.valid) {
            el.innerHTML = '<span style="color:var(--green)">✓ 有效</span>';
          } else {
            el.innerHTML = '<span style="color:var(--red)">✗ ' + (d.msg || '无效') + '</span>';
          }
        }
      } catch(e) {
        if (el) el.textContent = '异常';
      }
    }

    async function addCookieFromUI() {
      var name = document.getElementById('cookie-name').value.trim();
      var auth = document.getElementById('auth-token-input').value.trim();
      var ct0 = document.getElementById('ct0-input').value.trim();
      if (!name) return;
      if (!auth && !ct0) return;

      // 如果填了 auth_token 或 ct0，直接拼 cookie
      var cookie = '';
      if (auth && ct0) {
        cookie = 'auth_token=' + auth + '; ct0=' + ct0;
      } else if (auth) {
        cookie = 'auth_token=' + auth;
      } else {
        cookie = document.getElementById('ct0-input').value.trim();
      }

      // 也检查是否粘贴了完整 ~~~~ 包到 auth 栏
      if (auth.indexOf('~~~~') >= 0 || auth.indexOf('auth_token=') >= 0) {
        cookie = auth;
      }

      try {
        var r = await fetch('/pool/cookies', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name, cookie: cookie })
        });
        var d = await r.json();
        if (d.ok) {
          document.getElementById('cookie-name').value = '';
          document.getElementById('auth-token-input').value = '';
          document.getElementById('ct0-input').value = '';
          loadCookies();
        }
      } catch(e) {}
    }

    async function delCookie(name) {
      if (!confirm('删除 Cookie: ' + name + '?')) return;
      try {
        await fetch('/pool/cookies/' + encodeURIComponent(name), { method: 'DELETE' });
        loadCookies();
      } catch(e) {}
    }

    loadTasks().catch(function(e) { setToast(e.message); });
  </script>
</body>
</html>`;
}

module.exports = { renderDashboardPage };

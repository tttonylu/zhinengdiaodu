// =============================================================================
// X-Matrix 中控台 (V18.3.0 | 日志监控面板)
// =============================================================================
// 功能：
//   - 拦截 console.log/warn/error，捕获 Chat 和 Follow 的日志
//   - 监听 matrix-chat-log / matrix-follow-status / matrix-diagnostic 事件
//   - 实时展示：引擎状态、最近日志、错误统计
//   - 无设置面板，纯监控
// =============================================================================

(function() {
    'use strict';

    if (window.__matrix_console_injected__) return;
    window.__matrix_console_injected__ = true;

    // ==================== 常量 ====================
    var PANEL_ID = 'matrix-log-panel';
    var BTN_ID = 'matrix-log-btn';
    var MAX_LOGS = 200;
    var STATUS_KEY = 'matrix_console_status';

    // ==================== 状态 ====================
    var logs = [];
    var panelVisible = false;
    var filterMode = 'all'; // all | chat | follow | error
    var stats = {
        chat: { running: false, step: '', sent: 0, skipped: 0, errors: 0 },
        follow: { running: false, followed: 0, cooled: 0, errors: 0 },
        nurture: { running: false, likes: 0, comments: 0, reposts: 0, trends: 0, profiles: 0, dailyCap: 0 }
    };

    // ==================== 时间工具 ====================
    function bjTime(ts) {
        var d = ts ? new Date(ts) : new Date();
        return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function bjFull(ts) {
        var d = ts ? new Date(ts) : new Date();
        return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    }

    // ==================== 日志添加 ====================
    function addLog(source, level, message, data) {
        var entry = {
            ts: Date.now(),
            source: source,  // 'chat' | 'follow' | 'system'
            level: level,    // 'info' | 'warn' | 'error' | 'success'
            message: message,
            data: data || null
        };
        logs.push(entry);
        if (logs.length > MAX_LOGS) logs.shift();
        // 4.6.119 CPU 优化：面板默认隐藏，隐藏时只留内存日志，打开时 togglePanel 补渲染
        if (panelVisible) {
            renderLatestLogs();
            renderStats();
        }
        persistStatus();
    }

    // ==================== 持久化状态 ====================
    // 4.6.119 CPU 优化：stats 只是展示计数，防抖写盘（原每条日志一次同步 setItem）
    var _persistTimer = null;
    function persistStatus() {
        if (_persistTimer) return;
        _persistTimer = setTimeout(flushPersist, 3000);
    }
    function flushPersist() {
        if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
        try {
            localStorage.setItem(STATUS_KEY, JSON.stringify({
                stats: stats,
                lastUpdate: Date.now()
            }));
        } catch (_) {}
    }
    try { window.addEventListener('pagehide', flushPersist); } catch (_) {}

    function loadStatus() {
        try {
            var saved = localStorage.getItem(STATUS_KEY);
            if (saved) {
                var parsed = JSON.parse(saved);
                if (parsed.stats) {
                    stats.chat    = parsed.stats.chat    || stats.chat;
                    stats.follow  = parsed.stats.follow  || stats.follow;
                    stats.nurture = parsed.stats.nurture || stats.nurture;
                }
            }
        } catch (_) {}
    }

    // ==================== 样式注入 ====================
    function injectStyles() {
        if (document.getElementById('matrix-log-styles')) return;
        var style = document.createElement('style');
        style.id = 'matrix-log-styles';
        style.textContent = [
            '#' + BTN_ID + ' {',
            '  position:fixed; bottom:20px; left:50%; transform:translateX(-50%);',
            '  width:30px; height:30px; border-radius:50%;',
            '  background:linear-gradient(135deg,#1e293b,#334155); border:1px solid #475569;',
            '  color:#94a3b8; cursor:pointer; display:flex; align-items:center; justify-content:center;',
            '  z-index:2147483642; transition:all .2s; box-shadow:0 2px 10px rgba(0,0,0,.3);',
            '}',
            '#' + BTN_ID + ':hover { transform:translateX(-50%) scale(1.1); color:#e2e8f0; }',
            '#' + BTN_ID + '.has-error { border-color:#ef4444; color:#fca5a5; }',
            '#' + BTN_ID + ' .err-badge {',
            '  position:absolute; top:-2px; right:-2px; width:14px; height:14px;',
            '  border-radius:50%; background:#ef4444; color:#fff; font-size:9px;',
            '  display:flex; align-items:center; justify-content:center; font-weight:700;',
            '}',
            '#' + PANEL_ID + ' {',
            '  position:fixed; bottom:60px; left:50%; transform:translateX(-50%);',
            '  width:340px; max-height:38vh; background:#0f172a; border:1px solid #1e293b;',
            '  border-radius:12px; z-index:2147483642; display:flex; flex-direction:column;',
            '  box-shadow:0 8px 32px rgba(0,0,0,.5); font-family:ui-monospace,SFMono-Regular,monospace;',
            '  overflow:hidden;',
            '}',
            '#' + PANEL_ID + '.hidden { display:none; }',
            '.ml-header { padding:6px 10px; background:#1e293b; border-bottom:1px solid #334155; display:flex; align-items:center; justify-content:space-between; }',
            '.ml-header-title { color:#e2e8f0; font-size:11px; font-weight:600; }',
            '.ml-header-actions { display:flex; gap:6px; }',
            '.ml-header-btn { background:#334155; border:1px solid #475569; color:#94a3b8; padding:3px 8px; border-radius:6px; font-size:10px; cursor:pointer; }',
            '.ml-header-btn:hover { background:#475569; color:#e2e8f0; }',
            '.ml-header-btn.active { background:#1d4ed8; border-color:#3b82f6; color:#dbeafe; }',
            '.ml-stats { padding:4px 10px; background:#1e293b; border-bottom:1px solid #334155; display:flex; gap:10px; font-size:10px; }',
            '.ml-stat-group { display:flex; flex-direction:column; gap:2px; }',
            '.ml-stat-label { color:#64748b; font-size:9px; text-transform:uppercase; letter-spacing:.5px; }',
            '.ml-stat-row { display:flex; gap:8px; align-items:center; }',
            '.ml-dot { width:6px; height:6px; border-radius:50%; flex-shrink:0; }',
            '.ml-dot.green { background:#22c55e; }',
            '.ml-dot.red { background:#ef4444; }',
            '.ml-dot.gray { background:#64748b; }',
            '.ml-stat-val { color:#e2e8f0; font-size:10px; }',
            '.ml-logs { flex:1; overflow-y:auto; padding:4px 0; min-height:100px; max-height:25vh; }',
            '.ml-log-entry { padding:2px 10px; font-size:10px; line-height:1.4; display:flex; gap:6px; border-bottom:1px solid rgba(30,41,59,.5); }',
            '.ml-log-entry:hover { background:rgba(30,41,59,.3); }',
            '.ml-log-ts { color:#475569; flex-shrink:0; font-size:9px; width:54px; }',
            '.ml-log-src { flex-shrink:0; width:32px; font-size:9px; font-weight:600; text-transform:uppercase; }',
            '.ml-log-src.chat { color:#3b82f6; }',
            '.ml-log-src.follow { color:#a78bfa; }',
            '.ml-log-src.nurture { color:#22c55e; }',
            '.ml-log-src.system { color:#64748b; }',
            '.ml-log-lvl { flex-shrink:0; width:8px; }',
            '.ml-log-lvl.info { background:#3b82f6; }',
            '.ml-log-lvl.warn { background:#f59e0b; }',
            '.ml-log-lvl.error { background:#ef4444; }',
            '.ml-log-lvl.success { background:#22c55e; }',
            '.ml-log-msg { color:#cbd5e1; word-break:break-all; flex:1; }',
            '.ml-log-entry.error .ml-log-msg { color:#fca5a5; }',
            '.ml-log-entry.warn .ml-log-msg { color:#fcd34d; }',
            '.ml-log-entry.success .ml-log-msg { color:#86efac; }',
            '.ml-empty { text-align:center; color:#475569; padding:40px 0; font-size:12px; }',
            '.ml-toast {',
            '  position:fixed; top:20px; right:20px; padding:10px 16px; border-radius:8px;',
            '  font-size:12px; z-index:2147483643; transition:all .3s; opacity:0; transform:translateY(-10px);',
            '  box-shadow:0 4px 12px rgba(0,0,0,.3);',
            '}',
            '.ml-toast.visible { opacity:1; transform:translateY(0); }',
            '.ml-toast.info { background:#1e3a5f; color:#93c5fd; border:1px solid #2563eb; }',
            '.ml-toast.error { background:#3b1111; color:#fca5a5; border:1px solid #ef4444; }',
            '.ml-toast.success { background:#052e16; color:#86efac; border:1px solid #22c55e; }'
        ].join('\n');
        document.head.appendChild(style);
    }

    // ==================== 创建按钮 ====================
    function createButton() {
        if (document.getElementById(BTN_ID)) return;
        if (!document.body) return;
        var btn = document.createElement('button');
        btn.id = BTN_ID;
        btn.title = 'X-Matrix 日志监控 (V18)';
        btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" width="20" height="20"><rect x="2" y="3" width="20" height="18" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M7 8h10M7 12h6M7 16h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            togglePanel();
        });
        document.body.appendChild(btn);
    }

    // ==================== 创建面板 ====================
    function createPanel() {
        if (document.getElementById(PANEL_ID)) return;
        var panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.className = 'hidden';
        panel.innerHTML = [
            '<div class="ml-header">',
            '  <span class="ml-header-title">🔍 X-Matrix Monitor V18.3.0</span>',
            '  <div class="ml-header-actions">',
            '    <button class="ml-header-btn active" data-filter="all">ALL</button>',
            '    <button class="ml-header-btn" data-filter="chat">CHAT</button>',
            '    <button class="ml-header-btn" data-filter="follow">FOLW</button>',
            '    <button class="ml-header-btn" data-filter="nurture">NURT</button>',
            '    <button class="ml-header-btn" data-filter="error">ERR</button>',
            '    <button class="ml-header-btn" data-action="clear">CLR</button>',
            '  </div>',
            '</div>',
            '<div class="ml-stats">',
            '  <div class="ml-stat-group">',
            '    <span class="ml-stat-label">Nurture Engine</span>',
            '    <div class="ml-stat-row"><span class="ml-dot gray" id="ml-nurture-dot"></span><span class="ml-stat-val" id="ml-nurture-status">idle</span></div>',
            '    <div class="ml-stat-row"><span class="ml-stat-val" id="ml-nurture-detail">赞:0 评:0 转:0</span></div>',
            '  </div>',
            '  <div class="ml-stat-group">',
            '    <span class="ml-stat-label">Chat Engine</span>',
            '    <div class="ml-stat-row"><span class="ml-dot gray" id="ml-chat-dot"></span><span class="ml-stat-val" id="ml-chat-status">idle</span></div>',
            '    <div class="ml-stat-row"><span class="ml-stat-val" id="ml-chat-detail">sent:0 skip:0 err:0</span></div>',
            '  </div>',
            '  <div class="ml-stat-group">',
            '    <span class="ml-stat-label">Follow Engine</span>',
            '    <div class="ml-stat-row"><span class="ml-dot gray" id="ml-follow-dot"></span><span class="ml-stat-val" id="ml-follow-status">idle</span></div>',
            '    <div class="ml-stat-row"><span class="ml-stat-val" id="ml-follow-detail">follow:0 cool:0 err:0</span></div>',
            '  </div>',
            '</div>',
            '<div class="ml-logs" id="ml-logs-container"><div class="ml-empty">等待日志...</div></div>'
        ].join('\n');
        panel.addEventListener('click', function(e) { e.stopPropagation(); });
        document.body.appendChild(panel);

        // filter buttons
        panel.querySelectorAll('[data-filter]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                filterMode = btn.getAttribute('data-filter');
                panel.querySelectorAll('[data-filter]').forEach(function(b) { b.classList.remove('active'); });
                btn.classList.add('active');
                renderLatestLogs();
            });
        });
        // clear button
        var clearBtn = panel.querySelector('[data-action="clear"]');
        if (clearBtn) {
            clearBtn.addEventListener('click', function() {
                logs = [];
                renderLatestLogs();
            });
        }
    }

    // ==================== 面板切换 ====================
    function togglePanel() {
        var panel = document.getElementById(PANEL_ID);
        var btn = document.getElementById(BTN_ID);
        if (!panel) return;
        panelVisible = !panelVisible;
        if (panelVisible) {
            panel.classList.remove('hidden');
            if (btn) btn.style.color = '#3b82f6';
            renderLatestLogs();
            renderStats();
        } else {
            panel.classList.add('hidden');
            if (btn) btn.style.color = '';
        }
    }

    // ==================== 渲染日志 ====================
    function renderLatestLogs() {
        var container = document.getElementById('ml-logs-container');
        if (!container) return;
        var filtered = logs;
        if (filterMode === 'chat') filtered = logs.filter(function(l) { return l.source === 'chat'; });
        else if (filterMode === 'follow') filtered = logs.filter(function(l) { return l.source === 'follow'; });
        else if (filterMode === 'nurture') filtered = logs.filter(function(l) { return l.source === 'nurture'; });
        else if (filterMode === 'error') filtered = logs.filter(function(l) { return l.level === 'error'; });

        if (filtered.length === 0) {
            container.innerHTML = '<div class="ml-empty">无日志记录</div>';
            return;
        }
        var html = '';
        var show = filtered.slice(-80);
        for (var i = 0; i < show.length; i++) {
            var l = show[i];
            html += '<div class="ml-log-entry ' + l.level + '">' +
                '<span class="ml-log-ts">' + bjTime(l.ts) + '</span>' +
                '<span class="ml-log-src ' + l.source + '">' + l.source + '</span>' +
                '<span class="ml-log-lvl ' + l.level + '"></span>' +
                '<span class="ml-log-msg">' + escapeHtml(l.message) + '</span>' +
                '</div>';
        }
        container.innerHTML = html;
        container.scrollTop = container.scrollHeight;
    }

    function escapeHtml(s) {
        if (!s) return '';
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    // ==================== 渲染状态 ====================
    function renderStats() {
        setVal('ml-nurture-status', stats.nurture.running ? 'running' : 'idle');
        setDot('ml-nurture-dot', stats.nurture.running ? 'green' : 'gray');
        setVal('ml-nurture-detail', '赞:' + stats.nurture.likes + ' 评:' + stats.nurture.comments + ' 转:' + stats.nurture.reposts + ' 趋:' + stats.nurture.trends + ' 主:' + stats.nurture.profiles);
        setVal('ml-chat-status', stats.chat.running ? (stats.chat.step || 'running') : 'idle');
        setDot('ml-chat-dot', stats.chat.running ? 'green' : 'gray');
        setVal('ml-chat-detail', 'sent:' + stats.chat.sent + ' skip:' + stats.chat.skipped + ' err:' + stats.chat.errors);
        setVal('ml-follow-status', stats.follow.running ? 'running' : 'idle');
        setDot('ml-follow-dot', stats.follow.running ? 'green' : 'gray');
        setVal('ml-follow-detail', 'follow:' + stats.follow.followed + ' cool:' + stats.follow.cooled + ' err:' + stats.follow.errors);

        // error badge on button
        var btn = document.getElementById(BTN_ID);
        if (btn) {
            var totalErrors = stats.chat.errors + stats.follow.errors;
            var badge = btn.querySelector('.err-badge');
            if (totalErrors > 0) {
                btn.classList.add('has-error');
                if (!badge) {
                    badge = document.createElement('span');
                    badge.className = 'err-badge';
                    btn.appendChild(badge);
                }
                badge.textContent = totalErrors > 9 ? '9+' : totalErrors;
            } else {
                btn.classList.remove('has-error');
                if (badge) badge.remove();
            }
        }
    }

    function setVal(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }
    function setDot(id, cls) {
        var el = document.getElementById(id);
        if (!el) return;
        el.className = 'ml-dot ' + cls;
    }

    // ==================== 事件监听：Chat ====================
    document.addEventListener('matrix-chat-log', function(e) {
        var d = e.detail || {};
        var type = d.type || '';
        var data = d.data || {};

        switch (type) {
            case 'started':
                stats.chat.running = true;
                stats.chat.step = 'SCAN_FOLLOWERS';
                addLog('chat', 'success', '引擎启动: ' + (data.reason || ''));
                break;
            case 'stopped':
                stats.chat.running = false;
                stats.chat.step = '';
                addLog('chat', 'info', '引擎停止: ' + (data.reason || ''));
                break;
            case 'state_change':
                stats.chat.step = data.step || '';
                addLog('chat', 'info', '状态 → ' + data.step);
                break;
            case 'state_timeout':
                stats.chat.errors++;
                addLog('chat', 'error', '状态超时: ' + data.step);
                break;
            case 'fuse':
                stats.chat.errors++;
                addLog('chat', 'error', '熔断触发: ' + data.type);
                break;
            case 'scan_complete':
                addLog('chat', 'info', '粉丝扫描完成, ' + (data.count || 0) + ' 个目标');
                break;
            case 'dm_sent':
                stats.chat.sent++;
                addLog('chat', 'success', '消息已发送 → @' + data.target + ': ' + (data.text || ''));
                break;
            case 'dm_skip':
                stats.chat.skipped++;
                addLog('chat', 'info', '跳过 @' + data.target + ': ' + (data.reason || ''));
                break;
            case 'dm_error':
                stats.chat.errors++;
                addLog('chat', 'error', 'DM错误 @' + data.target + ': ' + (data.error || ''));
                break;
            case 'dm_no_text':
                addLog('chat', 'warn', '无话术 @' + data.target);
                break;
            case 'dm_no_decision':
                addLog('chat', 'warn', '后端无决策 @' + data.target);
                break;
            case 'debug':
                addLog('chat', 'info', data.message || data.step || 'debug');
                break;
            default:
                addLog('chat', 'info', type + (data.target ? ' @' + data.target : ''));
        }
        renderStats();
        persistStatus();
    });

    // ==================== 事件监听：Nurture ====================
    document.addEventListener('matrix-nurture-log', function(e) {
        var d = e.detail || {};
        var running = d.running;
        var st = d.stats || {};

        stats.nurture.running = !!running;
        if (st.daily && st.daily.used) {
            stats.nurture.likes    = st.daily.used.likes    || 0;
            stats.nurture.comments = st.daily.used.comments || 0;
            stats.nurture.reposts  = st.daily.used.reposts  || 0;
            stats.nurture.trends   = st.daily.used.trends   || 0;
            stats.nurture.profiles = st.daily.used.profiles || 0;
        }
        if (st.daily && st.daily.budget) {
            stats.nurture.dailyCap = st.daily.budget.likes || 0;
        }
        var msg = running ? ('赞' + stats.nurture.likes + ' 评' + stats.nurture.comments + ' 转' + stats.nurture.reposts) : 'idle';
        addLog('nurture', running ? 'info' : 'info', msg);
        renderStats();
        persistStatus();
    });

    // ==================== 事件监听：Follow ====================
    document.addEventListener('matrix-follow-status', function(e) {
        var data = e.detail || {};
        if (data.running !== undefined) stats.follow.running = data.running;
        if (data.count !== undefined) stats.follow.followed = data.count;
        var msg = data.running ? '运行中 (已关注:' + (data.count || 0) + ')' : (data.paused ? '冷却中' : 'idle');
        addLog('follow', data.running ? 'success' : 'info', msg);
        renderStats();
        persistStatus();
    });

    document.addEventListener('matrix-diagnostic', function(e) {
        var data = e.detail || {};
        var text = data.text || '';
        var level = 'info';
        if (text.indexOf('⚠') >= 0 || text.indexOf('warn') >= 0) level = 'warn';
        else if (text.indexOf('✅') >= 0) level = 'success';
        addLog('follow', level, text);
    });

    // ==================== Console 拦截 ====================
    var _origLog = console.log;
    var _origWarn = console.warn;
    var _origError = console.error;

    function interceptConsole(method, level) {
        var orig = method;
        return function() {
            try {
                orig.apply(console, arguments);
            } catch (_) {}
            try {
                var first = arguments[0];
                // 4.6.119 CPU 优化：快路径——非字符串/非 '[' 开头的日志不可能命中前缀，
                // 直接返回，避免对每条不相关日志做 Array.slice/map/JSON.stringify/join
                if (typeof first !== 'string' || first.charAt(0) !== '[') return;

                var isChatTag = first.indexOf('[Matrix-Chat]') === 0 ||
                    first.indexOf('[私信]') === 0 || first.indexOf('[战报]') === 0 ||
                    first.indexOf('[话术]') === 0 || first.indexOf('[推广链接]') === 0 ||
                    first.indexOf('[年龄识别]') === 0 ||
                    first.indexOf('[诊断]') === 0 || first.indexOf('[赶工]') === 0;
                var isFollowTag = first.indexOf('[Follow]') === 0;
                var isNurtureTag = first.indexOf('[养号]') === 0 || first.indexOf('[Nurture]') === 0;
                if (!isChatTag && !isFollowTag && !isNurtureTag) return;

                var args = Array.prototype.slice.call(arguments);
                var msg = args.slice(1).map(function(a) {
                    return typeof a === 'object' ? JSON.stringify(a) : String(a);
                }).join(' ');

                if (first.indexOf('[Matrix-Chat]') === 0) {
                    addLog('chat', level, msg || first.replace('[Matrix-Chat]', '').trim());
                } else if (isChatTag) {
                    addLog('chat', level, first + (msg ? ' ' + msg : ''));
                } else if (isFollowTag) {
                    addLog('follow', level, msg || first.replace('[Follow]', '').trim());
                } else {
                    addLog('nurture', level, msg || first.replace('[养号]', '').replace('[Nurture]', '').trim());
                }
            } catch (_) {}
        };
    }

    console.log = interceptConsole(_origLog, 'info');
    console.warn = interceptConsole(_origWarn, 'warn');
    console.error = interceptConsole(_origError, 'error');

    // ==================== 全局点击关闭 ====================
    document.addEventListener('click', function() {
        if (panelVisible) {
            var panel = document.getElementById(PANEL_ID);
            if (panel) panel.classList.add('hidden');
            panelVisible = false;
            var btn = document.getElementById(BTN_ID);
            if (btn) btn.style.color = '';
        }
    });
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && panelVisible) {
            var panel = document.getElementById(PANEL_ID);
            if (panel) panel.classList.add('hidden');
            panelVisible = false;
        }
    });

    // ==================== 初始化 ====================
    function init() {
        if (!document.body) {
            requestAnimationFrame(init);
            return;
        }
        injectStyles();
        // v3：中间悬浮球停用，改由 #sg-panel「打开日志」调用 __matrix_console__.show
        // createButton();
        createPanel();
        loadStatus();
        renderStats();
        addLog('system', 'info', '日志监控已启动 (V18.3.0) ' + bjFull());
    }

    init();

    window.__matrix_console__ = {
        show: function() {
            if (!document.getElementById(PANEL_ID)) createPanel();
            if (!panelVisible) togglePanel();
        },
        hide: function() { if (panelVisible) togglePanel(); },
        getLogs: function() { return logs.slice(); },
        getStats: function() { return JSON.parse(JSON.stringify(stats)); },
        clearErrors: function() { stats.chat.errors = 0; stats.follow.errors = 0; renderStats(); persistStatus(); }
    };

})();
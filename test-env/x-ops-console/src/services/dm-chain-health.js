/**
 * 私信全链路健康汇总（只读）。
 *
 * 目标：运营不读代码也能回答三件事——
 *   1. 这一小时到底有没有扫、有没有开、有没有发；
 *   2. 没回复是“对方没回”，还是“系统没读到/没打开”；
 *   3. 每个问题发生在谁身上、什么时候、证据是什么。
 *
 * 所有结论都从 log_events + dm_roster_items 推导，不新增插件上报依赖。
 */

const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 };

function shTime(ms) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  });
  const map = {};
  for (const p of fmt.formatToParts(new Date(ms))) map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
}

function parseMeta(row) {
  if (row && row.meta && typeof row.meta === 'object') return row.meta;
  try { return JSON.parse((row && row.meta_json) || '{}') || {}; } catch (e) { return {}; }
}

function pushSample(list, item, max) {
  if (!item) return;
  if (list.length >= (max || 6)) return;
  list.push(item);
}

/**
 * @param {object} input
 * @param {Array} input.events  最近窗口内的日志（已按时间倒序）
 * @param {Array} input.roster  dm_roster_items
 * @param {object} input.account 运行账号（可为空）
 * @param {string} input.build  当前插件 build
 * @param {number} input.now
 */
function buildIssues(input) {
  const events = Array.isArray(input.events) ? input.events : [];
  const roster = Array.isArray(input.roster) ? input.roster : [];
  const account = input.account || null;
  const build = String(input.build || '');
  const now = Number(input.now) || Date.now();
  const issues = [];

  function bucket(code, severity, stage, titleZh, reasonZh, fixZh) {
    return {
      code, severity, stage, title_zh: titleZh, reason_zh: reasonZh, fix_zh: fixZh,
      count: 0, first_seen: '', last_seen: '', handles: [], evidence: [],
    };
  }
  function add(b, row, ev) {
    b.count += 1;
    const at = (row && (row.created_at || '')) || '';
    if (at && (!b.first_seen || at < b.first_seen)) b.first_seen = at;
    if (at && (!b.last_seen || at > b.last_seen)) b.last_seen = at;
    const h = (row && row.account_handle) || '';
    if (ev && ev.handle && b.handles.indexOf(ev.handle) < 0 && b.handles.length < 12) b.handles.push(ev.handle);
    else if (h && b.handles.indexOf(h) < 0 && b.handles.length < 12) b.handles.push(h);
    if (ev) pushSample(b.evidence, ev, 6);
  }
  function finish(b) {
    if (b.count > 0) issues.push(b);
  }

  const pulse = events.filter((e) => e.event_id === 'chat.inbox_pulse');
  const tick = events.filter((e) => e.event_id === 'chat.inbox_tick');
  const hidden = pulse.filter((e) => {
    const m = parseMeta(e);
    return m.hidden === true || m.reason === 'page_hidden_deferred'
      || m.reason === 'deferred_not_visible';
  });

  // 1) 后台标签页挡住整条守箱
  if (hidden.length >= 2) {
    // 插件侧把“后台标签”当环境状态：默认 warn，连续 90 拍才升 error。
    // OPS 旧实现只要出现 2 次就标 error，导致正常最小化也被当成插件故障。
    const hiddenEscalated = hidden.some((e) => {
      const m = parseMeta(e);
      return e.severity === 'error' || Number(m.hidden_streak || 0) >= 90;
    });
    const b = bucket(
      'page_hidden_stuck', hiddenEscalated ? 'error' : 'warn', 'watch',
      '浏览器标签页在后台，守箱没有真正读取会话',
      '脉冲被 page_hidden / deferred_not_visible 挡住，没打开会话也就没有回复结论；这不是对方没回。',
      '测试时保持 X 标签页在前台；矩阵运行请用 --disable-backgrounding-occluded-windows --disable-renderer-backgrounding 启动 Chrome。'
    );
    hidden.slice(0, 12).forEach((e) => {
      const m = parseMeta(e);
      add(b, e, {
        at: e.created_at,
        handle: m.target || '',
        peer_id: m.peer_id || '',
        reason: m.reason || '',
        tab_active: m.tab_active,
        window_state: m.window_state || '',
        hidden_streak: m.hidden_streak || 0,
      });
    });
    finish(b);
  }

  // 2) 整页跳转配额/冷却导致打不开会话
  const navBlocked = pulse.filter((e) => {
    const m = parseMeta(e);
    return m.reason === 'nav_suppressed' || m.reason === 'nav_budget_wait';
  });
  if (navBlocked.length) {
    const b = bucket(
      'conversation_nav_blocked', 'error', 'watch',
      '会话打不开：整页跳转被冷却/配额拦住',
      '目标已经选中，但点击没有进入会话，地址直达又被预算拦下；台账不会推进，也不代表对方没回。',
      '4.9.31 起预算按会话隔离，并改为换下一个目标；若仍出现，检查是否同一会话反复点不开。'
    );
    navBlocked.slice(0, 12).forEach((e) => {
      const m = parseMeta(e);
      add(b, e, {
        at: e.created_at,
        handle: m.target || '',
        peer_id: m.peer_id || '',
        nav_guard_reason: m.nav_guard_reason || '',
        opened_url: m.opened_url || '',
      });
    });
    finish(b);
  }

  // 3) 会话正文读不出来
  const readFailed = events.filter((e) => {
    const m = parseMeta(e);
    return (e.event_id === 'chat.inbox_tick' && m.reply_verdict === 'reply_read_failed')
      || (e.event_id === 'chat.inbox_pulse' && m.reply_verdict === 'reply_read_failed');
  });
  if (readFailed.length) {
    const b = bucket(
      'reply_read_failed', 'error', 'watch',
      '打开了会话但正文没读出来',
      'DOM 里没有可读气泡（0 条文章/0 条文本）。系统禁止发送，也不会把这次当成“对方没回”。',
      '检查是否后台标签页/白屏；同一会话连续 2 次会冷却 10 分钟，列表预览变化会立即重试。'
    );
    readFailed.slice(0, 12).forEach((e) => {
      const m = parseMeta(e);
      add(b, e, {
        at: e.created_at,
        handle: m.target || '',
        peer_id: m.peer_id || '',
        dom_leaves: m.dom_leaves || 0,
        dom_articles: m.dom_articles || 0,
        open_mode: m.open_mode || '',
      });
    });
    finish(b);
  }

  // 4) 身份没证明
  const identity = tick.filter((e) => {
    const m = parseMeta(e);
    return m.identity_ok === false || m.reply_verdict === 'identity_unproven';
  });
  if (identity.length) {
    const b = bucket(
      'identity_unproven', 'warn', 'watch',
      '会话对象身份没证明，禁止发送',
      '会话头/地址对不上台账。为防止发错人，本次不写回复台账、不发送。',
      '检查台账 peerId 是否缺失；连续 3 次会升级为错误并冷却。'
    );
    identity.slice(0, 12).forEach((e) => {
      const m = parseMeta(e);
      add(b, e, {
        at: e.created_at,
        handle: m.target || '',
        peer_id: m.peer_id || '',
        identity_reason: m.identity_reason || '',
        identity_pending_count: m.identity_pending_count || 0,
      });
    });
    finish(b);
  }

  // 5) 发送失败
  // 对方关闭收件箱是平台侧终态：能读历史但不能发，台账会等预览变化或 6 小时后复查。
  // 它不是“插件发送失败”，不能混进 dm_send_failed 的红色故障。
  const SEND_TERMINAL_ERRORS = new Set([
    'peer_inbox_closed',
    'inbox_closed',
    'target_inbox_closed'
  ]);
  const sendClosed = tick.filter((e) => {
    const m = parseMeta(e);
    return m.action === 'send' && m.sent === false
      && SEND_TERMINAL_ERRORS.has(String(m.send_error || ''));
  });
  if (sendClosed.length) {
    const b = bucket(
      'dm_peer_inbox_closed', 'info', 'send',
      '对方关闭了收件箱，本次不发送（正常终态）',
      '会话可以读，但 X 不允许发送私信；这不是插件点击/确认失败。',
      '无需修复。台账会在列表预览变化或 6 小时后复查，对方重新开放即可恢复。'
    );
    sendClosed.slice(0, 12).forEach((e) => {
      const m = parseMeta(e);
      add(b, e, {
        at: e.created_at,
        handle: m.target || '',
        peer_id: m.peer_id || '',
        route: m.route || '',
        send_error: m.send_error || '',
      });
    });
    finish(b);
  }
  const sendFail = tick.filter((e) => {
    const m = parseMeta(e);
    return m.action === 'send' && m.sent === false && m.send_error
      && !SEND_TERMINAL_ERRORS.has(String(m.send_error || ''));
  });
  if (sendFail.length) {
    const b = bucket(
      'dm_send_failed', 'error', 'send',
      '判定要发，但发送没有确认成功',
      '已进入发送分支，输入框/气泡确认失败。待办会保留并优先续跑，不会静默丢单。',
      '看 send_error：no_composer / confirm_not_in_dom / send_confirm_timeout 对应不同修复项。'
    );
    sendFail.slice(0, 12).forEach((e) => {
      const m = parseMeta(e);
      add(b, e, {
        at: e.created_at,
        handle: m.target || '',
        peer_id: m.peer_id || '',
        route: m.route || '',
        send_error: m.send_error || '',
      });
    });
    finish(b);
  }

  // 6a) 关注页真的走错账号（旧实现把“列表加载中”也报成这个，已拆开）
  const followMismatch = events.filter((e) => e.event_id === 'follow.page_handle_mismatch');
  if (followMismatch.length) {
    const b = bucket(
      'follow_page_handle_mismatch', 'error', 'follow',
      '关注页打开成了别的账号',
      '步骤要求扫指定博主的粉丝页，实际页面类型/handle 与预期不一致。',
      '检查 follow 引擎的页面路由与多窗口 handle 绑定。'
    );
    followMismatch.slice(0, 12).forEach((e) => {
      const m = parseMeta(e);
      add(b, e, {
        at: e.created_at,
        expected: m.expected || '',
        actual: m.actual || '',
        step: m.step || '',
        page: m.page || m.url || '',
        cells: m.cells != null ? m.cells : 0
      });
    });
    finish(b);
  }

  // 6b) 粉丝列表一直渲染不出 UserCell（真正的“扫描为 0”）
  const followLoading = events.filter((e) => {
    if (e.event_id !== 'follow.followers_loading_wait') return false;
    const m = parseMeta(e);
    return Number(m.mismatch_count || 0) >= 8 && Number(m.cells || 0) === 0;
  });
  if (followLoading.length) {
    const b = bucket(
      'follow_followers_loading_stuck', 'error', 'follow',
      '粉丝列表超过 16 秒仍是 0 行',
      '页面在指定博主的 /followers 上，但 UserCell 一直没渲染出来；这不是账号走错页，也不是“没有新粉”。',
      '检查页面是否被限流/需要验证、博主是否隐藏粉丝；4.9.32 起会单独上报 loading 而不是误报 handle 不匹配。'
    );
    followLoading.slice(0, 12).forEach((e) => {
      const m = parseMeta(e);
      add(b, e, {
        at: e.created_at,
        creator: m.creator || '',
        expected: m.expected || '',
        actual: m.actual || '',
        page: m.page || '',
        busy: m.busy || 0,
        waited: m.mismatch_count || 0
      });
    });
    finish(b);
  }

  // 6c) 博主粉丝列表确实为空（0 Followers）
  const followEmpty = events.filter((e) => e.event_id === 'follow.followers_empty');
  if (followEmpty.length) {
    const b = bucket(
      'follow_followers_empty', 'warn', 'follow',
      '目标博主的粉丝列表是空的',
      '页面明确显示 0 Followers / 没有关注者，扫描不到任何新粉是预期结果。',
      '这不是故障；引擎应跳过该博主并换下一个，不要反复重试。'
    );
    followEmpty.slice(0, 12).forEach((e) => {
      const m = parseMeta(e);
      add(b, e, { at: e.created_at, creator: m.creator || '', page: m.page || '', cells: m.cells || 0 });
    });
    finish(b);
  }

  // 7) 主线程卡顿
  const pressure = events.filter((e) => {
    if (e.event_id !== 'system.pressure') return false;
    const m = parseMeta(e);
    return Number(m.lag_ms || m.lag || 0) >= 5000;
  });
  if (pressure.length >= 3) {
    const b = bucket(
      'event_loop_lag', 'warn', 'system',
      '浏览器主线程持续卡顿',
      '事件循环延迟 ≥5 秒，会拖慢扫描、点击与发送确认，表现为“脉冲在跑但很久没动作”。',
      '检查深度扫描、日志上报频率与同时开启的窗口数；矩阵化前必须先压到 1 秒以内。'
    );
    pressure.slice(0, 12).forEach((e) => {
      const m = parseMeta(e);
      add(b, e, { at: e.created_at, lag_ms: m.lag_ms || m.lag || 0, level: m.level || '' });
    });
    finish(b);
  }

  // 7b) 白屏自愈循环：页面被判白屏 → 刷新 → 还是白屏
  const whiteScreen = events.filter((e) => {
    if (e.event_id !== 'system.logger_warn') return false;
    const m = parseMeta(e);
    return /白屏|white_screen|blank/i.test(String(m.msg || m.message || ''));
  });
  if (whiteScreen.length >= 3) {
    const b = bucket(
      'white_screen_loop', 'error', 'system',
      '页面反复被判白屏并触发刷新',
      '自愈请求连续出现，说明“健康判定”本身可能误判（例如新版会话栏选择器没被识别），刷新只会打断扫描。',
      '4.9.32 已把新版 dm-conversation-option 行纳入健康判定；若仍出现，抓 system.logger_warn 的 unhealthyFor。'
    );
    whiteScreen.slice(0, 12).forEach((e) => {
      const m = parseMeta(e);
      add(b, e, { at: e.created_at, msg: String(m.msg || '').slice(0, 120), mod: m.mod || '' });
    });
    finish(b);
  }

  // 7c) 守箱心跳还在，但脉冲长时间没跑
  const loops = events.filter((e) => e.event_id === 'chat.inbox_loop');
  const lastLoop = loops[0];
  if (lastLoop) {
    const m = parseMeta(lastLoop);
    const lastPulse = Number(m.last_pulse_at) || 0;
    const paused = String(m.paused_reason || '');
    if (m.running === true && !paused && lastPulse && (now - lastPulse) > 5 * 60 * 1000) {
      const b = bucket(
        'inbox_pulse_stale', 'error', 'watch',
        '守箱引擎在，但脉冲已经超过 5 分钟没跑',
        '心跳 running=true、没有 paused_reason，但 last_pulse_at 很旧；表现为“插件开着却什么都不做”。',
        '检查是否有 tick 卡死、页面在后台、或脉冲定时器被页面刷新清掉；必要时点一次“私信测试”重建循环。'
      );
      add(b, lastLoop, {
        at: lastLoop.created_at,
        last_pulse_at: lastPulse,
        age_sec: Math.round((now - lastPulse) / 1000),
        hidden: m.hidden,
        path: m.path || '',
        build: m.build || ''
      });
      finish(b);
    }
    if (paused === 'outside_chat_hours') {
      const b = bucket(
        'chat_paused_outside_hours', 'info', 'watch',
        '当前处于私信时段外，守箱按规则暂停',
        '夜间不做任何私信：不扫列表、不打开会话、不发广告/催加；关注、养号、手动转帖不受影响。',
        '这是业务规则，不是 bug。测试副本按账号私信窗运行（默认交友 09:00–18:00，兼职池 10:00–19:00），不提供 24 小时私信测试；夜间只跑关注、养号和手动转帖。'
      );
      add(b, lastLoop, {
        at: lastLoop.created_at,
        test_24h: m.test_24h,
        build: m.build || '',
        path: m.path || ''
      });
      finish(b);
    }
  }

  // 8) 关注日计数跨日没有归零
  if (account && account.followed_today_date) {
    const today = shTime(now).slice(0, 10);
    if (String(account.followed_today_date) !== today && Number(account.followed_today || 0) > 0) {
      const b = bucket(
        'follow_daily_not_rolled', 'warn', 'follow',
        '关注日计数没有按上海日期归零',
        `账号显示今天已关注 ${account.followed_today}，但计数日期还是 ${account.followed_today_date}。`,
        '检查插件 matrix_stats 的上海日比较；不修会让第二天一开跑就提前触顶。'
      );
      add(b, { created_at: shTime(now), account_handle: account.x_handle || '' }, {
        at: shTime(now),
        followed_today: account.followed_today,
        followed_today_date: account.followed_today_date,
        today,
      });
      finish(b);
    }
  }

  // 9) 扩展版本落后
  const versions = new Set(events.map((e) => String(parseMeta(e).build || '')).filter(Boolean));
  if (build && versions.size && !versions.has(build)) {
    const b = bucket(
      'extension_outdated', 'warn', 'system',
      '浏览器里跑的不是当前代码版本',
      `当前代码 ${build}，最近日志里的 build 是 ${Array.from(versions).join('/')}。`,
      '在 chrome://extensions 点“重新加载”，否则磁盘上的修复不会生效。'
    );
    const last = events[0];
    add(b, last, { at: last && last.created_at, running_build: Array.from(versions).join('/'), expected_build: build });
    finish(b);
  }

  // 10) 台账积压：有破冰但长时间没有下一步
  const stuckAd = roster.filter((r) => {
    if (Number(r.round) !== 1 || String(r.queue_status) !== 'pending') return false;
    const at = Date.parse(String(r.updated_at || '').replace(/\//g, '-').replace(' ', 'T') + '+08:00');
    return Number.isFinite(at) && (now - at) > 3 * 3600 * 1000;
  });
  if (stuckAd.length >= 3) {
    const b = bucket(
      'roster_ad_overdue', 'warn', 'ledger',
      '已破冰会话超过 3 小时没有进入广告',
      '台账 round=1 且 pending，说明破冰成功但守箱没有轮到它。',
      '看 chat.inbox_pulse 的 scan_drop：常见是 closed/cooldown/own_last_replied 把目标挡掉。'
    );
    stuckAd.slice(0, 12).forEach((r) => {
      add(b, { created_at: r.updated_at, account_handle: '' }, {
        at: r.updated_at, handle: r.handle, round: r.round, queue_reason: r.queue_reason || '',
      });
    });
    finish(b);
  }

  issues.sort((a, b) => (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || (b.count - a.count));
  const totals = { error: 0, warn: 0, info: 0 };
  issues.forEach((i) => { totals[i.severity] = (totals[i.severity] || 0) + 1; });
  return { issues, totals, builds: Array.from(versions) };
}

/**
 * 链路漏斗：从“扫到未读”到“最终收口”每层数量 + 丢在哪。
 */
function buildPipeline({ events, roster, hours }) {
  const list = Array.isArray(events) ? events : [];
  const ticks = list.filter((e) => e.event_id === 'chat.inbox_tick');
  const pulses = list.filter((e) => e.event_id === 'chat.inbox_pulse');
  const counts = { reply_detected: 0, no_new_reply: 0, reply_read_failed: 0, identity_unproven: 0, non_text_inbound: 0 };
  const gates = {};
  const routes = { ad: 0, kick: 0, reject: 0, ice: 0 };
  let sent = 0;
  let skipped = 0;
  let opened = 0;
  for (const e of ticks) {
    const m = parseMeta(e);
    const v = String(m.reply_verdict || '');
    if (counts[v] != null) counts[v] += 1;
    if (m.send_gate) gates[m.send_gate] = (gates[m.send_gate] || 0) + 1;
    if (m.sent) {
      sent += 1;
      if (routes[m.route] != null) routes[m.route] += 1;
    }
    if (m.action === 'skip' || m.action === 'wait') skipped += 1;
    if (m.open_mode && m.open_mode !== 'none') opened += 1;
  }
  let scanRows = 0;
  let candidates = 0;
  let hiddenPulses = 0;
  for (const e of pulses) {
    const m = parseMeta(e);
    if (m.scan) {
      scanRows += Number(m.scan.rows || 0);
      candidates += Number(m.scan.candidates || 0);
    }
    if (m.hidden || m.reason === 'page_hidden_deferred') hiddenPulses += 1;
  }
  const rosterCounts = {
    total: roster.length,
    ice_pending: roster.filter((r) => Number(r.round) === 0).length,
    ad_pending: roster.filter((r) => Number(r.round) === 1 && String(r.queue_status) === 'pending').length,
    closed: roster.filter((r) => Number(r.round) >= 3).length,
  };
  return {
    hours,
    pulses: pulses.length,
    ticks: ticks.length,
    opened,
    sent,
    skipped,
    hidden_pulses: hiddenPulses,
    scan_rows: scanRows,
    candidates,
    reply: counts,
    send_gate: Object.keys(gates).sort((a, b) => gates[b] - gates[a]).map((k) => ({ gate: k, count: gates[k] })),
    routes,
    roster: rosterCounts,
  };
}

module.exports = { buildIssues, buildPipeline, shTime };

// =============================================================================
// 诊断冻结 + 阶段动作契约（SgDiagContract）
// 违规/超时 → 上报 → 冻结（拒 coStart）；白名单小修可 auto_repaired
// =============================================================================
(function () {
  'use strict';

  var FREEZE_KEY = 'sg_diag_freeze';
  var LAST_ACTION_KEY = 'sg_diag_last_action';

  /**
   * 契约表：actions 支持精确名或前缀（以 * 结尾，如 step_*）
   * timeoutMs=0 表示该阶段不因超时冻结
   */
  var CONTRACTS = {
    chat_inbox: {
      idle: { actions: ['lease_start', 'force_pulse', 'phase_idle', 'phase_scanning', 'duplicate_start_keep'], timeoutMs: 0 },
      scanning: {
        actions: [
          'lease_start', 'force_pulse', 'phase_scanning', 'phase_sealed',
          'queue_add', 'queue_seal', 'scroll', 'inbox_scroll', 'promote_deferred',
          'duplicate_start_keep', 'queue_defer'
        ],
        timeoutMs: 45000
      },
      sealed: {
        actions: [
          'phase_sealed', 'phase_executing', 'promote_deferred', 'duplicate_start_keep',
          'lease_start', 'force_pulse', 'queue_mark', 'start_from_queue'
        ],
        timeoutMs: 30000
      },
      executing: {
        actions: [
          'phase_executing', 'inbox_open', 'queue_mark', 'queue_mark_done', 'queue_mark_skipped',
          'queue_mark_failed', 'queue_mark_deferred', 'step_', 'identity_', 'inbox_resume_wait',
          'promote_deferred', 'duplicate_start_keep'
        ],
        timeoutMs: 45000
      },
      done: { actions: ['phase_done', 'round_done', 'lease_start', 'force_pulse'], timeoutMs: 0 }
    },
    chat_outbound: {
      running: {
        actions: ['lease_start', 'phase_', 'step_', 'identity_', 'queue_', 'outbound_', 'ice_'],
        timeoutMs: 120000
      }
    },
    follow: {
      running: { actions: ['*'], timeoutMs: 90000 }
    },
    nurture: {
      running: { actions: ['*'], timeoutMs: 120000 }
    }
  };

  function shanghaiTime() {
    try {
      return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    } catch (e) {
      return new Date().toISOString();
    }
  }

  function readFreeze() {
    try {
      var f = JSON.parse(sessionStorage.getItem(FREEZE_KEY) || 'null');
      return f && f.on ? f : null;
    } catch (e) {
      return null;
    }
  }

  function isFrozen() {
    return !!readFreeze();
  }

  function writeFreeze(obj) {
    try {
      sessionStorage.setItem(FREEZE_KEY, JSON.stringify(obj || { on: false }));
    } catch (e) {}
  }

  function clearFreeze(why) {
    var prev = readFreeze();
    try { sessionStorage.removeItem(FREEZE_KEY); } catch (e) {}
    try {
      if (typeof SgTelemetry !== 'undefined') {
        SgTelemetry.emit('scheduler.diag_unfreeze', {
          why: why || 'manual',
          prev_module: prev && prev.module,
          prev_reason: prev && prev.reason,
          prev_code: prev && prev.code
        });
      }
    } catch (eT) {}
    try {
      window.dispatchEvent(new CustomEvent('sg-diag-unfreeze', { detail: { why: why || 'manual', prev: prev } }));
    } catch (eEv) {}
    return prev;
  }

  function buildSnapshot(extra) {
    extra = extra || {};
    var snap = {
      time_zh: shanghaiTime(),
      url: '',
      chat_phase: '',
      auto_run: '',
      follow_running: '',
      softRiskUntil: 0
    };
    try { snap.url = String(location.href || ''); } catch (e0) {}
    try { snap.chat_phase = sessionStorage.getItem('dan_chat_phase') || ''; } catch (e1) {}
    try { snap.auto_run = sessionStorage.getItem('dan_auto_run') || ''; } catch (e2) {}
    try { snap.follow_running = localStorage.getItem('matrix_follow_running') || ''; } catch (e3) {}
    try {
      var sg = JSON.parse(localStorage.getItem('sg_state') || '{}');
      snap.softRiskUntil = sg.softRiskUntil || 0;
      snap.softRiskMode = sg.softRiskMode || '';
    } catch (e6) {}
    try {
      var last = JSON.parse(sessionStorage.getItem(LAST_ACTION_KEY) || 'null');
      if (last) snap.lastAction = last;
    } catch (e7) {}
    Object.keys(extra).forEach(function (k) { snap[k] = extra[k]; });
    return snap;
  }

  function emit(eventId, meta) {
    try {
      if (typeof SgTelemetry !== 'undefined') SgTelemetry.emit(eventId, meta || {});
    } catch (e) {}
  }

  /**
   * 4.1.33：不再冻结引擎。只上报 OPS（diag_anomaly + diag_freeze 事件名保留便于过滤），
   * 假活/契约违规仍由 reclaim/停模块处理，调度继续跑。
   */
  function enterFreeze(payload) {
    payload = payload || {};
    try { sessionStorage.removeItem(FREEZE_KEY); } catch (eClr) {}
    var snap = buildSnapshot(payload.extra || {});
    var rec = {
      on: false,
      report_only: true,
      module: payload.module || '',
      stage: payload.stage || '',
      reason: payload.reason || 'anomaly',
      code: payload.code || 'diag_anomaly',
      pulseId: payload.pulseId || snap.pulseId || '',
      at: Date.now(),
      time_zh: shanghaiTime(),
      url: snap.url,
      lastAction: snap.lastAction || null,
      hint: payload.hint || '',
      snapshot: snap
    };
    emit('scheduler.diag_anomaly', {
      module: rec.module,
      stage: rec.stage,
      reason: rec.reason,
      code: rec.code,
      pulseId: rec.pulseId,
      hint: rec.hint,
      url: rec.url,
      lastAction: rec.lastAction,
      snapshot: snap,
      report_only: true
    });
    emit('scheduler.diag_freeze', {
      module: rec.module,
      stage: rec.stage,
      reason: rec.reason,
      code: rec.code,
      pulseId: rec.pulseId,
      hint: rec.hint,
      report_only: true
    });
    try {
      window.dispatchEvent(new CustomEvent('sg-diag-report', { detail: rec }));
    } catch (eEv) {}
    try {
      console.warn('[诊断上报OPS]', rec.code, rec.reason, rec.hint || '', rec);
    } catch (eC) {}
    return rec;
  }

  function actionAllowed(allowList, action) {
    if (!allowList || !allowList.length) return true;
    var a = String(action || '');
    for (var i = 0; i < allowList.length; i++) {
      var rule = String(allowList[i] || '');
      if (rule === '*') return true;
      if (rule.slice(-1) === '_' || rule.slice(-1) === '*') {
        var prefix = rule.replace(/\*$/, '');
        if (a.indexOf(prefix) === 0) return true;
      } else if (a === rule || a.indexOf(rule) === 0) {
        // 精确或前缀：inbox_scroll_3 匹配 inbox_scroll
        if (a === rule || a.indexOf(rule + '_') === 0) return true;
      }
    }
    return false;
  }

  function resolveContract(module, stage) {
    var table = CONTRACTS[module];
    if (!table) return null;
    return table[stage] || table.running || null;
  }

  function noteAction(module, stage, action, meta) {
    module = String(module || '');
    stage = String(stage || '');
    action = String(action || '');
    var rec = {
      module: module,
      stage: stage,
      action: action,
      at: Date.now(),
      time_zh: shanghaiTime(),
      meta: meta || null
    };
    try { sessionStorage.setItem(LAST_ACTION_KEY, JSON.stringify(rec)); } catch (e) {}

    if (isFrozen()) return { ok: false, frozen: true };

    var contract = resolveContract(module, stage);
    if (contract && contract.actions && contract.actions[0] !== '*') {
      if (!actionAllowed(contract.actions, action)) {
        enterFreeze({
          module: module,
          stage: stage,
          reason: 'action_not_allowed',
          code: 'diag_bad_action',
          hint: '阶段 ' + stage + ' 不允许动作 ' + action,
          pulseId: (meta && meta.pulseId) || '',
          extra: { badAction: action, allowed: contract.actions.slice(0, 20) }
        });
        // 4.1.33：只上报，不因契约动作拒跑（frozen 恒 false）
        return { ok: true, reported: true, reason: 'action_not_allowed' };
      }
    }
    return { ok: true };
  }

  function checkStale(module, stage, ageMs) {
    if (isFrozen()) return { ok: false, frozen: true };
    var contract = resolveContract(module, stage);
    if (!contract || !contract.timeoutMs) return { ok: true };
    var age = ageMs;
    if (age == null) {
      try {
        var last = JSON.parse(sessionStorage.getItem(LAST_ACTION_KEY) || 'null');
        if (last && last.module === module) age = Date.now() - (last.at || 0);
        else age = 1e12;
      } catch (e) {
        age = 1e12;
      }
    }
    if (age > contract.timeoutMs) {
      enterFreeze({
        module: module,
        stage: stage || 'running',
        reason: 'stale_no_action',
        code: 'diag_stale',
        hint: module + '/' + (stage || 'running') + ' 超时无合法动作 age=' + Math.round(age / 1000) + 's',
        extra: { age_ms: age, timeout_ms: contract.timeoutMs }
      });
      // 4.1.33：上报 OPS，不冻结
      return { ok: true, reported: true, reason: 'stale', age_ms: age };
    }
    return { ok: true, age_ms: age };
  }

  /** 白名单自愈：仅清已知幽灵旗标类，成功则上报 auto_repaired */
  function tryAutoRepair(code, fn) {
    if (isFrozen()) return false;
    try {
      var ok = !!(fn && fn());
      if (ok) {
        emit('scheduler.diag_auto_repaired', { code: code || 'repair', time_zh: shanghaiTime() });
      }
      return ok;
    } catch (e) {
      return false;
    }
  }

  function getStatus() {
    return {
      frozen: isFrozen(),
      freeze: readFreeze(),
      lastAction: (function () {
        try { return JSON.parse(sessionStorage.getItem(LAST_ACTION_KEY) || 'null'); } catch (e) { return null; }
      })(),
      contracts: Object.keys(CONTRACTS)
    };
  }

  var api = {
    FREEZE_KEY: FREEZE_KEY,
    CONTRACTS: CONTRACTS,
    isFrozen: isFrozen,
    readFreeze: readFreeze,
    enterFreeze: enterFreeze,
    clearFreeze: clearFreeze,
    noteAction: noteAction,
    checkStale: checkStale,
    tryAutoRepair: tryAutoRepair,
    buildSnapshot: buildSnapshot,
    getStatus: getStatus
  };

  if (typeof window !== 'undefined') {
    window.SgDiagContract = api;
    window.__sgDiagUnfreeze = function (why) { return clearFreeze(why || 'console'); };
    window.__sgDiagStatus = function () { return getStatus(); };
    // 启动即清历史冻结，避免旧 sg_diag_freeze 卡死调度
    try { sessionStorage.removeItem(FREEZE_KEY); } catch (eBoot) {}
  }
  if (typeof self !== 'undefined') self.SgDiagContract = api;
})();

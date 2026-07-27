(function () {
  'use strict';

  var K = SKeys;

  var modules = {};
  var prev = { pageOwner: '', stage: 'S0' };
  var interval = null, wdTimer = null, lastTick = 0;
  var tickLock = false;
  var running = false;
  var _noPageJump = false;

  function register(name, mod) {
    if (!mod || typeof mod.canRun !== 'function' || typeof mod.tick !== 'function') {
      Logger.warn('Coor', '模块 ' + name + ' 缺少标准接口, 跳过注册');
      return;
    }
    modules[name] = mod;
    mod._name = name;
    mod._nextDelayUntil = 0;
    mod._state = 'stopped';
    Logger.info('Coor', '注册模块: ' + name);
  }

  function ensureStageDetectorLoaded() {
    if (typeof StageDetector === 'undefined') {
      Logger.error('Coor', 'StageDetector 未加载');
      return false;
    }
    return true;
  }

  function ensurePageRouterLoaded() {
    if (typeof PageRouter === 'undefined') {
      Logger.error('Coor', 'PageRouter 未加载');
      return false;
    }
    return true;
  }

  function loadPrev() {
    try {
      var raw = JSON.parse(localStorage.getItem(K.LK_STATE)) || {};
      prev.pageOwner = raw.coPageOwner || '';
      prev.stage = raw.coStage || 'S0';
      if (raw.coModules) {
        for (var k in raw.coModules) {
          if (modules[k]) {
            modules[k]._nextDelayUntil = raw.coModules[k].nextDelayUntil || 0;
            modules[k]._state = raw.coModules[k].state || 'stopped';
          }
        }
      }
    } catch (e) {}
  }

  function savePrev() {
    try {
      var stateBase = {};
      try { stateBase = JSON.parse(localStorage.getItem(K.LK_STATE)) || {}; } catch (e) {}
      var modSnap = {};
      for (var k in modules) {
        modSnap[k] = {
          nextDelayUntil: modules[k]._nextDelayUntil || 0,
          state: modules[k]._state || 'stopped'
        };
      }
      stateBase.coPageOwner = prev.pageOwner;
      stateBase.coStage = prev.stage;
      stateBase.coModules = modSnap;
      localStorage.setItem(K.LK_STATE, JSON.stringify(stateBase));
    } catch (e) {}
  }

  function stopAllExcept(keepName) {
    for (var k in modules) {
      if (k !== keepName && modules[k]._state === 'running') {
        try { modules[k].stop(); } catch (e) {}
        modules[k]._state = 'stopped';
      }
    }
  }

  function updatePanel(ctx) {
    try {
      var modStatus = {};
      for (var k in modules) {
        try { modStatus[k] = modules[k].status ? modules[k].status() : {}; } catch (e) {}
      }
      window.dispatchEvent(new CustomEvent('sg-coordinator-tick', { detail: {
        stage: prev.stage,
        pageOwner: prev.pageOwner,
        modules: modStatus,
        running: running,
        url: window.location.href,
        stageInfo: ctx || {}
      }}));
    } catch (e) {}
  }

  function onTick() {
    if (tickLock) return;
    tickLock = true;
    lastTick = Date.now();
    try {
      if (ensureStageDetectorLoaded()) {
        var result = StageDetector.detect();
        prev.stage = result.stage;
      }

      if (!running) {
        for (var k in modules) {
          var m = modules[k];
          var shouldRun = (prev.stage !== 'S0' && prev.stage !== 'S4') ? (typeof m.canRun === 'function' ? m.canRun(prev.stage) : true) : false;
          try {
            window.dispatchEvent(new CustomEvent('sg-coordinator-command', {
              detail: { module: k, action: shouldRun ? 'start' : 'stop', stage: prev.stage }
            }));
          } catch (e) {}
        }
        updatePanel({ currentStage: prev.stage }); return;
      }

      if (!ensurePageRouterLoaded()) { updatePanel({ currentStage: prev.stage }); return; }

      var stage = prev.stage;
      var priority = (function () {
        try { return (typeof StageDetector !== 'undefined') ? StageDetector.detect().priority : []; } catch (e) { return []; }
      })();

      if (stage === 'S0') {
        stopAllExcept('.');
        savePrev(); updatePanel({ currentStage: stage }); return;
      }

      var pageOwner = PageRouter.fromUrl();
      var now = Date.now();

      var desiredOwner = null;
      for (var i = 0; i < priority.length; i++) {
        var name = priority[i];
        var mod = modules[name];
        if (!mod) continue;
        if (mod._nextDelayUntil && now < mod._nextDelayUntil) continue;
        if (typeof mod.canRun === 'function' && mod.canRun(stage)) {
          desiredOwner = name;
          break;
        }
      }

      if (!desiredOwner) {
        updatePanel({ currentStage: stage, reason: 'no_module_ready' });
        savePrev(); return;
      }

      if (pageOwner !== desiredOwner) {
        if (_noPageJump) {
          try {
            window.dispatchEvent(new CustomEvent('sg-coordinator-command', {
              detail: { module: desiredOwner, action: 'start', stage: stage }
            }));
          } catch (e) {}
          savePrev();
          updatePanel({ currentStage: stage, desiredOwner: desiredOwner, noJump: true });
          return;
        }
        var targetUrl = PageRouter.homeUrlFor(desiredOwner);
        if (targetUrl) {
          PageRouter.jumpTo(targetUrl);
          prev.pageOwner = desiredOwner;
          savePrev();
          updatePanel({ currentStage: stage, desiredOwner: desiredOwner, jumping: true });
          return;
        }
        updatePanel({ currentStage: stage, reason: 'no_target_url' });
        return;
      }

      prev.pageOwner = desiredOwner;
      var mod = modules[desiredOwner];
      if (mod._state !== 'running') {
        try { if (typeof mod.start === 'function') mod.start(); } catch (e) { Logger.error('Coor', desiredOwner + ' start失败: ' + e.message); }
        mod._state = 'running';
      }

      var resultTick = null;
      try { resultTick = mod.tick({ stage: stage, pageOwner: desiredOwner, now: now }); } catch (e) {
        Logger.error('Coor', desiredOwner + ' tick异常: ' + e.message);
        resultTick = { tookPage: false, nextDelayMs: 60000 };
      }

      if (resultTick && resultTick.tookPage) {
        try { if (window._lastModuleAction) window._lastModuleAction[desiredOwner] = Date.now(); } catch (e) {}
      }

      if (resultTick && resultTick.nextDelayMs > 0) {
        mod._nextDelayUntil = now + resultTick.nextDelayMs;
      }

      if (resultTick && !resultTick.tookPage && resultTick.nextDelayMs > 0) {
        for (var j = 0; j < priority.length; j++) {
          var name2 = priority[j];
          if (name2 === desiredOwner) continue;
          var mod2 = modules[name2];
          if (!mod2) continue;
          if (mod2._nextDelayUntil && now < mod2._nextDelayUntil) continue;

          var targetUrl2 = PageRouter.homeUrlFor(name2);
          if (targetUrl2) {
            PageRouter.jumpTo(targetUrl2);
            prev.pageOwner = name2;
            break;
          }
        }
      }

      // ========== 健康检查 ==========
      var IDLE_HARD = 10 * 60 * 1000;
      var IDLE_SOFT =  5 * 60 * 1000;
      for (var k in modules) {
        var m = modules[k];
        if (m._state !== 'running') continue;
        var lastAct = 0;
        try { if (window._lastModuleAction) lastAct = window._lastModuleAction[k] || 0; } catch (e) {}
        if (!lastAct) continue;
        var idleMs = Date.now() - lastAct;
        if (idleMs > IDLE_HARD) {
          Logger.warn('Coor', k + ' 无动作 ' + Math.floor(idleMs / 60000) + ' 分钟 → 强制恢复');
          try { m.stop(); } catch (e) {}
          m._state = 'stopped';
          m._nextDelayUntil = 0;
          var homeUrl = PageRouter.homeUrlFor(k);
          if (homeUrl && _noPageJump) {
            try { window.dispatchEvent(new CustomEvent('sg-coordinator-command', { detail: { module: k, action: 'start', stage: prev.stage } })); } catch (e) {}
          } else if (homeUrl) {
            PageRouter.jumpTo(homeUrl);
          }
          try { if (window._lastModuleAction) window._lastModuleAction[k] = Date.now(); } catch (e) {}
        } else if (idleMs > IDLE_SOFT) {
          Logger.warn('Coor', k + ' 无反馈 ' + Math.floor(idleMs / 60000) + ' 分钟 → 释放延迟');
          m._nextDelayUntil = 0;
        }
      }

      savePrev();
      updatePanel({
        currentStage: stage,
        desiredOwner: desiredOwner,
        tookPage: resultTick ? resultTick.tookPage : true,
        nextDelayMs: resultTick ? resultTick.nextDelayMs : 0
      });
    } finally {
      tickLock = false;
    }
  }

  function start() {
    loadPrev();
    running = true;
    Logger.info('Coor', 'Coordinator 启动');
    savePrev();
    onTick();
  }

  function stop() {
    running = false;
    stopAllExcept('.');
    Logger.info('Coor', 'Coordinator 停止');
    savePrev();
    updatePanel();
  }

  function pause() {
    running = false;
    Logger.info('Coor', 'Coordinator 暂停');
    savePrev();
    updatePanel();
  }

  function resume() {
    running = true;
    Logger.info('Coor', 'Coordinator 恢复');
    savePrev();
    onTick();
  }

  function getModule(name) {
    return modules[name] || null;
  }

  function startInterval(intMs) {
    if (interval) clearInterval(interval);
    interval = setInterval(function () { loadPrev(); onTick(); }, intMs || 10000);
    if (wdTimer) clearInterval(wdTimer);
    wdTimer = setInterval(function () {
      if (Date.now() - lastTick > 30000 && !tickLock) {
        lastTick = Date.now();
        Logger.warn('Coor', '看门狗重启');
        onTick();
      } else if (Date.now() - lastTick > 60000) {
        tickLock = false;
        Logger.warn('Coor', '看门狗清理 tickLock');
        lastTick = Date.now();
        onTick();
      }
    }, 30000);
  }

  function startObserver() {
    startInterval(10000);
    running = true;
    _noPageJump = true;
    Logger.info('Coor', '调度模式已启动（V5 掌控页面跳转）');
  }

  function init() {
    startInterval(10000);
    Logger.info('Coor', '调度中心已加载');

    if (typeof window !== 'undefined' && window.SG_DEBUG) {
      clearInterval(interval);
      interval = setInterval(function () { loadPrev(); onTick(); }, 2000);
      console.log('[Coor] DEBUG: 2s tick');
    }
  }

  var Coordinator = {
    register: register, start: start, stop: stop, pause: pause, resume: resume,
    init: init, startObserver: startObserver, getModule: getModule, startInterval: startInterval
  };

  if (typeof window !== 'undefined') { window.Coordinator = Coordinator; }
  if (typeof self !== 'undefined') { self.Coordinator = Coordinator; }
})();

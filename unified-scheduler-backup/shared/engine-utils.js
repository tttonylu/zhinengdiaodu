// =============================================================================
// 智能调度 — 引擎生命周期工具（轻量版，替代 EngineBase 类）
// 为 nurture 引擎提供 timer/watchdog/flag 管理
// =============================================================================

var EngineUtils = (function () {
  'use strict';

  var _states = {};

  function _ns(name, key) {
    return 'sg_' + name + '_' + key;
  }

  return {
    /** 创建可取消的间隔 timer */
    createInterval: function (fn, ms) {
      var id = setInterval(fn, ms);
      return {
        id: id,
        cancel: function () { if (id) { clearInterval(id); id = null; } },
      };
    },

    /** 创建可取消的延迟 timer */
    createTimeout: function (fn, ms) {
      var id = setTimeout(fn, ms);
      return {
        id: id,
        cancel: function () { if (id) clearTimeout(id); id = null; },
      };
    },

    /** 启动引擎（写标记） */
    start: function (name) {
      sessionStorage.setItem(_ns(name, 'running'), 'true');
      sessionStorage.removeItem(_ns(name, 'paused'));
      localStorage.setItem(_ns(name, 'running'), 'true');
      _states[name] = { lastActivity: Date.now(), running: true, paused: false };
    },

    /** 停止引擎（清标记） */
    stop: function (name) {
      sessionStorage.removeItem(_ns(name, 'running'));
      sessionStorage.removeItem(_ns(name, 'paused'));
      localStorage.removeItem(_ns(name, 'running'));
      if (_states[name]) _states[name].running = false;
    },

    /** 暂停引擎 */
    pause: function (name) {
      sessionStorage.setItem(_ns(name, 'paused'), 'true');
      if (_states[name]) _states[name].paused = true;
    },

    /** 恢复引擎 */
    resume: function (name) {
      sessionStorage.removeItem(_ns(name, 'paused'));
      if (_states[name]) { _states[name].paused = false; _states[name].lastActivity = Date.now(); }
    },

    /** 引擎是否活跃（running && !paused） */
    isActive: function (name) {
      var running = sessionStorage.getItem(_ns(name, 'running')) === 'true';
      var paused = sessionStorage.getItem(_ns(name, 'paused')) === 'true';
      return running && !paused;
    },

    /** 引擎是否正在运行（含 paused） */
    isRunning: function (name) {
      return sessionStorage.getItem(_ns(name, 'running')) === 'true';
    },

    /** 更新时间戳 */
    ping: function (name) {
      if (_states[name]) _states[name].lastActivity = Date.now();
    },

    /** 获取距上次活动毫秒 */
    idleMs: function (name) {
      var st = _states[name];
      if (!st || !st.lastActivity) return 0;
      return Date.now() - st.lastActivity;
    },

    /** 创建看门狗，idle 超过 ms 时触发 cb */
    createWatchdog: function (name, ms, cb) {
      return setInterval(function () {
        if (!EngineUtils.isActive(name)) return;
        if (EngineUtils.idleMs(name) > ms) {
          EngineUtils.ping(name);
          try { cb(); } catch (e) {}
        }
      }, 10000);
    },

    /** 清除看门狗 */
    clearWatchdog: function (id) {
      if (id) clearInterval(id);
    },
  };
})();

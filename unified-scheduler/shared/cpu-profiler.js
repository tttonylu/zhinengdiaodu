// =============================================================================
// 智能调度 — CPU 仪表（obs 观测板块）
// 必须作为隔离世界第一个脚本加载（manifest 本块首位）：
// 包裹 setInterval / setTimeout / MutationObserver，按来源文件归因回调耗时。
// - 常驻包裹，零配置；仅累计，开销=每次回调一次 performance.now() 差值
// - 4.6.128 起默认开启（不必手动置 1）：每 60s 把当分钟桶写入
//   sg_cpu_profile_last（最近一分钟）并累计进 sg_cpu_profile_day（当天合计），
//   并 emit cpu.profile_minute 走遥测上传 OPS；置 localStorage sg_cpu_profile=0 可关闭
// - 4.6.138：①tagFromStack 穿透 safeSetInterval 等包装器帧，归因直达业务注册行；
//   ②新增 window.__sgCpuMark(name, ms) 分段 API（tag 前缀 §），供 coTick 等黑盒函数
//   内部拆段上报，与定时器回调桶合并排序输出
// - 4.6.142：coTick 补 9 个分段点（覆盖函数主体），上报切片 15→40 防小分段被挤掉
// - 随时可在控制台执行 window.__sgCpuProfile() 查看当前分钟桶（传 true 重置）
// =============================================================================

(function () {
  'use strict';

  if (window.__sgCpuProfilerInstalled) return;

  var buckets = Object.create(null);
  var segBuckets = Object.create(null);
  var enabledCache = null;
  var enabledAt = 0;

  // 4.6.138：穿透业务侧定时器包装器（safeSetInterval/safeSetTimeout/wrapCb 等）。
  // 否则归因停在包装器行（如 content_chat.js:231），看不到真实业务注册点。
  var WRAPPER_FNS = {
    safeSetInterval: 1, safeSetTimeout: 1,
    wrapCb: 1, debounce: 1, throttle: 1
  };

  function tagFromStack() {
    try {
      var s = new Error().stack || '';
      var lines = s.split('\n');
      for (var i = 1; i < lines.length; i++) {
        // V8 帧两种：
        //   "    at fnName (chrome-extension://EXTID/path/file.js:line:col)"
        //   "    at chrome-extension://EXTID/path/file.js:line:col"
        var m = lines[i].match(/at (?:([\w$]+)\s*\()?chrome-extension:\/\/[^/]+\/(?:[^()]*?\/)?([^/():?]+\.js):(\d+)/);
        if (!m) continue;
        var fnName = m[1] || '';
        var fileName = m[2];
        if (fileName.indexOf('cpu-profiler') !== -1) continue;
        if (WRAPPER_FNS[fnName]) continue;
        // 4.6.129：tag 带注册点行号（文件级粒度定位不了具体哪条定时器在烧 CPU）
        return fileName + ':' + (m[3] || '?');
      }
    } catch (e) {}
    return 'unknown';
  }

  function record(tag, ms) {
    var b = buckets[tag];
    if (!b) { b = buckets[tag] = { count: 0, ms: 0 }; }
    b.count++;
    b.ms += ms;
  }

  function wrapCb(fn, tag) {
    if (typeof fn !== 'function') return fn;
    return function () {
      var t0 = performance.now();
      try {
        return fn.apply(this, arguments);
      } finally {
        record(tag, performance.now() - t0);
      }
    };
  }

  try {
    var _setInterval = window.setInterval;
    var _setTimeout = window.setTimeout;

    window.setInterval = function (fn, ms) {
      var tag = tagFromStack();
      return _setInterval.call(window, wrapCb(fn, tag), ms);
    };
    window.setTimeout = function (fn, ms) {
      var tag = tagFromStack();
      if (arguments.length > 2) {
        var rest = Array.prototype.slice.call(arguments, 2);
        return _setTimeout.apply(window, [wrapCb(fn, tag), ms].concat(rest));
      }
      return _setTimeout.call(window, wrapCb(fn, tag), ms);
    };

    if (typeof window.MutationObserver === 'function') {
      var _MO = window.MutationObserver;
      var WrappedMO = function (cb) {
        var tag = tagFromStack();
        return new _MO(wrapCb(cb, tag));
      };
      WrappedMO.prototype = _MO.prototype;
      window.MutationObserver = WrappedMO;
    }
  } catch (eInstall) {
    // 任何包裹失败都不允许影响业务脚本
    try { console.warn('[CPU仪表] 安装失败', eInstall); } catch (e2) {}
    return;
  }

  window.__sgCpuProfilerInstalled = true;

  // 4.6.138：业务代码在关键段落/重活调用边界手动打点。
  // 用法：window.__sgCpuMark('coTick.freezeScan', performance.now() - t0);
  // 分段桶独立于定时器回调桶，tag 加 § 前缀区分（用于 coTick 等大黑盒函数内部拆段）。
  window.__sgCpuMark = function (name, ms) {
    try {
      var key = '§' + String(name || '?').slice(0, 48);
      var b = segBuckets[key];
      if (!b) { b = segBuckets[key] = { count: 0, ms: 0 }; }
      b.count++;
      b.ms += ms;
    } catch (e) {}
  };

  function isEnabled() {
    var now = Date.now();
    if (enabledCache === null || now - enabledAt > 5000) {
      enabledAt = now;
      try { enabledCache = localStorage.getItem('sg_cpu_profile') !== '0'; }
      catch (e) { enabledCache = true; }
    }
    return enabledCache;
  }

  function snapshot() {
    var out = [];
    function pushMap(map) {
      for (var k in map) {
        if (Object.prototype.hasOwnProperty.call(map, k)) {
          out.push({ tag: k, count: map[k].count, ms: Math.round(map[k].ms * 10) / 10 });
        }
      }
    }
    pushMap(buckets);
    pushMap(segBuckets);
    out.sort(function (a, b) { return b.ms - a.ms; });
    return out;
  }

  window.__sgCpuProfile = function (reset) {
    var s = snapshot();
    if (reset) { buckets = Object.create(null); segBuckets = Object.create(null); }
    return s;
  };

  // 每 60s：开启时落盘当分钟桶并累计当天；未开启只清桶防膨胀
  _setInterval.call(window, function () {
    var s = snapshot();
    buckets = Object.create(null);
    segBuckets = Object.create(null);
    if (!isEnabled()) return;
    try {
      localStorage.setItem('sg_cpu_profile_last', JSON.stringify({
        at: new Date().toISOString(),
        buckets: s.slice(0, 40)
      }));
      var day = new Date().toISOString().slice(0, 10);
      var acc = {};
      try { acc = JSON.parse(localStorage.getItem('sg_cpu_profile_day') || '{}'); } catch (e3) {}
      if (acc._date !== day) acc = { _date: day };
      for (var i = 0; i < s.length; i++) {
        var it = s[i];
        var a = acc[it.tag];
        if (!a) { a = acc[it.tag] = { count: 0, ms: 0 }; }
        a.count += it.count;
        a.ms = Math.round((a.ms + it.ms) * 10) / 10;
      }
      localStorage.setItem('sg_cpu_profile_day', JSON.stringify(acc));
    } catch (e) {}
    // 4.6.122：同份数据走遥测管道上传 OPS（cpu.profile_minute），后期可在 OPS 侧按号/按天调取；
    // localStorage 两份（last/day）保留作本地兜底，双通道防单点丢失
    try {
      if (window.SgTelemetry && typeof window.SgTelemetry.emit === 'function' && s.length) {
        window.SgTelemetry.emit('cpu.profile_minute', {
          // 4.6.142：切片 15→40，coTick 分段点增至 19 个后防止小分段被定时器桶挤掉
          buckets: s.slice(0, 40).map(function (it) { return { t: it.tag, c: it.count, ms: it.ms }; })
        });
      }
    } catch (eT) {}
  }, 60000);
})();

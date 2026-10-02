// =============================================================================
// ChallengeGuard — CF / 人机验证页检测与当日熔断（止血 A）
// 目标：禁止对挑战页硬刷新，避免刷新死循环把号刷异常
// =============================================================================
(function () {
  'use strict';
  if (window.ChallengeGuard) return;

  var HIT_AT_KEY = 'sg_challenge_hit_at';
  var KIND_KEY = 'sg_challenge_kind';
  var FUSE_UNTIL_KEY = 'sg_challenge_fuse_until';
  var FUSE_MS = 20 * 60 * 1000; // 连续卡验证 20 分钟 → 熔断
  var FUSE_HOLD_MS = 6 * 60 * 60 * 1000; // 熔断后至少冷却 6 小时
  var _lastLogAt = 0;

  function now() { return Date.now(); }

  function readInt(key) {
    try { return parseInt(localStorage.getItem(key) || '0', 10) || 0; } catch (e) { return 0; }
  }

  function write(key, val) {
    try { localStorage.setItem(key, String(val)); } catch (e) {}
  }

  function remove(key) {
    try { localStorage.removeItem(key); } catch (e) {}
  }

  function pageTextSample() {
    var parts = [];
    try { parts.push(document.title || ''); } catch (e0) {}
    try {
      var b = document.body;
      if (b) parts.push((b.innerText || b.textContent || '').slice(0, 4000));
    } catch (e1) {}
    return parts.join('\n');
  }

  function detect() {
    var signals = [];
    var kind = '';
    try {
      var path = (location.pathname || '').toLowerCase();
      var href = (location.href || '').toLowerCase();
      if (href.indexOf('cdn-cgi/challenge') >= 0 || path.indexOf('/cdn-cgi/') === 0) {
        signals.push('cdn-cgi');
        kind = 'cloudflare';
      }
    } catch (eP) {}

    try {
      if (document.querySelector('#challenge-form, #challenge-running, .cf-browser-verification, .cf-im-under-attack, [name="cf-turnstile-response"]')) {
        signals.push('cf-dom');
        kind = kind || 'cloudflare';
      }
      if (document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]')) {
        signals.push('turnstile');
        kind = kind || 'cloudflare';
      }
      if (document.querySelector('[data-sitekey], .cf-turnstile')) {
        signals.push('turnstile-widget');
        kind = kind || 'cloudflare';
      }
    } catch (eD) {}

    var txt = '';
    try { txt = pageTextSample(); } catch (eT) { txt = ''; }
    var lower = txt.toLowerCase();
    if (/just a moment|checking your browser|attention required|enable javascript and cookies|云flare|正在验证|请完成安全验证|请确认您是真人|verify you are human|security check/i.test(txt) ||
        lower.indexOf('cf-browser-verification') >= 0) {
      // 有 X 主壳则不当成 CF（避免误伤正常页文案）
      var hasXShell = false;
      try {
        hasXShell = !!(
          document.querySelector('[data-testid="primaryColumn"]') ||
          document.querySelector('[data-testid="AppTabBar_Home_Link"]') ||
          document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]')
        );
      } catch (eX) {}
      if (!hasXShell) {
        signals.push('cf-text');
        kind = kind || 'cloudflare';
      }
    }

    // Google / 其它验证码壳（少见，一并挡住硬刷）
    try {
      if (!kind && document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"]')) {
        var hasShell = false;
        try {
          hasShell = !!(document.querySelector('[data-testid="primaryColumn"]') || document.querySelector('[data-testid="AppTabBar_Home_Link"]'));
        } catch (e2) {}
        if (!hasShell) {
          signals.push('captcha-frame');
          kind = 'captcha';
        }
      }
    } catch (eC) {}

    return { hit: signals.length > 0, kind: kind || '', signals: signals };
  }

  function isFused() {
    return readInt(FUSE_UNTIL_KEY) > now();
  }

  function noteHit(kind) {
    var hitAt = readInt(HIT_AT_KEY);
    if (!hitAt) write(HIT_AT_KEY, now());
    if (kind) write(KIND_KEY, kind);
    hitAt = readInt(HIT_AT_KEY) || now();
    if (!isFused() && now() - hitAt >= FUSE_MS) {
      write(FUSE_UNTIL_KEY, now() + FUSE_HOLD_MS);
      try {
        if (typeof Logger !== 'undefined') {
          Logger.warn('Challenge', '验证页连续≥20分钟，熔断 ' + Math.round(FUSE_HOLD_MS / 3600000) + 'h');
        }
      } catch (eL) {}
      return true;
    }
    return false;
  }

  function clearHit() {
    remove(HIT_AT_KEY);
    remove(KIND_KEY);
  }

  function clearFuse() {
    remove(FUSE_UNTIL_KEY);
    clearHit();
  }

  function shouldBlockHeal() {
    var d = detect();
    return !!(d.hit || isFused());
  }

  function shouldBlockAutomation() {
    var d = detect();
    if (d.hit) return true;
    if (isFused()) return true;
    return false;
  }

  function tick() {
    var d = detect();
    if (d.hit) {
      var fusedNow = noteHit(d.kind);
      if (!_lastLogAt || now() - _lastLogAt > 60000) {
        _lastLogAt = now();
        try {
          if (typeof Logger !== 'undefined') {
            Logger.warn('Challenge', '检测到验证页 kind=' + d.kind + ' signals=' + d.signals.join(',') + (fusedNow ? ' [新熔断]' : ''));
          }
        } catch (e) {}
      }
      return snapshot();
    }
    // 验证已过：清连续计时；熔断冷却仍保留直到到期或人工解除
    clearHit();
    return snapshot();
  }

  function snapshot() {
    var d = detect();
    var hitAt = readInt(HIT_AT_KEY);
    var fuseUntil = readInt(FUSE_UNTIL_KEY);
    var fused = fuseUntil > now();
    var sinceMs = hitAt ? Math.max(0, now() - hitAt) : 0;
    var msg = '';
    if (d.hit) {
      msg = '人机验证中·禁刷新';
      if (sinceMs > 60000) msg += ' ' + Math.round(sinceMs / 60000) + 'm';
    } else if (fused) {
      msg = '验证熔断冷却 ' + Math.ceil((fuseUntil - now()) / 60000) + 'm';
    }
    return {
      active: !!(d.hit || fused),
      onChallenge: !!d.hit,
      kind: d.kind || (fused ? (localStorage.getItem(KIND_KEY) || 'cloudflare') : ''),
      signals: d.signals || [],
      sinceMs: sinceMs,
      fused: fused,
      fuseRemainSec: fused ? Math.ceil((fuseUntil - now()) / 1000) : 0,
      msg: msg
    };
  }

  window.ChallengeGuard = {
    detect: detect,
    isFused: isFused,
    noteHit: noteHit,
    clearHit: clearHit,
    clearFuse: clearFuse,
    shouldBlockHeal: shouldBlockHeal,
    shouldBlockAutomation: shouldBlockAutomation,
    tick: tick,
    snapshot: snapshot,
    FUSE_MS: FUSE_MS
  };
})();

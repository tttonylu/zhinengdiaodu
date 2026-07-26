(function () {
  'use strict';

  if (typeof window !== 'undefined' && window.__matrix_risk_control_loaded__) {
    return;
  }
  if (typeof self !== 'undefined' && self.__matrix_risk_control_loaded__) {
    return;
  }

  var defaultConfig = {
    buckets: {
      follow: { capacity: 8, refillPerSec: 0.12 },
      chat: { capacity: 6, refillPerSec: 0.08 },
      push: { capacity: 10, refillPerSec: 0.2 }
    },
    cooldown: {
      baseMs: 60000,
      maxMs: 240000,
      jitterRatio: 0.25
    },
    backoff: {
      levels: [60000, 120000, 240000, 600000]
    }
  };

  function getConfig() {
    try {
      if (typeof MatrixConfig !== 'undefined' && typeof MatrixConfig.getConfigValue === 'function') {
        return MatrixConfig.getConfigValue('risk', defaultConfig) || defaultConfig;
      }
      if (typeof self !== 'undefined' && self.MatrixConfig && typeof self.MatrixConfig.getConfigValue === 'function') {
        return self.MatrixConfig.getConfigValue('risk', defaultConfig) || defaultConfig;
      }
      if (typeof window !== 'undefined' && window.MatrixConfig && typeof window.MatrixConfig.getConfigValue === 'function') {
        return window.MatrixConfig.getConfigValue('risk', defaultConfig) || defaultConfig;
      }
    } catch (err) {
      console.warn('[Risk] load config fallback', err);
    }
    return defaultConfig;
  }

  function TokenBucket(capacity, refillPerSec) {
    this.capacity = Math.max(1, capacity);
    this.refillPerSec = Math.max(0.0001, refillPerSec);
    this.tokens = this.capacity;
    this.last = Date.now();
  }

  TokenBucket.prototype.refill = function () {
    var now = Date.now();
    var deltaSec = (now - this.last) / 1000;
    if (deltaSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + deltaSec * this.refillPerSec);
      this.last = now;
    }
  };

  TokenBucket.prototype.tryTake = function (count) {
    if (count === undefined) {
      count = 1;
    }
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  };

  TokenBucket.prototype.waitMsFor = function (count) {
    if (count === undefined) {
      count = 1;
    }
    this.refill();
    if (this.tokens >= count) {
      return 0;
    }
    var need = count - this.tokens;
    return Math.ceil((need / this.refillPerSec) * 1000);
  };

  function jitteredMs(ms, jitterRatio) {
    var ratio = Math.max(0, Math.min(1, jitterRatio || 0));
    var spread = ms * ratio;
    var low = ms - spread;
    var high = ms + spread;
    return Math.round(low + Math.random() * (high - low));
  }

  function RiskController() {
    var cfg = getConfig();
    var buckets = {
      follow: new TokenBucket(cfg.buckets.follow.capacity, cfg.buckets.follow.refillPerSec),
      chat: new TokenBucket(cfg.buckets.chat.capacity, cfg.buckets.chat.refillPerSec),
      push: new TokenBucket(cfg.buckets.push.capacity, cfg.buckets.push.refillPerSec)
    };

    var cooldownUntil = { follow: 0, chat: 0, push: 0 };
    var penaltyLevel = { follow: 0, chat: 0, push: 0 };
    var counters = { followLimits: 0, chatLimits: 0, pushLimits: 0 };

    function now() {
      return Date.now();
    }

    function remainingCooldown(category) {
      return Math.max(0, cooldownUntil[category] - now());
    }

    function applyLimitBackoff(category) {
      var levelIndex = Math.min(penaltyLevel[category], cfg.backoff.levels.length - 1);
      var base = cfg.backoff.levels[levelIndex];
      var wait = jitteredMs(base, cfg.cooldown.jitterRatio);
      cooldownUntil[category] = now() + wait;
      penaltyLevel[category] = Math.min(penaltyLevel[category] + 1, cfg.backoff.levels.length - 1);

      if (category === 'follow') {
        counters.followLimits += 1;
      } else if (category === 'chat') {
        counters.chatLimits += 1;
      } else if (category === 'push') {
        counters.pushLimits += 1;
      }

      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('matrix_global_cooldown_until', String(cooldownUntil.follow));
        }
      } catch (err) {}

      return wait;
    }

    function resetBackoff(category) {
      penaltyLevel[category] = Math.max(0, penaltyLevel[category] - 1);
    }

    function tryAcquire(category, count) {
      if (remainingCooldown(category) > 0) {
        return { ok: false, reason: 'cooldown', waitMs: remainingCooldown(category) };
      }
      if (!buckets[category].tryTake(count)) {
        return { ok: false, reason: 'token', waitMs: buckets[category].waitMsFor(count) };
      }
      return { ok: true, reason: 'ok', waitMs: 0 };
    }

    function jitterSleepMs(minMs, maxMs, category) {
      var base = Math.max(0, minMs) + Math.random() * Math.max(0, maxMs - minMs);
      var extra = Math.max(0, remainingCooldown(category));
      return Math.round(base + extra);
    }

    function getState() {
      return {
        cooldownUntil: { follow: cooldownUntil.follow, chat: cooldownUntil.chat, push: cooldownUntil.push },
        penaltyLevel: { follow: penaltyLevel.follow, chat: penaltyLevel.chat, push: penaltyLevel.push },
        counters: {
          followLimits: counters.followLimits,
          chatLimits: counters.chatLimits,
          pushLimits: counters.pushLimits
        }
      };
    }

    return {
      tryAcquire: tryAcquire,
      applyLimitBackoff: applyLimitBackoff,
      resetBackoff: resetBackoff,
      jitterSleepMs: jitterSleepMs,
      getState: getState
    };
  }

  var controller = new RiskController();

  var api = {
    controller: controller,
    tryAcquire: controller.tryAcquire,
    applyLimitBackoff: controller.applyLimitBackoff,
    resetBackoff: controller.resetBackoff,
    jitterSleepMs: controller.jitterSleepMs,
    getState: controller.getState
  };

  if (typeof self !== 'undefined') {
    self.__matrix_risk_control_loaded__ = true;
    self.MatrixRisk = api;
  }
  if (typeof window !== 'undefined') {
    window.__matrix_risk_control_loaded__ = true;
    window.MatrixRisk = api;
  }

  console.log('[Risk] risk_control.js loaded');
})();

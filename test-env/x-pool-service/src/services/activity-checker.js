function createActivityChecker(repo, xClient, options = {}) {
  const logger = options.logger || null;
  const inactiveHours = Math.max(1, Number(options.inactiveHours) || 72);
  const minFollowers = Math.max(0, Number(options.minFollowers) || 0);
  const maxFollowers = Math.max(0, Number(options.maxFollowers) || 0);
  const followingLimitBase = Math.max(0, Number(options.followingLimitBase) || 50);
  const followingLimitRate = Number(options.followingLimitRate) ?? 0.01;
  const batchSize = Math.max(1, Number(options.batchSize) || 200);
  const onProgress = options.onProgress || null;

  function emit(type, data) {
    if (onProgress) {
      try { onProgress({ type, ...data }); } catch (e) {}
    }
  }

  function maxAllowedFollowing(followers) {
    return Math.floor(followingLimitBase + followers * followingLimitRate);
  }

  function isTweetCountStale(storedTweetCount, currentTweetCount, lastCheckedAt) {
    if (storedTweetCount === null || storedTweetCount === undefined) return false;
    if (currentTweetCount > storedTweetCount) return false;
    if (!lastCheckedAt) return false;
    if (currentTweetCount < storedTweetCount) return true;
    const hoursSince = (Date.now() - new Date(lastCheckedAt + '+08:00').getTime()) / (1000 * 60 * 60);
    return hoursSince > inactiveHours;
  }

  function buildDeleteReasons(result, stored) {
    const reasons = [];
    if (result.protected) reasons.push('locked/private account');
    if (minFollowers > 0 && result.followersCount < minFollowers)
      reasons.push('followers ' + result.followersCount + ' < min ' + minFollowers);
    if (maxFollowers > 0 && result.followersCount > maxFollowers)
      reasons.push('followers ' + result.followersCount + ' > max ' + maxFollowers);
    var allowed = maxAllowedFollowing(result.followersCount);
    if (result.followingCount > allowed)
      reasons.push('following ' + result.followingCount + ' > limit ' + allowed + ' (粉丝' + result.followersCount + ')');
    if (isTweetCountStale(stored.tweet_count, result.tweetCount, stored.last_checked_at))
      reasons.push('tweet count unchanged (' + result.tweetCount + ') for >' + inactiveHours + 'h');
    if (result.lastTweetAt) {
      const hoursSince = Math.round((Date.now() - new Date(result.lastTweetAt).getTime()) / (1000 * 60 * 60) * 10) / 10;
      if (hoursSince > inactiveHours && !reasons.some(function(r) { return r.indexOf('tweet count') >= 0; }))
        reasons.push('last tweet ' + hoursSince + 'h ago > ' + inactiveHours + 'h');
    }
    return reasons;
  }

  async function run() {
    const handles = repo.getAllHandlesForActivityCheck(batchSize);
    if (handles.length === 0) {
      emit('done', { checked: 0, deleted: 0 });
      return { ok: true, checked: 0, deleted: 0, details: [] };
    }

    emit('start', { total: handles.length });
    var checked = 0;
    var deleted = 0;
    var details = [];

    var rawHandles = handles.map(function(h) { return h.handle; });

    await xClient.lookupUsers(rawHandles, function(progress) {
      var result = progress.result;
      var stored = handles[progress.index];
      checked++;

      if (!result.found) {
        if (result.reason === 'auth_failed' || result.reason === 'rate_limited' || result.reason.indexOf('retry_exhausted') === 0 || result.reason === 'error') {
          details.push({ handle: result.handle, action: 'skipped', reason: result.reason });
          emit('progress', { handle: result.handle, action: 'skipped', reason: result.reason, checked: checked, deleted: deleted, total: handles.length });
          return;
        }
        repo.deleteByHandle(result.handle);
        deleted++;
        var reason = 'unreachable: ' + result.reason;
        details.push({ handle: result.handle, action: 'deleted', reason: reason });
        emit('progress', { handle: result.handle, action: 'deleted', reason: reason, checked: checked, deleted: deleted, total: handles.length });
        return;
      }

      var reasons = buildDeleteReasons(result, stored);
      if (reasons.length > 0) {
        repo.deleteByHandle(result.handle);
        deleted++;
        details.push({ handle: result.handle, action: 'deleted', reason: reasons.join('; '), followersCount: result.followersCount, followingCount: result.followingCount, lastTweetAt: result.lastTweetAt, tweetCount: result.tweetCount });
        emit('progress', { handle: result.handle, action: 'deleted', reason: reasons.join('; '), followersCount: result.followersCount, followingCount: result.followingCount, lastTweetAt: result.lastTweetAt, checked: checked, deleted: deleted, total: handles.length });
      } else {
        repo.updateActivity(result.handle, result.tweetCount);
        details.push({ handle: result.handle, action: 'ok', followersCount: result.followersCount, followingCount: result.followingCount, lastTweetAt: result.lastTweetAt, tweetCount: result.tweetCount });
        emit('progress', { handle: result.handle, action: 'ok', followersCount: result.followersCount, followingCount: result.followingCount, lastTweetAt: result.lastTweetAt, checked: checked, deleted: deleted, total: handles.length });
      }
    });

    emit('done', { checked: checked, deleted: deleted });
    return { ok: true, checked: checked, deleted: deleted, details: details };
  }

  async function preview() {
    var handles = repo.getAllHandlesForActivityCheck(batchSize);
    if (handles.length === 0) {
      emit('done', { checked: 0, deleted: 0 });
      return { ok: true, total: 0, wouldDelete: 0, details: [] };
    }

    emit('start', { total: handles.length });
    var checked = 0;
    var wouldDelete = 0;
    var details = [];

    var rawHandles = handles.map(function(h) { return h.handle; });

    await xClient.lookupUsers(rawHandles, function(progress) {
      var result = progress.result;
      var stored = handles[progress.index];
      checked++;

      var reasons = [];
      var action = '';
      if (!result.found) {
        if (result.reason === 'auth_failed' || result.reason === 'rate_limited' || result.reason.indexOf('retry_exhausted') === 0 || result.reason === 'error') {
          reasons.push('skipped: ' + result.reason);
          action = 'skipped';
        } else {
          reasons.push('unreachable: ' + result.reason);
          action = 'would_delete';
          wouldDelete++;
        }
      } else {
        reasons = buildDeleteReasons(result, stored);
        action = reasons.length > 0 ? 'would_delete' : 'ok';
        if (reasons.length > 0) wouldDelete++;
      }

      details.push({
        handle: result.handle, wouldDelete: reasons.length > 0, reasons: reasons,
        followersCount: result.found ? result.followersCount : null,
        followingCount: result.found ? result.followingCount : null,
        lastTweetAt: result.found ? result.lastTweetAt : null,
        tweetCount: result.found ? result.tweetCount : null, storedTweetCount: stored.tweet_count,
      });

      emit('progress', {
        handle: result.handle, action: action,
        reason: reasons.join('; ') || null,
        followersCount: result.found ? result.followersCount : null,
        followingCount: result.found ? result.followingCount : null,
        lastTweetAt: result.found ? result.lastTweetAt : null,
        checked: checked, total: handles.length,
      });
    });

    emit('done', { checked: checked, deleted: wouldDelete });
    return { ok: true, total: handles.length, wouldDelete: wouldDelete, details: details };
  }

  return { run, preview };
}

module.exports = { createActivityChecker };

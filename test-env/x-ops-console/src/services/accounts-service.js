function createAccountsService(accountsRepo, rules) {
  const { normalizeHandle } = require('../utils/handle');
  return {
    ensureAccount(accountHandle, defaults = {}) {
      const raw = String(accountHandle || '').replace(/^@/, '').replace(/#guard$/i, '').trim();
      const handle = normalizeHandle(accountHandle);
      if (!handle) throw new Error('account handle required');

      let account = accountsRepo.findByHandle(handle);
      if (account) return account;

      try {
        accountsRepo.insert({
          x_handle: handle,
          display_name: defaults.display_name || raw || handle,
          status: 'active',
          daily_follow_limit: defaults.daily_follow_limit || rules.defaultDailyFollowLimit,
          daily_dm_limit: defaults.daily_dm_limit || rules.defaultDailyDmLimit,
        });
      } catch (e) {
        // 并发/唯一冲突：再读一次
        account = accountsRepo.findByHandle(handle);
        if (account) return account;
        throw e;
      }

      return accountsRepo.findByHandle(handle);
    },
  };
}

module.exports = { createAccountsService };


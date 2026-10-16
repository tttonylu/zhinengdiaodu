function accountDailyStatsRepo(db) {
  return {
    upsert(accountId, date, stats) {
      return db.prepare(`
        INSERT INTO account_daily_stats (
          account_id, stat_date,
          follow_count, follow_duration_sec,
          chat_rounds, chat_duration_sec,
          nurture_likes, nurture_comments, nurture_duration_sec,
          follow_back_count,
          updated_at
        ) VALUES (
          @account_id, @date,
          @follow_count, @follow_duration_sec,
          @chat_rounds, @chat_duration_sec,
          @nurture_likes, @nurture_comments, @nurture_duration_sec,
          @follow_back_count,
          datetime('now', '+8 hours')
        )
        ON CONFLICT(account_id, stat_date) DO UPDATE SET
          follow_count = follow_count + @follow_count,
          follow_duration_sec = follow_duration_sec + @follow_duration_sec,
          chat_rounds = chat_rounds + @chat_rounds,
          chat_duration_sec = chat_duration_sec + @chat_duration_sec,
          nurture_likes = nurture_likes + @nurture_likes,
          nurture_comments = nurture_comments + @nurture_comments,
          nurture_duration_sec = nurture_duration_sec + @nurture_duration_sec,
          follow_back_count = COALESCE(follow_back_count, 0) + @follow_back_count,
          updated_at = datetime('now', '+8 hours')
      `).run({
        account_id: accountId, date: date,
        follow_count: stats.follow_count || 0,
        follow_duration_sec: stats.follow_duration_sec || 0,
        chat_rounds: stats.chat_rounds || 0,
        chat_duration_sec: stats.chat_duration_sec || 0,
        nurture_likes: stats.nurture_likes || 0,
        nurture_comments: stats.nurture_comments || 0,
        nurture_duration_sec: stats.nurture_duration_sec || 0,
        follow_back_count: stats.follow_back_count || 0
      });
    },

    /**
     * 插件上报的是「当日累计绝对值」，必须覆盖写入，不能再用 upsert 累加，
     * 否则每次心跳会把数字乘上去。取 MAX 以防乱序旧包回退。
     */
    upsertAbsolute(accountId, date, stats) {
      return db.prepare(`
        INSERT INTO account_daily_stats (
          account_id, stat_date,
          follow_count, follow_duration_sec,
          chat_rounds, chat_duration_sec,
          nurture_likes, nurture_comments, nurture_duration_sec,
          follow_back_count,
          updated_at
        ) VALUES (
          @account_id, @date,
          @follow_count, @follow_duration_sec,
          @chat_rounds, @chat_duration_sec,
          @nurture_likes, @nurture_comments, @nurture_duration_sec,
          @follow_back_count,
          datetime('now', '+8 hours')
        )
        ON CONFLICT(account_id, stat_date) DO UPDATE SET
          follow_count = MAX(follow_count, @follow_count),
          follow_duration_sec = MAX(follow_duration_sec, @follow_duration_sec),
          chat_rounds = MAX(chat_rounds, @chat_rounds),
          chat_duration_sec = MAX(chat_duration_sec, @chat_duration_sec),
          nurture_likes = MAX(nurture_likes, @nurture_likes),
          nurture_comments = MAX(nurture_comments, @nurture_comments),
          nurture_duration_sec = MAX(nurture_duration_sec, @nurture_duration_sec),
          follow_back_count = MAX(COALESCE(follow_back_count, 0), @follow_back_count),
          updated_at = datetime('now', '+8 hours')
      `).run({
        account_id: accountId, date: date,
        follow_count: stats.follow_count || 0,
        follow_duration_sec: stats.follow_duration_sec || 0,
        chat_rounds: stats.chat_rounds || 0,
        chat_duration_sec: stats.chat_duration_sec || 0,
        nurture_likes: stats.nurture_likes || 0,
        nurture_comments: stats.nurture_comments || 0,
        nurture_duration_sec: stats.nurture_duration_sec || 0,
        follow_back_count: stats.follow_back_count || 0
      });
    },

    /** 增量累加（关注/回关单次上报） */
    bump(accountId, date, stats) {
      return this.upsert(accountId, date, stats || {});
    },

    getByAccount(accountId, limit) {
      return db.prepare(`
        SELECT * FROM account_daily_stats
        WHERE account_id = ?
        ORDER BY stat_date DESC
        LIMIT ?
      `).all(accountId, limit || 7);
    },

    getToday(accountId) {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
      return db.prepare(`
        SELECT * FROM account_daily_stats
        WHERE account_id = ? AND stat_date = ?
      `).get(accountId, today);
    },

    /** 今日各账号效率（次数 + 时长） */
    listTodayEfficiency() {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
      const rows = db
        .prepare(
          `
        SELECT
          a.id AS account_id,
          a.x_handle,
          COALESCE(s.follow_count, 0) AS follow_count,
          COALESCE(s.follow_duration_sec, 0) AS follow_duration_sec,
          COALESCE(s.chat_rounds, 0) AS chat_rounds,
          COALESCE(s.chat_duration_sec, 0) AS chat_duration_sec,
          COALESCE(s.nurture_likes, 0) AS nurture_likes,
          COALESCE(s.nurture_comments, 0) AS nurture_comments,
          COALESCE(s.nurture_duration_sec, 0) AS nurture_duration_sec,
          COALESCE(s.follow_back_count, 0) AS follow_back_count
        FROM accounts a
        LEFT JOIN account_daily_stats s
          ON s.account_id = a.id AND s.stat_date = ?
        WHERE a.x_handle IS NOT NULL AND TRIM(a.x_handle) != ''
        ORDER BY COALESCE(s.follow_count, 0) DESC, a.x_handle COLLATE NOCASE ASC
      `
        )
        .all(today);

      return rows.map((r) => {
        const followHours = (Number(r.follow_duration_sec) || 0) / 3600;
        const chatHours = (Number(r.chat_duration_sec) || 0) / 3600;
        const nurtureHours = (Number(r.nurture_duration_sec) || 0) / 3600;
        const activeHours = followHours + chatHours + nurtureHours;
        const follows = Number(r.follow_count) || 0;
        return {
          ...r,
          x_handle: String(r.x_handle || '')
            .replace(/^@/, '')
            .toLowerCase(),
          follow_hours: Math.round(followHours * 100) / 100,
          chat_hours: Math.round(chatHours * 100) / 100,
          nurture_hours: Math.round(nurtureHours * 100) / 100,
          active_hours: Math.round(activeHours * 100) / 100,
          follows_per_hour:
            followHours > 0.05 ? Math.round((follows / followHours) * 10) / 10 : null,
          chat_per_hour:
            chatHours > 0.05
              ? Math.round(((Number(r.chat_rounds) || 0) / chatHours) * 10) / 10
              : null,
        };
      });
    },
  };
}

module.exports = { accountDailyStatsRepo };

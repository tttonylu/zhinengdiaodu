/**
 * 回关率 / 事件漏斗 / 日趋势
 * 账号统计按 activity_logs.account_id（避免 leads 全局唯一串号）
 */

const { dateRangeLike } = require('../utils/shanghai-date');

const MIN_SAMPLE = 10;
const ATTR_HOURS = 72;

function shanghaiDateKey(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

function daysAgoKey(n) {
  const ms = Date.now() - n * 24 * 3600 * 1000;
  return shanghaiDateKey(new Date(ms));
}

function parseTs(s) {
  if (!s) return 0;
  const raw = String(s).trim();
  const m = raw.match(
    /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (m) {
    const t = Date.UTC(
      Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(m[4] || 0) - 8, Number(m[5] || 0), Number(m[6] || 0)
    );
    return Number.isNaN(t) ? 0 : t;
  }
  const t = new Date(raw).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function dayKeyFromTs(ms) {
  if (!ms) return '';
  return shanghaiDateKey(new Date(ms));
}

function normHandle(h) {
  return String(h || '').replace(/^@/, '').toLowerCase().trim();
}

/** 从 follow 的 detail_json 解析来源博主 */
function bloggerFromFollowDetail(detailJson) {
  let dj = {};
  try { dj = JSON.parse(detailJson || '{}'); } catch (e) { dj = {}; }
  const meta = dj.meta || {};
  let b = normHandle(meta.blogger_handle || meta.blogger || dj.blogger_handle || '');
  if (b) return b;
  const url = String(meta.sourceUrl || meta.source_url || dj.sourceUrl || '');
  const m = url.match(/\/([A-Za-z0-9_]{1,15})\/(?:followers|verified_followers|following)/i);
  if (m) return normHandle(m[1]);
  return '';
}

function createFollowBackAnalyticsRepo(db) {
  function countLogsToday(actionType) {
    const rng = dateRangeLike(1, 'created_at');
    const rows = db.prepare(`
      SELECT created_at, detail_json, source FROM activity_logs
      WHERE action_type = ? AND action_result = 'success'
        AND account_id IS NOT NULL AND account_id > 0
        AND ${rng.sql}
    `).all(actionType, ...rng.params);
    let n = 0;
    for (const row of rows) {
      if (actionType === 'follow_back') {
        let accepted = true;
        try {
          const dj = JSON.parse(row.detail_json || '{}');
          if (dj.follow_back_accepted === false) accepted = false;
        } catch (e) {}
        if (row.source === 'plugin' && accepted === false) continue;
      }
      n += 1;
    }
    return n;
  }

  return {
    minSample: MIN_SAMPLE,
    attrHours: ATTR_HOURS,

    /**
     * 驾驶舱事件漏斗（今日）：关注/回关用 logs；破冰/广告/盾牌用 dm_records；进线由调用方注入
     */
    eventFunnelToday(dmTotals = {}, scrmTodayDone = 0) {
      const follow = countLogsToday('follow');
      const followBack = countLogsToday('follow_back');
      const ice = Number(dmTotals.ice || 0);
      const adLink = Number(dmTotals.ad_link || 0);
      const ad = Number(dmTotals.ad || 0);
      const kick = Number(dmTotals.kick || 0);
      const inbound = Number(scrmTodayDone || 0);

      const steps = [
        { key: 'follow', label: '关注成功', color: '#58a6ff', count: follow, note: 'activity_logs' },
        { key: 'follow_back', label: '回关', color: '#3fb950', count: followBack, note: '须先关注' },
        { key: 'ice', label: '破冰', color: '#d29922', count: ice, note: 'dm_records' },
        { key: 'ad_link', label: '带链广告', color: '#f0883e', count: adLink, note: '含 line/http' },
        { key: 'inbound', label: 'SCRM进线', color: '#a371f7', count: inbound, note: '仅展示' },
      ];
      const maxCount = Math.max(1, ...steps.map((s) => s.count));
      return {
        mode: 'event',
        maxCount,
        ad_raw: ad,
        kick,
        steps: steps.map((s, i) => {
          let pct = maxCount > 0 ? (s.count / maxCount) * 100 : 0;
          if (pct < 5 && s.count > 0) pct = 5;
          const prev = i > 0 ? steps[i - 1].count : null;
          let conv_from_prev = null;
          let conv_label = '';
          if (i > 0 && prev != null) {
            if (prev > 0) {
              conv_from_prev = Math.round((s.count / prev) * 1000) / 10;
              // 跨数据源（日志/DM/SCRM）可能 >100%，展示 n/a 避免误导
              if (conv_from_prev > 100) {
                conv_label = 'n/a';
                conv_from_prev = null;
              } else {
                conv_label = `${conv_from_prev}%`;
              }
            } else {
              conv_label = prev === 0 && s.count === 0 ? '-' : 'n/a';
            }
          }
          return {
            ...s,
            pct,
            funnel_pct: maxCount > 0 ? Math.max(8, Math.round((s.count / maxCount) * 100)) : 8,
            conv_from_prev,
            conv_label,
          };
        }),
      };
    },

    /**
     * 每日漏斗（插件驱动，按自然日）：关注 → 回关 → 破冰 → 带链广告 → 进线
     * 来源：account_daily_stats（插件日上报，10-15 实测在写）+ scrm_inbound_daily.__summary__（破冰/带链/进线）
     * 口径：按 Asia/Shanghai 自然日聚合（事件日口径，非同期群）；末级「进线」仅展示，不作为主指标
     * 注意：dm_records 自 2026-10-05 停写，故不再用于破冰/带链口径
     */
    dailyFunnel({ days = 14 } = {}) {
      const nDays = Math.min(30, Math.max(1, Number(days) || 14));
      const sinceKey = daysAgoKey(nDays - 1);

      let ads = [];
      try {
        ads = db.prepare(`
          SELECT stat_date,
                 SUM(follow_count) AS follows,
                 SUM(follow_back_count) AS follow_backs,
                 SUM(chat_rounds) AS chat_rounds,
                 SUM(nurture_likes) AS likes,
                 SUM(nurture_comments) AS comments
          FROM account_daily_stats
          WHERE stat_date >= ?
          GROUP BY stat_date
        `).all(sinceKey);
      } catch (e) { ads = []; }

      let scrmRows = [];
      try {
        scrmRows = db.prepare(`
          SELECT stat_date, today_done AS inbound, ice, ad_link
          FROM scrm_inbound_daily
          WHERE agent_id = '__summary__' AND stat_date >= ?
        `).all(sinceKey);
      } catch (e) { scrmRows = []; }

      const adByDay = new Map(ads.map((r) => [String(r.stat_date), r]));
      const scrmByDay = new Map(scrmRows.map((r) => [String(r.stat_date), r]));

      const keys = [];
      for (let i = nDays - 1; i >= 0; i--) keys.push(daysAgoKey(i));

      const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

      const rows = keys.map((k) => {
        const a = adByDay.get(k) || {};
        const s = scrmByDay.get(k) || {};
        const follows = Number(a.follows) || 0;
        const followBacks = Number(a.follow_backs) || 0;
        const chatRounds = Number(a.chat_rounds) || 0;
        const ice = Number(s.ice) || 0;
        const adLink = Number(s.ad_link) || 0;
        const inbound = Number(s.inbound) || 0;
        return {
          date: k,
          follows,
          follow_backs: followBacks,
          chat_rounds: chatRounds,
          ice,
          ad_link: adLink,
          inbound,
          likes: Number(a.likes) || 0,
          comments: Number(a.comments) || 0,
          fb_pct: pct(followBacks, follows),
          // 破冰来自 SCRM 日表、关注来自插件日表，二者非同一集合：破冰数以「关注」为分母
          // （破冰数恒大于回关数，用回关作分母会得到 >100% 的无意义比率）
          ice_pct: pct(ice, follows),
          ad_pct: pct(adLink, ice),
          in_pct: pct(inbound, adLink),
        };
      });

      const maxCount = Math.max(1, ...rows.map((r) => Math.max(r.follows, r.ice, r.inbound)));
      const withBars = rows.map((r) => ({
        ...r,
        bar_follows: r.follows ? Math.max(2, Math.round((r.follows / maxCount) * 90)) : 0,
        bar_ice: r.ice ? Math.max(2, Math.round((r.ice / maxCount) * 90)) : 0,
        bar_in: r.inbound ? Math.max(2, Math.round((r.inbound / maxCount) * 90)) : 0,
      }));

      const sum = (f) => withBars.reduce((s, r) => s + f(r), 0);
      const totals = {
        follows: sum((r) => r.follows),
        follow_backs: sum((r) => r.follow_backs),
        chat_rounds: sum((r) => r.chat_rounds),
        ice: sum((r) => r.ice),
        ad_link: sum((r) => r.ad_link),
        inbound: sum((r) => r.inbound),
      };
      totals.fb_pct = pct(totals.follow_backs, totals.follows);
      totals.ice_pct = pct(totals.ice, totals.follows);
      totals.ad_pct = pct(totals.ad_link, totals.ice);
      totals.in_pct = pct(totals.inbound, totals.ad_link);

      return {
        days: nDays,
        since: sinceKey,
        max_count: maxCount,
        rows: withBars,
        totals,
        today: withBars[withBars.length - 1] || null,
      };
    },

    /** 近 days 日全网日趋势 */
    dailyTrend({ days = 14 } = {}) {
      const nDays = Math.min(30, Math.max(1, days));
      const sinceKey = daysAgoKey(nDays - 1);
      const sinceMs = parseTs(sinceKey + ' 00:00:00');
      const rng = dateRangeLike(nDays, 'created_at');

      const follows = db.prepare(`
        SELECT account_id, detail_json, created_at FROM activity_logs
        WHERE action_type = 'follow' AND action_result = 'success'
          AND account_id IS NOT NULL AND account_id > 0
          AND ${rng.sql}
      `).all(...rng.params);
      const backs = db.prepare(`
        SELECT account_id, detail_json, created_at, source FROM activity_logs
        WHERE action_type = 'follow_back' AND action_result = 'success'
          AND account_id IS NOT NULL AND account_id > 0
          AND ${rng.sql}
      `).all(...rng.params);

      const byDay = {};
      for (let i = 0; i < nDays; i++) {
        const k = daysAgoKey(nDays - 1 - i);
        byDay[k] = { date: k, follows: 0, follow_backs: 0 };
      }

      const followTimesByAcct = new Map();

      for (const row of follows) {
        const ts = parseTs(row.created_at);
        if (ts < sinceMs) continue;
        const dk = dayKeyFromTs(ts);
        if (!byDay[dk]) continue;
        byDay[dk].follows += 1;
        let target = '';
        try {
          target = String(JSON.parse(row.detail_json || '{}').target_handle || '')
            .replace(/^@/, '').toLowerCase();
        } catch (e) {}
        if (!followTimesByAcct.has(row.account_id)) followTimesByAcct.set(row.account_id, {});
        const ft = followTimesByAcct.get(row.account_id);
        if (target) {
          if (!ft[target]) ft[target] = [];
          ft[target].push(ts);
        }
      }

      for (const row of backs) {
        const ts = parseTs(row.created_at);
        if (ts < sinceMs) continue;
        const dk = dayKeyFromTs(ts);
        if (!byDay[dk]) continue;
        let accepted = true;
        let target = '';
        try {
          const dj = JSON.parse(row.detail_json || '{}');
          target = String(dj.target_handle || '').replace(/^@/, '').toLowerCase();
          if (dj.follow_back_accepted === false) accepted = false;
        } catch (e) {}
        if (row.source === 'plugin' && accepted === false) continue;

        let ok72 = false;
        const ft = followTimesByAcct.get(row.account_id) || {};
        if (target && ft[target] && ft[target].length) {
          const latestFollow = Math.max.apply(null, ft[target]);
          if (latestFollow && ts >= latestFollow && (ts - latestFollow) <= ATTR_HOURS * 3600 * 1000) {
            ok72 = true;
          }
        } else if (row.source === 'followers_cross') {
          ok72 = true;
        }
        if (ok72) byDay[dk].follow_backs += 1;
      }

      const seriesRaw = Object.keys(byDay).sort().map((k) => {
        const d = byDay[k];
        const rate = d.follows >= MIN_SAMPLE ? d.follow_backs / d.follows : null;
        return {
          date: k,
          follows: d.follows,
          follow_backs: d.follow_backs,
          rate,
          rate_pct: rate == null ? null : Math.round(rate * 1000) / 10,
        };
      });
      const maxF = Math.max(1, ...seriesRaw.map((s) => s.follows));
      const series = seriesRaw.map((s) => ({
        ...s,
        bar_follows: Math.max(s.follows ? 2 : 0, Math.round((s.follows / maxF) * 80)),
        bar_backs: Math.max(s.follow_backs ? 2 : 0, Math.round((s.follow_backs / maxF) * 80)),
      }));
      return { days: nDays, since: sinceKey, min_sample: MIN_SAMPLE, max_follows: maxF, series };
    },

    accountRates({ days = 7 } = {}) {
      const sinceKey = daysAgoKey(Math.max(1, days) - 1);
      const sinceMs = parseTs(sinceKey + ' 00:00:00');
      const rng = dateRangeLike(days, 'created_at');
      const follows = db.prepare(`
        SELECT account_id, detail_json, created_at
        FROM activity_logs
        WHERE action_type = 'follow' AND action_result = 'success'
          AND account_id IS NOT NULL AND account_id > 0
          AND ${rng.sql}
      `).all(...rng.params);

      const backs = db.prepare(`
        SELECT account_id, detail_json, created_at, source
        FROM activity_logs
        WHERE action_type = 'follow_back' AND action_result = 'success'
          AND account_id IS NOT NULL AND account_id > 0
          AND ${rng.sql}
      `).all(...rng.params);
      const byAcct = new Map();

      function bucket(aid) {
        if (!byAcct.has(aid)) {
          byAcct.set(aid, {
            account_id: aid,
            follows: 0,
            follow_backs: 0,
            follow_backs_72h: 0,
            followTimes: {},
          });
        }
        return byAcct.get(aid);
      }

      for (const row of follows) {
        const ts = parseTs(row.created_at);
        if (ts < sinceMs) continue;
        const b = bucket(row.account_id);
        b.follows += 1;
        let target = '';
        try {
          const dj = JSON.parse(row.detail_json || '{}');
          target = String(dj.target_handle || '').replace(/^@/, '').toLowerCase();
        } catch (e) {}
        if (target) {
          if (!b.followTimes[target]) b.followTimes[target] = [];
          b.followTimes[target].push(ts);
        }
      }

      for (const row of backs) {
        const ts = parseTs(row.created_at);
        if (ts < sinceMs) continue;
        let accepted = true;
        let target = '';
        try {
          const dj = JSON.parse(row.detail_json || '{}');
          target = String(dj.target_handle || '').replace(/^@/, '').toLowerCase();
          if (dj.follow_back_accepted === false) accepted = false;
        } catch (e) {}
        if (row.source === 'plugin' && accepted === false) continue;
        const b = bucket(row.account_id);
        b.follow_backs += 1;
        if (target && b.followTimes[target] && b.followTimes[target].length) {
          const latestFollow = Math.max.apply(null, b.followTimes[target]);
          if (latestFollow && ts >= latestFollow && (ts - latestFollow) <= ATTR_HOURS * 3600 * 1000) {
            b.follow_backs_72h += 1;
          }
        } else if (row.source === 'followers_cross') {
          b.follow_backs_72h += 1;
        }
      }

      // 私信量按 bot_handle（近 days 日）
      let dmRows = [];
      try {
        dmRows = db.prepare(`
          SELECT lower(replace(bot_handle, '@', '')) AS bot,
                 round_number, message_content, result, created_at
          FROM dm_records
          WHERE ${rng.sql}
        `).all(...rng.params);
      } catch (e) {
        dmRows = [];
      }
      const dmByBot = new Map();
      for (const r of dmRows) {
        const bot = String(r.bot || '').toLowerCase();
        if (!dmByBot.has(bot)) dmByBot.set(bot, { ice: 0, ad: 0, ad_link: 0, failed: 0 });
        const b = dmByBot.get(bot);
        const ok = String(r.result || '').toLowerCase() === 'success';
        if (!ok) { b.failed += 1; continue; }
        const rn = Number(r.round_number) || 0;
        if (rn === 1) b.ice += 1;
        if (rn === 2) {
          b.ad += 1;
          if (/line\.me|https?:\/\//i.test(String(r.message_content || ''))) b.ad_link += 1;
        }
      }

      const accounts = db.prepare(`
        SELECT id, x_handle, day_count, status, last_seen_at
        FROM accounts
        ORDER BY sort_order IS NULL, sort_order ASC, id ASC
      `).all();

      const rows = accounts.map((a) => {
        const b = byAcct.get(a.id) || { follows: 0, follow_backs: 0, follow_backs_72h: 0 };
        const rate = b.follows >= MIN_SAMPLE ? b.follow_backs_72h / b.follows : null;
        const handle = String(a.x_handle || '').replace(/^@/, '').toLowerCase();
        const dm = dmByBot.get(handle) || { ice: 0, ad: 0, ad_link: 0, failed: 0 };
        return {
          account_id: a.id,
          x_handle: a.x_handle,
          day_count: a.day_count || 1,
          status: a.status,
          follows: b.follows,
          follow_backs: b.follow_backs_72h,
          follow_backs_raw: b.follow_backs,
          rate,
          rate_pct: rate == null ? null : Math.round(rate * 1000) / 10,
          sample_ok: b.follows >= MIN_SAMPLE,
          ice: dm.ice,
          ad: dm.ad,
          ad_link: dm.ad_link,
          failed: dm.failed,
        };
      });

      rows.sort((x, y) => {
        const rx = x.rate == null ? -1 : x.rate;
        const ry = y.rate == null ? -1 : y.rate;
        if (ry !== rx) return ry - rx;
        return y.follows - x.follows;
      });

      const totF = rows.reduce((s, r) => s + r.follows, 0);
      const totB = rows.reduce((s, r) => s + r.follow_backs, 0);
      return {
        days,
        since: sinceKey,
        min_sample: MIN_SAMPLE,
        attr_hours: ATTR_HOURS,
        totals: {
          follows: totF,
          follow_backs: totB,
          rate: totF >= MIN_SAMPLE ? totB / totF : null,
          rate_pct: totF >= MIN_SAMPLE ? Math.round((totB / totF) * 1000) / 10 : null,
          ice: rows.reduce((s, r) => s + r.ice, 0),
          ad_link: rows.reduce((s, r) => s + r.ad_link, 0),
        },
        accounts: rows,
      };
    },

    /**
     * 博主维：关注来源 blogger → 回关(72h) / 破冰 / 带链广告
     * 依赖 follow.detail_json.meta.blogger_handle（或 sourceUrl 解析）
     */
    bloggerRates({ days = 7 } = {}) {
      const sinceKey = daysAgoKey(Math.max(1, days) - 1);
      const sinceMs = parseTs(sinceKey + ' 00:00:00');
      const rng = dateRangeLike(days, 'created_at');

      const follows = db.prepare(`
        SELECT account_id, detail_json, created_at FROM activity_logs
        WHERE action_type = 'follow' AND action_result = 'success'
          AND account_id IS NOT NULL AND account_id > 0
          AND ${rng.sql}
      `).all(...rng.params);
      const backs = db.prepare(`
        SELECT account_id, detail_json, created_at, source FROM activity_logs
        WHERE action_type = 'follow_back' AND action_result = 'success'
          AND account_id IS NOT NULL AND account_id > 0
          AND ${rng.sql}
      `).all(...rng.params);

      // account_id|target → { blogger, followTs }
      const targetMeta = new Map();
      const byBlogger = new Map();

      function bucket(blogger) {
        const key = blogger || '(unknown)';
        if (!byBlogger.has(key)) {
          byBlogger.set(key, {
            blogger: key,
            follows: 0,
            follow_backs: 0,
            ice: 0,
            ad: 0,
            ad_link: 0,
            accounts: new Set(),
          });
        }
        return byBlogger.get(key);
      }

      for (const row of follows) {
        const ts = parseTs(row.created_at);
        if (ts < sinceMs) continue;
        let target = '';
        try {
          target = normHandle(JSON.parse(row.detail_json || '{}').target_handle);
        } catch (e) {}
        const blogger = bloggerFromFollowDetail(row.detail_json) || '(unknown)';
        const b = bucket(blogger);
        b.follows += 1;
        b.accounts.add(row.account_id);
        if (target) {
          const tk = row.account_id + '|' + target;
          const prev = targetMeta.get(tk);
          if (!prev || ts >= prev.followTs) {
            targetMeta.set(tk, { blogger, followTs: ts });
          }
        }
      }

      for (const row of backs) {
        const ts = parseTs(row.created_at);
        if (ts < sinceMs) continue;
        let accepted = true;
        let target = '';
        try {
          const dj = JSON.parse(row.detail_json || '{}');
          target = normHandle(dj.target_handle);
          if (dj.follow_back_accepted === false) accepted = false;
        } catch (e) {}
        if (row.source === 'plugin' && accepted === false) continue;
        if (!target) continue;
        const meta = targetMeta.get(row.account_id + '|' + target);
        if (!meta) continue;
        if (ts < meta.followTs || (ts - meta.followTs) > ATTR_HOURS * 3600 * 1000) continue;
        bucket(meta.blogger).follow_backs += 1;
      }

      // DM：目标粉丝 → 最近一次关注的博主
      let dmRows = [];
      try {
        dmRows = db.prepare(`
          SELECT bot_handle, target_handle, round_number, message_content, result, created_at
          FROM dm_records WHERE ${rng.sql}
        `).all(...rng.params);
      } catch (e) { dmRows = []; }

      const acctByHandle = new Map();
      try {
        for (const a of db.prepare(`SELECT id, x_handle FROM accounts`).all()) {
          acctByHandle.set(normHandle(a.x_handle), a.id);
        }
      } catch (e) {}

      for (const r of dmRows) {
        const aid = acctByHandle.get(normHandle(r.bot_handle));
        if (!aid) continue;
        const target = normHandle(r.target_handle);
        const meta = targetMeta.get(aid + '|' + target);
        if (!meta) continue;
        const b = bucket(meta.blogger);
        const ok = String(r.result || '').toLowerCase() === 'success';
        if (!ok) continue;
        const rn = Number(r.round_number) || 0;
        if (rn === 1) b.ice += 1;
        if (rn === 2) {
          b.ad += 1;
          if (/line\.me|https?:\/\//i.test(String(r.message_content || ''))) b.ad_link += 1;
        }
      }

      const rows = [...byBlogger.values()].map((b) => {
        const rate = b.follows >= MIN_SAMPLE ? b.follow_backs / b.follows : null;
        return {
          blogger: b.blogger,
          follows: b.follows,
          follow_backs: b.follow_backs,
          rate,
          rate_pct: rate == null ? null : Math.round(rate * 1000) / 10,
          sample_ok: b.follows >= MIN_SAMPLE,
          ice: b.ice,
          ad: b.ad,
          ad_link: b.ad_link,
          account_count: b.accounts.size,
        };
      });

      rows.sort((x, y) => {
        const rx = x.rate == null ? -1 : x.rate;
        const ry = y.rate == null ? -1 : y.rate;
        if (ry !== rx) return ry - rx;
        return y.follows - x.follows;
      });

      return {
        days,
        since: sinceKey,
        min_sample: MIN_SAMPLE,
        attr_hours: ATTR_HOURS,
        bloggers: rows,
        unknown_follows: (byBlogger.get('(unknown)') || { follows: 0 }).follows,
      };
    },

    /** 私信插件指标：守箱命中率、ice→ad 中位耗时、年龄分流 */
    chatPluginMetrics({ days = 1 } = {}) {
      const nDays = Math.max(1, Math.min(30, days));
      const sinceKey = daysAgoKey(nDays - 1);
      const rng = dateRangeLike(nDays, 'created_at');
      const rows = db.prepare(`
        SELECT action_type, detail_json, created_at FROM activity_logs
        WHERE source = 'chat_plugin' AND ${rng.sql}
      `).all(...rng.params);
      let watchStart = 0;
      let inboxOpen = 0;
      let domMiss = 0;
      let rejectSent = 0;
      let defaultAd = 0;
      let parsedAge = 0;
      const latencies = [];
      const experiments = {};
      for (const row of rows) {
        const at = String(row.action_type || '').toLowerCase();
        let meta = {};
        try {
          const dj = JSON.parse(row.detail_json || '{}');
          meta = dj.meta || {};
        } catch (_) {}
        if (at === 'inbox_watch_start') watchStart += 1;
        if (at === 'inbox_open') inboxOpen += 1;
        if (at === 'inbox_dom_miss') domMiss += 1;
        if (at === 'ice_to_ad_latency_ms' && meta.latency_ms) {
          const ms = Number(meta.latency_ms);
          if (!Number.isNaN(ms) && ms > 0) latencies.push(ms);
        }
        if (at === 'parse_age_result') {
          if (meta.result === 'reject') rejectSent += 1;
          else if (meta.result === 'default_ad') defaultAd += 1;
          else if (meta.result === 'parsed') parsedAge += 1;
        }
        if (at === 'reject_sent') rejectSent += 1;
        if (meta.experiment_id) {
          const eid = String(meta.experiment_id);
          experiments[eid] = (experiments[eid] || 0) + 1;
        }
      }
      latencies.sort((a, b) => a - b);
      const medianMs = latencies.length
        ? latencies[Math.floor(latencies.length / 2)]
        : null;
      const ageTotal = parsedAge + defaultAd + rejectSent;
      return {
        days: nDays,
        since: sinceKey,
        inbox_watch_start: watchStart,
        inbox_open: inboxOpen,
        inbox_dom_miss: domMiss,
        inbox_hit_rate: watchStart > 0 ? Math.round((inboxOpen / watchStart) * 1000) / 10 : null,
        ice_to_ad_median_min: medianMs != null ? Math.round(medianMs / 60000) : null,
        ice_to_ad_samples: latencies.length,
        reject_sent: rejectSent,
        default_ad: defaultAd,
        parsed_age: parsedAge,
        reject_pct: ageTotal > 0 ? Math.round((rejectSent / ageTotal) * 1000) / 10 : null,
        default_ad_pct: ageTotal > 0 ? Math.round((defaultAd / ageTotal) * 1000) / 10 : null,
        experiments,
      };
    },
  };
}

module.exports = { createFollowBackAnalyticsRepo, MIN_SAMPLE, ATTR_HOURS, bloggerFromFollowDetail };

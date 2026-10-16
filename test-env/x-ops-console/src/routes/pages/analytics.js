const { createFollowBackAnalyticsRepo } = require('../../repositories/follow-back-analytics-repo');
const { createDmRecordsRepo } = require('../../repositories/dm-records-repo');
const { accountDailyStatsRepo } = require('../../repositories/account-daily-stats-repo');
const { createScrmStatusRepo } = require('../../repositories/scrm-status-repo');

async function analyticsPageRoutes(app) {
  const fbRepo = createFollowBackAnalyticsRepo(app.db);
  const dmRepo = createDmRecordsRepo(app.db);
  const dailyRepo = accountDailyStatsRepo(app.db);
  const cache = app.ttlCache;

  app.get('/analytics', async (request, reply) => {
    const days = Math.min(30, Math.max(1, parseInt(request.query.days, 10) || 7));
    const sort = String(request.query.sort || 'rate');
    const tab = String(request.query.tab || 'funnel');
    const cacheKey = `analytics:${days}:${sort}:${tab}`;
    const cached = cache.getCached(cacheKey);
    if (cached) {
      return reply.view('analytics.njk', cached);
    }

    const fb = fbRepo.accountRates({ days });
    const bloggers = fbRepo.bloggerRates({ days });
    const trend = fbRepo.dailyTrend({ days: 14 });

    // 每日漏斗（插件驱动）：关注 → 回关 → 破冰 → 带链广告 → 进线
    // 数据源为 account_daily_stats + scrm_inbound_daily.__summary__（dm_records 自 10-05 停写，不再作口径）
    let dailyFunnel = null;
    try {
      dailyFunnel = fbRepo.dailyFunnel({ days: Math.max(days, 14) });
    } catch (eDf) {
      dailyFunnel = null;
    }

    const sortKey = ['rate', 'follows', 'follow_backs', 'ice', 'ad_link', 'failed', 'account_count'].includes(sort)
      ? sort
      : 'rate';

    function sortRows(rows) {
      rows.sort((x, y) => {
        if (sortKey === 'rate') {
          const rx = x.rate == null ? -1 : x.rate;
          const ry = y.rate == null ? -1 : y.rate;
          if (ry !== rx) return ry - rx;
          return y.follows - x.follows;
        }
        return (Number(y[sortKey]) || 0) - (Number(x[sortKey]) || 0);
      });
    }
    sortRows(fb.accounts);
    sortRows(bloggers.bloggers);

    let dmTotals = { ice: 0, ad: 0, ad_link: 0, kick: 0, failed: 0 };
    try {
      const h = dmRepo.todayHourlyHealth();
      dmTotals = (h && h.totals) || dmTotals;
    } catch (e) {}

    let scrmTodayDone = 0;
    let inboundSeries = [];
    try {
      const scrmRepo = createScrmStatusRepo(app.db);
      try { scrmRepo.ensureTodayInboundRecorded(); } catch (eEns) {}
      const gate = scrmRepo.evaluateGate({});
      if (gate && Array.isArray(gate.agents)) {
        scrmTodayDone = gate.agents.reduce((s, a) => s + (Number(a.today_done) || 0), 0);
      }
      // 优先取当日 __summary__ 汇总行（listInboundDaily 按 agent_id 排序时 [0] 会落到单个客服行，导致进线数被低估）
      try {
        const rowsDaily = scrmRepo.listInboundDaily({ days: 1 }) || [];
        const summaryRow = rowsDaily.find((r) => String(r.agent_id) === '__summary__');
        const pick = summaryRow || rowsDaily[0];
        if (pick && Number(pick.today_done) > scrmTodayDone) {
          scrmTodayDone = Number(pick.today_done) || scrmTodayDone;
        }
      } catch (eT) {}
      inboundSeries = scrmRepo.listInboundDaily({ days: Math.max(days, 14) }) || [];
    } catch (e) {}
    // 兜底：日表当日 __summary__ 的进线数（与每日漏斗同源，保证两处口径一致）
    if (dailyFunnel && dailyFunnel.today && Number(dailyFunnel.today.inbound) > scrmTodayDone) {
      scrmTodayDone = Number(dailyFunnel.today.inbound) || scrmTodayDone;
    }
    // dm_records 自 2026-10-05 停写，破冰/带链回落到 SCRM 日表的当日值，避免页面显示为 0
    if (dailyFunnel && dailyFunnel.today) {
      if (!Number(dmTotals.ice) && Number(dailyFunnel.today.ice)) dmTotals.ice = Number(dailyFunnel.today.ice);
      if (!Number(dmTotals.ad_link) && Number(dailyFunnel.today.ad_link)) dmTotals.ad_link = Number(dailyFunnel.today.ad_link);
    }

    const funnel = fbRepo.eventFunnelToday(dmTotals, scrmTodayDone);
    let chatMetrics = {};
    try {
      chatMetrics = fbRepo.chatPluginMetrics({ days });
    } catch (eCm) {
      chatMetrics = {};
    }
    let efficiency = [];
    try {
      efficiency = dailyRepo.listTodayEfficiency();
    } catch (e) {
      efficiency = [];
    }

    // 低回关高放量博主（建议号池降权）
    let demoteHints = [];
    try {
      const list = (bloggers && bloggers.bloggers) || [];
      demoteHints = list
        .filter((b) => (Number(b.follows) || 0) >= 80 && (b.rate_pct == null || Number(b.rate_pct) < 1.5))
        .slice(0, 30)
        .map((b) => ({
          blogger: b.blogger,
          follows: b.follows,
          follow_backs: b.follow_backs,
          rate_pct: b.rate_pct,
        }));
    } catch (eD) {}

    const inboundView = inboundSeries.map((r) => {
      const done = Number(r.today_done) || 0;
      const ad = Number(r.ad_link) || 0;
      return {
        ...r,
        today_done: done,
        ice: Number(r.ice) || 0,
        ad_link: ad,
        conv_pct: ad > 0 ? Number(((done / ad) * 100).toFixed(1)) : null,
      };
    });

    const viewData = {
      title: '效率分析',
      days,
      sort: sortKey,
      tab: ['bloggers', 'efficiency', 'accounts', 'funnel'].includes(tab) ? tab : 'funnel',
      fb,
      bloggers,
      trend,
      dmTotals,
      funnel,
      dailyFunnel,
      efficiency,
      inboundSeries: inboundView,
      demoteHints,
      scrmTodayDone,
      chatMetrics,
    };
    cache.setCached(cacheKey, viewData, 30000);
    return reply.view('analytics.njk', viewData);
  });
}

module.exports = { analyticsPageRoutes };

function toBeijingStr(utcStr) {
  if (!utcStr) return '';
  try {
    return new Date(utcStr + '+08:00').toISOString().replace('T',' ').replace(/\.\d+Z$/,'').replace('Z','');
  } catch (_) { return utcStr; }
}

/** zh-CN / SQLite 时间戳 → ms（Asia/Shanghai） */
function parseSeenMs(s) {
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

const ONLINE_MS = 15 * 60 * 1000;

const { createLeadsRepo } = require('../../repositories/leads-repo');
const { createDmRecordsRepo } = require('../../repositories/dm-records-repo');
const { createScrmStatusRepo } = require('../../repositories/scrm-status-repo');
const { createFollowBackAnalyticsRepo } = require('../../repositories/follow-back-analytics-repo');
const { extractAgentIds, getPromoLinks } = require('../../services/scrm-links-sync');
const { maybeAlertDmCapacity } = require('../../services/dm-capacity-alert');

async function dashboardPageRoutes(app) {
  const leadsRepo = createLeadsRepo(app.db);
  const dmRepo = createDmRecordsRepo(app.db);
  const fbRepo = createFollowBackAnalyticsRepo(app.db);
  const cache = app.ttlCache;

  app.get('/dashboard', async (request, reply) => {
    const cacheKey = 'dashboard:default';
    const cached = cache.getCached(cacheKey);
    if (cached) {
      return reply.view('dashboard.njk', cached);
    }

    const stageCounts = leadsRepo.dashboardStageCounts();
    const todayActions = leadsRepo.todayActionCounts();
    const todayNew = leadsRepo.todayNewCount();
    const waitingReply = leadsRepo.waitingForReply(1);
    const recentLogs = leadsRepo.recentActivityLogs(20).map(l => ({ ...l, created_at: toBeijingStr(l.created_at) }));
    const activeScripts = leadsRepo.activeScriptCount();

    // 在线账号：runtime 或 accounts 最近心跳在 15 分钟内（status 不参与，仅真实心跳）
    let onlineAccounts = 0;
    let activeAccounts = 0;
    try {
      const seenRows = app.db.prepare(`
        SELECT a.status AS st, COALESCE(rs.last_seen_at, a.last_seen_at) AS seen
        FROM accounts a
        LEFT JOIN account_runtime_status rs ON LOWER(rs.x_handle) = LOWER(a.x_handle)
        WHERE a.x_handle IS NOT NULL AND TRIM(a.x_handle) != ''
      `).all();
      const now = Date.now();
      for (const r of seenRows) {
        if (String(r.st || '') === 'active') activeAccounts += 1;
        const ms = parseSeenMs(r.seen);
        if (ms > 0 && now - ms <= ONLINE_MS) onlineAccounts += 1;
      }
    } catch (eSeen) {}

    const dmHealth = dmRepo.todayHourlyHealth();
    let capacity = { alert: false };
    try { capacity = await maybeAlertDmCapacity(app, dmRepo, dmHealth); } catch (e) {}
    let scrmGate = { allow_chat: false, reason: 'SCRM未上报', online_count: 0, found_count: 0 };
    let scrmSyncedAt = '';
    let scrmAgentIds = [];
    let linkAgentIds = [];
    let scrmLinkMismatch = false;
    try {
      const scrmRepo = createScrmStatusRepo(app.db);
      linkAgentIds = extractAgentIds(getPromoLinks(app.db));
      const expectedAgentIds = linkAgentIds;
      try { scrmRepo.ensureTodayInboundRecorded(); } catch (eEns) {}
      scrmGate = scrmRepo.evaluateGate({ expectedAgentIds });
      const sync = scrmRepo.getLinkSync();
      scrmSyncedAt = (sync && sync.synced_at) || '';
      try { scrmAgentIds = sync && sync.agent_ids_json ? JSON.parse(sync.agent_ids_json) : []; } catch (_) {}
      if (!scrmAgentIds.length) scrmAgentIds = expectedAgentIds;
      const a = [...linkAgentIds].map(String).map((s) => s.toLowerCase()).sort();
      const b = [...scrmAgentIds].map(String).map((s) => s.toLowerCase()).sort();
      scrmLinkMismatch = a.length !== b.length || a.some((v, i) => v !== b[i]);
    } catch (eScrm) {}

    const adLinkToday = Number((dmHealth.totals && dmHealth.totals.ad_link) || 0);
    let scrmTodayDone = 0;
    if (scrmGate && Array.isArray(scrmGate.agents)) {
      scrmTodayDone = scrmGate.agents.reduce((s, a) => s + (Number(a.today_done) || 0), 0);
    }
    const funnelHint = {
      ad_link: adLinkToday,
      today_done: scrmTodayDone,
      rate_text: adLinkToday > 0
        ? ((scrmTodayDone / adLinkToday) * 100).toFixed(1) + '%'
        : (scrmTodayDone > 0 ? '有进线无广告记录' : '-'),
      warn_send_no_inbound: adLinkToday > 0 && scrmTodayDone === 0,
      warn_no_ads: adLinkToday === 0,
      active_agent: (linkAgentIds && linkAgentIds[0]) || (scrmAgentIds && scrmAgentIds[0]) || '',
      link_mismatch: scrmLinkMismatch,
    };

    // 事件漏斗（真口径）：关注/回关=logs，破冰/带链广告=dm，进线=SCRM
    const eventFunnel = fbRepo.eventFunnelToday(dmHealth.totals || {}, scrmTodayDone);
    const funnel = eventFunnel.steps;
    const maxCount = eventFunnel.maxCount;

    const countMap = {};
    stageCounts.forEach(r => { countMap[r.current_stage] = r.total; });
    const rejectedCount = (countMap['rejected'] || 0) + (countMap['foreigner_rejected'] || 0);
    const skippedCount = countMap['skipped'] || 0;

    // 中文操作名映射
    const actionLabels = {
      follow: '关注', follow_back: '回关', ice_sent: '破冰',
      ad_sent: '广告', kick_sent: '盾牌', reject_sent: '婉拒',
      foreigner_reject_sent: '婉拒', skip: '跳过', dm: '私信'
    };
    const actionColors = {
      follow: '#58a6ff', follow_back: '#3fb950', ice_sent: '#d29922',
      ad_sent: '#f0883e', kick_sent: '#a371f7', reject_sent: '#f85149',
      foreigner_reject_sent: '#f85149', skip: '#8b949e', dm: '#58a6ff'
    };

    const viewData = {
      title: '运营驾驶舱',
      funnel,
      maxCount,
      rejectedCount,
      skippedCount,
      todayActions,
      todayNew,
      waitingReply,
      recentLogs,
      activeAccounts,
      onlineAccounts,
      activeScripts,
      actionLabels,
      actionColors,
      dmHealthHours: (dmHealth.hours || []).slice(-8),
      dmHealthTotals: dmHealth.totals || {},
      capacityAlert: !!capacity.alert,
      capacityPrev: (capacity.snapshot && capacity.snapshot.prevHour) || null,
      scrmGate,
      scrmSyncedAt,
      scrmAgentIds,
      funnelHint,
    };
    cache.setCached(cacheKey, viewData, 30000);
    return reply.view('dashboard.njk', viewData);
  });
}

module.exports = { dashboardPageRoutes };

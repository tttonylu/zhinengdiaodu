const { todayCreatedAtLikeParams, TODAY_CREATED_AT_SQL } = require('../utils/shanghai-date');

/** 婉拒完结标记（round3 合成审计行） */
const REJECT_DONE_MARKERS = ['[job_intent_reject_done]', '[age_reject_done]'];
/** 合成标记行（非真实发送）：[peer_first_placeholder] / [peer_blocked] / [*_reject_done] 等 */
const SYNTHETIC_CONTENT_RE = /^\[[a-z0-9_]+\]$/i;

function createDmRecordsRepo(db) {
  return {
    insert(botHandle, targetHandle, roundNumber, messageContent, result, createdAt) {
      const stmt = db.prepare(`
        INSERT INTO dm_records (bot_handle, target_handle, round_number, message_content, result, created_at)
        VALUES (@bot, @target, @round, @msg, @result, @ts)
      `);
      return stmt.run({
        bot: botHandle,
        target: targetHandle,
        round: roundNumber,
        msg: messageContent || '',
        result: result || 'success',
        ts: createdAt || new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
      });
    },

    /** 按 bot + target 查所有轮次 */
    findByBotAndTarget(botHandle, targetHandle) {
      return db.prepare(`
        SELECT * FROM dm_records
        WHERE LOWER(bot_handle) = LOWER(@bot) AND LOWER(REPLACE(target_handle, '@', '')) = LOWER(@target)
        ORDER BY round_number ASC
      `).all({ bot: botHandle, target: String(targetHandle || '').replace(/^@/, '').toLowerCase() });
    },

    /** 某 bot+target 历史最大成功轮次（失败记录不占序列） */
    maxRoundByBotAndTarget(botHandle, targetHandle) {
      const clean = String(targetHandle || '').replace(/^@/, '').toLowerCase();
      const row = db.prepare(`
        SELECT MAX(round_number) AS max_r FROM dm_records
        WHERE LOWER(bot_handle) = LOWER(@bot)
          AND LOWER(REPLACE(target_handle, '@', '')) = @target
          AND LOWER(COALESCE(result, 'success')) = 'success'
      `).get({ bot: botHandle, target: clean });
      return row && row.max_r != null ? Number(row.max_r) : 0;
    },

    /** 某 bot 下各 target 的历史最大成功轮次 map */
    maxRoundsByBot(botHandle) {
      const rows = db.prepare(`
        SELECT LOWER(REPLACE(target_handle, '@', '')) AS t, MAX(round_number) AS max_r
        FROM dm_records
        WHERE LOWER(bot_handle) = LOWER(?)
          AND LOWER(COALESCE(result, 'success')) = 'success'
        GROUP BY LOWER(REPLACE(target_handle, '@', ''))
      `).all(botHandle);
      const map = {};
      rows.forEach((r) => {
        if (r.t) map[r.t] = Number(r.max_r) || 0;
      });
      return map;
    },

    /**
     * 今日按小时健康统计（可控产能）。
     * ad = round2 成功且非婉拒；ad_link = ad 中内容含 http/line.me
     * reject = round2 成功且该 bot+target 存在婉拒完结标记（[job_intent_reject_done]/[age_reject_done]）
     * 合成标记行（[peer_first_placeholder]/[peer_blocked]/[*_reject_done]）非真实发送，不计入任何桶
     * 进线转化波动大，不在此硬判。
     */
    todayHourlyHealth() {
      const p = todayCreatedAtLikeParams();
      const rows = db.prepare(`
        SELECT created_at, round_number, result, message_content, bot_handle, target_handle
        FROM dm_records
        WHERE ${TODAY_CREATED_AT_SQL}
      `).all(p);

      const rejectPairs = new Set(
        db.prepare(`
          SELECT LOWER(bot_handle) AS b, LOWER(REPLACE(target_handle, '@', '')) AS t
          FROM dm_records
          WHERE round_number = 3 AND message_content IN ('${REJECT_DONE_MARKERS.join("','")}')
        `).all().map((r) => r.b + '|' + r.t)
      );

      const hours = {};
      for (let h = 0; h < 24; h++) {
        const key = String(h).padStart(2, '0');
        hours[key] = { hour: key, ice: 0, ad: 0, ad_link: 0, reject: 0, kick: 0, failed: 0, success: 0, total: 0 };
      }

      for (const r of rows) {
        const m = String(r.created_at || '').match(/\b(\d{1,2}):/);
        if (!m) continue;
        const key = String(parseInt(m[1], 10)).padStart(2, '0');
        if (!hours[key]) continue;
        const content = String(r.message_content || '').trim();
        if (SYNTHETIC_CONTENT_RE.test(content)) continue; // 合成标记行不算真实发送
        const bucket = hours[key];
        bucket.total += 1;
        const res = String(r.result || 'success').toLowerCase();
        if (res !== 'success') {
          bucket.failed += 1;
          continue;
        }
        bucket.success += 1;
        const rnd = Number(r.round_number) || 0;
        if (rnd === 1) bucket.ice += 1;
        else if (rnd === 2) {
          const pairKey = String(r.bot_handle || '').toLowerCase() + '|' + String(r.target_handle || '').replace(/^@/, '').toLowerCase();
          if (rejectPairs.has(pairKey)) bucket.reject += 1;
          else {
            bucket.ad += 1;
            if (/line\.me|https?:\/\//i.test(content)) bucket.ad_link += 1;
          }
        } else if (rnd === 3) bucket.kick += 1;
      }

      const list = Object.keys(hours).sort().map((k) => hours[k]).filter((b) => b.total > 0);
      const totals = list.reduce((acc, b) => {
        acc.ice += b.ice; acc.ad += b.ad; acc.ad_link += b.ad_link;
        acc.reject += b.reject; acc.kick += b.kick; acc.failed += b.failed; acc.success += b.success; acc.total += b.total;
        return acc;
      }, { ice: 0, ad: 0, ad_link: 0, reject: 0, kick: 0, failed: 0, success: 0, total: 0 });

      return { hours: list, totals };
    },

    /**
     * 今日目标进度：按 bot+target 去重取当日最大成功轮次。
     * 完结 = 最大成功轮次 ≥3（含婉拒/拉黑完结标记，与 OPS 完结口径一致）。
     */
    todayTargetProgress() {
      const p = todayCreatedAtLikeParams();
      const rows = db.prepare(`
        SELECT id, bot_handle, target_handle, round_number, result, created_at
        FROM dm_records
        WHERE ${TODAY_CREATED_AT_SQL}
        ORDER BY id ASC
      `).all(p);

      const pairs = new Map();
      for (const r of rows) {
        const b = String(r.bot_handle || '').toLowerCase();
        const t = String(r.target_handle || '').replace(/^@/, '').toLowerCase();
        if (!b || !t) continue;
        const key = b + '|' + t;
        let e = pairs.get(key);
        if (!e) {
          e = { bot: b, target: t, maxRound: 0, fails: 0, lastId: 0, lastTs: '' };
          pairs.set(key, e);
        }
        if (Number(r.id) > e.lastId) { e.lastId = Number(r.id); e.lastTs = String(r.created_at || ''); }
        const res = String(r.result || 'success').toLowerCase();
        if (res !== 'success') { e.fails += 1; continue; }
        const rnd = Number(r.round_number) || 0;
        if (rnd > e.maxRound) e.maxRound = rnd;
      }

      const summary = { total: 0, done: 0, adOnly: 0, iceOnly: 0, failedOnly: 0 };
      const stalled = [];
      for (const e of pairs.values()) {
        summary.total += 1;
        if (e.maxRound >= 3) { summary.done += 1; continue; }
        if (e.maxRound === 2) { summary.adOnly += 1; e.stage = '停在第2轮（广告/婉拒后未完结）'; }
        else if (e.maxRound === 1) { summary.iceOnly += 1; e.stage = '仅破冰未推进'; }
        else { summary.failedOnly += 1; e.stage = '发送失败/未确认'; }
        stalled.push(e);
      }
      stalled.sort((a, b) => b.lastId - a.lastId);
      return { summary, stalled: stalled.slice(0, 50), stalledTotal: stalled.length };
    },

    /** 查某 bot 今天的数据 */
    findTodayByBot(botHandle) {
      const p = todayCreatedAtLikeParams();
      return db.prepare(`
        SELECT * FROM dm_records
        WHERE LOWER(bot_handle) = LOWER(@bot) AND ${TODAY_CREATED_AT_SQL}
        ORDER BY created_at DESC
      `).all({ bot: botHandle, ...p });
    },

    /** 某 bot 今天的轮次统计 */
    todayStatsByBot(botHandle) {
      const p = todayCreatedAtLikeParams();
      const rows = db.prepare(`
        SELECT round_number, COUNT(*) AS cnt
        FROM dm_records
        WHERE LOWER(bot_handle) = LOWER(@bot) AND ${TODAY_CREATED_AT_SQL}
          AND LOWER(COALESCE(result, 'success')) = 'success'
        GROUP BY round_number
      `).all({ bot: botHandle, ...p });

      const stats = { icebreaker_sent: 0, ad_sent: 0, kick_sent: 0, completed: 0 };
      rows.forEach((r) => {
        if (r.round_number === 1) stats.icebreaker_sent = r.cnt;
        if (r.round_number === 2) stats.ad_sent = r.cnt;
        if (r.round_number === 3) stats.kick_sent = r.cnt;
      });

      const completed = db.prepare(`
        SELECT COUNT(*) AS c FROM (
          SELECT target_handle, MAX(round_number) AS max_r
          FROM dm_records
          WHERE LOWER(bot_handle) = LOWER(@bot) AND ${TODAY_CREATED_AT_SQL}
            AND LOWER(COALESCE(result, 'success')) = 'success'
          GROUP BY target_handle
          HAVING max_r >= 3
        )
      `).get({ bot: botHandle, ...p });
      stats.completed = completed ? completed.c : 0;

      return stats;
    },

    /** 某 bot 今天已完成的 target_handle 列表 */
    todayCompletedTargets(botHandle) {
      const p = todayCreatedAtLikeParams();
      return db.prepare(`
        SELECT target_handle FROM (
          SELECT target_handle, MAX(round_number) AS max_r
          FROM dm_records
          WHERE LOWER(bot_handle) = LOWER(@bot) AND ${TODAY_CREATED_AT_SQL}
          GROUP BY target_handle
          HAVING max_r >= 3
        )
      `).all({ bot: botHandle, ...p }).map((r) => String(r.target_handle || '').replace(/^@/, '').toLowerCase());
    },

    // 分页查所有 DM 记录（UI 页面用）
    listAll(botHandle, offset, limit) {
      // 按 id（插入序）排序：created_at 是混合格式字符串（2026/10/6 与 2026/10/13 并存），字符串排序跨日会错序
      // is_reject：round2 且同 bot+target 存在婉拒完结标记 → 该 round2 是婉拒话术而非广告
      var sql = `
        SELECT d.*, CASE WHEN d.round_number = 2 AND EXISTS (
          SELECT 1 FROM dm_records x
          WHERE x.round_number = 3 AND x.message_content IN ('${REJECT_DONE_MARKERS.join("','")}')
            AND LOWER(x.bot_handle) = LOWER(d.bot_handle)
            AND LOWER(REPLACE(x.target_handle, '@', '')) = LOWER(REPLACE(d.target_handle, '@', ''))
        ) THEN 1 ELSE 0 END AS is_reject
        FROM dm_records d
        ORDER BY d.id DESC LIMIT @limit OFFSET @offset
      `;
      var params = {};
      params.limit = limit || 50;
      params.offset = offset || 0;
      var rows = db.prepare(sql).all(params);
      rows.forEach(function (r) {
        var c = String(r.message_content || '').trim();
        if (SYNTHETIC_CONTENT_RE.test(c)) r.display_round = 'marker';
        else if (r.round_number === 2 && r.is_reject) r.display_round = 'reject';
        else r.display_round = '';
      });
      return rows;
    },

    // 总数
    countAll(botHandle) {
      return db.prepare('SELECT COUNT(*) AS c FROM dm_records').get();
    },
  };
}

module.exports = { createDmRecordsRepo };

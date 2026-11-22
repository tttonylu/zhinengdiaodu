// =============================================================================
// TEST COPY ONLY · 拉新阶段判定（纯函数，无 DOM）
// 私信拆成两个阶段：roster（回本号主页读粉丝数 → 涨粉才扫列表破冰）
//                 watch （只处理已破冰会话的回复/广告/催加）
// 这里只回答一个问题：这一次回到主页，应该做什么。
// =============================================================================
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.SgRosterCheck) return;

  var RESULTS = {
    FIRST_SCAN: 'first_scan',
    NO_GROWTH: 'no_growth',
    GROWTH: 'growth',
    COUNT_DOWN: 'count_down',
    DRAIN_ICE: 'drain_ice',
    RESCAN_GAP: 'rescan_gap',
    NOT_DUE: 'not_due',
    COUNT_UNREADABLE: 'count_unreadable'
  };

  var REASON_ZH = {
    first_scan: '本号还没有粉丝台账基线，做一次全量登记',
    no_growth: '粉丝数没有增加，不滚列表，直接回守箱',
    growth: '粉丝数增加了，进粉丝列表登记新粉并破冰',
    count_down: '粉丝数减少，只下调基线，不动已有台账',
    drain_ice: '上一轮还有没做完的破冰，先把队列清完',
    rescan_gap: '上次粉丝列表没有读全，先补扫到与主页人数一致',
    not_due: '还没到下次查数时间',
    count_unreadable: '本号主页读不到粉丝数，停在主页重试（不带着 0 继续）'
  };

  function num(v) {
    var n = Number(v);
    return isFinite(n) && n > 0 ? n : 0;
  }

  /**
   * @param {Object} input
   * @param {number} input.now
   * @param {number} input.count            本号主页刚读到的粉丝数（0=读不到）
   * @param {number} input.baselineCount    台账基线粉丝数（0=没有基线）
   * @param {boolean} input.firstScanDone   是否已有本号台账基线
   * @param {number} input.lastCheckAt      上次查数时间
   * @param {number} input.intervalMs       查数间隔
   * @param {boolean} input.hasPendingIceDebt 队列/台账还有没做完的破冰
   * @param {boolean} input.iceBlocked      当前破冰被额度/时段挡住（有债也做不了）
   * @param {boolean} input.hasLedgerIceBacklog 台账里有未破冰的人，但队列里没有在跑的
   * @returns {{result:string, reason_zh:string, due:boolean, delta:number, count:number,
   *            baselineCount:number, firstScanDone:boolean, scanList:boolean, updateBaseline:boolean,
   *            fresh:boolean}}
   */
  function decide(input) {
    input = input || {};
    var now = num(input.now) || Date.now();
    var count = parseInt(input.count, 10);
    if (!isFinite(count) || count < 0) count = 0;
    var baselineCount = parseInt(input.baselineCount, 10);
    if (!isFinite(baselineCount) || baselineCount < 0) baselineCount = 0;
    var firstScanDone = !!input.firstScanDone;
    var lastCheckAt = num(input.lastCheckAt);
    var intervalMs = num(input.intervalMs) || 30 * 60 * 1000;
    var hasPendingIceDebt = !!input.hasPendingIceDebt;
    var hasLedgerIceBacklog = !!input.hasLedgerIceBacklog;
    var iceBlocked = !!input.iceBlocked;
    var due = !lastCheckAt || (now - lastCheckAt) >= intervalMs;

    function out(result, extra) {
      var base = {
        result: result,
        reason_zh: REASON_ZH[result] || '',
        due: due,
        delta: count - baselineCount,
        count: count,
        baselineCount: baselineCount,
        firstScanDone: firstScanDone,
        scanList: false,
        updateBaseline: false,
        fresh: false
      };
      if (extra) {
        for (var k in extra) {
          if (Object.prototype.hasOwnProperty.call(extra, k)) base[k] = extra[k];
        }
      }
      return base;
    }

    // 读不到数字：不能带 0 继续扫描（会误判掉粉/空列表）
    if (!(count > 0)) return out(RESULTS.COUNT_UNREADABLE, { due: false });

    // 没有基线 → 必须全量建台账（不受 30 分钟间隔限制）
    if (!firstScanDone || baselineCount <= 0) {
      return out(RESULTS.FIRST_SCAN, { scanList: true, updateBaseline: true });
    }

    if (!due) return out(RESULTS.NOT_DUE);

    // 还欠破冰：先把队列清完再查数；额度/时段挡住时不做无意义的跳转
    if (hasPendingIceDebt && !iceBlocked) {
      return out(RESULTS.DRAIN_ICE, { scanList: true, fresh: false });
    }
    // 队列里没有在跑的，但台账还有没破冰的人 → 重新扫一次列表把他们捞回队列
    if (hasLedgerIceBacklog && !iceBlocked) {
      return out(RESULTS.DRAIN_ICE, { scanList: true, fresh: true });
    }

    // 4.9.132：上次只扫到部分粉丝（cells < 主页 F）时不能把主页人数当成基线，
    // 否则「28/60」也会被记成已读全，下一轮不涨粉就永远不再扫，新回关直接漏掉。
    // 未读全时强制补扫，直到 cells 与主页人数一致才推进基线。
    if (input.hasRosterGap && !iceBlocked) {
      return out(RESULTS.RESCAN_GAP, { scanList: true, fresh: true, updateBaseline: false });
    }

    if (count > baselineCount) return out(RESULTS.GROWTH, { scanList: true, updateBaseline: true });
    if (count < baselineCount) return out(RESULTS.COUNT_DOWN, { updateBaseline: true });
    return out(RESULTS.NO_GROWTH, { updateBaseline: true });
  }

  window.SgRosterCheck = {
    RESULTS: RESULTS,
    REASON_ZH: REASON_ZH,
    decide: decide
  };
})();

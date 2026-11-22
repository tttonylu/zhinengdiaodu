// TEST COPY ONLY · Inbox list scan helpers (pure, no DOM)
// 会话栏深度扫描的纯规则：滚动容器选择、行快照去重、单步停止条件。
// 由 content_chat 调用；独立成模块是为了能在 Node 里回归“真的下滑了没有”。
// =============================================================================
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.SgInboxListScan) return;

  /**
   * 从「从深到浅」的候选节点里挑滚动容器。
   * 优先原生 overflow:auto/scroll/overlay；没有就退回第一个可滚节点
   * （例如 document.scrollingElement，overflow 常是 visible 但仍可滚动）。
   * @param {Array} nodes [{scrollHeight, clientHeight, overflowY}]
   * @returns {number} 命中下标，-1 = 没有可滚容器
   */
  function pickScrollCandidate(nodes) {
    var list = Array.isArray(nodes) ? nodes : [];
    var fallback = -1;
    var fallbackDy = 0;
    for (var i = 0; i < list.length; i++) {
      var n = list[i] || {};
      var dy = (Number(n.scrollHeight) || 0) - (Number(n.clientHeight) || 0);
      if (dy <= 20) continue;
      var oy = String(n.overflowY || '').toLowerCase();
      var native = oy === 'auto' || oy === 'scroll' || oy === 'overlay';
      // 从离行最近的祖先开始，第一个“像列表”的原生滚动容器就是它；
      // 跳过只有几十像素的小盒子（侧栏、弹层），避免滚错。
      if (native && dy >= 80) return i;
      if (dy > fallbackDy) {
        fallback = i;
        fallbackDy = dy;
      }
    }
    return fallback;
  }

  /**
   * 行快照去重键。虚拟列表会复用 DOM 行，索引不能当键；
   * 取 id → href → 行文本，最后才退回索引。
   */
  function snapshotKey(snap, idx) {
    var s = snap || {};
    if (s.id) return 'id:' + s.id;
    if (s.href) return 'href:' + s.href;
    var norm = String(s.text || '').replace(/\s+/g, ' ').trim();
    if (norm) return 'text:' + norm.slice(0, 180);
    return 'idx:' + idx;
  }

  /**
   * 单步滚动后的结论。
   * @returns {{stop:boolean, reason:string}}
   */
  function stepOutcome(input) {
    var i = input || {};
    var before = Number(i.rowsBefore) || 0;
    var after = Number(i.rowsAfter) || 0;
    var grew = after > before;
    if (i.atBottom && !grew) return { stop: true, reason: 'bottom_reached' };
    if (!grew && !i.moved) {
      return {
        stop: true,
        reason: i.wheelFallback ? 'wheel_no_new_rows' : 'scroll_not_moved'
      };
    }
    if (i.atBottom) return { stop: true, reason: 'bottom_reached' };
    return { stop: false, reason: '' };
  }

  window.SgInboxListScan = {
    pickScrollCandidate: pickScrollCandidate,
    snapshotKey: snapshotKey,
    stepOutcome: stepOutcome
  };
})();

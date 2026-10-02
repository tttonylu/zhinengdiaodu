/**
 * DM 回复链路实机验收脚本
 * 在 x.com 控制台粘贴运行，或：await __sgVerifyReplyChain('handle')
 *
 * 覆盖 SOP 五类场景（A–E）的接线检查 + 当前目标状态归类。
 */
(function sgReplyChainVerify() {
  'use strict';

  function pickHandle(inputHandle) {
    if (inputHandle) return String(inputHandle).replace(/^@/, '');
    try {
      var ct = sessionStorage.getItem('current_target') || '';
      if (ct) return ct.replace(/^@/, '');
    } catch (e) {}
    try {
      var rs = JSON.parse(localStorage.getItem('dan_reply_state') || 'null');
      if (rs && rs.target) return String(rs.target).replace(/^@/, '');
    } catch (e2) {}
    return '';
  }

  function formatReport(report) {
    if (!report || report.error) return '验收失败: ' + ((report && report.error) || 'unknown');
    var lines = [];
    lines.push('=== DM 回复链路验收 ' + new Date(report.at || Date.now()).toLocaleString('zh-CN', { hour12: false }) + ' ===');
    lines.push('总体: ' + (report.pass ? 'PASS（接线/持久化）' : 'FAIL'));
    if (report.handle) lines.push('目标: @' + report.handle);
    if (report.sop) {
      lines.push('SOP 场景 ' + report.sop.scenario + ': ' + report.sop.label);
      if (report.sop.waitLeftMin != null) lines.push('  剩余等待: ' + report.sop.waitLeftMin + ' 分钟');
      lines.push('  建议: ' + (report.sop.fix || ''));
    }
    if (report.trace) {
      lines.push('快照诊断: ' + (report.trace.verdict || report.trace.error || ''));
    }
    if (report.inbox) {
      lines.push('收件箱: confidence=' + (report.inbox.confidence || '?')
        + ' replied=' + report.inbox.replied
        + ' unread=' + report.inbox.unread
        + (report.inbox.unreadSource ? (' source=' + report.inbox.unreadSource) : ''));
      if (report.inbox.preview) lines.push('  preview=' + String(report.inbox.preview).slice(0, 60));
      if (report.inbox.previewFromSelf) lines.push('  previewFromSelf=true（最后一跳可能是本方）');
    }
    if (report.routeA) {
      lines.push('路线A: pass=' + report.routeA.pass);
      var layers = report.routeA.layers || {};
      var layerKeys = Object.keys(layers);
      for (var li = 0; li < layerKeys.length; li++) {
        var lk = layerKeys[li];
        var ly = layers[lk] || {};
        lines.push('  ' + lk + ': checked=' + ly.checked + ' ok=' + ly.ok + ' ' + (ly.detail || ''));
      }
      if (report.routeA.next) lines.push('  下一步: ' + report.routeA.next);
    }
    lines.push('持久化: localMirror=' + !!(report.persistence && report.persistence.localMirror)
      + ' chatTargetDb=' + !!(report.persistence && report.persistence.chatTargetDb));
    if (report.persistence && report.handle) {
      lines.push('  replySeenAt=' + (report.persistence.replySeenAt || 0)
        + ' lastInboundAt=' + (report.persistence.lastInboundAt || 0));
    }
    var wiring = report.wiring || {};
    var wiringKeys = Object.keys(wiring);
    for (var i = 0; i < wiringKeys.length; i++) {
      var k = wiringKeys[i];
      lines.push('  wiring.' + k + '=' + (wiring[k] ? 'OK' : 'MISSING'));
    }
    return lines.join('\n');
  }

  async function run(inputHandle) {
    var handle = pickHandle(inputHandle);
    var report;
    if (typeof window.__sgVerifyReplyChain === 'function') {
      report = await window.__sgVerifyReplyChain(handle);
    } else if (window.__sgChatBridge && typeof window.__sgChatBridge.debugVerifyReplyChainSetup === 'function') {
      report = window.__sgChatBridge.debugVerifyReplyChainSetup(handle);
    } else if (typeof window.__sgChatCmd === 'function') {
      report = await window.__sgChatCmd('debugVerifyReplyChainSetup', [handle], 6000);
    } else {
      report = { error: '扩展未就绪：请重载「智能调度中心」并在 x.com 页面运行' };
    }
    if (handle && !report.error) {
      try {
        if (typeof window.__sgAcceptRouteA === 'function') {
          report.routeA = await window.__sgAcceptRouteA(handle);
        } else if (typeof window.__sgChatCmd === 'function') {
          report.routeA = await window.__sgChatCmd('debugAcceptRouteA', [handle], 8000);
        }
      } catch (eRA) {
        report.routeA = { error: String((eRA && eRA.message) || eRA) };
      }
    }
    var text = formatReport(report);
    console.log('%c' + text, report && report.pass ? 'color:#3fb950' : 'color:#f85149');
    console.log('[reply-chain-verify] 原始报告:', report);
    window.__sgReplyChainVerifyReport = report;
    return report;
  }

  window.__sgReplyChainVerify = run;
  console.log('%c[reply-chain-verify] 已加载。运行: await __sgReplyChainVerify() 或 await __sgReplyChainVerify("handle")', 'color:#8b949e');
  console.log('%c[reply-chain-verify] 路线A分层: await __sgAcceptRouteA("handle")', 'color:#8b949e');
  return run;
})();

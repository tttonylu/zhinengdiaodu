/**
 * 软风控 chat 被闸门挡时的相位决策（纯函数，可供 node:test）。
 * @param {{ softRiskActive: boolean, phase?: string, afterPhase?: string }} input
 * @returns {'nurture'|'follow'|null}
 */
function softRiskChatBlockedDecision(input) {
  input = input || {};
  if (!input.softRiskActive) return null;
  var phase = input.phase || 'chat1';
  if (phase === 'chat2') return 'follow';
  // chat1：调用方若已推进到 chat2（近窗尾 skip），同闸则清窗
  if ((input.afterPhase || '') === 'chat2') return 'follow';
  return 'nurture';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { softRiskChatBlockedDecision: softRiskChatBlockedDecision };
}
if (typeof window !== 'undefined') {
  window.SgSoftRiskFallbackDecision = { softRiskChatBlockedDecision: softRiskChatBlockedDecision };
}

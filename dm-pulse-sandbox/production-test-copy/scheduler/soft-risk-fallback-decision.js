/**
 * 软风控 chat 被闸门挡时的相位决策（纯函数，可供 node:test）。
 * 4.6.78：单段私信一轮 — chat 相位被挡 → 临时 nurture（挂起）；勿当清窗。
 * @param {{ softRiskActive: boolean, phase?: string, afterPhase?: string }} input
 * @returns {'nurture'|'follow'|null}
 */
function softRiskChatBlockedDecision(input) {
  input = input || {};
  if (!input.softRiskActive) return null;
  // 单段一轮：闸门挂起一律先 nurture；清窗由调用方按 reason 另判
  return 'nurture';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { softRiskChatBlockedDecision: softRiskChatBlockedDecision };
}
if (typeof window !== 'undefined') {
  window.SgSoftRiskFallbackDecision = { softRiskChatBlockedDecision: softRiskChatBlockedDecision };
}

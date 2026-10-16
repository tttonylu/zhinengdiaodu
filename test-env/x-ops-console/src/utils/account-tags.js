// =============================================================================
// 账号管理标签（方案A：标签 = 模块策略模板）
// 语义（宪法「真相源声明」正向应用）：标签由 OPS 唯一维护，插件只接收合并后的 modules。
// 合并优先级：全局开关 → 账号手动 override → 标签掩码（标签关闭 > 手动开启，安全侧）。
// 多标签冲突：任一标签关闭 = 关闭（取关闭并集）。
// =============================================================================

const ACCOUNT_TAG_PRESETS = [
  { id: 'post_only', label: '发帖号', desc: '专门发帖：不关注不私信（养号/转帖正常）', disabled: ['follow', 'chat'] },
  { id: 'mute_chat', label: '禁言号', desc: '不私信（关注/养号/转帖正常）', disabled: ['chat'] },
  { id: 'nurture_only', label: '养号专用', desc: '新号养护期：不关注不私信，只养号+转帖', disabled: ['follow', 'chat'] },
  { id: 'follow_no_dm', label: '只关注不私信', desc: '纯铺粉号：不私信不转帖', disabled: ['chat', 'repost'] },
];

function listTagPresets() {
  return ACCOUNT_TAG_PRESETS.slice();
}

function findPreset(id) {
  return ACCOUNT_TAG_PRESETS.find(function (p) { return p.id === id; }) || null;
}

/** 任意输入 → 合法标签 id 数组；未知 id 收集到 unknown */
function normalizeTags(input) {
  const arr = Array.isArray(input) ? input : [];
  const seen = {};
  const tags = [];
  const unknown = [];
  arr.forEach(function (v) {
    const id = String(v || '').trim();
    if (!id || seen[id]) return;
    seen[id] = 1;
    if (findPreset(id)) tags.push(id);
    else unknown.push(id);
  });
  return { ok: unknown.length === 0, tags: tags, unknown: unknown };
}

/** account 行 → 合法标签 id 数组（容错：坏 JSON/未知 id → 剔除） */
function parseAccountTags(account) {
  try {
    const raw = account && account.tags;
    const t = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []);
    return Array.isArray(t) ? t.filter(function (id) { return !!findPreset(id); }) : [];
  } catch (e) {
    return [];
  }
}

/** 该账号被标签关闭的模块并集（无标签 → []） */
function tagDisabledModules(account) {
  const set = {};
  parseAccountTags(account).forEach(function (id) {
    const p = findPreset(id);
    if (p) (p.disabled || []).forEach(function (m) { set[m] = 1; });
  });
  return Object.keys(set);
}

/** 标签 id → 展示名数组（列表页徽标用） */
function tagLabels(account) {
  return parseAccountTags(account).map(function (id) {
    const p = findPreset(id);
    return p ? p.label : id;
  });
}

module.exports = {
  ACCOUNT_TAG_PRESETS,
  listTagPresets,
  findPreset,
  normalizeTags,
  parseAccountTags,
  tagDisabledModules,
  tagLabels,
};

/**
 * 统一消息推送服务
 * 支持两种 provider：
 *   - pushplus : PushPlus 推送（https://www.pushplus.plus）
 *   - wxpusher : WxPusher 推送（https://wxpusher.zjiecode.com）
 *
 * 配置项（config_thresholds）：
 *   push_alerts_enabled     : '1'/'0'      总开关
 *   push_provider           : 'pushplus' | 'wxpusher'
 *   pushplus_token          : string       PushPlus 的 token
 *   wxpusher_app_token      : string       WxPusher 的 appToken
 *   wxpusher_uids           : string       WxPusher 的 uid，多个用逗号分隔
 */

// ============ PushPlus ============

async function sendPushPlus(token, title, content) {
  if (!token) return { ok: false, error: 'no_token' };
  const res = await fetch('https://www.pushplus.plus/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: String(token).trim(),
      title: String(title || '智能调度告警').slice(0, 100),
      content: String(content || ''),
      template: 'txt',
    }),
  });
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }
  const ok = !!(data && (data.code === 200 || data.code === '200'));
  return { ok, status: res.status, data };
}

function getPushPlusToken(db) {
  try {
    const row = db.prepare(
      "SELECT value FROM config_thresholds WHERE key = 'pushplus_token'"
    ).get();
    return row && row.value ? String(row.value).trim() : '';
  } catch (e) {
    return '';
  }
}

// ============ WxPusher ============

async function sendWxPusher(appToken, uids, title, content) {
  if (!appToken) return { ok: false, error: 'no_app_token' };
  if (!uids || !uids.length) return { ok: false, error: 'no_uids' };

  const body = {
    appToken: String(appToken).trim(),
    content: String(content || ''),
    summary: String(title || '智能调度告警').slice(0, 100),
    contentType: 1, // 1=text
    uids: uids,
  };

  const res = await fetch('https://wxpusher.zjiecode.com/api/send/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }
  // WxPusher 成功 code 为 1000，且 data 数组中每条都有 code=1000
  const ok = !!(data && data.code === 1000 && Array.isArray(data.data) && data.data.length > 0);
  return { ok, status: res.status, data };
}

function getWxPusherConfig(db) {
  try {
    const tokenRow = db.prepare(
      "SELECT value FROM config_thresholds WHERE key = 'wxpusher_app_token'"
    ).get();
    const uidsRow = db.prepare(
      "SELECT value FROM config_thresholds WHERE key = 'wxpusher_uids'"
    ).get();
    const appToken = tokenRow && tokenRow.value ? String(tokenRow.value).trim() : '';
    const uidsRaw = uidsRow && uidsRow.value ? String(uidsRow.value).trim() : '';
    const uids = uidsRaw
      ? uidsRaw.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
      : [];
    return { appToken, uids };
  } catch (e) {
    return { appToken: '', uids: [] };
  }
}

// ============ 通用接口 ============

function pushEnabled(db) {
  try {
    const enabled = db.prepare(
      "SELECT value FROM config_thresholds WHERE key = 'push_alerts_enabled'"
    ).get();
    if (enabled && (enabled.value === '0' || enabled.value === 'false')) {
      return false;
    }
    return true;
  } catch (e) {
    return true;
  }
}

function getPushProvider(db) {
  try {
    const row = db.prepare(
      "SELECT value FROM config_thresholds WHERE key = 'push_provider'"
    ).get();
    const v = row && row.value ? String(row.value).trim().toLowerCase() : 'pushplus';
    return v === 'wxpusher' ? 'wxpusher' : 'pushplus';
  } catch (e) {
    return 'pushplus';
  }
}

/**
 * 统一发送入口：根据配置的 provider 自动选择通道
 * @param {object} db  - sqlite 数据库句柄
 * @param {string} title
 * @param {string} content
 * @returns {Promise<{ok:boolean, provider:string, error?:string, data?:any}>}
 */
async function sendNotify(db, title, content) {
  if (!pushEnabled(db)) {
    return { ok: false, provider: 'none', error: 'push_disabled' };
  }
  const provider = getPushProvider(db);

  if (provider === 'wxpusher') {
    const cfg = getWxPusherConfig(db);
    const r = await sendWxPusher(cfg.appToken, cfg.uids, title, content);
    return { ...r, provider: 'wxpusher' };
  }

  // 默认 pushplus
  const token = getPushPlusToken(db);
  const r = await sendPushPlus(token, title, content);
  return { ...r, provider: 'pushplus' };
}

// 兼容旧调用：导出原函数供已有的 require 直接使用
module.exports = {
  // 新统一接口（推荐）
  sendNotify,
  pushEnabled,
  getPushProvider,

  // PushPlus（保留兼容）
  sendPushPlus,
  getPushPlusToken,

  // WxPusher
  sendWxPusher,
  getWxPusherConfig,
};

'use strict';

const { createContentPoolRepo } = require('../../repositories/content-pool-repo');
const { saveContentMedia, resolveMediaFile, mediaDirFromApp, MEDIA_CONTENT_TYPES } = require('../../services/content-media');
const fs = require('node:fs');
const path = require('node:path');

/** 服务端日本墙钟 'YYYY-MM-DDTHH:MM'（JST，无时区后缀，比较走字典序） */
function jstNowWall() {
  const d = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' });
  const t = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Tokyo', hour12: false }).slice(0, 5);
  return d + 'T' + t;
}

function hashtagCount(text) {
  const m = String(text || '').match(/#[^\s#@＠]+/g);
  return m ? m.length : 0;
}

function normHandle(handle) {
  return String(handle || '').replace(/^@/, '').toLowerCase().trim();
}

async function contentPoolApiRoutes(app) {
  const repo = createContentPoolRepo(app.db);
  const mediaDir = mediaDirFromApp(app.appConfig || {});

  // ---------- 生产侧：写入内容池（AI 定时任务/人工） ----------
  app.post('/api/content/ingest', async (request, reply) => {
    const b = request.body || {};
    const text = String(b.text || '').trim();
    const sched = String(b.scheduled_jst_at || '').trim();
    const personaKey = String(b.persona || '').trim();
    const handleIn = String(b.account_handle || '').trim();
    if ((!handleIn && !personaKey) || !text || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(sched)
        || text.length > 1000 || hashtagCount(text) > 3) {
      return reply.code(400).send({ statusCode: 400, error: 'bad_request',
        msg: 'account_handle 或 persona（二选一）/text/scheduled_jst_at(YYYY-MM-DDTHH:MM) 必填，正文≤1000字，标签≤3个' });
    }
    let mediaUrls = [];
    try {
      for (const m of (Array.isArray(b.media) ? b.media : []).slice(0, 4)) {
        if (m && m.data_url) mediaUrls.push(saveContentMedia(m.data_url, mediaDir));
      }
    } catch (e) {
      return reply.code(400).send({ statusCode: 400, error: 'bad_media', msg: String(e.message || e) });
    }
    // H11 线路：给了 persona → 直接用线路绑定的台账发帖号入库
    let handle = handleIn;
    if (personaKey) {
      const line = repo.getLine(personaKey);
      if (!line || !repo.isRegisteredPoster(line.account_handle)) {
        return reply.code(400).send({ statusCode: 400, error: 'line_unbound',
          message: '线路不存在或未绑定可用发帖号: ' + personaKey });
      }
      if (handleIn && normHandle(handleIn) !== normHandle(line.account_handle)) {
        return reply.code(400).send({ statusCode: 400, error: 'handle_mismatch',
          message: 'account_handle 与线路绑定的发帖号不一致: ' + handleIn + ' ≠ ' + line.account_handle });
      }
      handle = line.account_handle;
    }
    // H11：account_handle 必须是台账注册的可用发帖号（post_only 标签、未封禁）
    if (!repo.isRegisteredPoster(handle)) {
      return reply.code(400).send({ statusCode: 400, error: 'unbound_poster',
        message: '账号未注册为发帖号或已封禁: ' + (handle || handleIn) });
    }
    const id = repo.insert({
      accountHandle: handle, persona: b.persona, text,
      mediaUrls, scheduledJstAt: sched, source: b.source === 'ai_daily' ? 'ai_daily' : 'manual',
    });
    return { ok: true, id, media_urls: mediaUrls };
  });

  // ---------- H11 线路绑定：模板线路 ↔ 台账发帖号 ----------
  app.get('/api/content/lines', async () => repo.listLines());

  app.post('/api/content/lines/bind', async (request, reply) => {
    const b = request.body || {};
    const result = repo.setLineBinding(b.persona, b.account_handle);
    if (result.error) {
      return reply.code(400).send({ statusCode: 400, error: result.error,
        message: result.error === 'line_not_found'
          ? '线路不存在: ' + String(b.persona || '')
          : '账号未注册为发帖号或已封禁: ' + String(b.account_handle || '') });
    }
    // 审核页表单提交 → redirect 回列表；JSON 调用 → 返回新绑定状态
    const ct = String(request.headers['content-type'] || '');
    if (ct.includes('application/x-www-form-urlencoded')) {
      return reply.redirect('/content?msg=' + encodeURIComponent('线路已绑定 @' + result.account_handle));
    }
    return result;
  });

  // ---------- 审核动作（JSON API；页面表单端点 Task 5 另行实现，两者共用 repo，不互相 require） ----------
  app.post('/api/content/approve', async (request) => {
    const changed = repo.setStatus((request.body || {}).ids, 'approved');
    return { ok: true, changed };
  });
  app.post('/api/content/reject', async (request) => {
    const changed = repo.setStatus((request.body || {}).ids, 'rejected');
    return { ok: true, changed };
  });
  app.post('/api/content/delete', async (request) => {
    const changed = repo.remove((request.body || {}).ids);
    return { ok: true, changed };
  });
  app.post('/api/content/:id/retry', async (request) => {
    repo.report(Number(request.params.id), 'retry', { failReason: 'manual_retry' });
    repo.setStatus([Number(request.params.id)], 'approved');
    return { ok: true };
  });
  app.post('/api/content/:id/edit', async (request, reply) => {
    const b = request.body || {};
    if (hashtagCount(b.text) > 3) {
      return reply.code(400).send({ statusCode: 400, error: 'too_many_hashtags' });
    }
    try {
      repo.edit(Number(request.params.id), { text: b.text, scheduledJstAt: b.scheduled_jst_at });
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ statusCode: 400, error: 'bad_input', msg: String(e.message || e) });
    }
  });

  // ---------- 插件侧：原子领单（bot_id 即 account_handle，不带 @，大小写不敏感） ----------
  app.get('/api/plugin/content-pool/claim', async (request, reply) => {
    const botId = request.query.bot_id || request.query.worker_id || '';
    const handle = String(botId).replace(/^@/, '').trim();
    if (!handle) return { ok: false, msg: 'bot_id required' };
    // H11：领单白名单——bot_id 必须是台账注册的发帖号（插件侧已兜错，60 秒后重试）
    if (!repo.isRegisteredPoster(handle)) {
      return reply.code(403).send({ ok: false, error: 'unbound_poster' });
    }
    const nowJst = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(request.query.now || ''))
      ? request.query.now : jstNowWall();
    const item = repo.claimDue(handle, nowJst);
    if (!item) return { ok: true, item: null, now_jst: nowJst };
    return { ok: true, now_jst: nowJst, item: {
      id: item.id, text: item.text, media_urls: item.media_urls,
      scheduled_jst_at: item.scheduled_jst_at, persona: item.persona,
    } };
  });

  // ---------- 插件侧：回报（posted 带 external_post_id / retry / failed） ----------
  app.post('/api/plugin/content-pool/report', async (request, reply) => {
    const b = request.body || {};
    const id = Number(b.id);
    if (!id || !['posted', 'retry', 'failed'].includes(String(b.result))) {
      return reply.code(400).send({ statusCode: 400, error: 'bad_request', msg: 'id + result(posted|retry|failed) required' });
    }
    try {
      repo.report(id, String(b.result), { externalPostId: b.external_post_id, failReason: b.fail_reason });
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ statusCode: 400, error: 'report_failed', msg: String(e.message || e) });
    }
  });

  // ---------- 配图回源（CORS 已全局开；文件名严格白名单，防目录穿越） ----------
  app.get('/content-media/:file', async (request, reply) => {
    const full = resolveMediaFile(mediaDir, request.params.file);
    if (!full) return reply.code(404).send({ statusCode: 404, error: 'not_found' });
    if (!fs.existsSync(full)) return reply.code(404).send({ statusCode: 404, error: 'not_found' });
    const ext = path.extname(full).toLowerCase();
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    reply.header('Content-Type', MEDIA_CONTENT_TYPES[ext] || 'application/octet-stream');
    return reply.send(fs.createReadStream(full));
  });
}

module.exports = { contentPoolApiRoutes, jstNowWall };

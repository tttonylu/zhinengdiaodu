'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MEDIA_CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
const MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

/**
 * 把 dataURL 图片落到 mediaDir，返回相对 URL '/content-media/<uuid><ext>'。
 * 只允许 jpeg/png/webp；拒绝其它 mime；最大 8MB。
 */
function saveContentMedia(dataUrl, mediaDir) {
  const m = /^data:(image\/jpeg|image\/png|image\/webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m) {
    if (/^data:/.test(String(dataUrl || ''))) throw new Error('unsupported media type');
    throw new Error('bad dataUrl');
  }
  const ext = MIME_TO_EXT[m[1]];
  const buf = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  if (buf.length < 100) throw new Error('media too small');
  if (buf.length > 8 * 1024 * 1024) throw new Error('media too large');
  fs.mkdirSync(mediaDir, { recursive: true });
  const name = crypto.randomUUID() + ext;
  fs.writeFileSync(path.join(mediaDir, name), buf);
  return '/content-media/' + name;
}

/** 文件名白名单校验 + 绝对路径拼接（防目录穿越） */
function resolveMediaFile(mediaDir, file) {
  if (!/^[a-f0-9-]{36}\.(jpe?g|png|webp)$/i.test(String(file || ''))) return null;
  const full = path.join(mediaDir, file);
  if (path.dirname(full) !== path.resolve(mediaDir)) return null;
  return full;
}

function mediaDirFromApp(appOrConfig) {
  const base = (appOrConfig && appOrConfig.contentMediaDir) ||
    path.join(__dirname, '..', '..', 'data', 'content-media');
  return path.resolve(base);
}

module.exports = { saveContentMedia, resolveMediaFile, mediaDirFromApp, MEDIA_CONTENT_TYPES };

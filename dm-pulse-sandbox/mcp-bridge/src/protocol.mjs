import { createHash, timingSafeEqual } from 'node:crypto';

export const MAX_FRAME_BYTES = 64 * 1024;

const DENY_KEYS = new Set([
  'token',
  'tokens',
  'auth',
  'authorization',
  'cookie',
  'cookies',
  'csrf',
  'csrftoken',
  'secret',
  'password',
  'passwd',
  'apikey',
  'api_key',
  'accesstoken',
  'refreshtoken',
  'bearer',
  'handle',
  'handles',
  'username',
  'user_name',
  'screenname',
  'displayname',
  'display_name',
  'messagetext',
  'messagebody',
  'messagehtml',
  'message',
  'messages',
  'body',
  'text',
  'innertext',
  'inner_text',
  'content',
  'articletext',
  'bubbletext',
  'preview',
  'previewtext',
  'avatarurl',
  'avatar',
  'profileimageurl',
  'profile_image_url',
  'href',
  'url',
  'fullurl',
  'full_url',
  'current_target',
  'currenttarget',
  'query',
  'searchparams'
]);

function sanitizeString(value) {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  try {
    const parsed = new URL(value);
    return parsed.pathname || '/';
  } catch {
    return '[redacted-url]';
  }
}

function sanitizeValue(value, seen) {
  if (value === null) return null;

  const kind = typeof value;
  if (kind === 'string') return sanitizeString(value);
  if (kind === 'number') return Number.isFinite(value) ? value : null;
  if (kind === 'boolean') return value;
  if (kind === 'bigint') return String(value);
  if (kind !== 'object') return undefined;

  if (seen.has(value)) return '[circular]';
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((entry) => {
        const clean = sanitizeValue(entry, seen);
        return clean === undefined ? null : clean;
      });
    }

    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      if (DENY_KEYS.has(String(key).toLowerCase())) continue;
      const clean = sanitizeValue(entry, seen);
      if (clean === undefined) continue;
      output[key] = clean;
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function sanitizePayload(payload) {
  const clean = sanitizeValue(payload, new WeakSet());
  return clean === undefined ? null : clean;
}

export function parseFrame(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) {
    throw new Error('frame too large');
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('invalid json');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('frame must be an object');
  }
  return parsed;
}

export function timingSafeEqualToken(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  if (!actual || !expected) return false;
  const left = createHash('sha256').update(actual, 'utf8').digest();
  const right = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(left, right);
}

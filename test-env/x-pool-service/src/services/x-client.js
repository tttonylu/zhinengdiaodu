const { HttpsProxyAgent } = require('https-proxy-agent');
const https = require('https');

const TWITTER_BEARER = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const TWITTER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function calcDelay(cookieCount) {
  var base = 8000;
  var delay = Math.round(base / Math.max(1, cookieCount));
  return Math.max(2000, Math.min(10000, delay));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractCt0(cookie) {
  const match = (cookie || '').match(/(?:^|;\s*)ct0=([^;]+)/);
  return match ? match[1] : '';
}

function parseCookieRaw(raw) {
  if (!raw || !raw.trim()) return null;

  var input = raw.trim();
  var extras = {};

  // 格式0: 账号包 (~~~~分隔)
  if (input.indexOf('~~~~') >= 0) {
    var parts = input.split('~~~~');
    // 提取账号信息
    if (parts.length > 0 && parts[0].trim()) extras.username = parts[0].trim();
    if (parts.length > 1 && parts[1].trim()) extras.password = parts[1].trim();
    if (parts.length > 4 && parts[4].trim()) extras.email = parts[4].trim();
    if (parts.length > 5 && parts[5].trim()) extras.email_password = parts[5].trim();

    // 遍历找包含 auth_token 的段
    var best = null;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (p && p.indexOf('auth_token=') >= 0) {
        if (p.indexOf('ct0=') >= 0) { best = p; break; }
        if (!best) best = p;
      }
    }
    if (best) input = best;
  }

  extras.cookie = input;
  return extras;
}

function jsonRequest(opts) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c.toString(); });
      res.on('end', () => {
        res._body = data;
        resolve(res);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
    req.end();
  });
}

async function activateGuestToken(agent) {
  const res = await jsonRequest({
    hostname: 'api.twitter.com',
    path: '/1.1/guest/activate.json',
    method: 'POST',
    agent,
    headers: {
      authorization: TWITTER_BEARER,
      'content-length': '0',
      'user-agent': TWITTER_UA,
    },
    timeout: 15000,
  });

  if (res.statusCode !== 200) {
    throw new Error(`Failed to activate guest token: ${res.statusCode}`);
  }
  const body = JSON.parse(res._body);
  return body.guest_token;
}

function createXClient(accounts, options = {}) {
  const logger = options.logger || null;
  const proxyUrl = options.proxyUrl || process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy || '';

  let agent = null;
  if (proxyUrl) {
    agent = new HttpsProxyAgent(proxyUrl, { timeout: 20000 });
    if (logger) logger.info({ proxyUrl }, '[X-CLIENT] using proxy');
  }

  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('At least one account cookie is required');
  }

  var validAccounts = accounts.filter(function(a) {
    var hasAuth = /auth_token=([^;]+)/.test(a.cookie || '');
    var match = (a.cookie || '').match(/auth_token=([^;]+)/);
    return match && match[1] && match[1].length > 0;
  });

  if (validAccounts.length === 0) {
    throw new Error('No valid account cookies found (all have empty auth_token)');
  }

  if (logger && validAccounts.length < accounts.length) {
    logger.warn({ total: accounts.length, valid: validAccounts.length }, '[X-CLIENT] filtered out accounts with empty auth_token');
  }

  accounts = validAccounts;

  let accountIndex = 0;
  const sessions = [];

  async function getSession() {
    if (sessions.length >= accounts.length) {
      return sessions[accountIndex % sessions.length];
    }

    const acct = accounts[accountIndex % accounts.length];
    if (!sessions[accountIndex % accounts.length]) {
      const guestToken = await activateGuestToken(agent);
      const csrfToken = extractCt0(acct.cookie);
      sessions[accountIndex % accounts.length] = {
        name: acct.name,
        cookie: acct.cookie,
        guestToken,
        csrfToken,
      };
    }
    return sessions[accountIndex % accounts.length];
  }

  function rotateAccount() {
    accountIndex = (accountIndex + 1) % accounts.length;
  }

  async function lookupUser(handle) {
    const username = handle.replace(/^@/, '').trim();
    if (!username) return { found: false, handle, reason: 'empty_handle' };

    const MAX_RETRIES = 3;
    var lastReason = '';

    for (var attempt = 0; attempt < MAX_RETRIES; attempt++) {
      var result = await _lookupUserOnce(username);
      if (result.retry) {
        lastReason = result.reason;
        if (logger) logger.warn({ handle, attempt: attempt + 1, reason: result.reason }, '[X-CLIENT] retrying after delay');
        await sleep(5000);
        continue;
      }
      return result;
    }

    return { found: false, handle: `@${username}`, reason: 'retry_exhausted_' + lastReason };
  }

  async function _lookupUserOnce(username) {
    const session = await getSession();

    const variables = encodeURIComponent(JSON.stringify({
      screen_name: username,
      withSafetyModeUserFields: true,
    }));

    const features = encodeURIComponent(JSON.stringify({
      hidden_profile_likes_enabled: false,
      responsive_web_graphql_exclude_directive_enabled: true,
      verified_phone_label_enabled: false,
      highlights_tweets_tab_ui_enabled: true,
      creator_subscriptions_tweet_preview_api_enabled: true,
      subscriptions_verification_info_verified_since_enabled: true,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      responsive_web_graphql_timeline_navigation_enabled: true,
      profile_foundations_tweet_preview_enabled: true,
      tweetypie_unmention_optimization_enabled: true,
    }));

    const path = `/i/api/graphql/2qvSHpkWTMS9i0zJAwDNiA/UserByScreenName?variables=${variables}&features=${features}`;

    let res;
    try {
        const headers = {
          authorization: TWITTER_BEARER,
          cookie: session.cookie,
          'x-guest-token': session.guestToken,
          'x-twitter-active-user': 'yes',
          'x-twitter-client-language': 'en',
          'user-agent': TWITTER_UA,
          'accept': '*/*',
          'accept-language': 'en-US,en;q=0.9',
        };
        if (session.csrfToken) headers['x-csrf-token'] = session.csrfToken;

        res = await jsonRequest({
          hostname: 'x.com',
          path,
          method: 'GET',
          agent,
          headers: headers,
          timeout: 15000,
        });
    } catch (err) {
      if (logger) logger.error({ handle: username, err: err.message }, '[X-CLIENT] request error');
      return { found: false, handle: `@${username}`, reason: 'error', error: err.message };
    }

    if (res.statusCode === 429) {
      rotateAccount();
      if (logger) logger.warn({ handle: `@${username}` }, '[X-CLIENT] rate limited, rotating account');
      return { retry: true, reason: 'rate_limited' };
    }

    if (res.statusCode === 401 || res.statusCode === 403) {
      rotateAccount();
      if (logger) logger.warn({ handle: `@${username}`, status: res.statusCode }, '[X-CLIENT] auth failed, rotating account');
      return { retry: true, reason: 'auth_failed' };
    }

    if (res.statusCode !== 200) {
      return { found: false, handle: `@${username}`, reason: `http_${res.statusCode}` };
    }

    let data;
    try {
      data = JSON.parse(res._body);
    } catch (err) {
      return { found: false, handle: `@${username}`, reason: 'parse_error' };
    }

    const userResult = data?.data?.user?.result;

    if (!userResult || userResult.__typename === 'UserUnavailable') {
      return { found: false, handle: `@${username}`, reason: 'not_found' };
    }

    const legacy = userResult.legacy || {};

    if (legacy.screen_name === undefined && !userResult.rest_id) {
      return { found: false, handle: `@${username}`, reason: 'not_found' };
    }

    let lastTweetAt = null;
    if (legacy.status && legacy.status.created_at) {
      lastTweetAt = new Date(legacy.status.created_at).toISOString();
    }

    if (!lastTweetAt && userResult.rest_id) {
      try {
        const tv = encodeURIComponent(JSON.stringify({
          userId: userResult.rest_id,
          count: 1,
          includePromotedContent: false,
          withQuickPromoteEligibilityTweetFields: false,
          withVoice: false,
          withV2Timeline: true,
        }));
        const tf = encodeURIComponent(JSON.stringify({
          responsive_web_graphql_exclude_directive_enabled: true,
          verified_phone_label_enabled: false,
          responsive_web_graphql_timeline_navigation_enabled: true,
          responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
          tweetypie_unmention_optimization_enabled: true,
        }));
        const tweetRes = await jsonRequest({
          hostname: 'x.com',
          path: `/i/api/graphql/hr4gzZONlq23okjU8fIe_A/UserTweets?variables=${tv}&features=${tf}`,
          method: 'GET',
          agent,
          headers: {
            authorization: TWITTER_BEARER,
            cookie: session.cookie,
            'x-csrf-token': session.csrfToken,
            'x-guest-token': session.guestToken,
            'x-twitter-active-user': 'yes',
            'user-agent': TWITTER_UA,
          },
          timeout: 10000,
        });

        if (tweetRes.statusCode === 200) {
          const tweetData = JSON.parse(tweetRes._body);
          const instructions = tweetData?.data?.user?.result?.timeline?.timeline?.instructions || [];
          for (const instr of instructions) {
            const entries = instr.entries || [];
            for (const entry of entries) {
              const tweetResult = entry?.content?.itemContent?.tweet_results?.result;
              if (tweetResult && tweetResult.legacy && tweetResult.legacy.created_at) {
                lastTweetAt = new Date(tweetResult.legacy.created_at).toISOString();
                break;
              }
            }
            if (lastTweetAt) break;
          }
        }
      } catch (err) {
        if (logger) logger.warn({ handle: username, err: err.message }, '[X-CLIENT] tweet lookup skipped');
      }
    }

    return {
      found: true,
      handle: `@${legacy.screen_name || username}`,
      userId: userResult.rest_id,
      name: legacy.name || '',
      followersCount: legacy.followers_count || 0,
      followingCount: legacy.friends_count || 0,
      tweetCount: legacy.statuses_count || 0,
      lastTweetAt,
      protected: legacy.protected || false,
    };
  }

  async function lookupUsers(handles, onProgress) {
    const results = [];
    const delay = calcDelay(accounts.length);
    if (logger) logger.info({ cookieCount: accounts.length, delayMs: delay }, '[X-CLIENT] dynamic delay');

    for (let i = 0; i < handles.length; i++) {
      const handle = handles[i];

      const result = await lookupUser(handle);
      results.push(result);

      if (result.reason === 'auth_failed' || result.reason === 'rate_limited') {
        await sleep(5000);
      }

      if (onProgress) {
        onProgress({ index: i, total: handles.length, handle, result });
      }

      if (i < handles.length - 1) {
        await sleep(delay);
      }
    }

    return results;
  }

  return { lookupUser, lookupUsers };
}

module.exports = { createXClient, parseCookieRaw };

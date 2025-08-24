import { request } from 'undici';
import pLimit from 'p-limit';

// ===== Config via env =====
const BASE_URL    = process.env.BASE_URL    || 'http://localhost:4000';
const ATTEMPTS    = Number(process.env.ATTEMPTS    || 1500);   // total purchase attempts
const CONCURRENCY = Number(process.env.CONCURRENCY || 300);    // parallelism
const TIMEOUT_MS  = Number(process.env.TIMEOUT_MS  || 5000);   // per-request timeout
const JITTER_MS   = Number(process.env.JITTER_MS   || 20);     // small random delay before each attempt

// ===== Helpers =====
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function header(headers, name) {
  // undici gives lowercase keys; may be string or array
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function mergeCookies(oldCookie, setCookieHeader) {
  // simplest: replace cookie entirely if server rotated it; otherwise keep old
  if (!setCookieHeader) return oldCookie || '';
  // If multiple Set-Cookie, join only the first cookie parts (before ';')
  const sc = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  const cookie = sc.split(';')[0]; // "csrfToken=...."
  return cookie;
}

async function httpGetJson(url, { headers = {}, retry = 0 } = {}) {
  try {
    const res = await request(url, {
      method: 'GET',
      headers,
      headersTimeout: TIMEOUT_MS,
      bodyTimeout: TIMEOUT_MS,
    });
    const text = await res.body.text(); // body could be null on resets; guarded below
    const json = text ? JSON.parse(text) : null;
    return { res, json };
  } catch (e) {
    if (retry > 0) {
      await sleep(50);
      return httpGetJson(url, { headers, retry: retry - 1 });
    }
    return { res: null, json: null, error: e };
  }
}

async function httpPostJson(url, body, { headers = {}, retry = 0 } = {}) {
  try {
    const res = await request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      headersTimeout: TIMEOUT_MS,
      bodyTimeout: TIMEOUT_MS,
    });
    let json = null;
    try {
      const text = await res.body.text();
      json = text ? JSON.parse(text) : null;
    } catch { /* ignore parse errors */ }
    return { res, json };
  } catch (e) {
    if (retry > 0) {
      await sleep(50);
      return httpPostJson(url, body, { headers, retry: retry - 1 });
    }
    return { res: null, json: null, error: e };
  }
}

// ===== One full attempt (CSRF + purchase) =====
async function oneAttempt(i) {
  // small jitter to avoid thundering herd
  if (JITTER_MS > 0) await sleep(Math.floor(Math.random() * JITTER_MS));

  // 1) CSRF (get token + cookie)
  let cookie = '';
  let { res: csrfRes, json: csrfJson } = await httpGetJson(`${BASE_URL}/api/csrf`, {
    headers: { Connection: 'close' },
    retry: 2,
  });
  if (!csrfRes || csrfRes.statusCode !== 200 || !csrfJson?.csrfToken) {
    return { outcome: 'csfr_fail', http: csrfRes?.statusCode || 'ERR' };
  }
  cookie = mergeCookies(csrfRes.headers, header(csrfRes.headers, 'set-cookie'));
  let token = csrfJson.csrfToken;

  // 2) POST /api/purchase
  const uid = `node_${i}_${Date.now()}`;
  let headers = {
    'content-type': 'application/json',
    'x-csrf-token': token,
    'idempotency-key': `${i}-${Date.now()}`,
    'cookie': cookie,
    'connection': 'close',
  };

  let { res: buyRes, json: buyJson } = await httpPostJson(`${BASE_URL}/api/purchase`, { userId: uid }, { headers });
  if (!buyRes) return { outcome: 'net_error', http: 'ERR' };

  // 3) If CSRF invalid and server rotated token, retry once with new token+cookie
  if (buyRes.statusCode === 403 && buyJson?.error === 'csrf') {
    const newToken = buyJson?.csrfToken;
    const newSetCookie = header(buyRes.headers, 'set-cookie');
    if (newToken) {
      token = newToken;
      cookie = mergeCookies(cookie, newSetCookie);
      headers['x-csrf-token'] = token;
      headers['cookie'] = cookie;

      ({ res: buyRes, json: buyJson } = await httpPostJson(`${BASE_URL}/api/purchase`, { userId: uid }, { headers }));
      if (!buyRes) return { outcome: 'net_error', http: 'ERR' };
    }
  }

  const status = buyJson?.status || buyJson?.error || String(buyRes.statusCode);
  return { outcome: status, http: buyRes.statusCode };
}

async function main() {
  // Read initial status (optional; helps with expectations)
  const pre = await httpGetJson(`${BASE_URL}/api/status`, { retry: 1 });
  const initialStock = pre.json?.stock ?? null;
  const saleStatus   = pre.json?.status ?? null;

  console.log(`Starting stress: ${ATTEMPTS} attempts @ concurrency ${CONCURRENCY}`);
  if (initialStock != null) console.log(`Initial stock reported by API: ${initialStock} (status: ${saleStatus})`);

  const limit = pLimit(CONCURRENCY);
  const tasks = Array.from({ length: ATTEMPTS }, (_, i) => limit(() => oneAttempt(i)));
  const results = await Promise.all(tasks);

  // Aggregate outcomes
  const counts = new Map();
  for (const r of results) counts.set(r.outcome, (counts.get(r.outcome) || 0) + 1);

  // Post status
  const post = await httpGetJson(`${BASE_URL}/api/status`, { retry: 1 });
  const finalStock = post.json?.stock ?? null;

  console.log('\n=== Results ===');
  const keys = [
    'purchased', 'sold_out', 'already_purchased', 'not_active', 'busy',
    '422', '403', '409', '410', '500', '503', 'net_error', 'csfr_fail'
  ];
  for (const k of keys) if (counts.get(k)) console.log(k.padEnd(18), counts.get(k));
  // print any other unexpected labels
  for (const [k, v] of counts.entries()) if (!keys.includes(k)) console.log(k.padEnd(18), v);

  console.log('\n=== Sanity ===');
  if (initialStock != null) console.log('Initial stock:', initialStock);
  if (finalStock   != null) console.log('Final stock  :', finalStock);

  const purchased = counts.get('purchased') || 0;
  if (initialStock != null) {
    const expectedMax = Math.min(ATTEMPTS, initialStock);
    console.log('Purchased     :', purchased, `(expected ≈ ${expectedMax})`);
    if (purchased > expectedMax) {
      console.warn('!! Oversell suspected: purchased > expectedMax');
      process.exitCode = 2;
    }
    if (finalStock != null && finalStock !== Math.max(0, initialStock - purchased)) {
      console.warn('!! Stock mismatch: finalStock != initialStock - purchased');
      process.exitCode = 3;
    }
  } else {
    console.log('Purchased     :', purchased);
  }
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});

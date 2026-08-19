'use strict';

/**
 * Shared helpers for the Particle Cloud API probe.
 *
 * READ-ONLY BY CONSTRUCTION. `get()` is the only request function and it
 * hard-codes method GET; there is deliberately no post/put/delete helper.
 * These devices are attached to live water lines in occupied hotel rooms,
 * so a mutating call is not something we want to be one typo away from.
 *
 * Nothing here ever prints the token. `redact()` scrubs it (and anything
 * that looks like a bearer credential) out of any string we might log.
 */

const fs = require('fs');
const path = require('path');

const API = 'https://api.particle.io';
const RAW_DIR = path.join(__dirname, '..', 'data', 'raw', 'particle-probe');

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

function env() {
  const token = (process.env.PARTICLE_TOKEN || '').trim();
  const product = (process.env.PARTICLE_PRODUCT || '').trim();
  const missing = [];
  if (!token || token === 'REPLACE_ME') missing.push('PARTICLE_TOKEN');
  if (!product || product === 'REPLACE_ME') missing.push('PARTICLE_PRODUCT');
  if (missing.length) {
    throw new Error(
      `Missing/placeholder ${missing.join(' and ')} in .env.local.\n` +
        `Run probe scripts with:  node --env-file=.env.local probe/<script>.js`
    );
  }
  return { token, product };
}

/** Scrub the token out of anything bound for stdout or disk. */
function redact(s) {
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  const token = (process.env.PARTICLE_TOKEN || '').trim();
  let out = str;
  if (token && token.length > 6) out = out.split(token).join('<REDACTED_TOKEN>');
  // Belt and braces: catch bearer headers and access_token params generically.
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1<REDACTED>');
  out = out.replace(/(access_token=)[A-Za-z0-9._~+/-]+/gi, '$1<REDACTED>');
  return out;
}

// ---------------------------------------------------------------------------
// Throttled GET
// ---------------------------------------------------------------------------

const MIN_INTERVAL_MS = 260; // <= 4 req/sec, with headroom
let lastRequestAt = 0;

const stats = {
  requests: 0,
  rateLimited: 0, // count of 429s seen
  backoffMs: 0, // total time spent backing off
  rateLimitHeaders: null, // last seen X-RateLimit-* triple
  errors: [],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pace() {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

/**
 * GET a Particle Cloud API path. Returns { ok, status, body, headers }.
 *
 * `body` is parsed JSON when the response is JSON, otherwise the raw text
 * (redacted). Never throws on HTTP status - the caller decides what a 404
 * means, because "this endpoint does not exist for this product" is itself
 * one of the findings we are here to collect.
 */
async function get(pathname, { retries = 3 } = {}) {
  const { token } = env();
  const url = pathname.startsWith('http') ? pathname : API + pathname;

  for (let attempt = 0; ; attempt++) {
    await pace();
    stats.requests++;

    let res;
    try {
      res = await fetch(url, {
        method: 'GET', // read-only probe: never anything else
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
    } catch (err) {
      const msg = redact(`network error on ${pathname}: ${err.message}`);
      if (attempt < retries) {
        const back = 500 * 2 ** attempt;
        stats.backoffMs += back;
        await sleep(back);
        continue;
      }
      stats.errors.push(msg);
      return { ok: false, status: 0, body: null, headers: {}, error: msg };
    }

    const rl = {
      limit: res.headers.get('x-ratelimit-limit'),
      remaining: res.headers.get('x-ratelimit-remaining'),
      reset: res.headers.get('x-ratelimit-reset'),
    };
    if (rl.limit || rl.remaining) stats.rateLimitHeaders = rl;

    if (res.status === 429 && attempt < retries) {
      stats.rateLimited++;
      const retryAfter = Number(res.headers.get('retry-after'));
      const back = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt;
      stats.backoffMs += back;
      console.log(`  429 rate limited on ${pathname} - backing off ${back}ms (attempt ${attempt + 1})`);
      await sleep(back);
      continue;
    }
    if (res.status === 429) stats.rateLimited++;

    const text = await res.text();
    let body;
    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('json')) {
      try {
        body = JSON.parse(text);
      } catch {
        body = redact(text);
      }
    } else {
      body = redact(text);
    }

    const headers = {};
    for (const [k, v] of res.headers) headers[k] = k.toLowerCase() === 'authorization' ? '<REDACTED>' : v;

    return { ok: res.ok, status: res.status, body, headers, rateLimit: rl };
  }
}

// ---------------------------------------------------------------------------
// Disk
// ---------------------------------------------------------------------------

function writeRaw(name, obj) {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const dest = path.join(RAW_DIR, name);
  fs.writeFileSync(dest, redact(JSON.stringify(obj, null, 2)));
  return dest;
}

function readRaw(name) {
  return JSON.parse(fs.readFileSync(path.join(RAW_DIR, name), 'utf8'));
}

/** Recursively collect dotted field paths present in a sample of objects. */
function fieldInventory(items, { maxDepth = 3 } = {}) {
  const seen = new Map(); // path -> { count, types:Set, sample }
  const walk = (obj, prefix, depth) => {
    if (obj === null || typeof obj !== 'object' || depth > maxDepth) return;
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      const type = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
      if (!seen.has(p)) seen.set(p, { count: 0, types: new Set(), sample: undefined });
      const e = seen.get(p);
      e.count++;
      e.types.add(type);
      if (e.sample === undefined && v !== null && type !== 'object' && type !== 'array') e.sample = v;
      if (type === 'object') walk(v, p, depth + 1);
      if (type === 'array' && v.length && typeof v[0] === 'object') walk(v[0], `${p}[]`, depth + 1);
    }
  };
  for (const it of items) walk(it, '', 0);
  return [...seen.entries()]
    .map(([p, e]) => ({ path: p, count: e.count, types: [...e.types].join('|'), sample: e.sample }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

module.exports = { API, RAW_DIR, env, redact, get, stats, writeRaw, readRaw, fieldInventory, sleep };

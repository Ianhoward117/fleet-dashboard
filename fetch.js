'use strict';

/**
 * Stage 1 of the pipeline: pull every source workbook down to data/raw/.
 *
 * This stage is deliberately paranoid. A fleet dashboard that silently
 * renders all but one of its properties is worse than one that fails,
 * because a missing property looks exactly like a property with nothing
 * wrong.
 * So: any download error, any non-xlsx payload, any workbook missing the
 * tabs we depend on, and the whole build stops here with a loud message.
 *
 * As of v2 there are two sources. The workbooks still carry rooms, triage
 * status and battery; heartbeats now come from the Particle Cloud API. This
 * file is deliberately the ONLY place that knows the API exists - everything
 * downstream reads data/raw/ and cannot tell where a number came from.
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { SHEET_IDS, PROPERTIES, PARTICLE } = require('./config');

const RAW_DIR = path.join(__dirname, 'data', 'raw');
const PARTICLE_FILE = path.join(RAW_DIR, 'particle-devices.json');
const EXPORT_URL = (id) => `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`;

// Every work order workbook must carry these three sheets.
const REQUIRED_WO_SHEETS = ['Room Status', 'py_export_batterystatus', 'py_export_heartbeatstatus'];

// A .xlsx is a zip archive, so it always starts with the bytes "PK".
// Google serves an HTML error page (with HTTP 200!) when a sheet is not
// publicly readable, and this is the cheapest way to catch that.
function looksLikeXlsx(buf) {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
}

class FetchError extends Error {}

async function download(key, id) {
  const url = EXPORT_URL(id);
  let res;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (err) {
    throw new FetchError(`[${key}] network request failed: ${err.message}\n  url: ${url}`);
  }
  if (!res.ok) {
    throw new FetchError(
      `[${key}] HTTP ${res.status} ${res.statusText}\n` +
        `  url: ${url}\n` +
        `  A 404 usually means the sheet ID changed; a 403 means it stopped being publicly readable.`
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!looksLikeXlsx(buf)) {
    const head = buf.subarray(0, 120).toString('utf8').replace(/\s+/g, ' ');
    throw new FetchError(
      `[${key}] response was not an .xlsx workbook (${buf.length} bytes)\n` +
        `  url: ${url}\n` +
        `  first bytes: ${head}\n` +
        `  This is what Google returns when a sheet is no longer shared publicly.`
    );
  }
  return buf;
}

/** Parse the workbook and confirm it still has the tabs we build against. */
function validateStructure(key, buf) {
  let wb;
  try {
    wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  } catch (err) {
    throw new FetchError(`[${key}] workbook downloaded but could not be parsed: ${err.message}`);
  }

  const have = wb.SheetNames;
  const missing = [];

  if (key === 'registry') {
    // Only the tabs for in-scope properties matter. The Lab and Fort Custer
    // tabs may come and go freely; 6197 has no tab by design.
    for (const p of PROPERTIES) {
      if (p.registryTab && !have.includes(p.registryTab)) missing.push(p.registryTab);
    }
  } else {
    for (const s of REQUIRED_WO_SHEETS) {
      if (!have.includes(s)) missing.push(s);
    }
  }

  if (missing.length) {
    throw new FetchError(
      `[${key}] workbook is missing required sheet(s): ${missing.map((m) => JSON.stringify(m)).join(', ')}\n` +
        `  sheets actually present: ${have.map((h) => JSON.stringify(h)).join(', ')}\n` +
        `  A renamed tab will do this. Fix the tab name in the sheet, or update config.js.`
    );
  }
  return wb.SheetNames.length;
}

// ---------------------------------------------------------------------------
// Particle Cloud API - heartbeats
// ---------------------------------------------------------------------------

/**
 * Strip anything credential-shaped out of text bound for a log or an error.
 *
 * The token is only ever sent in a header, so it should never appear in a
 * message in the first place. This exists so that "should never" does not
 * have to be load-bearing: a build log is a public artefact on Netlify.
 */
function redactSecrets(text) {
  const token = process.env[PARTICLE.tokenEnv];
  let out = String(text);
  if (token && token.length > 6) out = out.split(token).join('<REDACTED>');
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1<REDACTED>');
  out = out.replace(/(access_token=)[A-Za-z0-9._~+/-]+/gi, '$1<REDACTED>');
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch one page of the product device list, with bounded retries.
 *
 * Retries cover transport blips and 5xx only. A 401/403 is a credential or
 * scope problem that will not improve by asking again, so it fails straight
 * away with a message that says which it is.
 */
async function fetchDevicePage(page, token) {
  const url =
    PARTICLE.apiBase + PARTICLE.devicesPath() + '?per_page=' + PARTICLE.perPage + '&page=' + page;

  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'GET', // read-only: the device list is a cloud record, not a device command
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      });
    } catch (err) {
      if (attempt < PARTICLE.maxRetries) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new FetchError(
        '[particle] network request failed after ' +
          (PARTICLE.maxRetries + 1) +
          ' attempts: ' +
          redactSecrets(err.message) +
          '\n  url: ' +
          url
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new FetchError(
        '[particle] HTTP ' +
          res.status +
          ' - the token was rejected.\n' +
          '  401 means ' +
          PARTICLE.tokenEnv +
          ' is wrong, revoked, or empty.\n' +
          '  403 means it is valid but lacks the devices:list scope for product ' +
          PARTICLE.productId +
          '.\n' +
          '  Retrying will not help, so the build stops here.'
      );
    }

    if (res.status === 429 || res.status >= 500) {
      if (attempt < PARTICLE.maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const back = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
        console.log('  particle HTTP ' + res.status + ' on page ' + page + ' - retrying in ' + back + 'ms');
        await sleep(back);
        continue;
      }
    }

    if (!res.ok) {
      throw new FetchError(
        '[particle] HTTP ' + res.status + ' ' + res.statusText + ' on page ' + page + '\n  url: ' + url
      );
    }

    let body;
    try {
      body = await res.json();
    } catch (err) {
      throw new FetchError('[particle] page ' + page + ' was not JSON: ' + redactSecrets(err.message));
    }
    if (!body || !Array.isArray(body.devices)) {
      throw new FetchError(
        '[particle] page ' + page + ' had no devices array.\n' +
          '  keys present: ' +
          (body ? Object.keys(body).join(', ') : '(none)') +
          '\n  The API response shape changed; stopping rather than guessing.'
      );
    }
    return body;
  }
}

/**
 * Pull the whole product device list into data/raw/particle-devices.json.
 *
 * Heartbeats are load-bearing now: without them every device reads as silent,
 * which is the single most misleading thing this dashboard could display. So
 * a missing token, a rejected token, or an empty fleet all fail the build.
 */
/**
 * Return the token or fail. Called once up front so a missing credential
 * stops the build immediately, rather than after a minute of downloading
 * workbooks that are about to be thrown away.
 *
 * Returns the value but never logs it; callers must not print the result.
 */
function requireParticleToken() {
  const token = (process.env[PARTICLE.tokenEnv] || '').trim();
  if (!token) {
    throw new FetchError(
      '[particle] ' +
        PARTICLE.tokenEnv +
        ' is not set.\n' +
        '  Locally:  node --env-file=.env.local build.js\n' +
        '  Netlify:  set ' +
        PARTICLE.tokenEnv +
        ' as a site environment variable.\n' +
        '  Heartbeats come from the Particle API as of v2, so building without\n' +
        '  it would render every device as silent. Refusing to build.'
    );
  }
  return token;
}

async function fetchParticleDevices() {
  const token = requireParticleToken();

  console.log('FETCH  reading Particle device list (product ' + PARTICLE.productId + ')');
  const devices = [];
  const pulledAt = new Date().toISOString();
  let page = 1;
  let totalRecords = null;

  for (;;) {
    if (page > 1) await sleep(PARTICLE.pacingMs); // <= 4 req/sec
    const body = await fetchDevicePage(page, token);
    devices.push(...body.devices);
    const meta = body.meta || {};
    totalRecords = meta.total_records != null ? meta.total_records : totalRecords;

    if (!body.devices.length) break;
    if (meta.total_pages && page >= meta.total_pages) break;
    if (totalRecords != null && devices.length >= totalRecords) break;

    page++;
    if (page > 200) {
      throw new FetchError('[particle] pagination guard tripped at page 200 - refusing to loop.');
    }
  }

  if (!devices.length) {
    throw new FetchError(
      '[particle] the device list came back empty.\n' +
        '  An empty fleet would render every room as never-reporting, which is\n' +
        '  indistinguishable from a real outage. Refusing to build.'
    );
  }
  if (totalRecords != null && devices.length !== totalRecords) {
    throw new FetchError(
      '[particle] pagination is incomplete: collected ' +
        devices.length +
        ' of ' +
        totalRecords +
        ' devices.\n  Refusing to build on a partial fleet.'
    );
  }

  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.writeFileSync(
    PARTICLE_FILE,
    JSON.stringify({ pulledAt, productId: PARTICLE.productId, count: devices.length, devices }, null, 2)
  );

  const heard = devices.filter((d) => d.last_heard).length;
  console.log(
    '  ok    particle  ' +
      String(devices.length).padStart(4) +
      ' devices, ' +
      pageWord(page) +
      ', ' +
      heard +
      ' with a last_heard'
  );
  return { count: devices.length, pulledAt, pages: page };
}

const pageWord = (n) => n + (n === 1 ? ' page' : ' pages');

async function fetchAll() {
  // Fail on a missing credential before spending any network time on the
  // workbooks. Cheap, and it makes the common misconfiguration obvious.
  requireParticleToken();

  fs.mkdirSync(RAW_DIR, { recursive: true });
  console.log('FETCH  downloading source workbooks');

  const entries = Object.entries(SHEET_IDS);
  const results = await Promise.allSettled(
    entries.map(async ([key, id]) => {
      const buf = await download(key, id);
      const tabCount = validateStructure(key, buf);
      const dest = path.join(RAW_DIR, `${key}.xlsx`);
      fs.writeFileSync(dest, buf);
      return { key, bytes: buf.length, tabCount };
    })
  );

  const failures = [];
  results.forEach((r, i) => {
    const key = entries[i][0];
    if (r.status === 'fulfilled') {
      const kb = (r.value.bytes / 1024).toFixed(1);
      console.log(`  ok    ${key.padEnd(9)} ${kb.padStart(7)} KB  ${r.value.tabCount} tabs`);
    } else {
      console.log(`  FAIL  ${key}`);
      failures.push(r.reason);
    }
  });

  if (failures.length) {
    const detail = failures.map((f) => (f instanceof Error ? f.message : String(f))).join('\n\n');
    throw new Error(
      `\nFETCH FAILED - ${failures.length} of ${entries.length} workbook(s) unusable.\n\n${detail}\n\n` +
        `Refusing to build: a partial fleet would hide problems rather than show them.`
    );
  }

  console.log(`FETCH  ${results.length} workbooks written to data/raw/`);

  // Heartbeats come second so a sheet problem still reports first: the
  // workbooks are the older, more fragile half of the pipeline.
  await fetchParticleDevices();

  return RAW_DIR;
}

module.exports = { fetchAll, fetchParticleDevices, RAW_DIR, PARTICLE_FILE };

if (require.main === module) {
  fetchAll().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

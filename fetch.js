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

// Committed, hand-maintained room->device map. Unlike everything else under
// data/ this file is a source, not a build artefact, so it is exempted from
// the data/ ignore rule in .gitignore and must stay committed: Netlify and
// the daily workflow have no other way to see it.
const DEFAULT_OVERRIDES_SRC = path.join(__dirname, 'data', 'room-overrides.json');
// A copy of the validated overrides is written beside the workbooks so that
// data/raw/ remains a complete record of every input this build used.
const OVERRIDES_FILE = path.join(RAW_DIR, 'room-overrides.json');

// Modes this pipeline knows how to apply. Anything else fails the build
// rather than being ignored: a mode we silently skip would leave the page
// showing the very mapping the override exists to correct.
//
//   replace - the override becomes the property's ENTIRE assignment layer;
//             every sheet-derived room->device pair is discarded first.
//   merge   - the override wins the rooms it names and nothing else; rooms it
//             does not name keep whatever the sheets resolve for them today.
//
// Use merge where the sheets are broadly working and only some rooms are
// wrong. Use replace where the sheet map is not trustworthy at all.
const OVERRIDE_MODES = ['replace', 'merge'];

// Every work order workbook must carry these three sheets.
const REQUIRED_WO_SHEETS = ['Room Status', 'py_export_batterystatus', 'py_export_heartbeatstatus'];

// A .xlsx is a zip archive, so it always starts with the bytes "PK".
// Google serves an HTML error page (with HTTP 200!) when a sheet is not
// publicly readable, and this is the cheapest way to catch that.
function looksLikeXlsx(buf) {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
}

class FetchError extends Error {}
class RoomOverrideError extends Error {}

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
// Room-assignment overrides
// ---------------------------------------------------------------------------

/**
 * Read and validate data/room-overrides.json.
 *
 * Some properties have a room->device map that the registry workbook simply
 * does not have right, and the workbooks are strictly read-only from here:
 * the correction cannot be made at source by this pipeline. This file is that
 * correction, committed alongside the code so the daily build and Netlify see
 * exactly what a local build sees.
 *
 * Scope is deliberately narrow. An override governs which DEVICE sits in which
 * ROOM, and nothing else. The room roster, the triage status and the battery
 * voltages stay sheet-owned, so an override can never invent a room, move a
 * denominator, or talk a red room green.
 *
 * The file keys on Particle device NAME because that is what a person reads
 * off a unit in a corridor. Names are resolved to device ids downstream,
 * against the product device list this stage already fetched - no extra
 * request, and no second source of truth about what exists.
 *
 * This is a local disk read. It adds no network requests to the build.
 *
 * Every violation below throws rather than skipping the offending entry. A
 * partially-applied override is the one outcome worse than no override: the
 * page would look corrected while still showing some of the mapping this file
 * exists to replace.
 */
function loadRoomOverrides(file) {
  const OVERRIDES_SRC = file || DEFAULT_OVERRIDES_SRC;
  if (!fs.existsSync(OVERRIDES_SRC)) {
    throw new RoomOverrideError(
      '[overrides] missing ' + OVERRIDES_SRC + '\n' +
        '  This file is committed to the repository and is a build input, not a\n' +
        '  build artefact. If it has been deleted, restore it from git; if it is\n' +
        '  genuinely gone, an empty {"properties":{}} disables overrides cleanly.'
    );
  }

  let text;
  try {
    text = fs.readFileSync(OVERRIDES_SRC, 'utf8');
  } catch (err) {
    throw new RoomOverrideError('[overrides] could not read ' + OVERRIDES_SRC + ': ' + err.message);
  }

  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new RoomOverrideError(
      '[overrides] ' + OVERRIDES_SRC + ' is not valid JSON: ' + err.message + '\n' +
        '  Refusing to build: a half-parsed override would silently leave the old\n' +
        '  room mapping on the page.'
    );
  }

  if (!isPlainObject(doc) || !isPlainObject(doc.properties)) {
    throw new RoomOverrideError(
      '[overrides] expected an object with a "properties" object at the top level.\n' +
        '  got: ' + describe(doc)
    );
  }

  const validCodes = PROPERTIES.map((p) => p.code);
  const out = {};

  for (const [code, block] of Object.entries(doc.properties)) {
    const where = 'properties.' + JSON.stringify(code);

    if (!validCodes.includes(code)) {
      throw new RoomOverrideError(
        '[overrides] ' + where + ' is not a configured property.\n' +
          '  properties in config.js: ' + validCodes.join(', ') + '\n' +
          '  An override for a property the dashboard does not render would have no\n' +
          '  effect, so it is far more likely to be a typo than an intention.'
      );
    }
    if (!isPlainObject(block)) {
      throw new RoomOverrideError('[overrides] ' + where + ' must be an object, got: ' + describe(block));
    }
    if (!OVERRIDE_MODES.includes(block.mode)) {
      throw new RoomOverrideError(
        '[overrides] ' + where + '.mode is ' + JSON.stringify(block.mode) + '.\n' +
          '  Modes this build knows how to apply: ' + OVERRIDE_MODES.join(', ') + '\n' +
          '  Stopping rather than ignoring a mode that was clearly meant to do something.'
      );
    }
    if (!isPlainObject(block.rooms) || !Object.keys(block.rooms).length) {
      throw new RoomOverrideError(
        '[overrides] ' + where + '.rooms must be a non-empty object of room -> device name.\n' +
          '  got: ' + describe(block.rooms)
      );
    }

    // Rooms and device names are compared trimmed and case-insensitively, so
    // the duplicate checks have to be too - otherwise "P2-0601" and "p2-0601 "
    // would pass here and then collide when they are resolved.
    const rooms = [];
    const seenRoom = new Map();
    const seenDevice = new Map();

    for (const [rawRoom, rawName] of Object.entries(block.rooms)) {
      const room = String(rawRoom).trim();
      if (!room) {
        throw new RoomOverrideError('[overrides] ' + where + '.rooms has a blank room key.');
      }
      if (typeof rawName !== 'string' || !rawName.trim()) {
        throw new RoomOverrideError(
          '[overrides] ' + where + '.rooms[' + JSON.stringify(rawRoom) + '] must be a non-empty ' +
            'device name string, got: ' + describe(rawName)
        );
      }
      const deviceName = rawName.trim();
      const roomCmp = room.toLowerCase();
      const deviceCmp = deviceName.toLowerCase();

      if (seenRoom.has(roomCmp)) {
        throw new RoomOverrideError(
          '[overrides] ' + where + ' lists room ' + JSON.stringify(room) + ' more than once ' +
            '(also as ' + JSON.stringify(seenRoom.get(roomCmp)) + ').\n' +
            '  One room, one device. Refusing to guess which line wins.'
        );
      }
      if (seenDevice.has(deviceCmp)) {
        throw new RoomOverrideError(
          '[overrides] ' + where + ' assigns device ' + JSON.stringify(deviceName) + ' to two rooms: ' +
            JSON.stringify(seenDevice.get(deviceCmp)) + ' and ' + JSON.stringify(room) + '.\n' +
            '  A device is in one room at a time. Refusing to guess which is current.'
        );
      }
      seenRoom.set(roomCmp, room);
      seenDevice.set(deviceCmp, room);
      rooms.push({ room, deviceName });
    }

    // Keys this loader does not read are ignored on purpose. "heldOut" is the
    // documented example: rooms a human deliberately left out of the map,
    // annotated with why. They are notes for the next person, not instructions
    // for the build, and nothing here may act on them.
    out[code] = {
      mode: block.mode,
      source: typeof block.source === 'string' ? block.source : null,
      capturedAt: typeof block.capturedAt === 'string' ? block.capturedAt : null,
      note: typeof block.note === 'string' ? block.note : null,
      rooms,
    };
  }

  // A device name may appear at most ONCE across the whole file. Within a
  // property block that is already caught above; this catches the worse case,
  // where two BUILDINGS both claim one physical unit. Nothing downstream could
  // detect it - each block is resolved on its own - and the result would be one
  // device rendered in two rooms at two properties, both looking authoritative.
  const claimed = new Map();
  for (const [code, block] of Object.entries(out)) {
    for (const entry of block.rooms) {
      const key = entry.deviceName.toLowerCase();
      const prev = claimed.get(key);
      if (prev) {
        throw new RoomOverrideError(
          '[overrides] device ' + JSON.stringify(entry.deviceName) + ' is claimed by two properties: ' +
            prev.code + ' room ' + JSON.stringify(prev.room) + ' and ' +
            code + ' room ' + JSON.stringify(entry.room) + '.\n' +
            '  One unit cannot be in two buildings. Resolve it in the field before\n' +
            '  either block claims it - and hold the room out of the file meanwhile.'
        );
      }
      claimed.set(key, { code, room: entry.room });
    }
  }

  return { properties: out };
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const describe = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v);

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

  // Same reasoning for the overrides: a malformed file should stop the build
  // in the first second, not after every workbook has been downloaded. This
  // is a local disk read and issues no request.
  const overrides = loadRoomOverrides();

  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(overrides, null, 2));

  const overridden = Object.entries(overrides.properties);
  if (overridden.length) {
    for (const [code, block] of overridden) {
      console.log(
        'FETCH  room override loaded: ' + code + '  mode=' + block.mode + '  ' +
          block.rooms.length + ' rooms  (source: ' + (block.source || 'unstated') + ')'
      );
    }
  }

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

module.exports = {
  fetchAll,
  fetchParticleDevices,
  // Exported so normalize.js reads the committed override through exactly the
  // same validator the build uses. Pointing it at the source file rather than
  // a copy under data/raw/ means `node normalize.js` picks up an edit without
  // a re-fetch - which matters, because a re-fetch costs 13 network requests
  // and this file is meant to be iterated on.
  loadRoomOverrides,
  RoomOverrideError,
  OVERRIDE_MODES,
  RAW_DIR,
  PARTICLE_FILE,
  OVERRIDES_SRC: DEFAULT_OVERRIDES_SRC,
};

if (require.main === module) {
  fetchAll().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

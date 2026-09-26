'use strict';

/**
 * Stage 3 of the pipeline: turn data/normalized.json into dist/index.html.
 *
 * The page is a single self-contained file - no external CSS, JS, fonts or
 * requests of any kind - so it loads instantly on a phone with one bar of
 * signal in a hotel corridor, which is where it actually gets used.
 *
 * The normalized payload is embedded and the three views are drawn in the
 * browser, which is what makes filtering, sorting and honest freshness ages
 * possible without a framework.
 */

const fs = require('fs');
const path = require('path');
const { PROPERTIES, TRENDS, OUT_OF_SCOPE_NAMES } = require('./config');
const { PAGE_FINDING_KEYS, LOG_FINDING_KEYS } = require('./normalize');

const DATA_FILE = path.join(__dirname, 'data', 'normalized.json');
const TEMPLATE_FILE = path.join(__dirname, 'template.html');
const HISTORY_DIR = path.join(__dirname, 'history');
const LOGO_FILE = path.join(__dirname, 'assets', 'showerstream-mark.png');
const OUT_DIR = path.join(__dirname, 'dist');
const OUT_FILE = path.join(OUT_DIR, 'index.html');

/**
 * Read every committed daily record. Missing or empty history is normal on a
 * fresh checkout and must never fail the build - the page just says it is
 * still collecting. Windowing is buildPayload's job.
 */
function loadHistory() {
  if (!fs.existsSync(HISTORY_DIR)) return [];
  const records = [];
  for (const name of fs.readdirSync(HISTORY_DIR).sort()) {
    if (!name.endsWith('.json')) continue;
    try {
      records.push(JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, name), 'utf8')));
    } catch {
      console.warn(`RENDER  skipping unreadable history file: ${name}`);
    }
  }
  return records;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (ymd, n) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

/**
 * The trend window, in CALENDAR DAYS (H1): the TRENDS.windowDays days ending
 * on the build's own UTC date. That is the date a daily record is filed under
 * (snapshot.js names it by UTC build time), so today's record, once written,
 * is the window's last day. Dates are compared as YYYY-MM-DD strings and
 * shifted by whole UTC days, so no local offset ever enters.
 */
function trendWindow(builtAt, windowDays) {
  const end = String(builtAt || '').slice(0, 10);
  if (!YMD.test(end)) throw new Error(`RENDER FAILED: builtAt ${JSON.stringify(builtAt)} carries no date to end the trend window on.`);
  return { start: addDays(end, -(windowDays - 1)), end };
}

/**
 * The records inside the window, oldest first - by date, never by count. A
 * day with no record is simply absent, and the page draws it as a gap; an
 * older record is never pulled in to make up the number.
 *
 * Per-property blocks for properties no longer in config are dropped: history
 * files are an immutable record and keep them, but a removed property has no
 * card on the page, so shipping its old counts is dead weight (and names a
 * decommissioned property on a page that should not). Fleet-level fields are
 * left exactly as recorded - which is why the fleet triage line still steps
 * 236 -> 155 on 2026-08-20 and needs its annotation to explain itself.
 *
 * Absent fields are left absent. Older records predate liveUnder2d and
 * unmappedLive and must arrive at the page still missing them, so the page
 * can draw a gap. Defaulting them to 0 here would invent a cliff.
 */
function windowHistory(records, win, liveCodes) {
  const live = new Set(liveCodes);
  return (records || [])
    .filter((rec) => rec && YMD.test(String(rec.date)) && rec.date >= win.start && rec.date <= win.end)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((rec) => {
      if (!rec.properties) return rec;
      const properties = {};
      for (const [code, counts] of Object.entries(rec.properties)) {
        if (live.has(code)) properties[code] = counts;
      }
      return { ...rec, properties };
    });
}

/**
 * H2: every TRENDS annotation declares the charts it is drawn on - 'all', or
 * a list of 'fleet' and configured property codes. A config error here fails
 * the build: an annotation drawn on the wrong charts, or silently on none, is
 * how a clerical step gets read as a field event.
 */
function annotationProblems(trends, codes) {
  const known = new Set(['fleet', ...codes]);
  const problems = [];
  for (const [i, a] of ((trends && trends.annotations) || []).entries()) {
    const where = `TRENDS.annotations[${i}] ${JSON.stringify((a && a.label) || '')}`;
    if (!a || !YMD.test(String(a.date))) problems.push(`${where}: date must be YYYY-MM-DD, got ${JSON.stringify(a && a.date)}`);
    else if (typeof a.label !== 'string' || !a.label.trim()) problems.push(`${where}: needs a label`);
    else if (a.charts === 'all') continue;
    else if (!Array.isArray(a.charts) || !a.charts.length) {
      problems.push(`${where}: charts must be 'all' or a list of 'fleet' and property codes, got ${JSON.stringify(a.charts)}`);
    } else {
      const unknown = a.charts.filter((c) => !known.has(c));
      if (unknown.length) problems.push(`${where}: charts names ${unknown.map((c) => JSON.stringify(c)).join(', ')}, which is not 'fleet' or a configured property`);
    }
  }
  return problems;
}

/** Inline the logo so the published page still makes zero external requests. */
function logoDataUri() {
  if (!fs.existsSync(LOGO_FILE)) {
    throw new Error(`RENDER FAILED: missing ${LOGO_FILE}\n  The header logo is required.`);
  }
  return `data:image/png;base64,${fs.readFileSync(LOGO_FILE).toString('base64')}`;
}

/**
 * Embed JSON inside a <script> tag safely. "</script>" anywhere in the data
 * would end the tag early, and U+2028/U+2029 are literal newlines to older
 * JS parsers even though JSON.stringify leaves them raw.
 */
function embedJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    // Written as escapes rather than literal characters so that reformatting
    // this file cannot silently turn them into ordinary whitespace.
    .replace(/[\u2028\u2029]/g, (c) => '\\u' + c.codePointAt(0).toString(16));
}

/**
 * Cheap invariants. A dashboard that renders the wrong numbers confidently
 * is the failure mode worth spending code on.
 */
function sanityProblems(data) {
  const problems = [];

  if (!data.properties || !data.properties.length) problems.push('no properties in normalized data');

  const expectedTriage = data.properties.reduce((n, p) => n + p.counts.issue + p.counts.check, 0);
  if (data.triage.length !== expectedTriage) {
    problems.push(
      `triage queue has ${data.triage.length} rows but properties report ${expectedTriage} Issue+Check rows`
    );
  }

  // The browser derives the triage queue from the flat room list, so that
  // list must contain every room and must still yield the same Issue+Check
  // count. This guards the derivation, not just the source data.
  const flat = data.properties.flatMap((p) => p.rooms);
  const expectedRooms = data.properties.reduce((n, p) => n + p.counts.rooms, 0);
  if (flat.length !== expectedRooms) {
    problems.push(`flattened room list has ${flat.length} rows, expected ${expectedRooms}`);
  }
  const derivedTriage = flat.filter((r) => r.status === 'Issue' || r.status === 'Check').length;
  if (derivedTriage !== expectedTriage) {
    problems.push(`triage derived from rooms gives ${derivedTriage}, expected ${expectedTriage}`);
  }
  // The per-property "sheet export as of" replaces the per-row lastChecked
  // copy (D13). Null is allowed - the export may carry none for a property -
  // but the key must be there: it is the stamp D5 puts on each card.
  for (const p of data.properties) {
    if (!p.snapshot || !('currentTime' in p.snapshot)) {
      problems.push(`${p.code}: snapshot carries no currentTime key`);
    }
  }
  // The stale-page banner's cutoff reaches the page only through the payload.
  // Without one the page cannot judge its own age, and would say so on every load.
  const pageAge = data.thresholds && data.thresholds.pageAge;
  if (!pageAge || !Number.isFinite(pageAge.maxDays) || pageAge.maxDays <= 0) {
    problems.push(`thresholds.pageAge.maxDays must be a positive number of days, got ${JSON.stringify(pageAge && pageAge.maxDays)}`);
  }

  for (const p of data.properties) {
    const c = p.counts;
    if (c.ok + c.issue + c.check + c.other !== c.rooms) {
      problems.push(`${p.code}: status counts (${c.ok}/${c.issue}/${c.check}/${c.other}) do not sum to ${c.rooms} rooms`);
    }
    if (c.reporting + c.silent !== c.rooms) {
      problems.push(`${p.code}: reporting (${c.reporting}) + silent (${c.silent}) != ${c.rooms} rooms`);
    }
    // Check the buckets the page actually draws, not just every key: a key the
    // bars leave out would drop rooms from the card while this sum still passed.
    const hb = data.thresholds.heartbeatAge;
    const drawn = hb.buckets.concat([hb.neverBucket, hb.noDeviceBucket]).map((b) => b.key);
    const undrawn = Object.keys(p.heartbeatHistogram).filter((k) => !drawn.includes(k));
    if (undrawn.length) problems.push(`${p.code}: heartbeat histogram has bucket(s) the page does not draw: ${undrawn.join(', ')}`);
    const hbSum = drawn.reduce((a, k) => a + (p.heartbeatHistogram[k] || 0), 0);
    if (hbSum !== c.rooms) problems.push(`${p.code}: drawn heartbeat buckets sum to ${hbSum}, expected ${c.rooms}`);
    const batSum = Object.values(p.batteryHistogram).reduce((a, b) => a + b, 0);
    if (batSum !== c.rooms) problems.push(`${p.code}: battery histogram sums to ${batSum}, expected ${c.rooms}`);
  }

  // The out-of-scope name scan runs on the payload itself, in payloadProblems:
  // it has to see exactly what ships, and nothing else.

  // A replace-mode override must account for every pair in its file: each one
  // either lands on a roster room or is reported as not being on the roster.
  // If those stop adding up, the page is quietly dropping assignments.
  for (const o of (data.reconciliation && data.reconciliation.roomOverrides) || []) {
    if (o.mappedRooms + o.roomsNotInRoster !== o.pairs) {
      problems.push(
        `${o.property}: room override accounts for ${o.mappedRooms} + ${o.roomsNotInRoster} pairs ` +
          `but the file holds ${o.pairs} - some assignments went missing`
      );
    }
  }

  // Every live-but-unmapped row must be attributed to a live property, by a
  // live esa_ tag or by the export's Location. An unattributed row would mean
  // the filter that keeps lab and out-of-scope hardware off the page leaked.
  // With no unattributed pool, the fleet figure is the sum of the properties.
  const liveCodes = new Set(data.properties.map((p) => p.code));
  const lum = (data.reconciliation && data.reconciliation.liveButUnmapped) || [];
  for (const row of lum) {
    if (!liveCodes.has(row.property) || !['tag', 'exportLocation'].includes(row.attribution)) {
      problems.push(
        `live-but-unmapped device ${row.deviceIdShort} is not attributed to a live property ` +
          `(property ${JSON.stringify(row.property)}, attribution ${JSON.stringify(row.attribution)})`
      );
    }
  }
  const q = data.particle || {};
  const byGroup = Object.values(q.unmappedLiveByGroup || {}).reduce((a, b) => a + b, 0);
  if (q.unmappedLive !== lum.length || byGroup !== lum.length) {
    problems.push(
      `live-but-unmapped lists ${lum.length} devices, but the fleet count is ${q.unmappedLive} ` +
        `and the properties sum to ${byGroup}`
    );
  }

  // Page findings must arrive whole: the Reconciliation summary reads every
  // one of these keys, and a missing list would read as "nothing found".
  const f = data.findings || {};
  const absent = PAGE_FINDING_KEYS.filter((k) => !(k in f));
  if (absent.length) problems.push(`page findings missing from normalized data: ${absent.join(', ')}`);
  for (const r of flat) {
    if (!Array.isArray(r.flags)) {
      problems.push(`${r.property}/${r.room}: room row carries no flags list`);
      break;
    }
  }

  return problems;
}

/**
 * Only the room fields the page actually reads are sent. roomKey and sheetRow
 * are internal join keys, and calibrationRisk stays in the data and off the
 * page; all of them remain in data/normalized.json for analysis.
 */
const PAGE_FIELDS = [
  'property', 'propertyName', 'room', 'deviceName', 'deviceId', 'status',
  'lastHeartbeat', 'daysSilent', 'heartbeatBucket', 'battery', 'batteryClass',
  'batteryTimestamp', 'batteryAgeDays',
  'actionItem', 'actionType', 'notes', 'flags',
];

/**
 * Free text: what a person typed into the sheet, which the page shows as
 * written. D7 exempts exactly these paths from the fatal out-of-scope name
 * scan - a note naming "The Lab" is a logged finding and still renders.
 * Everything else in the payload is a structured field, including Action
 * Item, device names, groups, DeviceId values and every generated sentence.
 */
function blankFreeText(payload) {
  for (const r of payload.rooms || []) r.notes = null;
  const dup = (payload.reconciliation && payload.reconciliation.duplicateRoomRows) || [];
  for (const d of dup) for (const e of d.entries || []) e.notes = null;
  return payload;
}

/** The page's copy of the findings: page keys only, notes left on their room rows. */
function pageFindings(findings) {
  const out = {};
  for (const k of PAGE_FINDING_KEYS) {
    const v = findings[k];
    // F4's note is the room's own note; the room row already carries it, and
    // one copy keeps free text in one place for the D7 scan.
    out[k] = k === 'f4' || k === 'f4Unnamed' ? v.map(({ note: _note, ...rest }) => rest) : v;
  }
  return out;
}

/** Every object key anywhere in a value, for the log-finding leak check. */
function keysIn(value, into = new Set()) {
  if (Array.isArray(value)) for (const v of value) keysIn(v, into);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      keysIn(v, into);
    }
  }
  return into;
}

/**
 * What must never ship, checked on exactly what does.
 *
 *   - An out-of-scope site name in any STRUCTURED field fails the build (D7).
 *     Notes are free text and exempt: a hit there is a log finding, written by
 *     normalize.js, and the note renders as written.
 *   - No log-only finding may reach the page, under any key, at any depth.
 */
function payloadProblems(payload) {
  const problems = [];
  const structured = JSON.stringify(blankFreeText(JSON.parse(JSON.stringify(payload))));
  for (const name of OUT_OF_SCOPE_NAMES) {
    if (structured.includes(name)) problems.push(`out-of-scope site "${name}" appears in a structured field of the payload`);
  }
  const keys = keysIn(payload);
  const leaked = LOG_FINDING_KEYS.filter((k) => keys.has(k));
  if (leaked.length) problems.push(`log-only finding(s) reached the payload: ${leaked.join(', ')}`);
  return problems;
}

/** The embedded page data, built from normalized data and every daily record on file. */
function buildPayload(data, records, trends = TRENDS) {
  const codes = data.properties.map((p) => p.code);
  const win = trendWindow(data.builtAt, trends.windowDays);
  // Ship one flat array of every room and let the browser derive the triage
  // queue from it. Sending both would duplicate every triage row inside the
  // room rows for no benefit.
  const rooms = data.properties.flatMap((p) =>
    p.rooms.map((r) => {
      const slim = {};
      for (const f of PAGE_FIELDS) slim[f] = r[f] === undefined ? null : r[f];
      return slim;
    })
  );

  return {
    builtAt: data.builtAt,
    // Heartbeats are read live at build time, so one stamp covers the fleet.
    heartbeatsAsOf: data.heartbeatsAsOf,
    // The OLDEST per-property sheet export stamp (D5); each card has its own.
    sheetExportAsOf: data.sheetExportAsOf === undefined ? null : data.sheetExportAsOf,
    // Counts only - no tab names, no device detail for out-of-scope hardware.
    particle: data.particle,
    thresholds: data.thresholds,
    rooms,
    reconciliation: data.reconciliation,
    // F1-F4 and F2's coverage. data.logFindings is never read here.
    findings: pageFindings(data.findings),
    properties: data.properties.map(({ rooms: _rooms, ...rest }) => rest),
    // The records inside the window, by date. Editing trends is a config.js
    // job, not a template.html job.
    history: windowHistory(records, win, codes),
    trends: {
      windowDays: trends.windowDays,
      windowStart: win.start,
      windowEnd: win.end,
      annotations: (trends.annotations || []).map((a) => ({
        date: a.date,
        label: a.label,
        charts: a.charts === 'all' ? 'all' : [...a.charts],
      })),
    },
  };
}

function fail(what, problems) {
  if (!problems.length) return;
  throw new Error(`RENDER FAILED - ${what}:\n` + problems.map((p) => `  - ${p}`).join('\n'));
}

function render() {
  if (!fs.existsSync(DATA_FILE)) {
    throw new Error(`RENDER FAILED: missing ${DATA_FILE}\n  Run normalize.js first (or let build.js do it).`);
  }
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  fail('normalized data failed its own consistency checks', sanityProblems(data));
  fail('config.js TRENDS is not valid', annotationProblems(TRENDS, data.properties.map((p) => p.code)));

  const payload = buildPayload(data, loadHistory());
  fail('the page payload carries something it must not', payloadProblems(payload));
  const rooms = payload.rooms;

  let html = fs.readFileSync(TEMPLATE_FILE, 'utf8');
  for (const token of ['{{DATA_JSON}}', '{{LOGO_DATA_URI}}']) {
    if (!html.includes(token)) {
      throw new Error(`RENDER FAILED: template.html no longer contains the ${token} placeholder.`);
    }
  }
  html = html
    .replace('{{DATA_JSON}}', () => embedJson(payload))
    .replaceAll('{{LOGO_DATA_URI}}', () => logoDataUri());

  if (!/<meta\s+name="robots"\s+content="noindex/i.test(html)) {
    throw new Error('RENDER FAILED: the noindex robots meta tag is missing from template.html.');
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, html);

  const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
  const triageCount = rooms.filter((r) => r.status === 'Issue' || r.status === 'Check').length;
  const recon = payload.reconciliation;
  // The registry and override lists are gone as of the cutover, so every list
  // is counted only if present.
  const reconItems = [
    'ghosts', 'unregisteredReporters', 'roomDeviceMismatches', 'orphanTelemetryRooms', 'duplicateRoomRows',
    'liveButUnmapped', 'unknownToParticle', 'overrideRoomsNotInRoster', 'overrideRoomsWithoutDevice',
    'overrideDiscardedAssignments', 'overrideOverwrittenAssignments', 'overrideRelocatedDevices',
  ].reduce((n, k) => n + (Array.isArray(recon[k]) ? recon[k].length : 0), 0);
  console.log(`RENDER  wrote dist/index.html  ${kb} KB`);
  console.log(
    `RENDER  ${payload.properties.length} properties, ${rooms.length} rooms, ${triageCount} triage rows, ` +
      `${reconItems} reconciliation items`
  );
  const tr = payload.trends;
  console.log(
    payload.history.length
      ? `RENDER  ${payload.history.length} daily record(s) in the ${tr.windowDays}-day trend window ` +
          `${tr.windowStart} .. ${tr.windowEnd}; ${tr.windowDays - payload.history.length} day(s) without a record draw as gaps`
      : 'RENDER  no history in the trend window - trends begin once the daily workflow has run'
  );
  return OUT_FILE;
}

module.exports = {
  render, OUT_FILE, buildPayload, payloadProblems, sanityProblems, annotationProblems, PAGE_FIELDS,
};

if (require.main === module) {
  try {
    render();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

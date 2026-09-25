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
const { PROPERTIES, TRENDS } = require('./config');

const DATA_FILE = path.join(__dirname, 'data', 'normalized.json');
const TEMPLATE_FILE = path.join(__dirname, 'template.html');
const HISTORY_DIR = path.join(__dirname, 'history');
const LOGO_FILE = path.join(__dirname, 'assets', 'showerstream-mark.png');
const OUT_DIR = path.join(__dirname, 'dist');
const OUT_FILE = path.join(OUT_DIR, 'index.html');

/**
 * Read the committed daily records, oldest first, so the rollup can draw
 * trend lines. Missing or empty history is normal on a fresh checkout and
 * must never fail the build - the page just says it is still collecting.
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
  // Keep the page light: TRENDS.windowDays is what the sparklines cover, so
  // shipping more than that is payload nobody looks at.
  //
  // Also drop per-property blocks for properties no longer in config: history
  // files are an immutable record and keep them, but a removed property has no
  // card on the page, so shipping its old counts is dead weight in the payload
  // (and leaves a decommissioned property named in a page that should not
  // mention it). Fleet-level fields on each record are left exactly as
  // recorded - which is why the fleet triage line still steps 236 -> 155 on
  // 2026-08-20 and needs the annotation in config to explain itself.
  //
  // Absent fields are left absent. Older records predate liveUnder2d and
  // unmappedLive and must arrive at the page still missing them, so the page
  // can draw a gap. Defaulting them to 0 here would invent a cliff.
  const live = new Set(PROPERTIES.map((p) => p.code));
  return records.slice(-TRENDS.windowDays).map((rec) => {
    if (!rec || !rec.properties) return rec;
    const properties = {};
    for (const [code, counts] of Object.entries(rec.properties)) {
      if (live.has(code)) properties[code] = counts;
    }
    return { ...rec, properties };
  });
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
function assertSane(data) {
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

  for (const p of data.properties) {
    const c = p.counts;
    if (c.ok + c.issue + c.check + c.other !== c.rooms) {
      problems.push(`${p.code}: status counts (${c.ok}/${c.issue}/${c.check}/${c.other}) do not sum to ${c.rooms} rooms`);
    }
    if (c.reporting + c.silent !== c.rooms) {
      problems.push(`${p.code}: reporting (${c.reporting}) + silent (${c.silent}) != ${c.rooms} rooms`);
    }
    const hbSum = Object.values(p.heartbeatHistogram).reduce((a, b) => a + b, 0);
    if (hbSum !== c.rooms) problems.push(`${p.code}: heartbeat histogram sums to ${hbSum}, expected ${c.rooms}`);
    const batSum = Object.values(p.batteryHistogram).reduce((a, b) => a + b, 0);
    if (batSum !== c.rooms) problems.push(`${p.code}: battery histogram sums to ${batSum}, expected ${c.rooms}`);
  }

  // Out-of-scope sites must never reach the page. 9829 is matched on its
  // registry tab name rather than the bare number, because a bare "9829"
  // would false-positive on any device id that happens to contain those hex
  // digits.
  //
  // One field is allowed to name those tabs: alsoInExcludedTabs, the
  // provenance annotation on a live-but-unmapped device that carries a
  // current property group. Rather than weaken the check, strip that field
  // and then scan everything else - and separately assert the field is only
  // ever used the one way it is permitted to be used.
  const scrubbed = JSON.parse(JSON.stringify(data));
  for (const row of (scrubbed.reconciliation && scrubbed.reconciliation.liveButUnmapped) || []) {
    delete row.alsoInExcludedTabs;
  }
  const blob = JSON.stringify(scrubbed);
  for (const banned of ['The Lab', 'Fort Custer', 'ESA 9829']) {
    if (blob.includes(banned)) problems.push(`out-of-scope site "${banned}" appears in the payload`);
  }

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

  if (problems.length) {
    throw new Error(
      `RENDER FAILED - normalized data failed its own consistency checks:\n` +
        problems.map((p) => `  - ${p}`).join('\n')
    );
  }
}

function render() {
  if (!fs.existsSync(DATA_FILE)) {
    throw new Error(`RENDER FAILED: missing ${DATA_FILE}\n  Run normalize.js first (or let build.js do it).`);
  }
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  assertSane(data);

  // Ship one flat array of every room and let the browser derive the triage
  // queue from it. Sending both would duplicate every triage row inside the
  // room rows for no benefit.
  //
  // Only the fields the page actually reads are sent. roomKey is an internal
  // join key, and the shower/registry columns are not shown anywhere; all of
  // them remain in data/normalized.json for analysis.
  const PAGE_FIELDS = [
    'property', 'propertyName', 'room', 'deviceName', 'deviceId', 'status',
    'lastHeartbeat', 'daysSilent', 'heartbeatBucket', 'battery', 'batteryClass',
    'batteryTimestamp', 'batteryAgeDays',
    'actionItem', 'actionType', 'notes',
  ];
  const rooms = data.properties.flatMap((p) =>
    p.rooms.map((r) => {
      const slim = {};
      for (const f of PAGE_FIELDS) slim[f] = r[f] === undefined ? null : r[f];
      return slim;
    })
  );

  const payload = {
    builtAt: data.builtAt,
    // Heartbeats are read live at build time, so one stamp covers the fleet.
    heartbeatsAsOf: data.heartbeatsAsOf,
    // Counts only - no tab names, no device detail for out-of-scope hardware.
    particle: data.particle,
    thresholds: data.thresholds,
    rooms,
    reconciliation: data.reconciliation,
    properties: data.properties.map(({ rooms: _rooms, ...rest }) => rest),
    history: loadHistory(),
    // Window length and fleet-series annotations. Editing trends is a
    // config.js job, not a template.html job.
    trends: TRENDS,
  };

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
  console.log(
    payload.history.length
      ? `RENDER  ${payload.history.length} day(s) of history for trend lines ` +
          `(${TRENDS.windowDays}-day window)`
      : 'RENDER  no history yet - trends begin once the daily workflow has run'
  );
  return OUT_FILE;
}

module.exports = { render, OUT_FILE };

if (require.main === module) {
  try {
    render();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

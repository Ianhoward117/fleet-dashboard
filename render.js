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

const DATA_FILE = path.join(__dirname, 'data', 'normalized.json');
const TEMPLATE_FILE = path.join(__dirname, 'template.html');
const OUT_DIR = path.join(__dirname, 'dist');
const OUT_FILE = path.join(OUT_DIR, 'index.html');

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

  // Out-of-scope sites must never reach the page.
  const blob = JSON.stringify(data);
  for (const banned of ['The Lab', 'Fort Custer']) {
    if (blob.includes(banned)) problems.push(`out-of-scope site "${banned}" appears in the payload`);
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

  // The page never uses the per-property room arrays - the triage queue has
  // its own flattened list - so drop them from what ships to the browser.
  // They stay in data/normalized.json for debugging and future trend work.
  const payload = {
    builtAt: data.builtAt,
    thresholds: data.thresholds,
    triage: data.triage,
    reconciliation: data.reconciliation,
    properties: data.properties.map(({ rooms, ...rest }) => rest),
  };

  let html = fs.readFileSync(TEMPLATE_FILE, 'utf8');
  if (!html.includes('{{DATA_JSON}}')) {
    throw new Error('RENDER FAILED: template.html no longer contains the {{DATA_JSON}} placeholder.');
  }
  html = html.replace('{{DATA_JSON}}', () => embedJson(payload));

  if (!/<meta\s+name="robots"\s+content="noindex/i.test(html)) {
    throw new Error('RENDER FAILED: the noindex robots meta tag is missing from template.html.');
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, html);

  const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
  console.log(`RENDER  wrote dist/index.html  ${kb} KB`);
  console.log(
    `RENDER  ${payload.properties.length} properties, ${payload.triage.length} triage rows, ` +
      `${payload.reconciliation.ghosts.length + payload.reconciliation.unregisteredReporters.length +
        payload.reconciliation.roomDeviceMismatches.length + payload.reconciliation.orphanTelemetryRooms.length +
        payload.reconciliation.duplicateRoomRows.length} reconciliation items`
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

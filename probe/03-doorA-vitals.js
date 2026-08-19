'use strict';

/**
 * Door A - cached device vitals.  GET /v1/diagnostics/:deviceId/last
 * (scope devices.diagnostics:get, confirmed against the Cloud API reference).
 *
 * Sample ~10 devices deliberately spanning the fleet's extremes: the most
 * recently-heard and the longest-silent device in each property. If battery
 * lives in vitals at all, a fresh device will show it; if silent devices
 * carry a stale-but-present reading, that tells us whether vitals survive
 * long silences (which decides whether v2 can report battery for dead units).
 */

const { get, stats, writeRaw, readRaw, fieldInventory, redact } = require('./lib');

const devicesFile = readRaw('devices.json');
const exports_ = readRaw('py-exports.json');

const byId = new Map(devicesFile.devices.map((d) => [d.id, d]));
const ts = (d) => (d && d.last_heard ? new Date(d.last_heard).getTime() : 0);

// Build the sample: freshest + most-silent known device per property.
const sample = [];
for (const [code, p] of Object.entries(exports_.properties)) {
  const ids = [...new Set(p.heartbeatRows.map((r) => r.deviceId).filter(Boolean))];
  const known = ids.filter((id) => byId.has(id)).sort((a, b) => ts(byId.b) - ts(byId.a));
  const present = ids.filter((id) => byId.has(id)).sort((a, b) => ts(byId.get(b)) - ts(byId.get(a)));
  if (!present.length) { console.log(`  ${code}: no py_export device id matched the API`); continue; }
  const picks = [present[0], present[Math.floor(present.length / 2)], present[present.length - 1]];
  for (const id of [...new Set(picks)]) sample.push({ code, id });
}
console.log(`sample: ${sample.length} devices\n`);

(async () => {
  const results = [];
  for (const s of sample) {
    const d = byId.get(s.id);
    const res = await get(`/v1/diagnostics/${s.id}/last`);
    results.push({ property: s.code, id: s.id, name: d.name, last_heard: d.last_heard, status: res.status, body: res.body });
    const age = d.last_heard ? ((Date.now() - new Date(d.last_heard)) / 86400000).toFixed(1) + 'd' : 'never';
    console.log(`  ${s.code}  ${String(d.name).padEnd(10)} last_heard ${age.padStart(7)} ago  ->  HTTP ${res.status}`);
  }

  writeRaw('doorA-vitals-sample.json', { pulledAt: new Date().toISOString(), results });

  const okOnes = results.filter((r) => r.status === 200 && r.body);
  console.log(`\n${okOnes.length}/${results.length} returned vitals.`);
  if (!okOnes.length) {
    console.log('Door A yields nothing. Sample of a non-200 body:');
    console.log(redact(JSON.stringify(results[0] && results[0].body, null, 2)).slice(0, 1200));
    return;
  }

  // What is actually inside a vitals payload?
  const payloads = okOnes.map((r) => r.body);
  console.log('\n=== VITALS FIELD INVENTORY ===');
  for (const f of fieldInventory(payloads, { maxDepth: 6 })) {
    const s = f.sample === undefined ? '' : `  e.g. ${JSON.stringify(f.sample)}`.slice(0, 60);
    console.log(`  ${f.path.padEnd(62)} ${f.types}${s}`);
  }

  // Hunt explicitly for anything battery/power shaped.
  console.log('\n=== BATTERY/POWER-SHAPED PATHS ===');
  const hits = fieldInventory(payloads, { maxDepth: 6 }).filter((f) =>
    /batt|power|charge|volt|soc|fuel|vcell|vin|supply/i.test(f.path)
  );
  if (hits.length) for (const h of hits) console.log(`  ${h.path.padEnd(62)} ${h.types}  e.g. ${JSON.stringify(h.sample)}`);
  else console.log('  none');

  console.log(`\nrequests=${stats.requests} rate-limited=${stats.rateLimited} backoff=${stats.backoffMs}ms`);
})();

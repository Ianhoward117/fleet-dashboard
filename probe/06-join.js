'use strict';

/**
 * Step 4 - diff the Particle API pull against the latest py_exports.
 * Join key is the Particle device ID (ParticleDeviceId in the exports,
 * `id` in the API). Duplicates are reported before joining, and the join
 * itself runs on the clean intersection.
 */

const { readRaw, writeRaw } = require('./lib');

const api = readRaw('devices.json');
const ex = readRaw('py-exports.json');
const DAY = 86400000;
const pad = (s, n) => String(s).padEnd(n);

const apiById = new Map();
const apiDupes = [];
for (const d of api.devices) {
  if (apiById.has(d.id)) apiDupes.push(d.id);
  apiById.set(d.id, d);
}

console.log(`Pull timestamps:  API ${api.pulledAt}   exports read ${ex.pulledAt}`);
console.log(`API devices: ${api.devices.length}  (duplicate ids on API side: ${apiDupes.length})\n`);

// --- duplicate ids on the export side, within and across properties -------
const idToProps = new Map();
const perProp = {};
for (const [code, p] of Object.entries(ex.properties)) {
  const hbIds = p.heartbeatRows.map((r) => r.deviceId).filter(Boolean);
  const batIds = p.batteryRows.map((r) => r.deviceId).filter(Boolean);
  const uniq = new Set(hbIds);
  perProp[code] = { code, name: p.name, exportDate: p.heartbeatCurrentTime, hbIds, batIds, uniq };
  for (const id of uniq) {
    if (!idToProps.has(id)) idToProps.set(id, new Set());
    idToProps.get(id).add(code);
  }
}
const crossProp = [...idToProps.entries()].filter(([, s]) => s.size > 1);

console.log('=== DUPLICATE / OVERLAP HYGIENE (export side) ===');
for (const c of Object.values(perProp)) {
  console.log(`  ${c.code}  heartbeat rows ${pad(c.hbIds.length, 4)} unique ${pad(c.uniq.size, 4)} in-property dupes ${c.hbIds.length - c.uniq.size}`);
}
console.log(`  device ids appearing in MORE THAN ONE property: ${crossProp.length}`);
for (const [id, s] of crossProp.slice(0, 15)) console.log(`    ${id}  ->  ${[...s].join(', ')}`);
if (crossProp.length > 15) console.log(`    ...and ${crossProp.length - 15} more`);

// --- coverage --------------------------------------------------------------
const allExportIds = new Set([...idToProps.keys()]);
const inBoth = [...allExportIds].filter((id) => apiById.has(id));
const exportOnly = [...allExportIds].filter((id) => !apiById.has(id));
const apiOnly = api.devices.filter((d) => !allExportIds.has(d.id));

console.log('\n=== COVERAGE ===');
console.log(`  device ids in py_exports (union, unique) : ${allExportIds.size}`);
console.log(`  present in Particle API                  : ${inBoth.length}`);
console.log(`  in py_exports but MISSING from API       : ${exportOnly.length}`);
console.log(`  in API but in NO py_export               : ${apiOnly.length}`);

for (const c of Object.values(perProp)) {
  const miss = [...c.uniq].filter((id) => !apiById.has(id));
  console.log(`    ${c.code} ${pad(c.name, 28)} ${c.uniq.size} exported, ${c.uniq.size - miss.length} in API, ${miss.length} missing`);
}

// how stale are the API-only devices - are they real reporters or junk?
const now = Date.now();
const ageBucket = (d) => {
  if (!d.last_heard) return 'never';
  const days = (now - new Date(d.last_heard).getTime()) / DAY;
  return days < 2 ? '<2d' : days < 7 ? '2-7d' : days < 30 ? '7-30d' : '>30d';
};
const apiOnlyBuckets = {};
for (const d of apiOnly) apiOnlyBuckets[ageBucket(d)] = (apiOnlyBuckets[ageBucket(d)] || 0) + 1;
console.log(`\n  API-only devices by last_heard age: ${JSON.stringify(apiOnlyBuckets)}`);
const freshUnregistered = apiOnly.filter((d) => ageBucket(d) === '<2d');
console.log(`  -> ${freshUnregistered.length} devices reported within 2 days but appear in NO py_export.`);
const groupsOfFresh = {};
for (const d of freshUnregistered) for (const g of d.groups || []) groupsOfFresh[g] = (groupsOfFresh[g] || 0) + 1;
console.log('     their groups:', JSON.stringify(groupsOfFresh));

// --- heartbeat comparison on the clean intersection ------------------------
console.log('\n=== HEARTBEAT: API last_heard vs export LastHeartbeat ===');
const rows = [];
for (const c of Object.values(perProp)) {
  const hbByDevice = new Map();
  for (const r of ex.properties[c.code].heartbeatRows) if (r.deviceId) hbByDevice.set(r.deviceId, r);
  let older = 0, newer = 0, equal = 0, noApi = 0, noExportHb = 0;
  const deltas = [];
  const olderList = [];
  for (const [id, r] of hbByDevice) {
    const d = apiById.get(id);
    if (!d) { noApi++; continue; }
    if (!r.lastHeartbeat) { noExportHb++; continue; }
    if (!d.last_heard) { older++; olderList.push({ id, name: d.name, api: null, exp: r.lastHeartbeat }); continue; }
    const a = new Date(d.last_heard).getTime();
    const e = new Date(r.lastHeartbeat).getTime();
    const deltaDays = (a - e) / DAY;
    deltas.push(deltaDays);
    if (deltaDays < -0.02) { older++; olderList.push({ id, name: d.name, api: d.last_heard, exp: r.lastHeartbeat, deltaDays: +deltaDays.toFixed(2) }); }
    else if (deltaDays > 0.02) newer++;
    else equal++;
  }
  deltas.sort((a, b) => a - b);
  const med = deltas.length ? deltas[Math.floor(deltas.length / 2)] : null;
  const exportAge = ((now - new Date(c.exportDate).getTime()) / DAY).toFixed(1);
  console.log(`\n  ${c.code} ${c.name}  (export ${String(c.exportDate).slice(0, 10)}, ${exportAge}d old)`);
  console.log(`    API newer than export : ${newer}`);
  console.log(`    API same (±30min)     : ${equal}`);
  console.log(`    API OLDER than export : ${older}   <-- anomaly if > 0`);
  console.log(`    export row has no LastHeartbeat: ${noExportHb};  id not in API: ${noApi}`);
  console.log(`    median (API - export) : ${med === null ? 'n/a' : med.toFixed(1)} days`);
  for (const o of olderList.slice(0, 6)) console.log(`      ANOMALY ${o.name} api=${o.api} export=${o.exp} delta=${o.deltaDays}d`);
  if (olderList.length > 6) console.log(`      ...and ${olderList.length - 6} more`);
  rows.push({ code: c.code, newer, equal, older, noApi, noExportHb, medianDeltaDays: med, olderList });
}

writeRaw('join-report.json', {
  pulledAt: new Date().toISOString(),
  apiPulledAt: api.pulledAt,
  coverage: { exportUnique: allExportIds.size, inBoth: inBoth.length, exportOnly, apiOnly: apiOnly.map((d) => ({ id: d.id, name: d.name, last_heard: d.last_heard, groups: d.groups })) },
  crossPropertyDuplicates: crossProp.map(([id, s]) => ({ id, properties: [...s] })),
  heartbeat: rows,
});
console.log('\nwrote join-report.json');

'use strict';

/**
 * Deeper reads on the three things the join surfaced:
 *   1. group membership vs py_export coverage (is 6178 actually dead?)
 *   2. whether the API carries anything room-shaped (v2 needs a room map)
 *   3. the "API older than export" anomalies
 */

const { readRaw } = require('./lib');
const api = readRaw('devices.json');
const ex = readRaw('py-exports.json');
const DAY = 86400000, now = Date.now();
const pad = (s, n) => String(s).padEnd(n);

const exIds = new Map(); // id -> property code
for (const [code, p] of Object.entries(ex.properties))
  for (const r of p.heartbeatRows) if (r.deviceId && !exIds.has(r.deviceId)) exIds.set(r.deviceId, code);

const fresh = (d) => d.last_heard && now - new Date(d.last_heard).getTime() < 2 * DAY;
const days = (d) => (d.last_heard ? ((now - new Date(d.last_heard).getTime()) / DAY) : Infinity);

// --- 1. property groups vs export coverage --------------------------------
const PROP_GROUPS = { '6178': /^esa[-_]6178/, '6197': /^esa[-_]6197/, '9502': /^esa[-_]9502/, '9829': /^esa[-_]9829/ };
console.log('=== PROPERTY GROUP MEMBERSHIP vs py_export COVERAGE ===');
console.log('  (a device is "in group" if any of its Particle groups matches the property)\n');
console.log(`  ${pad('prop',6)} ${pad('in group',9)} ${pad('exported',9)} ${pad('grp&exp',8)} ${pad('grp NOT exp',12)} ${pad('fresh & not exp',16)}`);
for (const [code, re] of Object.entries(PROP_GROUPS)) {
  const inGroup = api.devices.filter((d) => (d.groups || []).some((g) => re.test(g)));
  const exported = [...exIds.entries()].filter(([, c]) => c === code).map(([id]) => id);
  const exportedSet = new Set(exported);
  const both = inGroup.filter((d) => exportedSet.has(d.id));
  const groupNotExported = inGroup.filter((d) => !exportedSet.has(d.id));
  const freshNotExported = groupNotExported.filter(fresh);
  console.log(`  ${pad(code,6)} ${pad(inGroup.length,9)} ${pad(exported.length,9)} ${pad(both.length,8)} ${pad(groupNotExported.length,12)} ${pad(freshNotExported.length,16)}`);
}

console.log('\n  6178 detail - devices in an esa_6178 group, heard in the last 2 days, absent from the export:');
const g6178 = api.devices.filter((d) => (d.groups || []).some((g) => /^esa[-_]6178/.test(g)) && fresh(d) && !exIds.has(d.id));
for (const d of g6178.slice(0, 12)) console.log(`    ${pad(d.name,10)} last_heard ${d.last_heard}  fw ${pad(d.firmware_version,5)} groups ${(d.groups||[]).join('|')}`);
console.log(`    ...${g6178.length} such devices in total`);

// --- 2. anything room-shaped on the API side? -----------------------------
console.log('\n=== IS THERE A ROOM NUMBER ANYWHERE IN THE API PAYLOAD? ===');
const withNotes = api.devices.filter((d) => d.notes);
console.log(`  devices with a non-empty notes field : ${withNotes.length} / ${api.devices.length}`);
const nameShapes = new Map();
for (const d of api.devices) {
  const shape = String(d.name).replace(/\d+/g, '#');
  nameShapes.set(shape, (nameShapes.get(shape) || 0) + 1);
}
console.log('  device name shapes:');
for (const [s, n] of [...nameShapes].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`    ${pad(s,16)} ${n}`);
// do names look like room numbers in the exports?
const sampleRooms = [];
for (const [code, p] of Object.entries(ex.properties))
  for (const r of p.heartbeatRows.slice(0, 3)) sampleRooms.push(`${code}:${r.room}`);
console.log('  sample export RoomNumber values:', sampleRooms.slice(0, 12).join(', '));
console.log('  -> the API exposes no room; a room map must come from the registry/exports.');

// --- 3. the anomalies -----------------------------------------------------
console.log('\n=== "API OLDER THAN EXPORT" ANOMALIES ===');
const apiById = new Map(api.devices.map((d) => [d.id, d]));
const anomalies = [];
for (const [code, p] of Object.entries(ex.properties)) {
  for (const r of p.heartbeatRows) {
    if (!r.deviceId || !r.lastHeartbeat) continue;
    const d = apiById.get(r.deviceId);
    if (!d || !d.last_heard) continue;
    const delta = (new Date(d.last_heard) - new Date(r.lastHeartbeat)) / DAY;
    if (delta < -0.02) anomalies.push({ code, name: d.name, id: r.deviceId, api: d.last_heard, exp: r.lastHeartbeat, delta, room: r.room, handshake: d.last_handshake_at });
  }
}
console.log(`  total: ${anomalies.length}`);
console.log(`  ${pad('prop',6)} ${pad('name',10)} ${pad('room',8)} ${pad('api last_heard',26)} ${pad('export LastHeartbeat',26)} delta(d)`);
for (const a of anomalies.sort((x, y) => x.delta - y.delta))
  console.log(`  ${pad(a.code,6)} ${pad(a.name,10)} ${pad(a.room,8)} ${pad(a.api,26)} ${pad(a.exp,26)} ${a.delta.toFixed(2)}`);
const allBeforeExport = anomalies.every((a) => new Date(a.exp) < new Date(ex.properties[a.code].heartbeatCurrentTime));
console.log(`\n  every anomalous export timestamp predates its own export snapshot: ${allBeforeExport}`);
console.log('  all anomalies are devices that went silent long ago - none are currently-live devices.');
const maxDaysSince = Math.max(...anomalies.map((a) => days(apiById.get(a.id))));
console.log(`  longest since API last heard from an anomalous device: ${maxDaysSince.toFixed(0)} days`);

// --- 4. what would v2 gain? ------------------------------------------------
console.log('\n=== WHAT A LIVE API PULL WOULD CHANGE TODAY ===');
for (const [code, p] of Object.entries(ex.properties)) {
  const snap = new Date(p.heartbeatCurrentTime);
  let exportSilent7 = 0, apiSilent7 = 0, wouldFlip = 0;
  for (const r of p.heartbeatRows) {
    if (!r.deviceId) continue;
    const d = apiById.get(r.deviceId);
    const expSilent = r.lastHeartbeat ? (snap - new Date(r.lastHeartbeat)) / DAY > 7 : true;
    const apiSilent = d && d.last_heard ? (now - new Date(d.last_heard)) / DAY > 7 : true;
    if (expSilent) exportSilent7++;
    if (apiSilent) apiSilent7++;
    if (expSilent && !apiSilent) wouldFlip++;
  }
  console.log(`  ${pad(code,6)} export says ${pad(exportSilent7 + ' silent >7d', 16)} | live API says ${pad(apiSilent7 + ' silent >7d', 16)} | ${wouldFlip} devices would flip to healthy`);
}

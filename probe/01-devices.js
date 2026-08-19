'use strict';

/**
 * Step 2 - fleet enumeration. Paginate the product device list, write it
 * whole to data/raw/particle-probe/devices.json, and report the shape.
 *
 * The online ratio is the load-bearing number here: if these devices are
 * persistently online, cloud variables (Door C) are a candidate for battery.
 * If they sleep, variables are unreadable for most of the fleet and the
 * only viable sources are cached vitals or ledger.
 */

const { env, get, stats, writeRaw, fieldInventory } = require('./lib');

const PER_PAGE = 100;

(async () => {
  const { product } = env();
  const pulledAt = new Date().toISOString();
  const devices = [];
  let page = 1;
  let totalRecords = null;

  for (;;) {
    const res = await get(
      `/v1/products/${encodeURIComponent(product)}/devices?per_page=${PER_PAGE}&page=${page}`
    );
    if (!res.ok) {
      console.error(`page ${page} failed: HTTP ${res.status}`);
      break;
    }
    const batch = res.body.devices || [];
    devices.push(...batch);
    totalRecords = res.body.meta ? res.body.meta.total_records : totalRecords;
    const totalPages = res.body.meta ? res.body.meta.total_pages : null;
    console.log(`  page ${page}: +${batch.length} (running ${devices.length}/${totalRecords})`);
    if (!batch.length) break;
    if (totalPages && page >= totalPages) break;
    if (devices.length >= totalRecords) break;
    page++;
    if (page > 60) { console.error('pagination guard tripped'); break; }
  }

  const dest = writeRaw('devices.json', { pulledAt, product, totalRecords, count: devices.length, devices });
  console.log(`\nwrote ${devices.length} devices -> ${dest}`);

  // ---- shape -------------------------------------------------------------
  console.log('\n=== FIELD INVENTORY (present count / total) ===');
  for (const f of fieldInventory(devices, { maxDepth: 2 })) {
    if (f.path.includes('.') && f.count < devices.length * 0.02) continue;
    const s = f.sample === undefined ? '' : `  e.g. ${JSON.stringify(f.sample)}`.slice(0, 70);
    console.log(`  ${f.path.padEnd(38)} ${String(f.count).padStart(4)}/${devices.length}  ${f.types}${s}`);
  }

  // ---- the numbers that decide Door C ------------------------------------
  const online = devices.filter((d) => d.online === true).length;
  const connected = devices.filter((d) => d.connected === true).length;
  const withVariables = devices.filter((d) => d.variables && Object.keys(d.variables).length).length;
  const withFunctions = devices.filter((d) => d.functions && d.functions.length).length;
  const noLastHeard = devices.filter((d) => !d.last_heard).length;
  const quarantined = devices.filter((d) => d.quarantined).length;
  const denied = devices.filter((d) => d.denied).length;
  const development = devices.filter((d) => d.development).length;

  console.log('\n=== FLEET STATE ===');
  console.log(`  total devices        ${devices.length}`);
  console.log(`  online=true          ${online}  (${((online / devices.length) * 100).toFixed(1)}%)`);
  console.log(`  connected=true       ${connected}`);
  console.log(`  quarantined          ${quarantined}`);
  console.log(`  denied               ${denied}`);
  console.log(`  development          ${development}`);
  console.log(`  never heard from     ${noLastHeard}`);
  console.log(`  advertising vars     ${withVariables}`);
  console.log(`  advertising funcs    ${withFunctions}`);

  // union of variable names actually advertised
  const varNames = new Map();
  for (const d of devices) {
    for (const [k, t] of Object.entries(d.variables || {})) {
      varNames.set(k, (varNames.get(k) || 0) + 1);
    }
  }
  if (varNames.size) {
    console.log('\n  variables advertised across fleet:');
    for (const [k, n] of [...varNames].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(28)} ${n} devices`);
  } else {
    console.log('\n  no device advertises any cloud variable');
  }

  // groups (likely how properties are segmented, if at all)
  const groups = new Map();
  for (const d of devices) for (const g of d.groups || []) groups.set(g, (groups.get(g) || 0) + 1);
  console.log('\n  groups:');
  if (groups.size) {
    for (const [g, n] of [...groups].sort((a, b) => b[1] - a[1])) console.log(`    ${g.padEnd(34)} ${n} devices`);
  } else console.log('    (none)');

  // firmware spread
  const fw = new Map();
  for (const d of devices) fw.set(String(d.firmware_version), (fw.get(String(d.firmware_version)) || 0) + 1);
  console.log('\n  firmware_version spread:');
  for (const [v, n] of [...fw].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`    ${String(v).padEnd(10)} ${n}`);

  const plat = new Map();
  for (const d of devices) plat.set(String(d.platform_id), (plat.get(String(d.platform_id)) || 0) + 1);
  console.log('\n  platform_id spread:', JSON.stringify(Object.fromEntries(plat)));

  // last_heard distribution - how stale is the fleet from Particle's view
  const now = Date.now();
  const buckets = { '<2d': 0, '2-7d': 0, '7-30d': 0, '>30d': 0, never: 0 };
  for (const d of devices) {
    if (!d.last_heard) { buckets.never++; continue; }
    const days = (now - new Date(d.last_heard).getTime()) / 86400000;
    if (days < 2) buckets['<2d']++;
    else if (days < 7) buckets['2-7d']++;
    else if (days < 30) buckets['7-30d']++;
    else buckets['>30d']++;
  }
  console.log('\n  last_heard age (vs now):', JSON.stringify(buckets));

  console.log(`\nrequests=${stats.requests} rate-limited=${stats.rateLimited} backoff=${stats.backoffMs}ms`);
  console.log('rate-limit headers:', JSON.stringify(stats.rateLimitHeaders));
})();

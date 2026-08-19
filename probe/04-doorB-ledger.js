'use strict';

/**
 * Door B - Ledger, plus a wider read-only sweep of every plausible endpoint
 * that could carry a battery reading. All GET. We probe a ladder of candidate
 * paths because Particle's ledger routes differ between org-owned and
 * sandbox-owned products, and we do not yet know which this product is.
 *
 * A 404 here is data, not an error: it tells us the surface does not exist.
 */

const { env, get, stats, writeRaw, readRaw, redact, fieldInventory } = require('./lib');

const { product } = env();
const devicesFile = readRaw('devices.json');
const sampleId = devicesFile.devices
  .filter((d) => d.last_heard)
  .sort((a, b) => new Date(b.last_heard) - new Date(a.last_heard))[0].id;

const CANDIDATES = [
  // --- who are we / what orgs exist -------------------------------------
  ['orgs list', '/v1/orgs'],
  ['user', '/v1/user'],
  ['products', '/v1/products'],
  // --- ledger definitions, sandbox and product scoped -------------------
  ['ledgers (sandbox)', '/v1/ledgers'],
  ['ledgers (product)', `/v1/products/${product}/ledgers`],
  // --- product-level device detail --------------------------------------
  ['product device detail', `/v1/products/${product}/devices/${sampleId}`],
  ['plain device detail', `/v1/devices/${sampleId}`],
  // --- diagnostics variants ---------------------------------------------
  ['diagnostics history', `/v1/diagnostics/${sampleId}`],
  // --- fleet-wide vitals / health ---------------------------------------
  ['product diagnostics', `/v1/products/${product}/diagnostics`],
  ['fleet health', `/v1/products/${product}/fleet_health`],
  ['device vitals (product)', `/v1/products/${product}/devices/${sampleId}/vitals`],
  // --- events (historical) ----------------------------------------------
  ['product events (hist)', `/v1/products/${product}/events?limit=1`],
];

(async () => {
  const results = [];
  console.log('Endpoint sweep (all GET):\n');
  for (const [label, p] of CANDIDATES) {
    const res = await get(p, { retries: 1 });
    const note =
      res.status === 200 ? 'OK'
      : res.status === 404 ? 'not found - surface does not exist'
      : res.status === 403 ? 'forbidden - scope missing'
      : res.status === 401 ? 'unauthorized'
      : '';
    console.log(`  ${label.padEnd(24)} ${p.replace(sampleId, '<id>').padEnd(52)} ${String(res.status).padStart(3)}  ${note}`);
    results.push({ label, path: p.replace(sampleId, '<id>'), status: res.status, body: res.status === 200 ? res.body : String(redact(JSON.stringify(res.body))).slice(0, 300) });
  }
  writeRaw('doorB-endpoint-sweep.json', { pulledAt: new Date().toISOString(), results });

  // --- report on anything that answered ---------------------------------
  for (const r of results.filter((x) => x.status === 200)) {
    console.log(`\n=== 200: ${r.label}  (${r.path}) ===`);
    const b = r.body;
    if (Array.isArray(b)) {
      console.log(`  array of ${b.length}`);
      if (b.length) console.log('  keys:', Object.keys(b[0]).join(', '));
      console.log(redact(JSON.stringify(b.slice(0, 3), null, 2)).slice(0, 1500));
    } else if (b && typeof b === 'object') {
      console.log('  keys:', Object.keys(b).join(', '));
      const batt = fieldInventory([b], { maxDepth: 6 }).filter((f) => /batt|power|charge|volt|soc|fuel|vcell/i.test(f.path));
      console.log('  battery-shaped paths:', batt.length ? batt.map((x) => x.path).join(', ') : 'none');
      console.log(redact(JSON.stringify(b, null, 2)).slice(0, 1800));
    }
  }

  console.log(`\nrequests=${stats.requests} rate-limited=${stats.rateLimited} backoff=${stats.backoffMs}ms`);
})();

'use strict';

/**
 * If battery is not readable from the Cloud API, something else is collecting
 * it. Integrations (webhooks) and Logic functions are where a product ships
 * telemetry off-platform, so enumerating them tells us where the py_export
 * numbers actually come from. All GET, all read-only.
 */

const { env, get, stats, writeRaw, readRaw, redact } = require('./lib');
const { product } = env();
const ORG = 'abstract-engineering-inc';

const CANDIDATES = [
  ['integrations (product)', `/v1/products/${product}/integrations`],
  ['integrations (user)', '/v1/integrations'],
  ['logic functions (org)', `/v1/orgs/${ORG}/logic/functions`],
  ['logic functions (sandbox)', '/v1/logic/functions'],
  ['ledgers (org)', `/v1/orgs/${ORG}/ledgers`],
  ['org products', `/v1/orgs/${ORG}/products`],
  ['product firmware', `/v1/products/${product}/firmware`],
  ['product config', `/v1/products/${product}/config`],
  ['product info', `/v1/products/${product}`],
];

(async () => {
  const results = [];
  console.log('Collection-layer sweep (all GET):\n');
  for (const [label, p] of CANDIDATES) {
    const res = await get(p, { retries: 1 });
    console.log(`  ${label.padEnd(26)} ${p.padEnd(50)} ${String(res.status).padStart(3)}`);
    results.push({ label, path: p, status: res.status, body: res.body });
  }
  writeRaw('collection-layer.json', { pulledAt: new Date().toISOString(), results });

  for (const r of results.filter((x) => x.status === 200)) {
    console.log(`\n========== ${r.label} ==========`);
    let b = r.body;
    // Trim firmware binaries / huge blobs before printing.
    const s = redact(JSON.stringify(b, null, 2));
    console.log(s.length > 2200 ? s.slice(0, 2200) + `\n  ...(${s.length} chars total)` : s);
  }

  console.log(`\nrequests=${stats.requests} rate-limited=${stats.rateLimited}`);
})();

'use strict';

/** Preflight: does the token + product resolve, and what scopes look present? */

const { env, get, stats, redact } = require('./lib');

(async () => {
  const { token, product } = env();
  console.log(`Preflight  product=${product}  token=${token.length} chars (value never printed)`);

  const res = await get(`/v1/products/${encodeURIComponent(product)}/devices?per_page=1`);
  console.log(`\nGET /v1/products/<product>/devices?per_page=1  ->  HTTP ${res.status}`);

  if (res.status === 401) {
    console.log('\n401 Unauthorized - the token is not valid (or expired/revoked).');
    console.log(redact(JSON.stringify(res.body)));
    process.exit(1);
  }
  if (res.status === 403) {
    console.log('\n403 Forbidden - token is valid but lacks a required scope.');
    console.log('Most likely missing: devices:list  (product device listing).');
    console.log(redact(JSON.stringify(res.body)));
    process.exit(1);
  }
  if (res.status === 404) {
    console.log('\n404 - product identifier did not resolve.');
    console.log('Check PARTICLE_PRODUCT: it should be the numeric product ID or the slug');
    console.log('from the console URL, and the token must belong to that product\'s org/team.');
    console.log(redact(JSON.stringify(res.body)));
    process.exit(1);
  }
  if (!res.ok) {
    console.log('\nUnexpected status. Body:');
    console.log(redact(JSON.stringify(res.body, null, 2)).slice(0, 2000));
    process.exit(1);
  }

  const b = res.body || {};
  console.log('\nOK. Envelope keys:', Object.keys(b).join(', '));
  if (b.meta) console.log('meta:', JSON.stringify(b.meta));
  console.log('devices returned on page 1:', Array.isArray(b.devices) ? b.devices.length : '(no devices array)');
  if (Array.isArray(b.devices) && b.devices[0]) {
    console.log('\nField names on a single device record:');
    console.log('  ' + Object.keys(b.devices[0]).sort().join('\n  '));
  }
  console.log(`\nrate-limit headers seen: ${JSON.stringify(stats.rateLimitHeaders)}`);
  console.log(`requests=${stats.requests} rate-limited=${stats.rateLimited}`);
})();

'use strict';

/**
 * Orchestrator: fetch -> normalize -> render.
 *
 * This is what Netlify runs. Any stage that throws stops the build with a
 * non-zero exit code, so a failed deploy leaves the previously published
 * page in place rather than replacing it with a partial fleet.
 */

const { fetchAll } = require('./fetch');
const { normalize, report } = require('./normalize');
const { render } = require('./render');

async function build() {
  const started = Date.now();

  await fetchAll();
  console.log('');
  report(normalize());
  console.log('');
  render();

  console.log(`\nBUILD  ok in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

build().catch((err) => {
  console.error(`\n${err.message}`);
  console.error('\nBUILD FAILED - nothing was published.');
  process.exit(1);
});

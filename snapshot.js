'use strict';

/**
 * Appends today's fleet counts to history/ as one small JSON file per day.
 *
 * Run by the daily GitHub Actions workflow, which commits the result back to
 * the repository. Netlify then picks the history up on its next build and
 * render.js turns it into the trend sparklines.
 *
 * History is what makes "are we getting better?" answerable. A single build
 * can only ever say "here is today".
 */

const fs = require('fs');
const path = require('path');
const { dailyRecord } = require('./normalize');

const DATA_FILE = path.join(__dirname, 'data', 'normalized.json');
const HISTORY_DIR = path.join(__dirname, 'history');

function writeSnapshot() {
  if (!fs.existsSync(DATA_FILE)) {
    throw new Error(`SNAPSHOT FAILED: missing ${DATA_FILE}\n  Run normalize.js first.`);
  }
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const record = dailyRecord(data);

  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const dest = path.join(HISTORY_DIR, `${record.date}.json`);

  // One record per day. A same-day re-run overwrites rather than duplicating,
  // so forcing extra refreshes never distorts the trend.
  const existed = fs.existsSync(dest);
  fs.writeFileSync(dest, JSON.stringify(record, null, 2) + '\n');

  const bytes = Buffer.byteLength(JSON.stringify(record));
  console.log(
    `SNAPSHOT  ${existed ? 'updated' : 'wrote'} history/${record.date}.json  (${bytes} bytes)  ` +
      `${Object.keys(record.properties).length} properties, ${record.triageRows} triage rows`
  );
  return dest;
}

module.exports = { writeSnapshot, HISTORY_DIR };

if (require.main === module) {
  try {
    writeSnapshot();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

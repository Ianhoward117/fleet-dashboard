'use strict';

/**
 * Stage 1 of the pipeline: pull every source workbook down to data/raw/.
 *
 * This stage is deliberately paranoid. A fleet dashboard that silently
 * renders three of four properties is worse than one that fails, because
 * a missing property looks exactly like a property with nothing wrong.
 * So: any download error, any non-xlsx payload, any workbook missing the
 * tabs we depend on, and the whole build stops here with a loud message.
 *
 * v2 seam: swap this file for a Particle API reader that writes the same
 * shape into data/raw/. Nothing downstream needs to change.
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { SHEET_IDS, PROPERTIES } = require('./config');

const RAW_DIR = path.join(__dirname, 'data', 'raw');
const EXPORT_URL = (id) => `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`;

// Every work order workbook must carry these three sheets.
const REQUIRED_WO_SHEETS = ['Room Status', 'py_export_batterystatus', 'py_export_heartbeatstatus'];

// A .xlsx is a zip archive, so it always starts with the bytes "PK".
// Google serves an HTML error page (with HTTP 200!) when a sheet is not
// publicly readable, and this is the cheapest way to catch that.
function looksLikeXlsx(buf) {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
}

class FetchError extends Error {}

async function download(key, id) {
  const url = EXPORT_URL(id);
  let res;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (err) {
    throw new FetchError(`[${key}] network request failed: ${err.message}\n  url: ${url}`);
  }
  if (!res.ok) {
    throw new FetchError(
      `[${key}] HTTP ${res.status} ${res.statusText}\n` +
        `  url: ${url}\n` +
        `  A 404 usually means the sheet ID changed; a 403 means it stopped being publicly readable.`
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!looksLikeXlsx(buf)) {
    const head = buf.subarray(0, 120).toString('utf8').replace(/\s+/g, ' ');
    throw new FetchError(
      `[${key}] response was not an .xlsx workbook (${buf.length} bytes)\n` +
        `  url: ${url}\n` +
        `  first bytes: ${head}\n` +
        `  This is what Google returns when a sheet is no longer shared publicly.`
    );
  }
  return buf;
}

/** Parse the workbook and confirm it still has the tabs we build against. */
function validateStructure(key, buf) {
  let wb;
  try {
    wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  } catch (err) {
    throw new FetchError(`[${key}] workbook downloaded but could not be parsed: ${err.message}`);
  }

  const have = wb.SheetNames;
  const missing = [];

  if (key === 'registry') {
    // Only the tabs for in-scope properties matter. The Lab and Fort Custer
    // tabs may come and go freely; 6197 has no tab by design.
    for (const p of PROPERTIES) {
      if (p.registryTab && !have.includes(p.registryTab)) missing.push(p.registryTab);
    }
  } else {
    for (const s of REQUIRED_WO_SHEETS) {
      if (!have.includes(s)) missing.push(s);
    }
  }

  if (missing.length) {
    throw new FetchError(
      `[${key}] workbook is missing required sheet(s): ${missing.map((m) => JSON.stringify(m)).join(', ')}\n` +
        `  sheets actually present: ${have.map((h) => JSON.stringify(h)).join(', ')}\n` +
        `  A renamed tab will do this. Fix the tab name in the sheet, or update config.js.`
    );
  }
  return wb.SheetNames.length;
}

async function fetchAll() {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  console.log('FETCH  downloading source workbooks');

  const entries = Object.entries(SHEET_IDS);
  const results = await Promise.allSettled(
    entries.map(async ([key, id]) => {
      const buf = await download(key, id);
      const tabCount = validateStructure(key, buf);
      const dest = path.join(RAW_DIR, `${key}.xlsx`);
      fs.writeFileSync(dest, buf);
      return { key, bytes: buf.length, tabCount };
    })
  );

  const failures = [];
  results.forEach((r, i) => {
    const key = entries[i][0];
    if (r.status === 'fulfilled') {
      const kb = (r.value.bytes / 1024).toFixed(1);
      console.log(`  ok    ${key.padEnd(9)} ${kb.padStart(7)} KB  ${r.value.tabCount} tabs`);
    } else {
      console.log(`  FAIL  ${key}`);
      failures.push(r.reason);
    }
  });

  if (failures.length) {
    const detail = failures.map((f) => (f instanceof Error ? f.message : String(f))).join('\n\n');
    throw new Error(
      `\nFETCH FAILED - ${failures.length} of ${entries.length} workbook(s) unusable.\n\n${detail}\n\n` +
        `Refusing to build: a partial fleet would hide problems rather than show them.`
    );
  }

  console.log(`FETCH  ${results.length} workbooks written to data/raw/`);
  return RAW_DIR;
}

module.exports = { fetchAll, RAW_DIR };

if (require.main === module) {
  fetchAll().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

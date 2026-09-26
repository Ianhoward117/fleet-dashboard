'use strict';

/**
 * Health check against the published site.
 *
 * The build is deliberately all-or-nothing: if a sheet is unshared, renamed
 * or malformed, fetch.js fails and Netlify publishes nothing. That is the
 * right behaviour, but from the outside it is invisible - the previous page
 * keeps serving and simply stops getting newer.
 *
 * This closes that gap. The daily workflow runs it after triggering a
 * rebuild, so a refresh that stops working becomes a failed workflow (which
 * GitHub emails about) instead of a page quietly going stale.
 *
 * Also useful by hand:  node verify-live.js
 */

const { SITE_URL, PROPERTIES } = require('./config');
// The one list of what the page may and may not carry (CUTOVER.md §9, D7).
const { PAGE_FINDING_KEYS, LOG_FINDING_KEYS } = require('./normalize');

const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

// Netlify usually publishes in well under a minute; poll generously so a slow
// build is never mistaken for a broken one.
const MAX_WAIT_MS = num('VERIFY_MAX_WAIT_MS', 6 * 60 * 1000);
const POLL_EVERY_MS = num('VERIFY_POLL_MS', 15 * 1000);

// How recent the published page must be to count as "this run refreshed it".
const MAX_BUILD_AGE_MS = num('VERIFY_MAX_BUILD_AGE_MS', 2 * 60 * 60 * 1000);

/**
 * The strong check: the timestamp that was published *before* this run
 * triggered a build. When set, the page must carry a strictly newer one,
 * which proves this run caused a rebuild rather than merely finding a recent
 * page lying around. Falls back to the age check when unset (for example on
 * a manual run, or when the site was unreachable beforehand).
 */
const NEWER_THAN = (() => {
  const raw = (process.env.VERIFY_NEWER_THAN || '').trim();
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d) ? null : d;
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pull the embedded payload back out of the published HTML. */
function parsePayload(html) {
  const m = html.match(/<script type="application\/json" id="payload">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('the published page has no embedded data payload');
  return JSON.parse(m[1]);
}

async function probe() {
  const res = await fetch(SITE_URL, { headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} from ${SITE_URL}`);
  const html = await res.text();
  const data = parsePayload(html);

  const builtAt = data.builtAt ? new Date(data.builtAt) : null;
  const ageMs = builtAt && !isNaN(builtAt) ? Date.now() - builtAt.getTime() : null;

  return { html, data, ageMs, builtAt, rooms: data.rooms ? data.rooms.length : 0 };
}

/** Every object key anywhere in a value. */
function keysIn(value, into = new Set()) {
  if (Array.isArray(value)) for (const v of value) keysIn(v, into);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      keysIn(v, into);
    }
  }
  return into;
}

/**
 * What a healthy published page carries. Checked only on the build this run
 * is waiting for: while the previous build is still being served, its shape
 * is not this run's business - right after a deploy that changes the payload,
 * the old page would fail every new check.
 *
 * Returns { problems, notes }: problems fail the run, notes are only printed.
 */
function pageProblems(html, data) {
  const problems = [];
  const notes = [];

  // Every configured property must be on the page.
  const codes = new Set((data.properties || []).map((p) => p.code));
  for (const p of PROPERTIES) {
    if (!codes.has(p.code)) problems.push(`property ${p.code} is missing from the published page`);
  }

  // The page must carry rooms; an empty fleet means something went wrong.
  if (!data.rooms || !data.rooms.length) problems.push('the published page contains no rooms');

  // Unlisted-but-public is a deliberate property of this site; if the meta
  // tag ever disappears, that is worth failing over.
  if (!/name="robots"\s+content="noindex/i.test(html)) {
    problems.push('the noindex robots meta tag is missing from the published page');
  }

  // The sheet export stamps (CUTOVER.md §7, D5): the oldest in the header and
  // one per property card. A null stamp is allowed - the export carried none
  // and the page says "unknown" - but a missing key means the page lost it.
  if (!('sheetExportAsOf' in data)) problems.push('the payload carries no sheetExportAsOf (header) stamp');
  for (const p of data.properties || []) {
    const snap = p.snapshot;
    if (!snap || !('currentTime' in snap)) {
      problems.push(`property ${p.code} carries no sheet export stamp (snapshot.currentTime)`);
    } else if (snap.currentTime === null) {
      notes.push(`property ${p.code}: the sheet export carried no stamp for it; its card reads "unknown"`);
    } else if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(snap.currentTime)) || isNaN(Date.parse(snap.currentTime))) {
      // An ISO instant, as normalize.js writes it. `new Date('Sep 25')` would
      // happily parse as 2001, so a loose check proves nothing.
      problems.push(`property ${p.code}: sheet export stamp ${JSON.stringify(snap.currentTime)} is not an ISO date-time`);
    }
  }

  // Page findings arrive whole; log-only findings never arrive at all (D7).
  const f = data.findings;
  const absent = f ? PAGE_FINDING_KEYS.filter((k) => !(k in f)) : PAGE_FINDING_KEYS;
  if (absent.length) problems.push(`page findings missing from the payload: ${absent.join(', ')}`);
  const keys = keysIn(data);
  const leaked = LOG_FINDING_KEYS.filter((k) => keys.has(k));
  if (leaked.length) problems.push(`log-only finding(s) published on the page: ${leaked.join(', ')}`);

  return { problems, notes };
}

const fmtWait = (ms) => (ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)} minutes`);

async function verifyLive() {
  console.log(`VERIFY  checking ${SITE_URL}`);
  const deadline = Date.now() + MAX_WAIT_MS;
  let last = null;
  let lastError = null;
  // What was wrong with the most recent page that was recent but failed the
  // checks, when no VERIFY_NEWER_THAN could prove it was the awaited build.
  let lastWrong = null;

  for (;;) {
    try {
      last = await probe();
      lastWrong = null;
      const mins = last.ageMs === null ? null : Math.round(last.ageMs / 60000);

      const fresh = NEWER_THAN
        ? last.builtAt && last.builtAt > NEWER_THAN
        : last.ageMs !== null && last.ageMs <= MAX_BUILD_AGE_MS;

      if (fresh) {
        const { problems, notes } = pageProblems(last.html, last.data);
        if (problems.length) {
          const wrong =
            `the published page is reachable but wrong:\n` +
            problems.map((p) => `  - ${p}`).join('\n');
          // A strictly newer builtAt proves this is the build being waited
          // for, so what is wrong with it is final. Without VERIFY_NEWER_THAN,
          // "fresh" only means recent: right after a push the previous build
          // can still be the one served, so keep polling and report this only
          // if it is still true at the deadline.
          if (NEWER_THAN) throw new Error(wrong);
          lastWrong = wrong;
          console.log(`VERIFY  the page served now fails the checks; it may be the previous build, waiting...`);
        } else {
          for (const n of notes) console.log(`VERIFY  note: ${n}`);
          console.log(
          `VERIFY  ok - published ${mins} min ago, ` +
            `${last.data.properties.length} properties, ${last.rooms} rooms` +
            (NEWER_THAN ? ' (newer than the build this run started from)' : '')
          );
          return true;
        }
      } else {
        console.log(
          NEWER_THAN
            ? `VERIFY  still serving the previous build (${last.builtAt ? last.builtAt.toISOString() : 'unknown'}), waiting...`
            : `VERIFY  page is ${mins} min old, waiting for the new build...`
        );
      }
    } catch (err) {
      // Network blips and mid-deploy 404s are expected while a build runs.
      lastError = err.message.split('\n')[0];
      console.log(`VERIFY  not ready yet: ${lastError}`);
      if (err.message.includes('reachable but wrong')) throw err;
    }

    if (Date.now() >= deadline) {
      // A recent page that never passed the checks: say what is wrong with it.
      if (lastWrong) {
        throw new Error(
          `VERIFY FAILED: ${lastWrong}\n` +
            `  (still true after ${fmtWait(MAX_WAIT_MS)}; pass VERIFY_NEWER_THAN=<the previous builtAt> ` +
            `to tell a new build from the one it replaced)`
        );
      }
      // Two different failures land here, and they need different fixes.
      const reachedOurPage = last && last.ageMs !== null;
      const detail = reachedOurPage
        ? `  The page is reachable but still shows the build from ` +
          `${last.builtAt ? last.builtAt.toISOString() : 'an unknown time'}\n` +
          `  (${Math.round(last.ageMs / 60000)} minutes old), so this run did not produce a new\n` +
          `  build. Check the Netlify deploy log:\n` +
          `  a failed build leaves the previous page serving, which is why the site\n` +
          `  still looks fine while the data quietly goes stale.`
        : `  Could not read the dashboard at all. Last error: ${lastError || 'unknown'}\n` +
          `  Either the site is down, the URL in config.js is wrong, or the deploy\n` +
          `  published something that is not the dashboard.`;

      throw new Error(
        `VERIFY FAILED: ${SITE_URL} did not refresh within ${fmtWait(MAX_WAIT_MS)}.\n${detail}`
      );
    }
    await sleep(POLL_EVERY_MS);
  }
}

/**
 * Print the timestamp currently published, or nothing if the site cannot be
 * read. The workflow captures this before triggering a build and feeds it
 * back in as VERIFY_NEWER_THAN. Never fails: an unreachable site here just
 * means the run falls back to the age check.
 */
async function currentBuiltAt() {
  try {
    const { data } = await probe();
    return data.builtAt || '';
  } catch {
    return '';
  }
}

module.exports = { verifyLive, currentBuiltAt, pageProblems };

if (require.main === module) {
  if (process.argv.includes('--current')) {
    currentBuiltAt().then((v) => {
      process.stdout.write(v + '\n');
    });
  } else {
    verifyLive().catch((err) => {
      console.error(`\n${err.message}`);
      process.exit(1);
    });
  }
}

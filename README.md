# Shower Stream — Fleet & Ops Dashboard

Internal ops tool for the Shower Stream IoT fleet in Extended Stay America
properties: **fleet health and triage**. Savings and water metrics live in a
separate dashboard and are deliberately out of scope here.

The site is **public but unlisted** — `noindex, nofollow`, an unguessable
hostname, no login. Anyone with the link can read it, so treat the link the
way you would treat the sheets themselves.

- **Live site:** <!-- NETLIFY_URL -->_(filled in once Netlify is connected)_
- **Rebuilds:** automatically every morning, plus on every push to `main`

---

## What it shows

| View | Purpose |
| --- | --- |
| **Ops triage queue** (default) | Every `Issue` and `Check` row across the whole fleet, one line each. Filter by property, status, action type and battery class; free-text search across room, device, action and notes; every column sorts. This doubles as the consolidated diagnostic register. |
| **Fleet rollup** | One card per property: installed / reporting / silent, the Ok-Issue-Check mix, a heartbeat-age histogram, battery distribution, and a prominent colour-coded **freshness badge** showing how old that property's data actually is. |
| **Reconciliation** | Where the three sources disagree: ghosts, unregistered reporters, room/device mismatches, telemetry from unlisted rooms, duplicated room rows, and per-property caveats. |

---

## Architecture

```
  Google Sheets (5 workbooks, public export URLs, read-only)
        │
        │   registry ── master device spreadsheet, one tab per property
        │   wo_6197 ─┐
        │   wo_6178  ├─ one work order workbook per property, 3 sheets each:
        │   wo_9502  │     Room Status              (human triage layer)
        │   wo_9829 ─┘     py_export_batterystatus  (voltages)
        │                  py_export_heartbeatstatus(heartbeats + snapshot time)
        ▼
  ┌──────────────┐
  │  fetch.js    │  downloads all 5 workbooks → data/raw/  (gitignored)
  │              │  FAILS THE BUILD on any HTTP error, non-xlsx payload,
  │              │  or missing tab. Never renders a partial fleet.
  └──────┬───────┘
         ▼
  ┌──────────────┐
  │ normalize.js │  merges registry ↔ telemetry ↔ triage
  │              │  cleans room floats, suite halves, NA / #N/A /
  │              │  "No device in room"; collapses registry history to the
  │              │  current device per room by latest Install Date
  │              │  → data/normalized.json + reconciliation lists
  └──────┬───────┘
         ▼
  ┌──────────────┐
  │  render.js   │  asserts its own invariants, then injects the payload
  │  template.html  into one self-contained page → dist/index.html
  └──────┬───────┘
         ▼
     Netlify (runs `node build.js`, publishes `dist/`)
```

`build.js` is the orchestrator: **fetch → normalize → render**. Any stage that
throws exits non-zero, so a failed build leaves the previously published page
up rather than replacing it with something incomplete.

**One npm dependency:** `xlsx` (SheetJS), for parsing the workbooks. Everything
else is vanilla Node and vanilla browser JS — no framework, no build tool, no
external requests from the published page.

### Why the page is one file

`dist/index.html` is entirely self-contained: CSS, JS and data inline, zero
external requests. It loads on a phone with one bar of signal in a hotel
corridor, which is where it actually gets used.

---

## Running it locally

```bash
npm install
node build.js
open dist/index.html
```

Individual stages, if you want to iterate on one:

```bash
node fetch.js       # re-download the workbooks into data/raw/
node normalize.js   # rebuild data/normalized.json and print the counts
node render.js      # rebuild dist/index.html from the existing JSON
```

`node normalize.js` prints per-property counts, the heartbeat and battery
histograms, and the full reconciliation summary. That console output is the
fastest way to sanity-check a data question without opening the page.

> `data/` and `dist/` are gitignored. Netlify rebuilds both from scratch on
> every deploy, and the raw workbooks are never committed.

---

## Refreshing the data

The dashboard is a snapshot: it shows whatever the sheets said when it was
last built.

**Automatically** — `.github/workflows/rebuild.yml` runs at `0 11 * * *`
(11:00 UTC = 06:00 CDT / 05:00 CST, so it lands before the working day in
Austin year-round) and POSTs the Netlify build hook. It can also be run on
demand from the Actions tab via **workflow_dispatch**.

**Manually, from your own machine** — force an immediate rebuild:

```bash
curl -X POST -d '{}' "$NETLIFY_BUILD_HOOK"
```

where `$NETLIFY_BUILD_HOOK` is the build-hook URL from
**Netlify → Site configuration → Build & deploy → Build hooks → `daily-refresh`**.

> **This hook URL is the only secret in the entire system.** Anyone holding it
> can trigger a rebuild (they cannot read anything or change any data). It
> lives in exactly one place — the GitHub Actions secret
> `NETLIFY_BUILD_HOOK` — and must never be committed. Every data input is a
> public URL, which is precisely why Netlify can build this without
> credentials of any kind.

---

## Editing thresholds and property metadata

Everything an operator is likely to change lives in [`config.js`](config.js).
Edit, commit, push — Netlify rebuilds automatically.

### Property display metadata

```js
const PROPERTIES = [
  { code: '6197', name: 'ESA 6197', sheetKey: 'wo_6197', registryTab: null, tag: null },
  ...
];
```

- **Array order is the order properties appear on the page.**
- `name` — free text; change it to whatever ops calls the property.
- `tag` — the small pill next to the name (`'offboarding'`, `'active-mode paused'`), or `null`.
- `registryTab` — the exact tab name in the registry workbook, or `null` when
  the property has no registry coverage.
- Removing a property from this array removes it from the dashboard entirely.
  This is how The Lab and Fort Custer stay out of scope despite having tabs in
  the registry workbook.

### Thresholds

```js
heartbeatAge:  < 2 days = fresh, 2–7 days = aging, > 7 days = stale, no heartbeat = never
snapshotFreshness: same cutoffs, applied to the age of each property's export snapshot
batteryVoltage: ok >= 3.6 V, warn >= 3.2 V, below that = critical
```

Each group carries a `confirmed` flag. **Set `confirmed: false` and the
dashboard stops classifying** — it shows raw voltages with an explicit
"unconfirmed" marker rather than presenting a guess as an engineering fact.
Use that when a cutoff is under review.

To retune battery cutoffs, change `okAbove` / `warnAbove` and push. Nothing
else needs to change.

---

## Known data quirks

Real characteristics of the source sheets, verified against live data. The
pipeline handles all of these; they are documented so nobody has to
rediscover them.

1. **6197 has no registry tab.** It is shown from triage and telemetry only
   and cannot be reconciled. The Reconciliation view says so explicitly.
2. **Room numbers are not all numeric.** Suite halves appear as
   `213a`, `245b`, `402a`… and are preserved as strings, never coerced.
   Numeric rooms arrive as floats (`102.0`) and are normalized to `102`.
3. **`py_export_batterystatus.LastHeartbeat` is unreliable** — at 6178 all
   rows carry a duration string (`"242 days 07:46:38"`) instead of a
   timestamp. That column is ignored entirely; heartbeats come from
   `py_export_heartbeatstatus`.
4. **Room Status header dates lag the machine export.** At 6178 and 9829 the
   human-typed header date is weeks older than the export's `CurrentTime`.
   Freshness badges use `CurrentTime`; the divergence is flagged in
   Reconciliation.
5. **A room can occupy several Room Status rows** (6178 rooms 202 and 301),
   each with its own action item, when a device was swapped. Every row is kept
   in the triage queue — they are separate pieces of triage — and the
   duplication is reported so row counts are never mistaken for room counts.
6. **Registry coverage is thinner than room counts** at every property, which
   is why the unregistered-reporter list is long. That is a paperwork gap, not
   a pipeline bug.

**Days-silent is measured against each property's own export snapshot**, not
against today, because that is what the source column means. The freshness
badge tells you separately how old that snapshot is, so a stale figure is
never mistaken for a current one.

---

## v2: swapping to the Particle API

`fetch.js` is the only file that knows where the data comes from. It is a
deliberate seam.

To move off the `py_export_*` sheets and read Particle directly:

1. Rewrite `fetch.js` so that instead of downloading workbooks it queries the
   Particle API and writes the same three logical tables per property.
2. Keep `readRoomStatus` reading the Room Status sheet — that layer is human
   triage and has no API equivalent.
3. **`normalize.js`, `render.js` and `template.html` do not change.**

That swap also removes the staleness problem at its source: the freshness
badges exist because the `py_export_*` sheets are refreshed by hand. With a
live API pull, every property is current by construction.

Note that a Particle API key **would** be a real secret — the first one this
system has. It would need to live in a Netlify environment variable, and the
"no secrets anywhere" property described above would no longer hold.

---

## Scope

**In:** fleet health, triage, reconciliation, for properties 6197, 6178, 9502
and 9829.

**Out:** the Particle API (v2), authentication of any kind, The Lab and Fort
Custer, savings/water metrics, and **any write back to any Google Sheet** —
this system is strictly read-only against the sheets.

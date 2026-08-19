# Shower Stream — Fleet & Ops Dashboard

Internal ops tool for the Shower Stream IoT fleet in Extended Stay America
properties: **fleet health and triage**. Savings and water metrics live in a
separate dashboard and are deliberately out of scope here.

The site is **public but unlisted** — `noindex, nofollow`, an unguessable
hostname, no login. Anyone with the link can read it, so treat the link the
way you would treat the sheets themselves.

- **Live site:** <https://ss-fleet-rxsm.netlify.app>
- **Repository:** <https://github.com/Ianhoward117/fleet-dashboard> (private)
- **Rebuilds:** automatically every morning, plus on every push to `main`

---

## What it shows

| View | Purpose |
| --- | --- |
| **Fleet rollup** (default) | One card per property: installed / reporting / silent, the Ok-Issue-Check mix, an **Issue trend** sparkline, a heartbeat-age histogram, battery distribution, and a prominent colour-coded **freshness badge** showing how old that property's data actually is. Leads because it answers "how is the fleet doing" before the room list answers "which one do I fix". |
| **All rooms** | Every room in the fleet, one line each, sorted worst-first: `Issue`, then `Check`, then `Ok`, longest-silent first within each. Filter by property, status, action type and battery class; free-text search across room, device, action and notes; every column sorts. Selecting **Issue + Check** turns this into the ops triage queue, which is also the consolidated diagnostic register. |
| **Reconciliation** | Where the three sources disagree: ghosts, unregistered reporters, room/device mismatches, telemetry from unlisted rooms, duplicated room rows, and per-property caveats. |

The status filter carries live counts — `Issue + Check (155)`, `Ok (148)` — so
the size of the queue is visible without applying the filter.

### Sharing a view

Filters, search and sort are kept in the address bar, so a filtered view is a
link. Copy the URL after filtering and the recipient sees the same rows —
`?v=rooms&prop=6178&status=attention` is 6178's work queue, and
`?v=rooms&prop=6178&action=Battery` is its battery worklist.

Links saved when a separate triage tab existed (`?v=triage`) still work: they
open the room list pre-filtered to everything needing attention.

**Export CSV** downloads exactly what is on screen — same filters, same order —
for a printable worklist rather than a webpage.

### Reading freshness

Two sources, two different kinds of age, and the page keeps them apart.

**Heartbeats are live.** They are read from the Particle Cloud API every time
the page is built, so **days-silent is counted from the build stamp in the
header** — "Heartbeats as of …". There is no per-property heartbeat staleness
any more, because there is nothing to be stale: every property is current by
construction.

**Battery is not live.** Voltages still come from the `py_export_batterystatus`
sheets, so each reading carries its own age. The room table shows that age
beside the voltage (`3.94 V  ~12d`) and the exact reading date in the
**Battery read** column. Ages are shown with a `~` and described as
approximate on purpose: the collector runs intermittently and its timestamps
are not precise enough to read as exact.

The per-property freshness badge and the header chips therefore report
**battery-data age** — the only part of a property's data that can still go
stale — on the same 2-day / 7-day colour scale as before.

---

## Architecture

```
  Google Sheets (4 workbooks, public export URLs, read-only)
        │                                    Particle Cloud API (authenticated)
        │   registry ── master device                    │
        │               spreadsheet, one tab             │  GET /v1/products/
        │               per property                     │      18173/devices
        │   wo_6197 ─┐                                   │  ~9 pages @ 100,
        │   wo_6178  ├─ one work order workbook per      │  260 ms apart
        │   wo_9502 ─┘  property, 3 sheets each:         │
        │                 Room Status      (triage)      │  last_heard per
        │                 py_export_batterystatus        │  device = the
        │                                  (voltages)    │  heartbeat truth
        │                 py_export_heartbeatstatus      │
        │                                  (room↔device) │
        ▼                                                ▼
  ┌───────────────────────────────────────────────────────────┐
  │  fetch.js   the ONLY file that knows either source exists  │
  │             workbooks + device list → data/raw/ (gitignored)│
  │             FAILS THE BUILD on any HTTP error, non-xlsx     │
  │             payload, missing tab, missing/rejected token,   │
  │             or an empty device list. Never a partial fleet. │
  └──────┬────────────────────────────────────────────────────┘
         ▼
  ┌──────────────┐
  │ normalize.js │  merges registry ↔ telemetry ↔ triage ↔ Particle
  │              │  joins ParticleDeviceId ↔ device.id for liveness
  │              │  cleans room floats, suite halves, NA / #N/A /
  │              │  "No device in room"; collapses registry history to the
  │              │  current device per room by latest Install Date
  │              │  → data/normalized.json + reconciliation lists
  └──────┬───────┘
         ▼
  ┌──────────────┐
  │  render.js   │  asserts its own invariants, then injects the payload
  │  template.html  (+ history/ + the inlined logo) into one self-contained
  └──────┬───────┘  page → dist/index.html
         ▼
     Netlify (runs `node build.js`, publishes `dist/`)


  Trend capture runs separately, in GitHub Actions rather than on Netlify,
  because only Actions can commit back to the repository:

     snapshot.js ──▶ history/YYYY-MM-DD.json ──▶ committed to main
                                                      │
                     render.js reads history/ on the next build ◀┘
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

The build needs a Particle API token. Create `.env.local` in the repo root:

```
PARTICLE_TOKEN=your-devices-list-token
```

`.env.local` is gitignored and must stay that way — it is the only place the
token lives on a developer machine. Then:

```bash
npm install
node --env-file=.env.local build.js
open dist/index.html
```

Individual stages, if you want to iterate on one:

```bash
node --env-file=.env.local fetch.js   # workbooks + Particle device list → data/raw/
node normalize.js                     # rebuild data/normalized.json and print the counts
node render.js                        # rebuild dist/index.html from the existing JSON
```

`normalize.js` and `render.js` need no token: they read what `fetch.js`
already wrote. Only `fetch.js` ever talks to the API.

Running without the token is not a soft failure — the build stops immediately,
before it downloads anything, with a message naming the variable. That is
deliberate: heartbeats are load-bearing, and a fleet rendered without them
would show every device as silent, which is the most misleading thing this
page could display.

`node normalize.js` prints per-property counts, the heartbeat and battery
histograms, and the full reconciliation summary. That console output is the
fastest way to sanity-check a data question without opening the page.

> `data/` and `dist/` are gitignored. Netlify rebuilds both from scratch on
> every deploy, and the raw workbooks are never committed.

---

## Refreshing the data

The dashboard is rebuilt, not live-updating. Heartbeats are read from the
Particle API at build time, so they are current as of the build stamp in the
header; battery, rooms and triage status show whatever the sheets said when
that build ran.

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

> **There are two secrets in this system**, and neither is ever committed:
>
> - `NETLIFY_BUILD_HOOK` — the build-hook URL. Anyone holding it can trigger a
>   rebuild; they cannot read anything or change any data. Lives in the GitHub
>   Actions secret of the same name.
> - `PARTICLE_TOKEN` — the `devices:list` API token added in v2. Lives in the
>   Netlify environment variables **and** the GitHub Actions secrets, because
>   the site build and the nightly history job each call the API independently.
>   See [v2: the Particle API](#v2-the-particle-api-shipped).
>
> Every *sheet* input is still a public URL. The Particle call is the one
> authenticated request the pipeline makes.

---

## Trend history

`snapshot.js` writes one small JSON file per day into `history/` — counts
only, roughly 800 bytes, no room detail. The daily workflow commits it, and
the next build turns the series into the Issue-trend sparkline on each rollup
card. Two days are needed before a line appears; until then the card says it
is still collecting.

A same-day re-run overwrites that day's file rather than appending, so forcing
extra refreshes never distorts the trend.

History files dated before 2026-08-19 still contain a block for property 9829,
which was removed from the dashboard that day. They are left exactly as
recorded. `render.js` drops blocks for properties no longer in `config.js`
before embedding the series, so a removed property leaves no trace on the page
and the surviving properties keep their full, unbroken trend lines. Note that
the rollup sparklines are per-property, so removing 9829 produces no step in
any line on the page; what changes is fleet-wide totals quoted elsewhere
(303 rooms rather than 421, 155 triage rows rather than 236).

To rebuild history locally without committing anything:

```bash
node fetch.js && node normalize.js && node snapshot.js
```

## When something breaks

The build is deliberately all-or-nothing: if any workbook is missing,
unshared, renamed or malformed, `fetch.js` fails and **nothing is
published**. That is the right behaviour — a partial fleet hides problems —
but it means a failure is quiet from the outside: the previous page stays up
and simply stops getting newer.

The daily workflow is the watchdog. It does not just poke Netlify — it runs
the same fetch and normalize the site does, and then checks the published
result:

```bash
node verify-live.js     # or: npm run verify
```

`verify-live.js` polls the live site and fails if the page cannot be read, is
missing a configured property, has lost its `noindex` tag, or was last
published too long ago. Because it runs as the last step of the workflow,
**any of those turns into a failed GitHub Actions run**, and GitHub emails the
account that owns the schedule. That covers the case Netlify cannot: a build
that failed, leaving yesterday's page serving.

Inside the workflow the check is stricter than a plain freshness test. The
published timestamp is recorded *before* anything triggers a build
(`node verify-live.js --current`) and passed back in as `VERIFY_NEWER_THAN`,
so the page must come back **strictly newer**. Without that, a build could
fail while a page from a few minutes earlier still satisfied the age
tolerance — the check would pass and prove nothing.

Tolerances are environment-overridable, which is also how the failure paths
get tested: `VERIFY_MAX_WAIT_MS`, `VERIFY_POLL_MS`, `VERIFY_MAX_BUILD_AGE_MS`,
`VERIFY_NEWER_THAN`.

Run it by hand any time to answer "is the dashboard actually current?".

### Who gets told

**Alerts go to the GitHub account that owns the schedule** — currently
`Ianhoward117`. Netlify's own deploy-failure email is a **Pro** feature and is
not enabled on this site, so GitHub Actions is the notification channel.

Confirm it is switched on at least once: GitHub → Settings → Notifications →
Actions → *"Send notifications for failed workflows only"* (the default).

There is deliberately **no alert to a shared inbox yet**, because the fleet
has one owner today. When that changes, in rough order of effort:

1. **HTTP POST request** (Netlify → Notifications, free) — post deploy events
   to a Slack incoming webhook. Best fit if the team lives in Slack.
2. **A GitHub account for the shared inbox**, added as a collaborator and
   watching the repo, so it receives the same failure emails.
3. **GitHub commit status** (Netlify → Notifications, free) — puts deploy
   success/failure on the commit; a passive signal rather than a push.
4. **Netlify Pro** — native email to any address, if it is worth the
   subscription for one feature.

The two passive signals remain useful either way: the **freshness badges**,
and the **"Page built"** timestamp in the header. If "Page built" is more than
a day old, the refresh is not completing.

When a build does fail, read the Netlify deploy log first — `fetch.js` names
the property and the likely cause (404 = sheet ID changed, 403 = no longer
publicly readable, missing tab = renamed sheet).

## Editing thresholds and property metadata

Everything an operator is likely to change lives in [`config.js`](config.js).
Edit, commit, push — Netlify rebuilds automatically.

### Property display metadata

```js
const PROPERTIES = [
  { code: '6197', name: 'Round Rock - Southwest', sheetKey: 'wo_6197', registryTab: null, tag: null },
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
4. **Room Status header dates lag the machine export.** At 6178 the
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

## v2: the Particle API (shipped)

Heartbeats come from the Particle Cloud API. Battery, room mapping and triage
status stay on the sheets, and always will: a read-only probe of the API
([`probe/FINDINGS.md`](probe/FINDINGS.md)) established that battery is not
exposed anywhere in the Cloud API for this hardware — these are P2 modules with
no fuel gauge — and that no room identifier ever appears in a Particle payload.

### The one endpoint

```
GET https://api.particle.io/v1/products/18173/devices
```

That is the whole surface, and it is the only endpoint this pipeline is
permitted to call. It reads cloud-held records and touches no hardware.
Anything that commands or wakes a device — function calls, ping, signal,
rename, claim, flash, and the per-device vitals GET, which asks the device to
report — is out of bounds. These are physical units plumbed into occupied hotel
water lines. `config.js` derives the path from the product id so there is one
place to change it and no way to point it at a device-level route by accident.

Paginated 100 at a time, ~9 pages, 260 ms apart to stay under 4 requests/second.
No rate limiting has ever been observed, and Particle returns no
`X-RateLimit-*` headers to budget against, so the pacing stays conservative by
convention.

### The token

The first real secret this system has. It is a Particle **API user** token
scoped to **`devices:list` only** — API users cannot log into the Console, and
their tokens do not expire.

It must be set in **two** places, and the site and the nightly job fail
independently without it:

| Where | Why | How |
|---|---|---|
| Netlify environment variable | the site build runs `node build.js` | Site configuration → Environment variables → `PARTICLE_TOKEN` |
| GitHub Actions secret | the daily workflow runs `fetch.js` to record history | Settings → Secrets and variables → Actions → `PARTICLE_TOKEN` |
| `.env.local` (local only, gitignored) | developer machines | see *Running it locally* |

The token never appears in the repository, in build output, or in an error
message. `fetch.js` sends it only in an `Authorization` header and scrubs
credential-shaped text out of anything bound for a log, because a Netlify build
log is a public artefact.

### Rotating the token

Create the replacement before revoking the old one — the two overlap happily,
since nothing about the call is stateful. Mint a new API user on product 18173
scoped to `devices:list`, update the Netlify environment variable and the
GitHub Actions secret, then trigger a build and confirm it goes green before
deleting the old API user in the Console. If you revoke first, the next build
fails with `HTTP 401 — the token was rejected`, the published page stays up
untouched, and the fix is simply to set the new value. Rotation is therefore
safe to do at any time; the failure mode is a stale page, never a wrong one.

If a token is ever exposed, revoke it first and accept the failed builds. A
`devices:list` token can only enumerate device metadata, but it should still be
treated as a credential.

---

## Scope

**In:** fleet health, triage, reconciliation, for properties 6197, 6178 and
9502.

**Out:** the Particle API (v2), authentication of any kind, The Lab and Fort
Custer, savings/water metrics, and **any write back to any Google Sheet** —
this system is strictly read-only against the sheets.

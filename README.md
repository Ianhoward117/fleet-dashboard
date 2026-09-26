# Shower Stream — Fleet & Ops Dashboard

Internal ops tool for the Shower Stream IoT fleet in Extended Stay America
properties: **fleet health and triage**. Savings and water metrics live in a
separate dashboard and are deliberately out of scope here.

The site is **public but unlisted** — `noindex, nofollow`, an unguessable
hostname, no login. Anyone with the link can read it, so treat the link the
way you would treat the sheets themselves.

- **Live site:** <https://ss-fleet-rxsm.netlify.app>
- **Repository:** <https://github.com/Ianhoward117/fleet-dashboard> (GitHub
  reports it as **public**)
- **Rebuilds:** automatically every morning, plus on every push to `main`

---

## Where the numbers come from

Two sources, and nothing else.

| Source | What it supplies |
| --- | --- |
| **Priya's consolidated workbook** (one Google Sheet, read through its public export URL, never written to) | `roomstatus`: every room, its `Location` (the property), its `DeviceId`, triage `Status`, `Action Item`, notes and battery voltage. `batterystatus`: when each battery reading was taken. `heartbeatstatus`: the export's own timestamp, and — for devices no room holds — which property the export places them in. |
| **Particle Cloud API** (`GET /v1/products/18173/devices`, read-only) | When each device was last heard from, and its name. This is the heartbeat truth. |

**Which device is in which room** comes from exactly one place: the room's
`DeviceId` cell in `roomstatus`. A blank cell means the room has no device.
There is no fallback — no registry, no override file, no guessing from notes.

The three legacy work-order workbooks, the registry workbook and the
room-override file were retired when the dashboard moved onto the
consolidated workbook, and their code has since been deleted. See
[`CUTOVER.md`](CUTOVER.md) for why; the git tag `pre-cutover` is the last build
that used them.

---

## What it shows

| View | Purpose |
| --- | --- |
| **Fleet rollup** (default) | One card per property: rooms / reporting / never heard / no device, the Ok-Issue-Check mix, status and heartbeat trends, a heartbeat-age histogram, the battery distribution, the property's **sheet export stamp**, and a colour-coded **battery-data badge**. A fleet strip on top trends total triage rows and devices awaiting room mapping. Leads because it answers "how is the fleet doing" before the room list answers "which one do I fix". |
| **All rooms** | Every room in the fleet, one line each, sorted worst-first: `Issue`, then `Check`, then `Ok`, longest-silent first within each. Filter by property, status, action type, battery class, **heartbeat state** and **sheet finding**; free-text search across room, device, action, notes and findings; every column sorts. Selecting **Issue + Check** turns this into the ops triage queue. |
| **Reconciliation** | Where the data disagrees with itself: a **sheet findings** summary (F1–F4, below), devices that are live but in no room, duplicated room rows, and room devices Particle does not know. |

The status filter carries live counts — `Issue + Check (62)`, `Ok (257)` on
the Sep 25 export — so the size of the queue is visible without applying it.

### Sharing a view

Filters, search and sort are kept in the address bar, so a filtered view is a
link. Copy the URL after filtering and the recipient sees the same rows:

| Link | Shows |
| --- | --- |
| `?v=rooms&prop=6178&status=attention` | 6178's work queue |
| `?v=rooms&prop=6178&action=Battery` | 6178's battery worklist |
| `?v=rooms&flag=F4` | every room whose note names a unit the sheet does not show |
| `?v=rooms&hb=noDevice` | every room with no device |

Links saved when a separate triage tab existed (`?v=triage`) still work: they
open the room list pre-filtered to everything needing attention.

**Export CSV** downloads exactly what is on screen — same filters, same order —
for a printable worklist rather than a webpage. It includes each room's
heartbeat state and its findings in plain words.

### The three stamps

The header carries three times, and each means something different.

| Stamp | Means |
| --- | --- |
| **Sheet export as of** | When Priya's export was taken (the `CurrentTime` in `heartbeatstatus`). The header shows the **oldest** of the three properties'; each card shows its own. |
| **Heartbeats as of** | When the Particle device list was read — which is when the page was built. Days-silent is counted from here. Heartbeats are live, so they cannot be stale. |
| **Page built** | When this page was generated. If it is more than a day old, the daily refresh is not completing. |

**A red banner above every view** means the page was built more than 7 days ago (`THRESHOLDS.pageAge`): the daily refresh has stopped landing, so read every figure as out of date. If it says instead that it cannot tell when it was built, the page itself is malformed.

None of these vouches for **battery** data. Battery readings are taken by a
separate collector and can be much older than the export that carries them —
the Sep 25 export carried readings from Sep 17. That is what the **battery-data
badge** on each card (and the chips in the header) is for: it reports how old
that property's battery readings are, on the confirmed 2-day / 7-day scale.
Ages are shown with a `~` because the collector's timestamps are approximate.

### Heartbeat states: no device is not never

Every room is in exactly one heartbeat state, and the card's bars always add
up to its room count.

| State | Means |
| --- | --- |
| **< 2 days / 2–7 days / > 7 days** | The room's device was last heard from that long ago. |
| **Never** | The sheet names a device, but Particle has never heard from it, does not know it, or the `DeviceId` is not a device id at all. Something is wrong with the unit or the sheet. |
| **No device** | The room's `DeviceId` is blank. The sheet says there is nothing to hear from. That is a different statement from "a device that has never reported", and the page keeps the two apart everywhere: on the card, in the Days silent column, in the Heartbeat filter and in the CSV. |

### Sheet findings (F1–F4)

The consolidated sheet is the source of truth, and the dashboard never
corrects it. Where the sheet contradicts itself or Particle, the room is
**flagged** — never dropped, never "fixed", and never a reason to fail the
build. Each flagged room carries a tag in All rooms; hover it for the reason.

| Flag | In plain words | Example tooltip |
| --- | --- | --- |
| **F1** | One device is listed in two or more rooms. | `F1 · P2-0433 is also listed in 9502/308, another property` |
| **F2** | The room's property disagrees with the property tag the device carries in Particle. | `F2 · P2-0433 is tagged esa_6178 in Particle, which belongs to 6178` |
| **F3** | `DeviceId` is not a usable device id — it is text, a spreadsheet error, or an id Particle does not know. The room reads **Never**. | `F3 · DeviceId holds the spreadsheet error #REF!` |
| **F4** | A note says a replacement unit was installed, but the `DeviceId` column does not show it. | `F4 · note names P2-0556; DeviceId shows P2-0615` |

Two caveats the Reconciliation summary states beside the counts:

- **F2 can only check tagged devices.** Many devices carry no property tag in
  Particle, and F2 cannot look at those. Its coverage is shown per property —
  on the Sep 25 export, 6197 93.4 % · 6178 86.3 % · 9502 32.1 % of rooms with a
  device — so a low F2 count at 9502 is not a clean bill of health.
- **A note that records a replacement without naming the unit** ("Replaced
  device on 9/23/26") is tagged F4 but drawn dashed and counted separately.

A typed placeholder in `DeviceId` (`NA`, `No device`, `-`) means **no device**,
not F3.

---

## Architecture

```
  Google Sheets (1 workbook, public export URL, read-only)
        │                                    Particle Cloud API (authenticated)
        │   consolidated workbook, 3 tabs read:          │
        │     roomstatus       rooms, DeviceId,          │  GET /v1/products/
        │                      triage, voltage           │      18173/devices
        │     batterystatus    battery reading times     │  ~9 pages @ 100,
        │     heartbeatstatus  export stamp; Location    │  260 ms apart
        │                      of devices in no room     │
        │   (devicenames exists and is not read)         │  last_heard per device
        ▼                                                ▼  = the heartbeat truth
  ┌───────────────────────────────────────────────────────────┐
  │  fetch.js   the ONLY file that knows either source exists  │
  │             workbook + device list → data/raw/ (gitignored) │
  │             10 requests: 1 workbook + 9 Particle pages      │
  │             FAILS THE BUILD on any HTTP error, non-xlsx     │
  │             payload, missing tab, missing/rejected token,   │
  │             or an empty device list. Never a partial fleet. │
  └──────┬────────────────────────────────────────────────────┘
         ▼
  ┌──────────────┐
  │ normalize.js │  room → device = roomstatus.DeviceId, else no device
  │              │  liveness and names from Particle, by device id
  │              │  sheet times read as America/Chicago, DST-aware
  │              │  F1–F4 findings, attribution of live-but-unmapped
  │              │  FAILS only on structure: missing tab or header, a
  │              │  property with no rows, a row landing in two properties
  │              │  → data/normalized.json (page findings + log findings)
  └──────┬───────┘
         ▼
  ┌──────────────┐
  │  render.js   │  asserts its own invariants, windows history/ by date,
  │  template.html  injects payload + logo into one self-contained page
  └──────┬───────┘  → dist/index.html
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

**One npm dependency:** `xlsx` (SheetJS), for parsing the workbook. Everything
else is vanilla Node and vanilla browser JS — no framework, no build tool, no
external requests from the published page.

### What reaches the page, and what does not

`normalize.js` writes two kinds of finding. **Page findings** — F1–F4 and F2's
coverage — are shipped to the page. **Log findings** — telemetry rows for
devices no room holds, rows outside the three properties, rows with no room
number, notes that name an out-of-scope site, devices tagged for two
properties, sheet hygiene — stay in `data/normalized.json` and the build log,
and never reach the page. `render.js` fails the build if one does.

The names of out-of-scope sites (The Lab, Fort Custer, ESA 9829) must never
appear in a structured field of the page; that also fails the build. A
free-text **note** that mentions one is the exception: the note is what a person
wrote about that room, so it renders as written and the build log records it.

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
node --env-file=.env.local fetch.js   # workbook + Particle device list → data/raw/
node normalize.js                     # rebuild data/normalized.json and print the counts
node render.js                        # rebuild dist/index.html from the existing JSON
npm test                              # unit tests; each suite runs under UTC and America/Chicago
```

`normalize.js` and `render.js` need no token: they read what `fetch.js`
already wrote. Only `fetch.js` ever talks to the API.

Running without the token is not a soft failure — the build stops immediately,
before it downloads anything, with a message naming the variable. That is
deliberate: heartbeats are load-bearing, and a fleet rendered without them
would show every device as silent, which is the most misleading thing this
page could display.

`node normalize.js` prints per-property counts, the heartbeat and battery
histograms, every finding (page and log) and the reconciliation summary. That
console output is the fastest way to sanity-check a data question without
opening the page.

> `data/` and `dist/` are gitignored. Netlify rebuilds both from scratch on
> every deploy, and the raw workbook is never committed.

---

## Refreshing the data

The dashboard is rebuilt, not live-updating. Heartbeats are read from the
Particle API at build time, so they are current as of the build stamp in the
header; rooms, triage status and battery show whatever the sheet export said
when that build ran — see its stamp.

**Automatically** — `.github/workflows/rebuild.yml` runs at `0 11 * * *`
(11:00 UTC = 06:00 CDT / 05:00 CST, so it lands before the working day in
Austin year-round), records the day's counts, and triggers a Netlify build. It
can also be run on demand from the Actions tab via **workflow_dispatch**.

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
> - `PARTICLE_TOKEN` — the `devices:list` API token. Lives in the Netlify
>   environment variables **and** the GitHub Actions secrets, because the site
>   build and the daily history job each call the API independently. See
>   [The Particle API](#the-particle-api).
>
> The sheet input is a public URL. The Particle call is the one authenticated
> request the pipeline makes.

---

## Trend history

`snapshot.js` writes one small JSON file per day into `history/` — counts
only, roughly a kilobyte, no room detail. The daily workflow commits it, and
the next build turns the series into sparklines. A record is filed under the
**UTC date of the build** that wrote it; a same-day re-run overwrites that
day's file rather than appending, so forcing extra refreshes never distorts
the trend.

### Charts are drawn by date

The trend window is the **last 30 calendar days**, ending on the build date,
and each point sits on its own date. A day with no record is simply empty:
the line breaks there and picks up again on the next recorded day. Between
2026-09-16 and 09-24 the daily refresh failed and wrote no records, so every
chart shows that stretch as a gap — the line never joins Sep 15 straight to
Sep 25 as if nothing had happened between them. The trends caption names the
missing days, and the key under each line says how many days it covers and
how many were not recorded.

### What is plotted

On each **property card**:

| Trend | Form |
| --- | --- |
| **Status trend** | Ok / Check / Issue as three thin lines on one shared scale |
| **Devices heard from** | `liveUnder2d` — rooms whose device was heard in the last two days |
| **Awaiting room mapping** | `unmappedLive` — shown only where the series has ever been nonzero |

A shared scale is what keeps three flat lines at three distinct heights
instead of collapsing them onto one track. It also means two genuinely close
values sit close together; that is the honest reading, and the key beside the
chart carries the exact numbers.

On the **fleet strip** at the top of the rollup: total triage rows, and
fleet-wide `unmappedLive`, which is the sum of the property cards. Records
written before the move to the consolidated workbook also counted devices no
property could claim (60 on Sep 15), so that line steps down at the cutover
for a clerical reason, and its marker says so.

### The gap rule

**A value that was not recorded renders as a gap, never a zero.** That covers
two cases:

- **a missing day** — no record was written (the Sep 16–24 outage);
- **a missing field** — a record written before the field existed.
  `liveUnder2d` and `unmappedLive` only begin on 2026-08-20; `null` and
  non-numeric values count as absent too.

Lines break at gaps and resume; nothing is interpolated across them, and an
isolated point is drawn as a dot so a single recorded day is never silently
dropped. A series with fewer than two points shows its current value plus
"tracking since &lt;date&gt;" as text rather than a degenerate one-point line.

### Markers on the charts

Some steps in a series are clerical, not field events — a property leaving the
dashboard, a change of data source. Each is marked with a dashed vertical line
and a label, on **every chart it moves** and no others. The markers are
listed under the fleet strip and on each affected card.

### Editing trends

Both knobs live in the `TRENDS` block in `config.js`:

```js
const TRENDS = {
  windowDays: 30,
  annotations: [
    { date: '2026-08-20', label: '9829 removed', charts: ['fleet'] },
    { date: '2026-08-29', label: '6178 override -> merge', charts: ['fleet', '6178'] },
  ],
};
```

- **`windowDays`** — how many trailing calendar days the charts cover. Only
  records dated inside the window are shipped to the page. Nothing is lost
  either way: `history/` keeps every record ever written.
- **`annotations`** — each entry declares its `charts`: `'all'`, or a list of
  `'fleet'` (the fleet strip) and property codes (that property's card). The
  build fails on an entry without one. Date an entry on the **first record that
  carries** the new value; a marker is drawn only on a day that has a record.
  Add an entry whenever a property joins or leaves `PROPERTIES`, or a source
  change moves a series.

### 9829 and the step on the fleet line

History files dated before 2026-08-20 still contain a block for property 9829,
which was removed from the dashboard. They are left exactly as recorded.
`render.js` drops blocks for properties no longer in `config.js` before
embedding the series, so a removed property leaves no trace on the cards.
Fleet-level fields are left exactly as recorded, so the fleet triage line
carries a real step on 2026-08-20 — 236 rows down to 155. That is 9829 leaving
the dashboard, not 81 rooms getting fixed, and the `9829 removed` marker says
so.

`history/` is a record: never create, edit or delete a file in it by hand,
and never write one for a test. To see what today's record would be without
committing anything, run `node --env-file=.env.local fetch.js && node normalize.js`
and read the counts it prints.

## When something breaks

The build is deliberately all-or-nothing: if the workbook is missing,
unshared, renamed or malformed, `fetch.js` fails and **nothing is
published**. That is the right behaviour — a partial fleet hides problems —
but it means a failure is quiet from the outside: the previous page stays up
and simply stops getting newer.

Sheet *contradictions* never fail the build — they become findings (F1–F4).
Only structure does: a missing tab or required header, a property with no
rows, or a row that lands in more than one property.

The daily workflow is the watchdog. It does not just poke Netlify — it runs
the same fetch and normalize the site does, and then checks the published
result:

```bash
node verify-live.js     # or: npm run verify
```

`verify-live.js` polls the live site and fails if the page cannot be read, was
not rebuilt in time, is missing a configured property or its rooms, has lost
its `noindex` tag, is missing its sheet export stamps or any page finding, or
carries a log-only finding. It checks the page's contents only once the new
build is being served, so a deploy that changes the page's shape is not
failed on the old page still being served. Because it runs as the last step of
the workflow, **any of those turns into a failed GitHub Actions run**, and
GitHub emails the account that owns the schedule. That covers the case Netlify
cannot: a build that failed, leaving yesterday's page serving.

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

The passive signals remain useful either way: the **battery-data badges**, and
the **"Page built"** timestamp in the header. If "Page built" is more than a
day old, the refresh is not completing.

When a build does fail, read the Netlify deploy log first — `fetch.js` and
`normalize.js` name the cause (404 = sheet ID changed, 403 = no longer publicly
readable, missing tab or header = a renamed sheet or column).

### Rolling back

If a deploy publishes something wrong, roll back in Netlify — **Deploys → the
last good deploy → Publish deploy** — rather than rewriting `main`. Then fix
forward.

## Editing thresholds and property metadata

Everything an operator is likely to change lives in [`config.js`](config.js).
Edit, commit, push — Netlify rebuilds automatically.

### Property display metadata

```js
const PROPERTIES = [
  { code: '6197', name: 'Round Rock - Southwest', tag: null },
  ...
];
```

- **Array order is the order properties appear on the page.**
- `code` — the property number; it is also the value of the sheet's
  `Location` column.
- `name` — free text; change it to whatever ops calls the property.
- `tag` — the small pill next to the name (`'active-mode paused'`), or `null`.
- Removing a property from this array removes it from the dashboard entirely.
  Its rows in the sheet are then dropped and logged, never counted. Add a
  `TRENDS` annotation when you do.

### Thresholds

```js
heartbeatAge:   < 2 days = fresh, 2–7 days = aging, > 7 days = stale,
                heard never = Never, blank DeviceId = No device
batteryAge:     same 2 / 7-day cutoffs, applied to battery-reading age (the badges)
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

Real characteristics of the consolidated sheet, verified against live data.
The pipeline handles all of these; they are documented so nobody has to
rediscover them.

1. **`DeviceId` is mostly a lookup formula.** Most cells look the room up in
   `heartbeatstatus`, so they move whenever Priya re-exports; a few are typed
   by hand, and **typed cells do not follow re-exports**. A unit that has never
   reported can only be placed by typing its id. The build reads the value the
   sheet last calculated.
2. **Sheet times are Central.** The export writes America/Chicago wall-clock
   times with no zone attached. The build reads them as Central, DST included,
   so a battery age is the same whether the build runs in Austin or on
   Netlify.
3. **`Location` is a number** (`6197`), while property codes are text; the
   build converts it before comparing, because a number never equals a string
   and every row would silently vanish.
4. **`roomstatus` row 1 is a counter, not a header.** The header is row 2.
5. **Room numbers are not all numeric.** Suite halves such as `213a` are
   preserved as strings, never coerced. Numeric rooms arrive as floats
   (`102.0`) and are normalized to `102`.
6. **A room can occupy several rows**, each with its own action item. Every
   row is kept in the triage queue and the duplication is reported, so row
   counts are never mistaken for room counts.
7. **Battery readings can lag the export.** The Sep 25 export carried battery
   rows unchanged since Sep 17. Read the battery badge, not the export stamp,
   for battery freshness.
8. **The page's device names come from Particle**, by device id — not from the
   sheet's `Device#` text column, which is never read. The two disagree for a
   few units (`P2-0823` in the sheet, `P-0823` in Particle).

**Days-silent is measured against build time**, because heartbeats are read
live from Particle when the page is built.

---

## The Particle API

Heartbeats come from the Particle Cloud API. Battery, room mapping and triage
status stay on the sheet, and always will: a read-only probe of the API
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
With the workbook, a build makes **10 requests** in all. No rate limiting has
ever been observed, and Particle returns no `X-RateLimit-*` headers to budget
against, so the pacing stays conservative by convention.

### The token

It is a Particle **API user** token scoped to **`devices:list` only** — API
users cannot log into the Console, and their tokens do not expire.

It must be set in **two** places, and the site and the daily job fail
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

**In:** fleet health, triage and reconciliation for properties 6197, 6178 and
9502.

**Out:** authentication of any kind; The Lab and Fort Custer; savings and
water metrics (the sheet's `Calibration Risk` column is read and kept in the
data, but never shown); and **any write back to any Google Sheet** — this
system is strictly read-only against the sheet.

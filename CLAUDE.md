# CLAUDE.md — Shower Stream Fleet & Ops Dashboard

Internal ops tool for the Shower Stream IoT fleet in Extended Stay America
properties: **fleet health and triage**. Savings/water metrics live in a
separate dashboard and are out of scope.

- **Live:** https://ss-fleet-rxsm.netlify.app (public but unlisted, `noindex`)
- **Repo:** https://github.com/Ianhoward117/fleet-dashboard — **PUBLIC**, as
  `gh repo view --json visibility` reports it (checked 2026-09-25; earlier
  versions of this file said "private", which was wrong)
- **Owner:** Ian Howard, co-founder, Abstract Engineering Inc.

`README.md` is the user-facing doc. `CUTOVER.md` is the contract for the move
onto the consolidated workbook and records every decision behind it (§9).
This file is the working context: current state, decisions, and the traps.

---

## Environment traps (these will waste your time otherwise)

### Machine and accounts

- **Node is not on the non-interactive PATH.** Prefix every command:
  `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$HOME/.local/bin:$PATH"`
  (`gh` lives at `~/.local/bin/gh`; no Homebrew on this machine).
- **`gh` has two accounts: `Ianhoward117` and `TXIC-UT`.** The repo belongs to
  Ianhoward117; never use TXIC-UT. If git says *"Repository not found"*, the
  active account has drifted: `gh auth status`, then
  `gh auth switch --user Ianhoward117`.
- **The macOS keychain holds a stale TXIC-UT token**, so plain git auth fails
  even when `gh` is right. A repo-local override routes git through `gh`:
  `credential.https://github.com.helper = !gh auth git-credential`.
- **`app.netlify.com` and `localhost` are blocked in the Claude browser pane.**
  Netlify changes are Ian's to make: guide, do not drive.
- **Headless Chrome on this Mac often does not exit** after `--dump-dom` or
  `--screenshot`, on any page, even a plain one with no script. The output is
  written first, so wrap the call in `perl -e 'alarm 15; exec @ARGV' ...` and
  expect exit 142. It will not lay out narrower than 500 px either: check phone
  width by loading the page in a 390 px iframe.
- **The daily bot commits to `main`.** Always `git pull --rebase` before
  pushing. A stale checkout makes `git diff origin/main` look like it deletes
  history files; it does not — they are commits you have not pulled.
- **The build needs `PARTICLE_TOKEN`**, in `.env.local` (gitignored) locally:
  `node --env-file=.env.local build.js`. A bare `node build.js` fails at once by
  design. The probe keeps its own broader `PARTICLE_PROBE_TOKEN`. Never print
  either, in any form.

### The sheet

- **`DeviceId` is (mostly) a single-cell ARRAY formula.** 282 of 319 cells are
  `IFNA(INDEX(heartbeatstatus!A:A, MATCH(1, (heartbeatstatus!F:F=A3) *
  (heartbeatstatus!B:B=B3), 0)), "")` — a two-key (Location, RoomNumber)
  lookup that only works array-evaluated. SheetJS never calculates: the build
  reads the value Google Sheets **cached** in the export. Consequences:
  a formula cell moves whenever Priya re-exports; the **35 typed cells freeze**
  and never follow a re-export; `""` (15 cells today) means no device; a
  broken lookup arrives as an error cell, which `sheet_to_json` would silently
  turn into a blank — `restoreErrorCells` puts the text back so it becomes F3,
  not "no device". If a DeviceId ever reads wrong, look at the cell's formula
  and cached value before touching the code.
- **Sheet times are America/Chicago wall clock with no zone attached.** They
  are read with `cellDates: false` and parsed by `parseSheetDateTime`, which
  turns an Excel serial into wall-clock fields by arithmetic and then into an
  instant via `Intl`, DST-aware (`SHEET_TIME_ZONE` in config). **Never** let
  SheetJS or `new Date()` build a Date from a sheet value: it uses the host
  zone, so Austin and Netlify would disagree by 5–6 h. A daily record's
  per-property `snapshot` is the **Chicago calendar date** (`zonedDate`), not
  an ISO slice. The suites run under both `TZ=UTC` and `TZ=America/Chicago`
  and fail unless the results are identical. The Nov 1 switch to CST is still
  unconfirmed against real data (CUTOVER.md §12 Q11).
- **`Location` is a number** (`6197`); property codes are strings. It goes
  through `locationCode()` before any comparison, or every row silently
  vanishes (roomstatus is then caught by the zero-rows check; heartbeatstatus
  is not caught at all).
- **`roomstatus` row 1 is a counter formula**; the header is row 2
  (`range: 1`). The other tabs have their header on row 1.
- **The sheet's `Device# ` column is never read** (D8). A room's device name is
  Particle's name for its `DeviceId`. No name is ever resolved into an
  assignment — resolving `P-0351` by name is exactly what caused the Sep 16–24
  outage (CUTOVER.md §0).

### The page

- **History dates are date-only (`YYYY-MM-DD`): format them with `fmtDay()`
  in `template.html`**, never `fmtDateShort()`. `new Date('2026-08-20')` is UTC
  midnight and renders as Aug 19 anywhere west of Greenwich. To *count* days
  the page uses `dayNumber()` (via `Date.UTC`), which is zone-free.
- **Trends are drawn by calendar date (H1).** The window is the last
  `TRENDS.windowDays` (30) days ending on the build's **UTC** date; `render.js`
  ships only records dated inside it, sorted by date. x is the date, so a
  missing day is a gap — the gap rule covers missing days as well as missing
  fields. A trailing gap is normal before that day's record is written.
- **Every `TRENDS` annotation declares `charts`** (`'all'`, or `'fleet'` and
  property codes), or the build fails (H2). A marker draws only on a day that
  has a record, on every chart in scope. Date it on the **first record that
  carries** the new value, not the day the change shipped.
- **Same-day history overwrite.** `snapshot.js` files a record under the UTC
  date of its build, and a same-day re-run — including a manual
  `workflow_dispatch` — overwrites that day's file. So a change merged before
  00:00 UTC replaces that day's record, old values and all (they stay in git
  history). Never create, edit or delete a `history/` file by hand, and never
  write one for a test.
- **D7: out-of-scope names.** `OUT_OF_SCOPE_NAMES` (config) — The Lab, Fort
  Custer, ESA 9829 — in any **structured** field of the payload fails the
  build. Free-text **notes** are the only exemption: a note hit renders as
  written and is logged (`notesNamingOutOfScope`). `Action Item` counts as
  structured. The exempt paths are exactly those blanked in `blankFreeText()`
  in `render.js`; a new free-text field on the page has to be added there, or
  it is scanned as structured.
- **Page findings vs log findings.** `PAGE_FINDING_KEYS` and
  `LOG_FINDING_KEYS` in `normalize.js` are the one list. `render.js` ships the
  first and fails the build if any key of the second appears anywhere in the
  payload; `verify-live.js` checks the same on the live page.
- **`verify-live.js` checks the page's shape only on the build it is waiting
  for.** While the previous build is still served it just waits, so a deploy
  that changes the payload is not failed on the old page. Without
  `VERIFY_NEWER_THAN` it cannot tell a recent old page from the new one, so a
  page failing the checks is polled until the deadline before it fails; pass
  `VERIFY_NEWER_THAN=<previous builtAt>` when checking a specific deploy.

## Commands

```bash
node --env-file=.env.local build.js      # fetch -> normalize -> render (what Netlify runs)
node --env-file=.env.local fetch.js      # 1 workbook + 9 Particle pages = 10 requests -> data/raw/
node normalize.js    # rebuild data/normalized.json; prints counts, every finding, the log findings
node render.js       # rebuild dist/index.html from existing JSON (+ history/)
node snapshot.js     # write today's record to history/  (the workflow does this; not by hand)
npm test             # cutover + page suites; each re-runs itself under TZ=UTC and America/Chicago
node verify-live.js  # health-check the published site   (npm run verify)
node verify-live.js --current   # print the live builtAt, nothing else
```

`node normalize.js` printing the per-property counts is the fastest way to
answer a data question without opening the page.

## Architecture

`config.js` → `fetch.js` → `normalize.js` → `render.js` + `template.html` →
`dist/index.html`, orchestrated by `build.js`. One npm dependency: `xlsx`.
Everything else is vanilla Node and vanilla browser JS.

- **Sources:** the consolidated workbook (`SHEET_IDS.consolidated`) — tabs
  `roomstatus`, `batterystatus`, `heartbeatstatus` (`devicenames` exists and is
  not read) — and Particle `GET /v1/products/18173/devices`. `fetch.js` is the
  only file that knows either exists.
- **Room → device: `roomstatus.DeviceId` → null.** That is the whole chain. No
  override, no registry, no heartbeatstatus or battery lookup by room, no
  notes.
- **Liveness and display name:** Particle, by device id. Days-silent is
  measured against build time. Buckets: fresh / aging / stale / never, plus
  **noDevice** for a blank `DeviceId` (D11) — never and no device are
  different statements and are kept apart everywhere.
- **Battery:** voltage is the `roomstatus` column (itself a lookup of
  `batterystatus`); its age is `batterystatus.LastTimestamp`, joined by device
  id only. A property's battery-age badge is the median of its rooms' exact
  ages, rounded once for display (`batteryAgeSummary`).
- **Live but unmapped:** heard ≤ 7 d, held by no room, attributed by the first
  live-property `esa_` tag, else by a single `heartbeatstatus.Location`.
  Devices tagged for two live properties, or placed in two Locations, are
  unattributable: neither listed nor counted. Fleet = sum of the properties.
- **Findings, never failures:** F1 (a device in two rooms), F2 (Location vs
  the device's live tag; coverage reported per property), F3 (DeviceId not an
  id / an error / unknown to Particle), F4 (a note names a replacement DeviceId
  does not show). Each lands on its room row as a `flags` entry. **Only
  structure is fatal:** a missing tab or required header, a property with zero
  rows, a row landing in two properties (D16).
- **Stamps:** "Sheet export as of" is `heartbeatstatus.CurrentTime` per
  Location (the header shows the oldest); "Heartbeats as of" and "Page built"
  are `builtAt`. The battery badge is the battery-freshness signal.
- `data/` and `dist/` are gitignored and rebuilt every deploy. `history/` and
  `assets/` are committed. The published page makes **zero external
  requests**; keep it that way.

## Retired paths (pointers only)

Deleted in Block 5 (CUTOVER.md §11 was the list). The tag **`pre-cutover`**
(`b4f8c4b`) is the last build that ran them, and **`pre-cleanup`** is the last
commit that still carries their code: read it there
(`git show pre-cutover:fetch.js`), not here.

- **Room-assignment overrides** (`data/room-overrides.json`, `replace` /
  `merge` modes, `heldOut`, `loadRoomOverrides`, `resolveRoomOverride`,
  `planRoomOverrideMerge`, `test-overrides.js`): CUTOVER.md §1 and §11;
  `git log -- data/room-overrides.json` (from `bfcd178`); the CLAUDE.md at
  `pre-cutover` documents the `heldOut` trap. The two-property-claim tests
  live on as F1 tests in `test-cutover.js`.
- **The registry workbook and its exclusion tabs**
  (`EXCLUDED_REGISTRY_TABS`, `readRegistry`, `readExcludedDeviceIds`):
  CUTOVER.md §1, §6 and D2/D3.
- **The three legacy work-order workbooks** (`py_export_*`, `Room Status`,
  `sheetKey`, `registryTab`): CUTOVER.md §0–§3; `docs/CONSOLIDATION-FINDINGS.md`.
  `probe/02`, `03`, `06` and `07` read them and are frozen; run them from
  `pre-cutover`.

## Decisions already made (do not re-litigate)

- **Battery cutoffs, confirmed by Ian:** ok ≥ 3.6 V, warn ≥ 3.2 V, below is
  critical. **Heartbeat buckets, confirmed:** < 2d / 2–7d / > 7d / never, plus
  no device. Reviewed and confirmed with Priya.
- **Property names:** 6197 Round Rock - Southwest · 6178 Austin - Southwest ·
  9502 Austin - Airport (`active-mode paused`). **9829 was fully uninstalled
  2026-08-19** and removed; `render.js` trims non-configured properties from
  history before shipping it.
- **Tabs:** Fleet rollup (default) → All rooms → Reconciliation. `?v=triage`
  still resolves to All rooms filtered to Issue + Check.
- **Heartbeats come from Particle, one endpoint only**, never anything that
  commands or wakes a device. Battery, rooms and triage stay on the sheet.
- **Site is public-but-unlisted** by choice: no login, `noindex`. Alerts go to
  the GitHub account owning the schedule; `verify-live.js` is the watchdog.
- **The consolidated-workbook design and every cutover decision** are in
  CUTOVER.md §1 and §9 (D1–D16 for Blocks 1–2; H1, H2, D7, D12 and the two
  leftovers for Block 3). In one line each for Block 3:
  - **H1** trend x is the calendar date; the window is 30 days, not 30
    records; a missing day is a gap.
  - **H2** annotations declare their charts; the cutover entry is `'all'`.
  - **D7** out-of-scope names fatal in structured fields; a note hit is
    logged and still renders; log-only findings never reach the payload.
  - **D12** F2's coverage is shown beside its count.
  - A typed `DeviceId` placeholder means no device; other non-id text or an
    error is F3. Two different live tags make a device unattributable.
- **THE GAP RULE is not negotiable:** a value that was not recorded is a gap,
  never a zero — a missing field, and (H1) a missing day. Series with < 2
  points show their value plus "tracking since <date>".
- **No floor on "ever nonzero"** for the awaiting-room-mapping line; the
  shared scale for Ok/Check/Issue stays (per-series scaling was rejected).
- **Workflow actions are pinned to current majors** (`actions/checkout@v7`,
  `actions/setup-node@v7`, node24). Check each action's releases before
  bumping.
- **Stale-page banner, confirmed by Ian 2026-09-25:** the page compares
  `builtAt` with the viewer's clock on load and hourly while open. Older than
  `THRESHOLDS.pageAge.maxDays` (**7**, matching the > 7 d stale cutoff) shows a
  `tone-bad` banner above every view: the local build time and whole days
  since. A missing or unreadable `builtAt` shows it too; a future one (the
  viewer's clock is behind) does not. The cutoff reaches the page only through
  the payload, and `render.js` fails the build without a usable one. It is
  client-side only, so `verify-live.js` cannot see it. Tests fix the clock with
  `runPage(payload, search, { now })` and fire the timer with `advance(ms)`.
- **A summary-only view for Greg and David is still wanted** (Ian,
  2026-09-25): an in-page toggle, per the Sep 9 lean, not Cloudflare Access.
  Not yet scoped. A toggle changes only what is drawn: every room still ships
  in the page's payload, so it does not settle the access-control open item.

## Current state (2026-09-26, cutover merged)

- **The cutover is live.** Blocks 2 and 3 were fast-forwarded onto `main` on
  2026-09-26 at 03:06Z (`b4f8c4b..58d28af`, no merge commit). The tag
  **`pre-cutover`** marks `b4f8c4b`, the last legacy build (the interim
  override fix that ended the Sep 16–24 outage). Rollback is Netlify's
  Deploys → the last pre-cutover deploy → Publish deploy, never a rewrite of
  `main`. The dispatched `daily-refresh` run 36213819929 went green and wrote
  `history/2026-09-26.json` (`24386e9`).
- **The first consolidated record, 2026-09-26** (from the 2026-09-25 11:48 CDT
  export): 319 rooms, **Ok 257 / Issue 50 / Check 12 / Unknown 0, 62 triage
  rows** (6197 68/26/0, 6178 105/2/2, 9502 84/22/10), unmappedLive **3**
  (6197 1, 9502 2), liveUnder2d 164. 302 rooms hold a device (301 distinct
  ids), **17 have no device** (3/7/7), 0 never heard. The record before it,
  2026-09-25, was written by the legacy build: 161 triage rows, unmappedLive 73.
  An independent re-derivation from the raw workbook matched the pipeline on
  every room and reproduced CUTOVER.md §10's NEW column exactly.
- **The cutover `TRENDS` annotation** is `{ date: '2026-09-26', label:
  'consolidated sheet', charts: 'all' }`: the fleet triage line steps
  161 -> 62, the awaiting-room-mapping line 73 -> 3, and 6178's Ok 13 -> 105.
  Read it as neither a recovery nor a regression (config.js says why).
- **Findings:** F1 1 (P2-0433 in 6178/428 and 9502/308), F2 1 (9502/308),
  F3 0, F4 28 (+1 unnamed note at 6178/302); 30 rooms flagged. F2 coverage
  6197 93.4 % · 6178 86.3 % · 9502 32.1 %. Log: 10 unplaced telemetry rows
  (7 devices), 0 out-of-scope rows, 0 note hits, 0 two-tag devices.
- **Battery is stale everywhere:** the Sep 25 export did not refresh
  `batterystatus` (newest reading Sep 17), so the badges read ~11 / 10 / 10 d
  and climb daily until Priya re-exports. That is honest; do not "fix" it in
  code.
- **History:** records for Aug 16 – Sep 15, then Sep 25 (legacy values) and
  Sep 26 onwards (consolidated). **Sep 16–24 do not exist and are never
  backfilled** (CUTOVER.md §0); every trend chart shows them as a gap.
- **Block 5 (cleanup), 2026-09-26:** CUTOVER.md §11 executed. The retired
  override, registry and legacy code is gone (see Retired paths); the payload
  was byte-identical before and after, apart from one intended fix: the
  battery-age median is taken on exact ages (6197 read 11.3 d, exactly 11.2 d).
  The tag `pre-cleanup` marks `main` just before it.
- **Tests:** `npm test` — 79 cutover + 70 page, identical in both zones.

## Open items

- **Block 4:** the Reconciliation worklists (D9's Ok-but-stale / no-device
  list; full F1–F4 worklists). Block 5 is done.
- **Questions for Priya** are in CUTOVER.md §12 — chiefly typing replacements
  into `DeviceId` at install time (all 28 F4 findings are at 6178, where
  notes record replacements the column does not yet show), P2-0433's two
  rooms, and P2-0823.
- **Scheduling the export is still the highest-value fix.** Battery, rooms
  and triage all wait on it, and the Sep 25 export did not even refresh
  `batterystatus`. Until it is scheduled, read the battery badge before quoting
  any battery number.
- **The repository is public.** `history/`, `CUTOVER.md` and the docs carry
  room numbers and device ids. Whether that is acceptable is Ian's call; the
  site itself is unlisted by design.
- Consider access control before room-level detail goes on screen for external
  eyes (Cloudflare Access bolts on later).
- `npm audit` flags xlsx 0.18.5 (prototype pollution, ReDoS). No npm-side fix;
  judged acceptable for a build-time parser reading our own sheet.

## Working style Ian asked for

One-sentence explanation before each step; small, clearly-messaged commits;
ask before anything destructive. **If the data does not match the documented
schema, stop and show him rather than improvising around it.** Numbers come
from scripts, never from memory.

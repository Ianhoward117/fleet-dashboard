# CLAUDE.md — Shower Stream Fleet & Ops Dashboard

Internal ops tool for the Shower Stream IoT fleet in Extended Stay America
properties: **fleet health and triage**. Savings/water metrics live in a
separate dashboard and are out of scope.

- **Live:** https://ss-fleet-rxsm.netlify.app (public but unlisted, `noindex`)
- **Repo:** https://github.com/Ianhoward117/fleet-dashboard (private)
- **Owner:** Ian Howard, co-founder, Abstract Engineering Inc.

`README.md` is the user-facing doc. This file is the working context: current
state, decisions already made, and the environment traps.

---

## Environment traps (these will waste your time otherwise)

- **Node is not on the non-interactive PATH.** Prefix every command:
  `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"`
- **`gh` lives at `~/.local/bin/gh`** (standalone install, no Homebrew on this
  machine). Add `$HOME/.local/bin` to PATH too.
- **`gh` has two accounts: `Ianhoward117` and `TXIC-UT`.** The repo belongs to
  Ianhoward117 and the brief explicitly rules out txic-ut. If git says
  *"Repository not found"*, the active account has drifted — check with
  `gh auth status` and fix with `gh auth switch --user Ianhoward117`.
- **The macOS keychain holds a stale TXIC-UT token**, so plain git auth fails
  even when `gh` is correct. A repo-local override routes git through `gh`:
  `credential.https://github.com.helper = !gh auth git-credential`.
  Permanent fix, if wanted: update the github.com entry in Keychain Access, or
  run `gh auth setup-git` (global).
- **`app.netlify.com` and `localhost` are blocked in the Claude browser pane.**
  Netlify changes have to be made by Ian; guide, do not attempt to drive.
- **The daily bot commits to `main`.** Always `git pull --rebase` before
  pushing or the push is rejected.
- **History dates are date-only (`YYYY-MM-DD`) and need the date-only
  formatter.** `new Date('2026-08-20')` parses as UTC midnight, which
  `toLocaleDateString` then renders as **Aug 19** anywhere west of Greenwich,
  Austin included. Format history dates with `fmtDay()` in `template.html`,
  which builds the date in local terms — never with `fmtDateShort()`, which is
  correct only for the full ISO datetimes it is already used on
  (`batteryTimestamp`). This is a silent off-by-one-day, not an error.
- **The build needs `PARTICLE_TOKEN` as of v2.** Locally it lives in
  `.env.local` (gitignored) and you must run node with
  `--env-file=.env.local`; a bare `node build.js` fails immediately by
  design. The probe keeps its own broader credential as
  `PARTICLE_PROBE_TOKEN` so the two never shadow each other. Never print
  either, in any form.

## Commands

```bash
node --env-file=.env.local build.js   # fetch -> normalize -> render (what Netlify runs)
node --env-file=.env.local fetch.js   # 4 workbooks + Particle device list -> data/raw/
node normalize.js    # rebuild normalized.json + print all counts
node render.js       # rebuild dist/index.html from existing JSON
node snapshot.js     # append today's counts to history/  (workflow does this)
node verify-live.js  # health-check the published site   (npm run verify)
node verify-live.js --current   # print the live builtAt, nothing else
```

`node normalize.js` printing the per-property counts is the fastest way to
answer a data question without opening the page.

## Architecture

`config.js` → `fetch.js` → `normalize.js` → `render.js` + `template.html` →
`dist/index.html`, orchestrated by `build.js`. One npm dependency: `xlsx`.
Everything else is vanilla Node and vanilla browser JS.

- `data/` and `dist/` are gitignored and rebuilt every deploy.
- `history/` and `assets/` **are committed** — the trend series and the logo.
- The published page makes **zero external requests**; data, CSS, JS and the
  logo are all inlined. Keep it that way.
- **`fetch.js` is the v2 seam.** Swapping it for a Particle API reader needs no
  change to normalize/render.

## Decisions already made (do not re-litigate)

- **Battery cutoffs, confirmed by Ian:** ok ≥ 3.6 V, warn ≥ 3.2 V, below is
  critical. Set `confirmed: false` in config to stop classifying and show raw
  voltages instead of a guess.
- **Heartbeat buckets, confirmed:** < 2d / 2–7d / > 7d / never.
- **Property names** (corrected — the brief had 6178 and 6197 transposed;
  these match the registry tab names):
  6197 Round Rock - Southwest · 6178 Austin - Southwest ·
  9502 Austin - Airport (`active-mode paused`)
- **9829 fully uninstalled 2026-08-19; removed from the dashboard same day**
  (Ian). Registry tab retained in the workbook, unread — a later phase reuses
  it as an exclusion list. History files before that date still carry 9829 and
  are left as recorded; `render.js` filters non-configured properties out of
  the page payload.
- **Tabs:** Fleet rollup (default) → All rooms → Reconciliation. The old
  triage tab is folded into All rooms as the `Issue + Check` status filter;
  legacy `?v=triage` links still resolve to it.
- **Days-silent is measured against build time.** *(v2, 2026-08-19 — this
  supersedes the earlier decision to measure against each property's own
  export snapshot.)* That earlier rule was correct while heartbeats came from
  a hand-refreshed export: the figure meant "as of that export". Heartbeats
  now come live from the Particle API at build time, so "vs now" is simply
  what the number means. The old **Last checked** column is gone; the header
  carries one global **Heartbeats as of …** stamp instead.
- **v2 shipped 2026-08-19: heartbeats come from the Particle Cloud API.**
  One endpoint only — `GET /v1/products/18173/devices` — and never anything
  that commands or wakes a device. Battery, room mapping and triage stay on
  the sheets permanently: the probe proved battery is absent from the Cloud
  API for this hardware and that rooms never appear in a Particle payload.
  `fetch.js` remains the only file that knows the API exists.
- **Per-property freshness badges now report battery-data age**, since
  heartbeats can no longer be stale. Same confirmed 2d/7d tones. Battery ages
  are shown as approximate — Priya confirms the collector runs intermittently
  and its timestamps are not precise.
- **Exclusion tabs are transit logs, not rosters.** A device carrying a live
  property's `esa_` group tag is never excluded, because that group is its
  current assignment while tab membership is history. 152 of the 196 ids in
  the 9829 tab are also in the lab tab, so membership alone cannot mean
  out-of-scope.
- **Alerts go to the GitHub account owning the schedule**, not a shared inbox.
  Netlify email is Pro-only; the workflow's `verify-live.js` step is the
  watchdog instead. Escalation options are in the README.
- **Site is public-but-unlisted** by choice: no login, protection is the
  unguessable hostname plus `noindex`. Cloudflare Access bolts on later.
- **v1.5 shipped 2026-08-20: trend lines from the committed `history/`
  snapshots.** Render-side only — `fetch.js` and `normalize.js` were not
  touched, no new endpoint, no new dependency, page still makes zero external
  requests. Per-property cards carry a three-line status trend
  (Ok/Check/Issue on one **shared** scale), `liveUnder2d`, and `unmappedLive`
  where that series has ever been nonzero. A fleet strip on the rollup carries
  total triage rows and fleet-wide `unmappedLive`.
- **THE GAP RULE, and it is not negotiable: a field absent from a history
  record renders as a GAP, never a zero.** Lines break and resume, nothing is
  interpolated, an isolated point draws as a dot. `liveUnder2d` and
  `unmappedLive` only start on 2026-08-20, so a fabricated 0 would draw every
  one of those series falling off a cliff on a day when nothing happened in
  the field — only a schema change. `null` and non-numeric are absent too.
  Series with < 2 points show their value plus "tracking since <date>" text
  rather than a degenerate line.
- **Fleet-series annotations live in `config.js`, not in the template.** The
  `TRENDS` block holds `windowDays` (trailing window; `render.js` ships
  exactly that many records) and `annotations`. Add an annotation whenever a
  property joins or leaves `PROPERTIES` — without one, the fleet line shows an
  unexplained step and the next person reads a clerical change as a fleet
  event. The 2026-08-20 `9829 removed` entry exists for exactly that: the
  fleet triage line really does step 236 → 155 that day, and the step is
  marked and labelled rather than smoothed or rebased.
- **No floor on "ever nonzero"** for the awaiting-room-mapping line (Ian,
  2026-08-20). The line's job is the backfill endgame: when 6178 falls to 3,
  then 1, those are the last rooms, not noise. 6197's single-device line is a
  real device awaiting mapping and stays.
- **6178's near-overlapping Ok/Check lines are the honest reading** (Ian,
  2026-08-20). Ok 13 and Check 11 genuinely are two apart on an 11–69 domain.
  The shared scale stays; the key beside the chart carries the numbers.
  Per-series scaling was considered and rejected.
- **Workflow actions are pinned to current majors.** `actions/checkout@v7` and
  `actions/setup-node@v7` as of 2026-08-20, both on the node24 runtime; v4 ran
  on deprecated node20. Check each action's own releases before bumping rather
  than assuming a version from memory.

## Current state (2026-08-20)

- All three properties render; counts tie exactly to the source sheets:
  303 rooms, 148 Ok / 121 Issue / 34 Check, 155 needing attention.
  (Was 421 / 185 / 197 / 39 / 236 before 9829 was removed.)
- Daily refresh has run unattended and green on 16-20 Aug.
- **5 days of history captured; v1.5 trend lines ship as of 2026-08-20.**
  Status trends are flat (29/69/23) because the `py_export_*` sheets have not
  been re-exported — status still comes from those sheets.
- **The live series have one point so far**, so `liveUnder2d` and
  `unmappedLive` render today in their "tracking since Aug 20" text form on
  every card and on the fleet strip. They become lines on the second snapshot.
  This is the documented < 2-point behaviour, not a fault. The line path was
  proved before shipping with synthetic records held in memory — `history/`
  files are records and are never written to for a test.
- Fleet `unmappedLive` is 184 against 53 across the property cards; the other
  131 carry no property group tag at all and so cannot be attributed to a
  property. The fleet strip states this on the page, computed at render time.
- **Heartbeats are live as of v2**; the join is exact (229/229 device ids
  matched, zero unknown to Particle) against a fleet of 879 devices.
- Battery-data age as of 19 Aug (this is what the badges now show):
  6197 ~12d median, 9502 ~37d, 6178 ~69d.

## Open items

- **6178: the data source got honest, and it cuts both ways.** Read these two
  facts together or you will draw the wrong conclusion.

  *The export was flattering the mapped set.* Under live heartbeats, 6178's
  93 mapped rooms read 1 fresh / 5 aging / 27 stale / 60 never — where the
  June export made them look considerably healthier. Nothing got worse on
  2026-08-19; we simply stopped measuring silence against a two-month-old
  photograph.

  *And the page is showing far less of 6178 than exists.* Roughly 52 devices
  carrying an `esa_6178` group tag were heard from within the last 7 days but
  map to no room on this dashboard at all. Installs outran the paperwork:
  the registry covers 26 of 93 rooms, and Priya confirms the exports only
  include a device after its first data lands, with 6178 installs continuing
  into June.

  **Net read: the hardware is probably fine in many more rooms than the page
  can show, and the bottleneck is registry/export backfill — a field and
  clerical task, not an engineering one.** The fix is to get those ~52 devices
  mapped to rooms, after which most should appear as healthy. Do not present
  6178's current numbers as a fleet regression.

- **9502 improved under live data:** silent dropped from 9 to 3 once
  heartbeats stopped being measured against a 36-day-old export. Same
  direction of correction as 6178, opposite sign — further evidence this is a
  measurement change, not a fleet change.
- **The `py_export` refresh still gates battery, rooms and triage status.**
  v2 fixed heartbeats only. Battery voltages at 6178 are ~69 days old on
  average. Scheduling that Python export remains the highest-value fix.
- `npm audit` flags xlsx 0.18.5 (prototype pollution, ReDoS). No npm-side fix
  exists; patched builds are only on SheetJS's own CDN. Judged acceptable for
  a build-time parser reading our own sheets.
- ~~Thresholds are due a review with Priya.~~ **CLOSED** — reviewed and
  confirmed by Priya; battery cutoffs and heartbeat buckets stand as
  configured. Do not re-litigate.
- **Housekeeping, known and deliberate:** the phone media query in
  `template.html` (~line 266) contains a duplicated `.livetag` and
  `.cardnote .await` block, copy-pasted from the desktop rules with the same
  declarations and wrong indentation. It is inert — identical values, so it
  changes nothing. Remove it in a future cleanup pass, **never mid-feature**:
  an unrelated CSS change buried in a feature diff is how a rendering
  regression gets attributed to the wrong commit.
- Consider access control before the mid-September ESA/David meeting if
  room-level detail will be on screen for external eyes.
- Open questions for Priya on the battery collector remain in
  `probe/FINDINGS.md` §7 — chiefly where `BatteryVoltage_V` is collected,
  since it is not in the Cloud API.

## Working style Ian asked for

One-sentence explanation before each step; small, clearly-messaged commits;
ask before anything destructive. **If the data does not match the documented
schema, stop and show him rather than improvising around it** — that rule has
already caught several real discrepancies, all recorded in the README's
"Known data quirks".

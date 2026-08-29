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
- **`data/` is gitignored except one file.** `.gitignore` uses `data/*` plus
  `!data/room-overrides.json`, because git will not descend into an ignored
  *directory* — `data/` alone makes the negation impossible. That one file is a
  committed source, not a build artefact; if it stops being committed, Netlify
  and the daily workflow build a different page than you do locally.
- **The build needs `PARTICLE_TOKEN` as of v2.** Locally it lives in
  `.env.local` (gitignored) and you must run node with
  `--env-file=.env.local`; a bare `node build.js` fails immediately by
  design. The probe keeps its own broader credential as
  `PARTICLE_PROBE_TOKEN` so the two never shadow each other. Never print
  either, in any form.
- **The Room Status `Device#` column is DISPLAY TEXT ONLY.** It is read
  generically for *all* three properties — `findKey(probe, /^device\s*#/i)` in
  `readRoomStatus`, no property-specific branch — and the value only ever
  becomes a room's `deviceName`. It never feeds assignment for any property.
  Room-to-device assignment resolves **override → `py_export_heartbeatstatus`
  byRoom → registry byRoom → null**, and that is the whole chain. A room can
  therefore show a device *name* on the page and still be unassigned and
  never-reporting. Wiring `Device#` to assignment would need new code; do not
  assume it is already wired because the column is populated. This cost a full
  investigation session to establish.

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
- **v1.6 shipped 2026-08-26: per-property room-assignment overrides**, loaded
  from the committed `data/room-overrides.json`, with 6178 as the first entry
  (82 field-verified pairs, `mode: "replace"` *as shipped — 6178 moved to
  `merge` on 2026-08-29, see below*). The file keys on Particle
  device *name*; names resolve against the device list `fetch.js` already
  pulls, so the build still makes exactly 13 requests. `replace` discards
  **both** sheet-derived assignment sources for that property — the registry
  tab's map *and* `py_export_heartbeatstatus`'s room→device map. That second
  one is the important half: at 6178, 30 of the 30 discarded assignments came
  from the export, so displacing only the registry would have changed almost
  nothing.
- **Overrides have two modes as of 2026-08-26** (`adb3e2c`, applied in
  `f479613`). `replace` takes a property's assignments **entirely** from the
  file, discarding every sheet-derived pair first — so a room the file does not
  name has no device at all. `merge` wins only the rooms it names; rooms it
  does not name keep whatever the sheets resolve for them. Merge is a
  whole-property pass (`planRoomOverrideMerge`), not a per-room decision,
  because a device the override places in room X may currently sit in room Y of
  the same property and has to be taken out of Y. Use `merge` where the sheet
  map is broadly working and only some rooms are wrong; use `replace` only
  where the sheet map is not trustworthy at all. 6197 (90 pairs) and 9502
  (32 pairs) shipped as `merge` on 2026-08-26.
- **6178 moved from `replace` to `merge` on 2026-08-29** (Ian). The 2026-08-26
  `py_export` refresh took 6178's export room→device map from ~32 rooms to 86,
  so the sheets can now describe rooms the override does not name — and
  `replace` was discarding them. Under merge 27 of the 28 previously
  deviceless rooms pick up a device (24 export, 2 registry, 1 override); only
  room 415, blank in every source, stays unassigned. The same commit renamed
  the pair `A322` to `322`: `A322` is not on the Room Status roster so the pair
  was inert, while roster room 322 held the same physical unit (`P2-0744`,
  id `…0186f8`) and was stranded by replace.

  **Frame this honestly. It is not a recovery.** Silent falls 28 → 1, but only
  **4** of the 27 are live; the other **23** come back as devices last heard
  **32–270 days ago**, moving from "no device" to "reporting, but stale". The
  heartbeat histogram tells the true story: fresh 40→44, aging 15→15, stale
  26→**49**, never 28→1. It is still the better reading for triage, because
  "P2-0158, silent 67d" is an actionable row and "no device" is not. The
  `TRENDS` annotation dated 2026-08-29 says this on the chart.
- **An override governs room-to-device ASSIGNMENT only.** Room roster, triage
  status and battery stay sheet-owned, so it can never invent a room, move a
  denominator, or talk a red room green. `render.js` asserts the pairs balance
  on every build. Verified against identical raw data: Ok/Issue/Check, room
  counts, the triage queue and every battery histogram are unchanged.
- **An override fails the build rather than half-applying.** Unknown property,
  unimplemented mode, duplicate room or device name, two rooms collapsing onto
  one key, a name matching no device or more than one device in product 18173,
  or a device carrying another live property's `esa_` tag. A device with **no**
  group tag is ordinary and is not an error.
- **Workflow actions are pinned to current majors.** `actions/checkout@v7` and
  `actions/setup-node@v7` as of 2026-08-20, both on the node24 runtime; v4 ran
  on deprecated node20. Check each action's own releases before bumping rather
  than assuming a version from memory.

## Current state (2026-08-29)

- **Priya re-ran the `py_export` on 2026-08-25/26 — the first fresh export
  since June/August**, and it landed in all three work-order workbooks. It
  changed the sheets in ways the docs did not describe: 6178's Room Status went
  **93 → 109 rooms** and gained a populated `Device#` column (108/109); all
  three tabs gained a `Calibration Risk` column; and the date-bearing headers
  now read `[Aug 26, 2026]`. The date-bearing headers still match, because
  every column is found by prefix regex, and `Calibration Risk` is silently
  ignored — nothing asserts on the column set.
  **It also settles a question that was open on the battery collector: the
  collector never stopped, only the export did.** Battery ages fell back into a
  normal range the moment the export refreshed.
- **6178 now runs `mode: "merge"`** (shipped today). Counts against live data:
  **109 rooms, 108 with a device, 1 without** (room 415, blank in every
  source). Heartbeats **fresh 44 / aging 15 / stale 49 / never 1**.
  Live-but-unmapped at 6178 is **0** (was 3), fleet-wide **108** (was 112).
  Ok/Issue/Check (13/69/11), the 319-room denominator, the 161-row triage queue
  and every battery histogram are unchanged, at 6178 and at the other two.
  **Read the histogram, not the silent count** — see the merge decision above.
- **All 82 of the override's pairs now land**, up from 81, because `A322` was
  renamed to the roster's `322`. Nothing is held out and
  `overrideRoomsNotInRoster` for 6178 is empty.
- **Fleet: 319 rooms, 142 Ok / 142 Issue / 19 Check, 161 in the triage queue.**
  6197 94 rooms (57/29/8), 6178 109 (13/69/11 + 16 null-status), 9502 116
  (72/44/0).
- **13 days of history** (16-28 Aug); the daily workflow has run green
  throughout. `history/2026-08-29.json` did **not** exist when this shipped, so
  today's record is the first that carries the new numbers — which is why the
  TRENDS annotation is dated 2026-08-29 rather than the 30th.
- A stale local checkout makes `git diff origin/main` look like it deletes
  history files. It does not: they are commits you have not pulled. **Always
  `git pull --rebase` first** — this is exactly the trap that rule guards.

## Previous state (2026-08-26)

- 6178 ran `mode: "replace"`: 81 of its 109 rows carried a device, 28 did not,
  and heartbeats read 40 fresh / 15 aging / 26 stale / 28 never.
  Live-but-unmapped at 6178 was 5 against the pre-refresh sheets, 3 after.
- Only 81 of the override's 82 pairs landed; `A322` named a room the roster
  does not carry. 11 days of history (16-26 Aug).

## Previous state (2026-08-20)

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

- **6178 floor 4: two device generations, and the 2026-08-26 export reframes
  it.** *(Rewritten 2026-08-29. The earlier reading — "two documents describing
  the same rooms differently", i.e. a numbering mismatch — is no longer what
  the data shows.)* On floor 4 the override and the triage roster still have
  zero overlap: the override covers 404-406, 412-417, 419-421, 423, 425-430 and
  the export covers 401-403, 407-411, 418, 422, 424, 432. But against the
  refreshed export those two sets are **complementary, not conflicting** —
  under merge every floor-4 room resolves to a device, and there is exactly
  **one** disagreement property-wide (room 404, see the cross-property guard
  item below). Disjoint sets that between them tile the floor are two
  generations of hardware in *different* rooms, not one set of rooms numbered
  two ways.

  The generational split is still real and still visible: the export's floor-4
  devices are the old low-numbered range (`P2-0008`-`P2-0231`), against the
  override's `P2-0303`-`P2-0825`, and most of the old ones last reported
  ~133 days ago in a tight cluster — a whole-floor silence in early April, not
  a scatter. Merge now shows both generations rather than neither.

  **This does not close the field question.** Nobody has walked floor 4 and
  confirmed which units are physically installed where; what changed is that
  the documents no longer contradict each other, so the remaining question is
  "are the old-range units still in these rooms?" rather than "which document
  is right?". Still do not edit the override to match the roster.

- **The export path has no cross-property guard, and room 404 is a live
  instance.** `resolveRoomOverride` refuses to place a device that carries
  another live property's `esa_` group tag, and fails the build rather than
  half-applying. **The export path has no equivalent check.** At 6178, the
  export maps room 404 to device `…017d04`, which is named `P2-0457` and
  carries the group tag **`esa-6197`** — a Round Rock unit sitting in an Austin
  room in the export. The override happens to win room 404, so nothing wrong
  reaches the page today, and an audit of all 27 rooms merge newly assigns
  found no other instance. But nothing in the code would catch it if it spread.
  **Known code gap, awaiting its own session** — it is a change to a
  load-bearing path and does not belong in a data-only commit.

- **6178's statuses do not cover its roster: 13 + 69 + 11 = 93 against 109
  rooms.** The other **16 rooms carry a null status** and normalize buckets
  them as `Unknown`. These are the rows Priya added in the 2026-08-26 refresh
  (the roster went 93 → 109) that do not yet have triage against them. The
  behaviour is correct — status is sheet-owned and the dashboard will not
  invent one — but a property card whose three numbers do not sum to its room
  count is easy to misread. **This is the number most likely to be questioned
  at the mid-September ESA/David meeting.** Getting those 16 rooms triaged is a
  Priya/field task, not an engineering one.

- **The 6178 registry/export backfill is still open with Priya.** The override
  corrects the dashboard, not the source. `py_export_*` still gates battery,
  rooms and triage status, and 6178's export snapshot is still 2026-06-24.

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

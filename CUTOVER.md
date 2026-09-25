# CUTOVER.md — consolidated-workbook cutover contract

**Block 1 of 5.** Written 2026-09-25 against `c561bd5`. This was a read-only session: no code or data changed.
This is the contract Blocks 2–5 implement. For background, see
[`docs/CONSOLIDATION-FINDINGS.md`](docs/CONSOLIDATION-FINDINGS.md) (the Sep 8–9 investigation).
Where that document and this one disagree, this one wins: the sheet has moved since.

**How the numbers were made.** Every number below came from a script, and each was derived twice
independently, reconciled, checked by a third reader, and then re-checked against this text by
five adversarial verifiers. The inputs:
- the consolidated workbook, pulled read-only 2026-09-25 at about 12:35Z;
- the Particle device list, pulled `2026-09-25T12:32:09Z` (879 devices);
- the live page's embedded payload, built `2026-09-15T15:28:56Z`.

The scripts and their outputs are in `investigate/cutover/`, which is git-excluded and local only.

**Staleness.** Heartbeat buckets and ages move daily. Status and device counts move whenever the
sheet is edited. Re-run the scripts before quoting anything on cutover day.

**How to read the contract.** It states the approved design (§1–§7). **Anything marked
*Recommended* or *Proposed* is not approved.** Each such item has a row in §9, and Ian decides it
before Block 2.

---

## 0. Outage — the site has not refreshed since 2026-09-15

| | |
|---|---|
| Symptom | Live `builtAt` is `2026-09-15T15:28:56Z`. The last `history/` record is `2026-09-15` (`c561bd5`). Netlify shows no deploy since Sep 15 (Ian confirmed). |
| Runs | `daily-refresh` has fired on schedule every day and failed 9 times running, Sep 16 → Sep 24, each in 13–23 s. The schedule is fine. |
| Error | Identical in all 9 runs, and reproduced locally: `NORMALIZE FAILED: room override for 6197 names device "P-0351" for room "226", which matches no device in product 18173.` |
| Cause | **Class (b): the override tripped.** `fetch.js` `loadRoomOverrides` passed. It was name resolution in `resolveRoomOverride` (`normalize.js:510-520`) that threw. Between the Sep 15 15:28Z pull and the Sep 16 15:21Z run, devices `…4a017a74` and `…4a017aa8` were **renamed in Particle from `P-0351`/`P-0791` to `P2-0351`/`P2-0791`**, correcting a naming typo. The same ids render as `P-0351`/`P-0791` on the Sep 15 page. `data/room-overrides.json` has spelled them `P-` since `f479613` (6197 rooms 226 and 237), and the exact-name guard failed loudly, as designed. |
| Not the cause | Credentials (the Particle pull succeeds in every run), the schedule, GitHub settings, Netlify settings. Nothing needs changing in Particle Console, GitHub or Netlify. |
| Why Netlify is silent | The workflow dies at `node normalize.js`, before the history commit and before the build-hook step. With nothing pushed and no hook called, no build is triggered. |
| Fix | **The cutover removes this failure class.** Assignment keys on `DeviceId`, and no name is ever resolved into an assignment (§5). An interim two-line override edit (`P-0351`→`P2-0351`, `P-0791`→`P2-0791`) makes the daily build green until the cutover: only rooms 226 and 237 fail against today's pull, and 0 fail after the rename. Whether to make that edit is Ian's call, and this session did not touch the override. |
| Costs while it lasts | The page is frozen at Sep 15. `history/` gains no record until the first green run, and missing days are never backfilled. GitHub disables scheduled workflows in a **public** repo after 60 days with no repository activity. The last commit was Sep 15, so that limit falls around mid-November. |

---

## 1. The approved design (Ian, 2026-09-24)

- **Source of truth: two tabs.**
  - `roomstatus`: rooms, `Location`, `DeviceId`, `Status`, `Action Item`, `Notes from/to Ops`, battery voltage and `Calibration Risk`.
  - `batterystatus`: battery `LastTimestamp`, joined by device id.
- **`heartbeatstatus` is secondary.** Its `CurrentTime` is the "sheet export as of" stamp. Its `Location` may attribute devices for reconciliation, never for assignment.
- **`devicenames` is not read.**
- **Liveness stays on Particle.** One endpoint only, `GET /v1/products/18173/devices` (9 paginated requests today), unchanged. Days-silent is measured against build time.
- **Room→device chain: `roomstatus.DeviceId → null`.** There is no fallback of any kind: no override, no `heartbeatstatus` byRoom, no registry byRoom, no battery byRoom. Notes are never parsed into an assignment.
- **Retired:**
  - the three legacy work-order workbooks and the registry workbook (4 workbooks → 1, **13 → 10 requests** per build);
  - `data/room-overrides.json` and `test-overrides.js`. Their guard logic is reused as sheet validation.
- **Sheet conflicts FLAG, never fail:**
  - one device id in two rooms (F1);
  - `Location` vs a live-property `esa_` group tag (F2);
  - a `DeviceId` unknown to Particle (F3);
  - a note naming a replacement device the `DeviceId` column does not show (F4).
- **Structure FAILS loudly:** a missing tab, a missing required header, a property with zero rows (§2).
- **Live-but-unmapped attribution** comes from a live-property `esa_` tag, or else from `heartbeatstatus.Location`.
  - It never uses the registry, and never a bare room number (`batterystatus` has no `Location`).
  - Unattributable devices are never listed or counted, so the untagged fleet pool goes away.
  - That is what keeps Lab / Fort Custer hardware off the page. The data strains this: see D2.

---

## 2. Fetch contract

| | |
|---|---|
| Workbook | `1_qlAjrnafeOQN-EYXGXf0Gks3BZySXtpWk_FKbpQQGI`, via `https://docs.google.com/spreadsheets/d/{ID}/export?format=xlsx`. Verified anonymous and read-only on 2026-09-25. It stays public only while it remains link-shared. |
| Plus | Particle `GET /v1/products/18173/devices`: 9 pages, unchanged, through `fetch.js` only. |
| Requests per build | **10** (1 workbook + 9 Particle pages). Today it is 13. |
| Tabs required | `roomstatus`, `batterystatus`, `heartbeatstatus`. `devicenames` exists and is neither required nor read. |
| Header row | `roomstatus` uses **row 2**, read with `sheet_to_json(ws, { range: 1, defval: null, raw: true })`. Row 1 is a counter formula and is **never read**; that includes `sheetHeaders()` (`normalize.js:147`), which reads row index 0. The other tabs have their header on row 1. |
| Required headers | Matched with `findKey` (`normalize.js:158`), which trims each header before testing it. Each pattern carries its own anchors: `^…$` for exact names, and `^` alone where a date suffix follows. |
| | `roomstatus`: `/^location$/i`, `/^rooms?$/i`, `/^deviceid$/i`, `/^status$/i`, `/^action item/i`, `/^notes/i`, `/^battery status/i` (date suffix, e.g. `[Sep 17, 2026]`), `/^calibration risk/i`. `/^device\s*#/i` (header `Device# `, with a trailing space) is required only if D8 chooses the sheet name for display. |
| | `batterystatus`: `ParticleDeviceId`, `LastTimestamp` |
| | `heartbeatstatus`: `ParticleDeviceId`, `CurrentTime`, `Location` |
| FAIL loudly | A missing tab. A missing required header. A configured property with zero `roomstatus` rows, **after** `Location` has been converted to a string code (§3). **Proposed (D16):** also fail unless every in-scope row lands in exactly one property. That guards the FINDINGS §3.1 near-miss, where every property receives all rows. |
| Today's data | 3/3 tabs present. Every required header above is present. Zero-row properties: none. |

---

## 3. Normalization

| column / rule | contract |
|---|---|
| `Location` (both tabs) | A **number** in all 319 `roomstatus` rows and all 268 `heartbeatstatus` rows. Convert it to a 4-digit **string** code before any comparison with `PROPERTIES[].code`. A number-to-string compare fails silently in two ways. In `roomstatus` it yields zero rows, which trips the zero-rows FAIL. In `heartbeatstatus` it empties every Location attribution (§6) and every per-property `CurrentTime` (§7), and no check catches that. A `roomstatus` row whose code is outside the three is excluded and never counted (0 today). Whether it is also listed is D15. |
| `Rooms` | Normalize with `normRoom` (`102.0`→`"102"`; letter suffixes kept). The key is lowercased. Duplicate (property, room) rows keep every row and raise the existing duplicate note (0 today). |
| `DeviceId` | `normStr`, valid only if it matches `/^[0-9a-f]{24}$/i`. Blank means no device: 15 cells are formulas returning `""` and 2 are absent. A non-blank value that is not 24-hex, or not known to Particle, is **flagged F3 and bucketed `never`. It never fails the build** (0 today). |
| `Status` | `normStr(...) \|\| 'Unknown'`. Triage is Issue + Check. |
| `Action Item` | `actionType()`. The literal word `None` means no action (256 rows). |
| Battery voltage | `normNum` of the `/^battery status/i` column, then `batteryClass()` with the confirmed thresholds, unchanged. |
| Battery age | `batterystatus.LastTimestamp`, joined by `ParticleDeviceId` **only**, measured against build time. |
| `Calibration Risk` | Read and carried as text. Vocabulary today: No 189, No data 88, Yes 20, No savings 12, Maybe risky 8, Too many FPs 2. How it is displayed is a Block-level choice. No savings metric is derived from it. |
| `Notes from/to Ops` | Carried as display text. Parsed only by F4, and never for assignment. It falls inside the banned-string scan (`render.js:151`), which is D7. |
| **Never read** | `roomstatus`: row 1, `Days with no Heartbeat` and `Days with no Shower` (formulas; one hardcodes a date), `Last Heartbeat [..]`, `Last Shower`, and `Device# ` unless D8 chooses it. `batterystatus`: `RoomNumber`, `LastHeartbeat`, `BatteryVoltage_V` (the roomstatus voltage is a lookup of it). `heartbeatstatus`: `RoomNumber`, `LastHeartbeat`, `TimeDiff`. The whole `devicenames` tab. |
| **Sheet datetimes** | **Recommended, pending D4:** interpret every sheet datetime as America/Chicago wall-clock on every host. The pipeline has no time-zone handling today, and Netlify and Actions parse in UTC. See the evidence below. |
| Padding | `batterystatus` has 604 trailing blank rows. `sheet_to_json` already drops them (268 data rows). |

**Evidence for the time-zone rule (D4).**
- **heartbeatstatus.** Read as Central, `LastHeartbeat` matches Particle `last_heard` within 4 minutes on 67 of the 70 rows whose device was silent ≥ 10 d at the Sep 25 pull. Read as UTC, those same rows are exactly 5 h early.
- **batterystatus.** `LastTimestamp`, the column battery age actually uses, equals `last_heard` exactly on 28 of 72 long-silent rows when read as Central, and on 0 when read as UTC.
- **Pre-existing.** The legacy exports behave the same way, so today's published battery ages are already about 0.2 d too old.
- **CDT only.** Every compared timestamp falls in Apr–Sep 2026. Whether the exporter switches to CST on Nov 1 is unconfirmed (Q11).
- **The sheet disagrees with itself.** Its own `Days with no Shower` formula, `…-(G-5/24)`, treats the timestamp as UTC.

**What the columns actually are** (a schema surprise; see D1):
- **`DeviceId` is a lookup formula** over `heartbeatstatus` by (Location, RoomNumber) in 279 of 319 cells. 38 cells are typed and 2 are absent.
- **`Battery Status` is a lookup** of `batterystatus.BatteryVoltage_V` by DeviceId in all 319 cells.
- The build reads the cached values. But a unit only reaches a room once Priya's export has seen it, or once someone types its id.

---

## 4. Joins

| join | key | notes |
|---|---|---|
| room → device | `roomstatus.DeviceId` | Nothing else. No fallback. |
| device → liveness | Particle `id` | `last_heard` against build time: <2 d fresh, 2–7 aging, >7 stale, or never. **Recommended (D11):** report *no device* (blank DeviceId) separately from *never*, since the page lumps them today. |
| device → battery age | `batterystatus.ParticleDeviceId` | Never by `RoomNumber`. |
| device → attribution (unmapped devices only) | A live `esa_####` / `esa-####` group via `particleGroupCode`, else `heartbeatstatus.Location` by id | Keep `particleGroupCode`'s anchored regex: `baseline_6_shelves_esa_wifi_spi` must not match. A device with no live tag and more than one `heartbeatstatus.Location` is unattributable (D5). P2-0433 has two Locations, but its `esa_6178` tag attributes it first, and it is placed anyway. |
| device → display name | **D8, open** | Choose the Particle name by id (recommended) or the `Device# ` text. They differ on 3 rows: 6178/418 (`P2-0823` vs Particle `P-0823`), 6197/226 and 6197/237 (sheet `P-`, Particle `P2-`). **`Device# ` must never be resolved to an id.** That resolution is exactly what caused the §0 outage. |

---

## 5. Flags (FLAG, never fail) and today's counts

| flag | definition | today |
|---|---|---|
| **F1** | One device id in two or more `roomstatus` rows | **2 devices / 4 rows, both cross-property.** P2-0433 (`…017d18`, tag `esa_6178`, silent 26.5 d) at 6178/428 and 9502/308. P2-0306 (`…016d3c`, no group, fresh) at 6197/103 and 9502/103. |
| **F2** | Row `Location` ≠ the live-property code of the device's `esa_` group | **1:** 9502/308 (P2-0433, `esa_6178`). F2 can check only devices carrying a live-property `esa_####` group: 92.3 % of device rows at 6197, 86.3 % at 6178, and **32.1 % at 9502**, where 74 of 109 rows have no such group and 57 of those 74 carry a `baseline_*` group F2 cannot use. **Recommended (D12):** display this blind spot beside the flag. |
| **F3** | `DeviceId` not 24-hex, or unknown to Particle | **0** |
| **F4** | A note names a replacement that `DeviceId` does not show | **28, all at 6178:** 21 where DeviceId still shows the room's previous unit (TODAY's device in all 21; no note names the unit it replaced), 5 where DeviceId is blank (116, 201, 404, 405, 406), and 2 where the named unit is unresolvable (329 and 418, both `"P2-0823"`). The unnamed `"Replaced device"` at 6178/302 is shown separately (+1). |

**The F4 rule, precisely**
- **Recognize** `Replaced with <name>`, `<name> installed` and `correct device … is <name>`.
- **Exclude** `Replaced batteries recently` (20 rows) and `Showerhead replaced` (1 row, 6178/130).
- **Resolve** a named unit by exact trimmed, case-insensitive Particle name to an id, and compare that id with `DeviceId`.
  - A name that matches no device, or more than one device, is itself flagged. The name-resolution guard (`normalize.js:510-528`) becomes a flag, not a throw. There are 0 duplicate names today.
  - **Never** resolve by digits alone: `P2-0823` vs `P-0823` stays unresolved.
- **Dates are unreliable.** The notes are free text. Of the 61 notes the rule recognizes, 20 are undated (6 at 6197 and 14 at 9502, none flagged), and two read `9/16` with no year (6178/418 and 428).

**Liveness of the named units**
- Of the 26 resolvable units in flagged rows, 12 are live, and 11 of those 12 are in no room anywhere. The other 14 were last heard 99.6–132.8 d ago.
- Across all 58 resolvable note-named units, flagged or not, 25 are silent (> 7 d). 17 of those last reported on Jun 16–17, as one batch.

**Porting the override guards: throw becomes flag**
- Ported verbatim, the guards would fail **today's** build on:
  - F1 (P2-0433, P2-0306). Both are cross-property, so it is `fetch.js:281` that throws; the within-property guard at `fetch.js:251` finds nothing today.
  - F2 (9502/308, `normalize.js:543`).
  - The unresolvable note name `P2-0823` (`normalize.js:511`).
- Three new checks would also throw on today's data if written as asserts: "one `CurrentTime`", "unique `heartbeatstatus` id" and "one Location per id". **All of the above must flag, not throw.**
- Checks that pass today and may stay fatal: missing tab, missing header, zero rows (after the §3 conversion), and the banned-string scan (but see D7).
- **F3 stays a flag.** It passes today, but it is not fatal.

**Unplaced telemetry: a finding, not a page list.** Showing it on the page is D10.
- **11 rows** (7 `batterystatus` + 4 `heartbeatstatus`) cover **7 devices** that no room holds.
- `V` is `batterystatus.BatteryVoltage_V`, which this investigation read. The design itself does not read it.

| device | Particle group | attribution under §6 | last heard | V |
|---|---|---|---|---|
| P2-0117 `…02575c` | `esa-9502-non-spi` | 9502 (tag) | 92.3 d | 2.796 |
| P2-0692 `…017694` | none | unattributable | 133 d | 2.800 |
| P2-0694 `…01769c` | none | unattributable | 133 d | 2.801 |
| P2-0032 `…024e2c` | `baseline_6_shelves` | 9502 (heartbeatstatus.Location) | **0.1 d** | 3.575 |
| P2-38 `…02b91c` | `esa-6178-non-spi` | 6178 (tag) | 297 d | 3.660 |
| P2-0519 `…017c64` | `baseline_6_shelves_esa_wifi_spi` | 9502 (heartbeatstatus.Location) | **0.4 d** | 3.858 |
| P2-0454 `…017794` | `baseline_6_shelves_esa_wifi_spi` | 9502 (heartbeatstatus.Location) | 129.9 d | 4.311 |

**Why the 4 `heartbeatstatus` rows are unplaced.** They sit at 9502/103, 223, 401 and 402. In each room, a typed value (103, 223, 402) or a deleted cell (401) displaced the unit that heartbeatstatus reports there. 9502 has 9 non-formula `DeviceId` cells in all. The other five (126, 129, 221, 229, 425) have no heartbeatstatus row, so nothing was displaced.

---

## 6. Live-but-unmapped

**Rule:** Particle devices heard ≤ 7 d ago, held by no room, and attributed by a live tag or else by `heartbeatstatus.Location`.
- Fleet becomes the sum of the properties.
- The daily-record comment at `normalize.js:1574-1576` ("NOT the sum") and the fleet field `unmappedLive: q.unmappedLive || 0` at `:1578` both change.

| | TODAY (Sep 15 page) | REPLAYED (today's Particle) | NEW |
|---|---|---|---|
| 6197 / 6178 / 9502 | 0 / 0 / 0 | 0 / 0 / 0 | **2 / 0 / 2** |
| untagged pool | 60 | 71 | — (removed) |
| fleet | 60 | 71 | **4** |

**The NEW four**
- P2-0856 and P2-0891 (`esa-6197`). They were the override's units at 6197/340 and 103, and the sheet now names other units there.
- P2-0519 and P2-0032 (9502, via Location).

**87 live devices are dropped as unattributable.** 28 are in the registry exclusion tabs and 59 are not. They are neither listed nor counted.
- Among them are the **11 live 6178 replacement units** that notes record as installed.
- Also among them is P2-0799, which was live at 9502/221 on today's page.

See D3.

---

## 7. Stamps

| stamp | source | contract |
|---|---|---|
| Sheet export as of | `heartbeatstatus.CurrentTime` | **Three values, one per Location**, spanning 7.6 s: 2026-09-17 12:30:12–20 CDT, in the order 9502, 6178, 6197. The Sep 8 pull had the same shape plus one null. The rule is D5. Recommended: store per property in `properties[].snapshot.currentTime`, show the maximum in the header, and ignore nulls. |
| daily record `snapshot` | the date of the above | Once D4 lands, this must be the **America/Chicago calendar date**, not `currentTime.slice(0, 10)` (`normalize.js:1561`). Slicing the UTC ISO string records an export made at or after 19:00 CDT as the next day. The Sep 8 pull's Sep 4 20:00 CDT stamp would record as `2026-09-05`. This is CLAUDE.md's date-only trap. |
| Heartbeats as of | `builtAt` | Unchanged. `builtAt` is `new Date()` at `normalize.js:696`, seconds after the Particle pull. The pull's own time is `particle.pulledAt`. |
| Page built | `builtAt` | Unchanged. |
| Battery-data badge | per-property median of `batteryAgeDays` | Unchanged mechanics. **On the Sep 25 data all three read `stale`:** 6197 10.1 d, 6178 9.6 d, 9502 9.2 d on a Central-parsed host, or 10.3 / 9.8 / 9.4 on an unfixed UTC host. The export-lag floor is 7.8 d, and 6197 cannot read `current` even at the moment of export. |
| Sheet header date | the `[Sep 17, 2026]` suffix | Today `snapshot.headerLabel` / `labelMatchesSnapshot` are read from the `Last Heartbeat [..]` header, via `sheetHeaders()` on row index 0 (`normalize.js:311-316`, `1205-1223`, `1247-1248`, `template.html:1021`). On `roomstatus` that row is the banner, so the label silently becomes null. Choose one (D14): derive the label from the `Battery Status [..]` header on row 2, or delete all of those sites together. |
| `rooms[].lastChecked` | — | **Recommended (D13): delete.** It is the per-property export stamp copied onto every row. FINDINGS #13 recommended keeping it. If it is deleted, these change together: `normalize.js:870-873`, `render.js:117-120` (becomes an assertion that every `properties[].snapshot` carries a `currentTime` key, with null allowed), `render.js:205`, and `template.html:757`. |

---

## 8. History continuity

- **`history/` is a record and is never rewritten or backfilled.** The days from Sep 16 until the first green run simply have no file. That first green run is the cutover or the interim override fix, whichever comes first.
- **The gap will not look like a gap.**
  - Trend x is the record's *index* in the window, not its date (`template.html:883`), so the last record before the gap and the first after it are drawn side by side.
  - The comment at `:860` ("a gap occupies its real horizontal width") holds only for a field missing from a record, not for a missing day.
  - `render.js:57` ships the last 30 *records*, not 30 days, and two labels count records as days: "over N days" (`template.html:960`) and "Trends cover the last 30 days of daily records" (`:1125`).
  - See H1.
- **The gap rule itself is unchanged.** A field absent from a record is a gap, never a zero. The daily-record shape does not change, so no field goes absent.
- **Only the fleet Triage-rows chart draws markers** (`annotate: true` at `template.html:1116`).
  - The fleet "Live, awaiting room mapping" chart (`:1121-1122`) has no markers, and neither does any per-property chart (`:984-988`; policy at `config.js:220-224`).
  - There is no fleet Ok series.
  - So the fleet unmapped step (60 → 4) and 6178's Ok step (13 → 105) both draw unannotated. See H2.
- **Series that change meaning at the cutover:**

| field | before | after |
|---|---|---|
| `triageRows`, `properties.*.ok/issue/check` | Legacy sheets, frozen Aug 25/26 | The consolidated sheet, re-triaged by Priya. 6178's 16 `Unknown` go to 0. |
| `properties.*.reporting/silent` | Override, then export, then registry | `DeviceId` only. Rooms with no device go 6 → 17. |
| `properties.*.battery` | Export by device, then **byRoom fallback**, then Room Status | roomstatus voltage only. The 18 readings today's page misattributes disappear. |
| `properties.*.snapshot` | Per-property legacy export date (`2026-08-25/26`) | The consolidated `CurrentTime` date, per D5 and the date rule in §7 |
| `properties.*.unmappedLive` | Tag only | Tag, else `heartbeatstatus.Location` |
| fleet `unmappedLive` | Properties plus the untagged pool (60 on Sep 15) | The sum of the properties (4) |
| `liveUnder2d` (properties and fleet) | — | The meaning is unchanged. P2-0306 counts twice while F1 stands (177 rooms, 176 devices). |

**The `TRENDS` annotation** is dated on the *first record that carries consolidated values*: the UTC date of the first green `daily-refresh` after the cutover merges, which is the convention of every existing entry. A date with no record never renders (`template.html:893`). Fill in both placeholders at merge time. Proposed entry:

```js
// The dashboard moved onto Priya's consolidated workbook: roomstatus.DeviceId is the
// whole room->device chain; the legacy workbooks, registry and override are retired.
// No single field event happened on this date, but the step folds that source change
// together with field work the sheet recorded during the outage gap (e.g. 12 units
// installed at 6178 on 9/16 now report). The chart cannot separate the two; read it as
// neither a recovery nor a regression. Triage steps 161 -> 62 and the fleet
// awaiting-room-mapping line 60 -> 4 (the untagged pool is no longer counted), against
// the 2026-09-25 pull. The record before this marker is <last legacy record>: the build
// was down from 2026-09-16 (override name check) and no records exist for the gap.
{ date: '<first record carrying consolidated values>', label: 'consolidated sheet' },
```

---

## 9. Decisions for Ian before Block 2

These are the places where the data strains the approved design, or where this contract proposes something the design does not cover.

| # | finding | options | recommendation |
|---|---|---|---|
| **D1** | `DeviceId` *is* `heartbeatstatus` byRoom, computed in the sheet (279 of 319 cells, first match). Assignments move whenever Priya re-exports. Typed cells go stale. A unit that has never reported can be placed only by typing its id. | Accept / ask Priya to change the sheet | **Accept.** The code still never builds a heartbeatstatus byRoom. Raise the mechanism with Priya (Q1). |
| **D2** | P2-0032 is untagged and is **counted at 9502** via `heartbeatstatus.Location` (row 9502/401, a cell someone deleted). The registry lists it in the Lab and 9829 tabs *and* in the 9502 tab (room 425, installed 2025-10-27), so its tab history points to 9502 rather than the Lab. With the registry retired, nothing can see tab membership. No Fort Custer device leaks. | Accept / keep an exclusion list somewhere | **Accept**, and ask Priya where it is installed (Q6). |
| **D3** | The no-pool rule hides live units the sheet records as installed. The 11 at 6178 still surface as F4 flags. P2-0799 does not: 9502/221's note names P2-0779, which *is* the DeviceId, so F4 does not fire, and P2-0799 is untagged. 6178 reads 0 unmapped. | Accept / add another attribution path | **Accept.** F4 must display the named unit and its liveness. P2-0799 leaves the page and stays visible only through Q4. |
| **D4** | The time zone of sheet datetimes (§3) | Fix in the cutover / leave it | **Fix:** America/Chicago on every host. Confirm the Nov 1 DST behaviour with Priya (Q11). |
| **D5** | `CurrentTime` is per Location. `heartbeatstatus.Location` is two-valued for P2-0433. | Per property / max / first | **Per property**, the max in the header, nulls ignored. For attribution, an untagged device with more than one Location is unattributable, so it is neither listed nor counted. |
| **D6** | The F4 rule (§5) | As in §5 | **As in §5:** 28 flags, with 6178/302 shown separately. |
| **D7** | `render.js:151` fails the build on "The Lab" / "Fort Custer" / "ESA 9829" anywhere in the payload. Free-text notes now reach the page, so one ops note could take the site down (0 hits today). | Keep it fatal / fatal on structured fields, a flag on free text | **A flag on free text**, fatal elsewhere |
| **D8** | The display name (§4) | Particle by id / `Device# ` | **Particle by id**. `Device# ` is never resolved to an id. |
| **D9** | The no-fallback rule makes specific rooms worse. <br>• 6197/340: live P2-0856 gives way to P2-0639 (silent 101.6 d). <br>• 9502/221: live P2-0799 gives way to P2-0779 (silent 100.8 d; the names are one digit apart). <br>• 6197/103 gets the F1 duplicate. <br>• The critical readings at 9502/101 and 104 vanish. <br>• Ok rooms that are stale or have no device go 24 → **55**. | This is the design working: the sheet is the source of truth | **Accept.** 6197/103 → Q2. 6197/340 and 9502/221 → Q4. 9502/101 and 104 → Q12. Never present the Ok count as a recovery. |
| **D10** | Unplaced telemetry (§5) is not in the design | No page list / list the attributable rows only | **No new page list.** The live, attributable ones already appear in live-but-unmapped. Log the rest in the build output. The unattributable ones are never listed. |
| **D11** | Report *no device* separately from *never* (§4) | Split / keep lumped | **Split.** Blank DeviceIds go 6 → 17, and they are a different problem from silence. |
| **D12** | Display the F2 blind spot (§5) | Show it / omit it | **Show it.** Without it, a clean F2 at 9502 reads as reassurance. |
| **D13** | Delete `rooms[].lastChecked` (§7) | Delete / keep populated | **Delete**, with the lockstep in §7 |
| **D14** | The sheet header date label (§7) | Derive from `Battery Status` on row 2 / delete | **Delete**, since D5's `CurrentTime` stamp supersedes it |
| **D15** | List out-of-scope `roomstatus` rows (§3)? | List / drop silently | **Drop, and log them in the build output.** Never put them on the page. |
| **D16** | Fail unless every in-scope row lands in exactly one property (§2) | Add / skip | **Add** |
| **H1** | The outage gap is invisible on the charts (§8) | Leave it / plot x by date | **Plot by date**, and fix the window and both labels in the same change. Never backfill. |
| **H2** | Clerical steps are unmarked outside the fleet Triage chart (§8) | Extend `annotate` / accept | **Extend** it to the fleet unmapped chart and the per-property charts. |

---

## 10. Expected post-cutover numbers (against the 2026-09-25 pull)

Each cell reads TODAY / REPLAYED / NEW.
- TODAY is the live page as published (Sep 15).
- REPLAYED holds TODAY's assignments and sheet fields fixed, but re-measures them against today's Particle pull.
- **REPLAYED − TODAY is field movement:** 9.88 days of real time.
- **NEW − REPLAYED is everything the cutover brings in at once.** That covers the source switch, the sheet's own re-triage, and the Sep 17 export's newer readings. The newer readings are real change surfacing late (51 of the 77 battery-class changes, and most of the battery-age drop), and the page cannot tell them from the clerical part.

**Nothing here is a recovery.**

| metric | 6197 | 6178 | 9502 | fleet |
|---|---|---|---|---|
| rooms | 94 / 94 / 94 | 109 / 109 / 109 | 116 / 116 / 116 | 319 / 319 / 319 |
| Ok | 57 / 57 / **68** | 13 / 13 / **105** | 72 / 72 / **84** | 142 / 142 / **257** |
| Issue | 29 / 29 / 26 | 69 / 69 / **2** | 44 / 44 / 22 | 142 / 142 / **50** |
| Check | 8 / 8 / 0 | 11 / 11 / 2 | 0 / 0 / 10 | 19 / 19 / 12 |
| Unknown | 0 | 16 / 16 / **0** | 0 | 16 / 16 / 0 |
| triage | 37 / 37 / 26 | 80 / 80 / **4** | 44 / 44 / 32 | 161 / 161 / **62** |
| rooms with a device | 92 / 92 / 91 | 108 / 108 / 102 | 113 / 113 / 109 | 313 / 313 / 302 (300 ids) |
| hb fresh | 52 / 47 / 47 | 48 / 50 / 60 | 65 / 71 / 70 | 165 / 168 / 177 |
| hb aging | 10 / 9 / 9 | 7 / 13 / 14 | 16 / 6 / 6 | 33 / 28 / 29 |
| hb stale | 30 / 36 / 35 | 53 / 45 / 28 | 32 / 36 / 33 | 115 / 117 / 96 |
| hb never | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| hb no device | 2 / 2 / 3 | 1 / 1 / 7 | 3 / 3 / 7 | 6 / 6 / **17** |
| battery ok / warn / crit / unknown (TODAY → NEW) | 54/11/15/14 → 51/16/12/15 | 61/14/11/23 → 55/15/14/25 | 77/13/16/10 → 77/7/16/16 | 192/38/42/47 → 183/38/42/56 |
| median battery age, d (build-style) | 24.9 / 34.8 / 10.1 | 25.8 / 35.7 / 9.6 | 20.8 / 30.7 / 9.2 | 23.2 / 33.1 / 9.5 |
| liveUnder2d | 52 / 47 / 47 | 48 / 50 / 60 | 65 / 71 / 70 | 165 / 168 / 177 |
| unmappedLive | 0 / 0 / 2 | 0 / 0 / 0 | 0 / 0 / 2 | 60 / 71 / 4 |

**Battery-age values**
- TODAY and REPLAYED were parsed as UTC, like the live page, and carry about +0.2 d of error. NEW is Central-parsed. An unfixed UTC host would publish NEW as 10.3 / 9.8 / 9.4 / 9.7, in the table's column order.
- The page publishes no fleet median, so the TODAY fleet cell is derived.
- Like for like, the drop is −24.4 / −25.9 / −21.3, fleet −23.4 d. All buckets are `stale`.

**How to read the movement**
- **Status.** The sheet itself went 127 → 62 triage rows between the Sep 8 and Sep 25 pulls. 108 rooms changed status, and 122 changed status or DeviceId.
  - **55 NEW Ok rooms are stale or have no device** (6197 15, 6178 31, 9502 9). That is against 24 TODAY and 30 REPLAYED: +6 field, +25 at the cutover.
  - **20 Ok rooms read critical battery.**
  - Together, 63 rooms have a green status the telemetry does not back.
- **Heartbeat.** Field: fresh +3, aging −5, stale +2. At the cutover: fresh +9, stale −21, no device +11.
  - Mostly this is 6178 floor 4. 11 rooms move from units silent 105–292 d to the units installed 9/16.
  - 12 rooms lose a device, and 11 of those devices were stale.
- **Battery age.** Of the fleet −23.4 d, **−20.4 to −22.1 d is export recency**: the Sep 17 export is newer than the Aug 25/26 legacy exports. Only −1.2 to −3.0 d is the source change.
- **Battery class.** 77 rooms change class:
  - 15 are corrections of readings today's page misattributes. These include all four of 9502's critical→ok.
  - 11 are device changes.
  - 11 are recorded battery swaps, which account for 10 of 6197's 11 critical→ok.
  - 40 are same-device export refreshes.
- **Voltage.** 17 rooms lose a voltage and 8 gain one.
  - Only 9502/402 (P2-0449) loses one because the consolidated export is narrower than the legacy ones.
  - 9502/101 and 104 (P2-0692/0694, both critical) reached a room only by room number, which the design forbids.

**Device changes TODAY → NEW: 34 rooms** (21 swapped, 12 lost, 1 gained)
- On the page all 34 happen at the cutover. The sheet records a physical event behind 28 of them, or 23 if "field" must mean the event *caused* the change.
- **(i) The ID reflects a recorded replacement: 19.**
  - 6178: 413, 415, 416, 417, 419, 420, 422, 423, 425, 429, 430, 432. All are 9/16 installs, and all are now live.
  - 6197: 110, 113, 117, 319, 340.
  - 9502: 126, 221.
- **(ii) The ID lags or contradicts the note: 7, all at 6178.**
  - 116, 201, 302, 404, 405, 406: DeviceId blank, lagging the note.
  - 418: DeviceId changed to `P-0823` (silent 133 d), which does not match the note's `P2-0823`. Unresolved; see F4 and Q3.
- **(iii) Everything else: 8.**
  - 6197/103: P2-0891 (live, override) → P2-0306, the F1 duplicate.
  - 6197/204: P2-0406 → blank (uninstall note).
  - 6178/132: P2-0796 → blank. That unit went to 432 on 9/16.
  - 9502/210, 307, 310, 315: registry units silent 163–330 d → blank.
  - 9502/229: registry P2-0014 (336 d) → P2-0797 (143 d).

---

## 11. Block 5 deletion list (line numbers at `c561bd5`; locate by symbol after Blocks 2–4)

The full verified site inventory lists 246 sites: 101 delete, 70 change, 10 reuse, 65 keep. It is in `investigate/cutover/verify-inventory/inventory-final.json`. A literal application of an earlier draft of this list broke `fetch.js`, `normalize.js`, `render.js` and `template.html`, so these three lists are separate on purpose.

**Delete outright**

| file | lines |
|---|---|
| `config.js` | `SHEET_IDS.registry` (24); `EXCLUDED_REGISTRY_TABS` (68-88) and its export (293), **if D2 is accepted**; `PROPERTIES[].sheetKey` (114/121/128) and `.registryTab` (115/122/129) |
| `fetch.js` | Override paths and modes (28-48); `RoomOverrideError` (61); `loadRoomOverrides` and its helpers (129-303); the override load and copy in `fetchAll` (510-514, 516-526). **Keep 515**, the `mkdirSync(RAW_DIR)` the workbook write needs on a fresh checkout. |
| `normalize.js` | Override import (30-34); `readExcludedDeviceIds` (260-302), if D2 is accepted; dead sheet reads (heartbeat 322-323, 345-346; shower 324-325, 347-348, 866-867); `hb.byRoom` (376-382); battery export `byRoom`, export voltage and `corruptHeartbeatRows` (397, 398, 403, 404, 407); `readRegistry` (412-461); `RoomOverrideApplyError`, `resolveRoomOverride` and `planRoomOverrideMerge` (467-685); registry, exclusion and override set-up (692-695, 699, 709-711, 715-718, 722-733, 740, 742-753, 762-769, 796-810); row fields `lastChecked` (870-873, per D13) and `registered`, `installDate`, `assignmentSource` (875-893), keeping `notes` at 874; `registryDevices` / `registryInventoryOnly` (933-934); replace and merge bookkeeping (959-1100); ghosts, unregistered reporters, mismatches, the no-registry note and orphan rooms (1102-1187); the corrupt-LastHeartbeat note (1225-1235); `hasRegistry` (1241); `hasDeviceColumn` (1242, if D8 picks the Particle name); exclusion counters (1286-1287, 1299-1316, 1373-1376); the `alsoInExcludedTabs` field (1331-1333); the reconciliation output keys (1396-1399, 1404-1409); `report()` lines (1483-1485, 1508-1511, 1523-1525) |
| `render.js` | The `alsoInExcludedTabs` scrub comment and loop (141-145, 147-149); the override pair balance (155-165) |
| `template.html` | `.prov` CSS (257-271); `#reconOverrides` (410); `fmtDate` (459-463; its only callers are in 1374-1411); `NOW` (432) and `ageDays` (469-473), which are already dead today; the registry card note (1017-1019); the "ungrouped" fleet note (1092-1104) **and its use at 1122**; `fmtYmd` and the override banner (1136-1216); `freshWindowDays` (1233-1239); the five override blocks (1277-1360); the ghosts, unregistered, mismatch and orphan blocks (1374-1411) |
| other | `test-overrides.js`, the whole file; the two-property-claim tests at 109-129 are rewritten as validation tests. `data/room-overrides.json`. The `.gitignore` negation (9). |

**Edit in place.** These lines also carry tokens that must stay.

| file | line(s) | edit |
|---|---|---|
| `fetch.js` | 103-113 | Replace the registry branch and its `else` with the unconditional required-tab loop over the new tab list. Deleting 103-108 alone is a SyntaxError. |
| `fetch.js` | 573-583 | Drop the override exports and fix the "13 requests" comment. `RAW_DIR` and `PARTICLE_FILE` (581-582) are not override exports: keep or drop them deliberately. |
| `normalize.js` | 28 | Remove `EXCLUDED_REGISTRY_TABS` only. `PROPERTIES`, `THRESHOLDS` and `PARTICLE` stay. |
| `normalize.js` | 355 | If D8 picks the Particle name, remove `hasDeviceColumn` from the return. `rows` stays, and `headerLabel` stays unless D14 deletes it. |
| `normalize.js` | 405, 409 | Drop `volts` from the record; return `{ byDevice, rowCount: rows.length }`. |
| `normalize.js` | 1335 | **Not deleted.** This is the per-property counter behind `unmappedLiveByGroup`, which feeds history (1565) and the card (`template.html:969`). Change it to `const bucket = prop.code;`, and skip unattributable devices before the push at 1322. |
| `normalize.js` | 1582-1584 | `module.exports = { normalize, report, dailyRecord, OUT_FILE }` |
| `render.js` | 146, 150 | Change these together: `scrubbed` (146) is read by the kept banned-string scan (150), shaped by D7. |
| `render.js` | 205 | Remove `'lastChecked'` only. `'actionItem'`, `'actionType'` and `'notes'` stay. |
| `template.html` | 1263, 1266-1268 | Remove the "unattributed" branch and the "(also in …)" suffix. The live-but-unmapped row stays. |
| `.gitignore`, `package.json` | 2-7; 13 | Fix the comment; repoint or remove `scripts.test`. |

**Must change in the same commit as the chain switch** (lockstep; these cannot wait for Block 5):
- **The assignment block, `normalize.js:771-794`.** It reads `tele`, `regRec`, `ovReplace`, `ovRec`, `mergeTouched` and `mergeRec`. It becomes `deviceId = t.deviceId`.
- **The battery join, `normalize.js:812-816`.** It becomes `batRec = deviceId ? bat.byDevice.get(deviceId) || null : null` and `volts = t.battery`.
- **`properties[].snapshot`.** It is read with no guard at `normalize.js:1429`, `:1561` and `template.html:1021`.
- **The reconciliation arrays.** They are read with no guard at `render.js:254-259` and `template.html:501-502`, `1374`, `1385`, `1394` and `1404`. A page-script throw is invisible to `verify-live.js`, which only parses the payload.
- **`lastChecked`.** It goes in all four places in §7.
- **`hasRegistry`.** Removing it without the template change makes every card read "No registry tab".

**Reuse as validation.** These existing guards reappear as flags, never as throws:
- `fetch.js:281` → F1, cross-property. `fetch.js:251` → F1, within a property.
- `normalize.js:543` → F2.
- `normalize.js:510-528` and the `byName` index at `:233` → F4 name resolution.
- `render.js:167-177` → becomes "every live-but-unmapped row is attributed to a live property".

**Not deleted.** `probe/02-exports.js` reads `sheetKey` and the legacy tabs (11, 23-27), and `probe/03`, `06` and `07` consume its output. **Freeze them with a header note.** `probe/FINDINGS.md` is the evidence that battery is absent from the Cloud API.

**FINDINGS §12, re-judged under this design**

| verdict | items |
|---|---|
| applies | #3, #6, #7, #8, #15. 9502/101 and 104 go to unknown battery. Priya: the battery worklist (now 80 warn/critical, of which 22 carry a Battery item and 55 carry no action; 25 Battery items in all, 3 of them on rooms reading ok). Priya: export scheduling. Not devicenames, no thresholds, no CSS cleanup. |
| applies, changed | #2: sheetKey is deleted, and the one-property-per-row check is proposed (D16). #4. #5: 13 → **10**, not 11. #9: DeviceId *is* the chain. #13: CurrentTime is per Location, and lastChecked is proposed for deletion (D13). The TRENDS annotation: wider (the pool step, H2). Priya: P2-0433, now flagged by F1 and F2. |
| moot | #10, #12, #14. Expected ghosts 6 → 8. 6178 room 208, which is back in the sheet as of this pull. Priya: room 208. |
| contradicted by design | #1 "keep registry" (retired; see D2). #11 "fix bat.byRoom" (deleted). "No cross-property guard" (built in as F1 and F2). |

---

## 12. Open questions for Priya

1. **DeviceId mechanism.** `DeviceId` is a formula over `heartbeatstatus`, so a unit reaches a room only after the export sees it. 27 notes dated 09/23/26 at 6178 lag the column. Should replacements be typed into `DeviceId` when they are installed?
2. **Duplicates.** **P2-0433** is in 6178/428 *and* 9502/308, in both `roomstatus` and `heartbeatstatus`. It is tagged `esa_6178`, and 428's note says it was replaced by P2-0553 on 9/16. **P2-0306** is in 6197/103 *and* 9502/103. Its telemetry is at 6197/103, while 9502/103's note names it. Which rows are right?
3. **P2-0823** is named at both 6178/329 (09/23) and 6178/418 (9/16). Particle knows only `P-0823`, which is 418's DeviceId and has been silent 133 d. Which unit is in each room?
4. **Two notes that contradict the telemetry.**
   - At 6197/340 the note names P2-0639 (silent 102 d). But P2-0856, live and tagged `esa-6197`, was the unit there on the Sep 15 page, and it is now in no room.
   - At 9502/221 the note names P2-0779 (silent 101 d), while the live P2-0799 was there. The two names are one digit apart.
   - Which unit is in each room?
5. **The June batch.** 14 named replacement units have not reported since they were installed. 17 of the 25 silent note-named units last reported on Jun 16–17. Are they powered and connected?
6. **P2-0032.** The registry lists it in the Lab and 9829 tabs, and also in the 9502 tab at room 425. Priya's export places it at 9502/401, but that `DeviceId` cell was deleted, and 401's Action Item reads "Recheck device name". Is it installed at 9502, and in which room?
7. **P2-0556** is named for 6178/101, but `DeviceId` places it at 9502/233.
8. **The battery worklist.** Of 80 warn/critical rooms, 22 carry a Battery action item and 55 carry no action. Three more Battery items sit on rooms reading ok, and 20 critical rooms are status Ok. Five rooms noted "Replaced batteries recently" still show pre-replacement readings: 6197/119, 211, 213, 234, and 9502/329.
9. **Two single rooms.** **9502/402 (P2-0449)** was dropped from the consolidated export; its only battery row is in the retired `wo_9502`. **6197/321** is status Ok with "Replace device: WiFi not connecting".
10. **Export cadence.** The two samples are Sep 4 20:00 and Sep 17 12:30 CDT, 12.7 days apart. Every battery badge is `stale` on cutover day. Scheduling the export is still the highest-value fix.
11. **Time zone.** Does the export write Central wall-clock time, and does it switch to CST on Nov 1? The sheet's own `Days with no Shower` formula treats the timestamp as UTC (`-5/24`), and the telemetry says otherwise.
12. **9502/101 and 104.** P2-0692 and P2-0694 carry `batterystatus` rows for rooms 101 and 104, both critical. They are untagged, have no `Location`, and have been silent 133 d, while both rooms' `DeviceId` is blank. Are those rooms without a unit?

# CUTOVER.md — consolidated-workbook cutover contract

**Block 1 of 5.** Written 2026-09-25 against `c561bd5` in a read-only session. It was refreshed the same
day against Priya's 11:48 CDT re-export, and Ian's decisions were recorded in §9. The decisions for Block 2
(D5b, D6, D8, D10, D11, D13, D14, D15, D16) were recorded in §9 on the `cutover` branch the same day.

This is the contract Blocks 2–5 implement. For background, see
[`docs/CONSOLIDATION-FINDINGS.md`](docs/CONSOLIDATION-FINDINGS.md) (the Sep 8–9 investigation).
Where the two disagree, this document wins, because the sheet has moved since then.

**What the figures are "as of"**

| input | stamp |
|---|---|
| Consolidated workbook export | `heartbeatstatus.CurrentTime` **2026-09-25 11:48:26–36 CDT**. Headers read `[Sep 25, 2026]`. |
| Battery data inside that export | `batterystatus` is **unchanged since the Sep 17 export**: newest `LastTimestamp` 2026-09-17 12:24 CDT, and 0 of 268 rows changed. |
| Particle device list | pulled `2026-09-25T18:55:43Z` (879 devices) |
| TODAY | the live page's embedded payload, built `2026-09-15T15:28:56Z` |

**How the figures were made**
- Every number came from a script.
- The first draft was built against the Sep 17 export. Each figure was derived twice independently, reconciled, and checked by a third reader. Five adversarial verifiers then checked the text.
- The refresh re-ran the same reconciled scripts against the Sep 25 export. Only what changed was spot-checked; there was no second verifier pass.
- The scripts are in `investigate/cutover/` (the refresh is in `investigate/cutover/refresh/`). That directory is git-excluded and local only.
- Heartbeat buckets and ages move daily, and status and device counts move whenever the sheet is edited. **Re-run before quoting anything on cutover day.**

**What changed between the Sep 17 and Sep 25 exports** (`refresh/01-diff-exports.js`)

| | |
|---|---|
| Statuses, Action Items, Notes, Calibration Risk | Unchanged (319 rooms) |
| `DeviceId` | **One room moved:** 6197/103, P2-0306 → P2-0891 (`…0176d0`). This clears the P2-0306 duplicate. |
| `DeviceId` cells | 6178/330, 413 and 415 went from typed to formula, with the same ids. The column is now **282 formula / 35 typed / 2 absent**. |
| `batterystatus` | Byte-identical: 268 rows, 0 voltage changes, 0 timestamp changes. 6197/103 loses its voltage, because P2-0891 has no battery row. |
| `heartbeatstatus` | 268 → 282 rows (280 ids). 16 rows were added: 14 at 6178, plus P2-0891 at 6197/103 and P2-0306 at 9502/103. 2 were removed: P2-0117 at 9502/103 and P2-0306 at 6197/103. |

**How to read the rest.** It states the approved design (§1–§7) and the decisions Ian made on 2026-09-25 (§9). **Anything still marked *Recommended*, *Proposed* or *open* is not decided.**

---

## 0. Outage — the site has not refreshed since 2026-09-15

| | |
|---|---|
| Symptom | Live `builtAt` is `2026-09-15T15:28:56Z`. The last `history/` record is `2026-09-15` (`c561bd5`). Ian confirmed Netlify shows no deploy since Sep 15. |
| Runs | `daily-refresh` has fired on schedule every day, and failed 9 times running from Sep 16 to Sep 24, each in 13–23 s. The schedule itself is fine. |
| Error | Identical in all 9 runs, and reproduced locally: `NORMALIZE FAILED: room override for 6197 names device "P-0351" for room "226", which matches no device in product 18173.` |
| Cause | **Class (b): the override tripped.** `fetch.js` `loadRoomOverrides` passed; the name resolution in `resolveRoomOverride` (`normalize.js:510-520`) threw. Between the Sep 15 15:28Z pull and the Sep 16 15:21Z run, devices `…4a017a74` and `…4a017aa8` were **renamed in Particle from `P-0351`/`P-0791` to `P2-0351`/`P2-0791`**, correcting a naming typo. The same ids render as `P-0351`/`P-0791` on the Sep 15 page. `data/room-overrides.json` has spelled them `P-` since `f479613` (6197 rooms 226 and 237), and its exact-name guard failed loudly, as designed. |
| Not the cause | Credentials (the Particle pull succeeds in every run), the schedule, GitHub settings, Netlify settings. |
| Why Netlify is silent | The workflow dies at `node normalize.js`, before the history commit and before the build-hook step. Nothing is pushed and no hook is called. |
| Fix | **Interim (decided 2026-09-25):** follow the rename in the override (`P-0351`→`P2-0351`, `P-0791`→`P2-0791`). This ships as its own commit after this document. **Permanent:** the cutover removes this failure class. Assignment keys on `DeviceId`, and no name is ever resolved into an assignment (§5). |
| Cost | `history/` has no records for 2026-09-16 → 09-24, and they are never backfilled. |

---

## 1. The approved design (Ian, 2026-09-24)

**Sources**
- **Source of truth: two tabs.**
  - `roomstatus`: rooms, `Location`, `DeviceId`, `Status`, `Action Item`, `Notes from/to Ops`, battery voltage, `Calibration Risk`.
  - `batterystatus`: battery `LastTimestamp`, joined by device id.
- **`heartbeatstatus` is secondary.** Its `CurrentTime` is the "sheet export as of" stamp. Its `Location` may attribute devices for reconciliation, never for assignment.
- **`devicenames` is not read.**
- **Liveness stays on Particle.** One endpoint only, `GET /v1/products/18173/devices` (9 paginated requests today), unchanged. Days-silent is measured against build time.

**Assignment**
- **Room→device chain: `roomstatus.DeviceId → null`.** No fallback of any kind: no override, no `heartbeatstatus` byRoom, no registry byRoom, no battery byRoom.
- Notes are never parsed into an assignment.

**Retired**
- The three legacy work-order workbooks and the registry workbook (4 workbooks → 1; **13 → 10 requests** per build).
- `data/room-overrides.json` and `test-overrides.js`. Their guard logic is reused as sheet validation.

**Conflicts and structure**
- **Sheet conflicts FLAG, never fail:**
  - one device id in two rooms (F1);
  - `Location` vs a live-property `esa_` group tag (F2);
  - a `DeviceId` unknown to Particle (F3);
  - a note naming a replacement device the `DeviceId` column does not show (F4).
- **Structure FAILS loudly:** a missing tab, a missing required header, or a property with zero rows (§2).

**Live-but-unmapped**
- Attribution comes from a live-property `esa_` tag, or else from `heartbeatstatus.Location`.
- It never uses the registry, and never a bare room number (`batterystatus` has no `Location`).
- Unattributable devices are never listed or counted, so the untagged fleet pool goes away. That is what keeps Lab / Fort Custer hardware off the page (see D2).

---

## 2. Fetch contract

| | |
|---|---|
| Workbook | `1_qlAjrnafeOQN-EYXGXf0Gks3BZySXtpWk_FKbpQQGI`, via `https://docs.google.com/spreadsheets/d/{ID}/export?format=xlsx`. Verified anonymous and read-only on 2026-09-25. It stays public only while it remains link-shared. |
| Plus | Particle `GET /v1/products/18173/devices`: 9 pages, unchanged, through `fetch.js` only. |
| Requests per build | **10** (1 workbook + 9 Particle pages). Today it is 13. |
| Tabs required | `roomstatus`, `batterystatus`, `heartbeatstatus`. `devicenames` exists and is neither required nor read. |
| Header row | **`roomstatus`:** row 2, read with `sheet_to_json(ws, { range: 1, defval: null, raw: true })`. Row 1 is a counter formula and is **never read**, including by `sheetHeaders()` (`normalize.js:147`), which reads row index 0. **Other tabs:** row 1. |
| Required headers | Headers are matched with `findKey` (`normalize.js:158`), which trims each header before testing it. The patterns carry their own anchors: `^…$` for exact names, and `^` alone where a date suffix follows. |
| | **`roomstatus`:** `/^location$/i`, `/^rooms?$/i`, `/^deviceid$/i`, `/^status$/i`, `/^action item/i`, `/^notes/i`, `/^battery status/i` (date suffix, currently `[Sep 25, 2026]`), `/^calibration risk/i`. `/^device\s*#/i` (header `Device# `, with a trailing space) is **not** required: D8 chose the Particle name. |
| | **`batterystatus`:** `ParticleDeviceId`, `LastTimestamp` |
| | **`heartbeatstatus`:** `ParticleDeviceId`, `CurrentTime`, `Location` |
| FAIL loudly | A missing tab. A missing required header. A configured property with zero `roomstatus` rows, checked **after** `Location` is converted to a string code (§3). **Decided (D16):** also fail unless every in-scope row lands in exactly one property, which guards FINDINGS §3.1. |
| Today's data | 3/3 tabs present. Every required header above is present. No property has zero rows. |

---

## 3. Normalization

| column / rule | contract |
|---|---|
| `Location` (both tabs) | A **number** in all 319 `roomstatus` rows and all 282 `heartbeatstatus` rows. Convert it to a 4-digit **string** code before comparing with `PROPERTIES[].code`. A number-to-string compare fails silently: in `roomstatus` it yields zero rows (the zero-rows FAIL catches that); in `heartbeatstatus` it empties every Location attribution (§6) and every per-property `CurrentTime` (§7), and nothing catches it. A `roomstatus` row whose code is outside the three is excluded and never counted (0 today). **Decided (D15):** it is dropped and logged, not listed. |
| `Rooms` | Normalize with `normRoom` (`102.0`→`"102"`; letter suffixes kept); the key is lowercased. A duplicate (property, room) keeps every row and raises the existing duplicate note (0 today). |
| `DeviceId` | `normStr`, valid only if it matches `/^[0-9a-f]{24}$/i`. Blank means no device: 15 cells are formulas returning `""` and 2 are absent. A non-blank value that is not 24-hex, or not known to Particle, is **flagged F3 and bucketed `never`**. It never fails the build (0 today). **Contradiction (Block 2):** the implementation reads the `normStr` placeholder tokens (`NA`, `n/a`, `No device`, `-`, `--`, `null`) as blank, i.e. *no device*, not as F3. Spreadsheet errors (`#REF!`, `#VALUE!`, `#N/A` and kin) are F3, bucket `never`. 0 cells today. Open for Ian: keep, or make every typed non-id F3. |
| `Status` | `normStr(...) \|\| 'Unknown'`. Triage is Issue + Check. |
| `Action Item` | `actionType()`. The literal `None` means no action (256 rows). |
| Battery voltage | `normNum` of the `/^battery status/i` column, then `batteryClass()` with the confirmed thresholds, unchanged. |
| Battery age | `batterystatus.LastTimestamp`, joined by `ParticleDeviceId` **only**, and measured against build time. |
| `Calibration Risk` | Read and carried as text: No 189, No data 88, Yes 20, No savings 12, Maybe risky 8, Too many FPs 2. How it is displayed is a Block-level choice. No savings metric is derived from it. |
| `Notes from/to Ops` | Display text. Parsed only by F4, and never for assignment. It falls inside the banned-string scan (`render.js:151`); see D7. |
| **Never read** | **`roomstatus`:** row 1; `Days with no Heartbeat` and `Days with no Shower` (formulas, and one hardcodes a date); `Last Heartbeat [..]`; `Last Shower`; `Device# ` (D8). **`batterystatus`:** `RoomNumber`, `LastHeartbeat`, `BatteryVoltage_V` (the roomstatus voltage is a lookup of it). **`heartbeatstatus`:** `RoomNumber`, `LastHeartbeat`, `TimeDiff`. **`devicenames`:** the whole tab. |
| **Sheet datetimes** | **Decided (D4): fixed in Block 2.** Parse sheet datetimes as America/Chicago, DST-aware, with no new dependency. **Verify each timestamp column against Particle** wherever the same event exists, and do not assume one zone for the whole workbook: the sheet's own `Days with no Shower` formula subtracts `5/24`. Today the pipeline has no time-zone handling, and Netlify and Actions parse in UTC. |
| Padding | `batterystatus` has 604 trailing blank rows, which `sheet_to_json` already drops (268 data rows). |

**The time-zone evidence so far** (Sep 17 export). Block 2 re-verifies it column by column.
- **`heartbeatstatus.LastHeartbeat`:** read as Central, it matches Particle `last_heard` within 4 minutes on 67 of the 70 rows whose device had been silent ≥ 10 d. Read as UTC, those same rows are exactly 5 h early.
- **`batterystatus.LastTimestamp`:** it equals `last_heard` exactly on 28 of 72 long-silent rows when read as Central, and on 0 when read as UTC.
- **Legacy exports:** they behave the same way, so today's published battery ages are about 0.2 d too old.
- **Coverage:** every compared timestamp falls in CDT, so the Nov 1 switch to CST is unconfirmed (Q11).

> **Corrections from the Block 2 re-verification (2026-09-25, Sep 25 export; these contradict two lines above).**
> - *`LastTimestamp` does not equal `last_heard` exactly.* No row matches to the second under either reading. The 28
>   near-matches fall **7–172 s before** `last_heard`: 28 of 73 long-silent rows are within 4 min read as Central, and
>   0 read as UTC, where the same 28 sit at −5 h. The conclusion, Central, stands. Block 1's "exact" counted
>   differences that round to 0.0 h at 0.1 h resolution.
> - *Not every compared timestamp is CDT.* One is CST-dated: `batterystatus` row 88, **P2-38** (`…02b91c`),
>   2025-11-26 06:19 Central. It matches `last_heard` under neither reading (−143 h Central, −149 h UTC), so it
>   carries no CST evidence, and Q11 stays open.
> - The other columns confirm Central. `heartbeatstatus.LastHeartbeat` (not read by the build) has 65 of 70
>   long-silent rows within 4 min as Central and 0 as UTC. The other 5 are later than `last_heard` under both
>   readings, so they are not a zone effect. `heartbeatstatus.CurrentTime` reads 11:48:26 / :31 / :36 CDT; read as
>   UTC, 31 rows would have been heard after the export that contains them.

**What the columns actually are** (D1, accepted)
- `DeviceId` is a lookup formula over `heartbeatstatus` by (Location, RoomNumber) in 282 of 319 cells. 35 cells are typed and 2 are absent.
- `Battery Status` is a lookup of `batterystatus.BatteryVoltage_V` by DeviceId in all 319 cells.
- The build reads the cached values. **Typed cells freeze: they do not follow re-exports.**

---

## 4. Joins

| join | key | notes |
|---|---|---|
| room → device | `roomstatus.DeviceId` | Nothing else. No fallback. |
| device → liveness | Particle `id` | `last_heard` against build time: <2 d fresh, 2–7 aging, >7 stale, else never. **Decided (D11):** report *no device* (blank DeviceId) separately from *never*. |
| device → battery age | `batterystatus.ParticleDeviceId` | Never by `RoomNumber`. |
| device → attribution (unmapped only) | A live `esa_####` / `esa-####` group via `particleGroupCode`; else `heartbeatstatus.Location` by id. **Contradiction (Block 2):** the implementation takes the first `esa_` group that names a *live* property (`liveTagOf`); `particleGroupCode` takes the first `esa_` group of *any* property. They differ only for a device with two or more `esa_` groups: 0 of 879 today. F2 uses the same rule. | Keep the anchored regex: `baseline_6_shelves_esa_wifi_spi` must not match. **A Location-attributed device is labelled "attributed by export Location" on Reconciliation (D2, decided).** **Decided (D5b):** an untagged device with more than one `heartbeatstatus.Location` is unattributable. |
| device → display name | **D8, decided: Particle name by id** | Not the `Device# ` text, which is never read. They differ on 3 rows: 6178/418 (`P2-0823` vs Particle `P-0823`), and 6197/226 and 6197/237 (sheet `P-`, Particle `P2-`). **`Device# ` must never be resolved to an id**; that is exactly what caused the §0 outage. |

---

## 5. Flags and validators

**Decided (D5): guard checks become validators that return findings. Nothing ported from `resolveRoomOverride` may throw.**

| flag | definition | as of the Sep 25 export |
|---|---|---|
| **F1** | One device id in two or more `roomstatus` rows | **1 device / 2 rows, cross-property:** P2-0433 (`…017d18`, `esa_6178`, silent 26.8 d) at 6178/428 and 9502/308. *The P2-0306 duplicate was cleared by the Sep 25 export.* |
| **F2** | Row `Location` ≠ the live-property code of the device's `esa_` group | **1:** 9502/308 (P2-0433, `esa_6178`). F2 can check only devices carrying a live-property `esa_####` group. That covers 93.4 % of device rows at 6197, 86.3 % at 6178 and **32.1 % at 9502**, where 74 of 109 rows have none (57 of the 74 carry a `baseline_*` group). **Recommended (D12):** display this blind spot. |
| **F3** | `DeviceId` not 24-hex, or unknown to Particle | **0** |
| **F4** | A note names a replacement that `DeviceId` does not show | **28, all at 6178.** 21 where DeviceId still shows the room's previous unit (TODAY's device in all 21; no note names the unit it replaced). 5 where DeviceId is blank (116, 201, 404, 405, 406). 2 where the named unit is unresolvable (329 and 418, both `"P2-0823"`). The unnamed `"Replaced device"` at 6178/302 is shown separately (+1). |

**The F4 rule**
- **Recognize:** `Replaced with <name>`, `<name> installed`, and `correct device … is <name>`.
- **Exclude:** `Replaced batteries recently` (20 rows) and `Showerhead replaced` (1 row, 6178/130).
- **Resolve** by exact, trimmed, case-insensitive Particle name to an id, then compare that id with `DeviceId`.
  - No match, or several matches, is itself a finding (`normalize.js:510-528`, as a validator). There are 0 duplicate names today.
  - **Never resolve by digits alone.** `P2-0823` vs `P-0823` stays unresolved.
- **Notes are free text.** Of the 61 notes the rule recognizes, 20 are undated (6 at 6197 and 14 at 9502, none flagged), and two read `9/16` with no year (6178/418 and 428).

**Where the named units are now**
- Of the 26 resolvable named units in flagged rows, **13 are live, and 12 of those are in no room anywhere**. The other 13 were last heard 99.9–133.1 d ago.
- Across all 58 resolvable note-named units, 24 are silent, and 16 of those last reported on Jun 16–17.
- Two units long silent reported today: **P2-0860** (named at 6178/204) and **`P-0823`** (DeviceId at 6178/418).

**Validators, not throws.** Ported verbatim, the override guards would throw on today's data:
- F1 (P2-0433; cross-property, so `fetch.js:281`; the within-property `fetch.js:251` finds nothing);
- F2 (9502/308, `normalize.js:543`);
- the unresolvable note name `P2-0823` (`normalize.js:511`).

"One `CurrentTime`", "unique `heartbeatstatus` id" and "one Location per id" would also throw if written as asserts; P2-0433 still has two `heartbeatstatus` rows. **All of these return findings.** Only the structural checks stay fatal: missing tab, missing header, and zero rows (after the §3 conversion). The banned-string scan is fatal too, subject to D7.

**Unplaced telemetry**
- This is a finding, not a page list (D10).
- **10 rows** (7 `batterystatus` + 3 `heartbeatstatus`) cover **7 devices** that no room holds.
- `V` is `batterystatus.BatteryVoltage_V`, read by this investigation; the design does not read it.

| device | Particle group | attribution under §6 | last heard | V |
|---|---|---|---|---|
| P2-0117 `…02575c` | `esa-9502-non-spi` | 9502 (tag) | 92.6 d | 2.796 |
| P2-0692 `…017694` | none | unattributable | 133 d | 2.800 |
| P2-0694 `…01769c` | none | unattributable | 133 d | 2.801 |
| P2-0032 `…024e2c` | `baseline_6_shelves` | 9502 (attributed by export Location) | **0.3 d** | 3.575 |
| P2-38 `…02b91c` | `esa-6178-non-spi` | 6178 (tag) | 297 d | 3.660 |
| P2-0519 `…017c64` | `baseline_6_shelves_esa_wifi_spi` | 9502 (attributed by export Location) | **0.2 d** | 3.858 |
| P2-0454 `…017794` | `baseline_6_shelves_esa_wifi_spi` | 9502 (attributed by export Location) | 130 d | 4.311 |

**Why the heartbeatstatus rows are unplaced.** The 3 `heartbeatstatus` rows sit at 9502/223, 401 and 402. At each, a typed value (223, 402) or a deleted cell (401) displaced the unit heartbeatstatus reports for that room. The Sep 25 export dropped P2-0117's row at 9502/103, and now reports P2-0306 there, which matches the typed DeviceId.

---

## 6. Live-but-unmapped

**Rule:** a Particle device heard ≤ 7 d ago, held by no room, and attributed by a live tag or else by `heartbeatstatus.Location`.
- Fleet equals the sum of the properties.
- The daily-record comment at `normalize.js:1574-1576` ("NOT the sum") changes, and so does the fleet field `unmappedLive: q.unmappedLive || 0` at `:1578`.

| | TODAY (Sep 15 page) | REPLAYED (legacy rule, today's Particle) | NEW |
|---|---|---|---|
| 6197 / 6178 / 9502 | 0 / 0 / 0 | 0 / 0 / 0 | **1 / 0 / 2** |
| untagged pool | 60 | 73 | dropped (D3, decided) |
| fleet | 60 | 73 | **3** |

**The NEW three**
- **P2-0856** (`esa-6197`). It was the override's unit at 6197/340, and the sheet now names P2-0639 there.
- **P2-0519** and **P2-0032** (9502, "attributed by export Location").

P2-0891 left this list when the Sep 25 export put it in 6197/103.

**88 live devices are unattributable** (28 in the registry exclusion tabs, 60 not). They are neither listed nor counted.
- Among them are **12 live 6178 replacement units** that notes record as installed. They stay visible through F4.
- Also among them is **P2-0799**, which was live at 9502/221 on today's page (Q13).

---

## 7. Stamps

| stamp | source | contract |
|---|---|---|
| Sheet export as of | `heartbeatstatus.CurrentTime` | **Decided (D5):** a per-property "sheet export as of" on each card, and the header shows the **oldest**. There are three values, one per Location, spanning 10.5 s: 2026-09-25 11:48:26 (9502), 11:48:31 (6178) and 11:48:36 (6197) CDT. The Sep 8 pull had the same shape plus one null. Nulls are ignored; a property with none shows "unknown". |
| daily record `snapshot` | the date of the above | After D4, this must be the **America/Chicago calendar date**, not `currentTime.slice(0, 10)` (`normalize.js:1561`). An export at or after 19:00 CDT would otherwise record as the next day. This is CLAUDE.md's date-only trap. |
| Heartbeats as of | `builtAt` | Unchanged. It is `new Date()` at `normalize.js:696`, seconds after the Particle pull (`particle.pulledAt`). |
| Page built | `builtAt` | Unchanged. |
| Battery-data badge | per-property median of `batteryAgeDays` | Unchanged mechanics. **All three read `stale`:** 6197 10.9 d, 6178 9.8 d, 9502 9.5 d (Central-parsed; an unfixed UTC host reads 11.1 / 10.0 / 9.7). The lag floor is 8.06 d. **The Sep 25 export did not refresh `batterystatus`**, so a Sep 25 "sheet export as of" stamp sits beside Sep 17 battery data. The badge, not the export stamp, is the honest battery-freshness signal. |
| Sheet header date | the `[Sep 25, 2026]` suffix | Today `snapshot.headerLabel` and `labelMatchesSnapshot` are read from the `Last Heartbeat [..]` header via `sheetHeaders()` on row index 0 (`normalize.js:311-316`, `1205-1223`, `1247-1248`; rendered at `template.html:1021`). On `roomstatus` that row is the banner, so the label silently becomes null. **Decided (D14): delete these sites together.** The Sep 25 export shows why a header date alone cannot vouch for battery data. |
| `rooms[].lastChecked` | — | **Decided (D13): delete.** It is the per-property export stamp, copied onto every row. If it goes, these change together: `normalize.js:870-873`; `render.js:117-120` (which becomes an assertion that every `properties[].snapshot` carries a `currentTime` key, null allowed); `render.js:205`; and `template.html:757`. |

---

## 8. History continuity

**Records and gaps**
- **`history/` is a record, and is never rewritten or backfilled.** The days 2026-09-16 → 09-24 have no file.
- The interim override fix (§0) resumes daily records **with legacy values**. The first record carrying consolidated values comes later, at the cutover.

**The gaps will not look like gaps (H1, pending)**
- Trend x is the record's *index* in the window, not its date (`template.html:883`). The last record before a gap is therefore drawn beside the first record after it.
- The comment at `:860` ("a gap occupies its real horizontal width") holds only for a field missing from a record, not for a missing day.
- `render.js:57` ships the last 30 *records*, not 30 days.
- Two labels count records as days: "over N days" (`template.html:960`) and "Trends cover the last 30 days of daily records" (`:1125`).

**The gap rule is unchanged.** A field absent from a record is a gap, never a zero. The daily-record shape does not change.

**Where markers are drawn (H2, open)**
- Only the fleet Triage-rows chart draws markers (`annotate: true` at `template.html:1116`).
- The fleet "Live, awaiting room mapping" chart (`:1121-1122`) and every per-property chart (`:984-988`; policy at `config.js:220-224`) have none, and there is no fleet Ok series.
- So the fleet unmapped step and 6178's Ok step (13 → 105) both draw unannotated.

**Series that change meaning at the cutover**

| field | before | after |
|---|---|---|
| `triageRows`, `properties.*.ok/issue/check` | Legacy sheets, frozen Aug 25/26 | The consolidated sheet, re-triaged by Priya. 6178's 16 `Unknown` go to 0. |
| `properties.*.reporting/silent` | Override → export → registry | `DeviceId` only. Rooms with no device go 6 → 17. |
| `properties.*.battery` | Export by device → **byRoom fallback** → Room Status | roomstatus voltage only. The 18 readings today's page misattributes disappear. |
| `properties.*.snapshot` | Per-property legacy export date (`2026-08-25/26`) | The consolidated `CurrentTime` date, per property (D5), as a Chicago calendar date (§7) |
| `properties.*.unmappedLive` | Tag only | Tag, else `heartbeatstatus.Location` |
| fleet `unmappedLive` | Properties + untagged pool (60 on Sep 15) | Sum of the properties (3) |
| `liveUnder2d` | — | Unchanged in meaning |

**The `TRENDS` annotation**
- It is dated on the *first record that carries consolidated values*: the UTC date of the first green `daily-refresh` after the cutover merges. That follows the convention of every existing entry.
- A date with no record never renders (`template.html:893`).
- Fill in the placeholders from the records on either side at merge time. Proposed text:

```js
// The dashboard moved onto Priya's consolidated workbook: roomstatus.DeviceId is the
// whole room->device chain; the legacy workbooks, registry and override are retired.
// No single field event happened on this date, but the step folds that source change
// together with field work the sheet recorded while the legacy sheets were frozen (e.g.
// 12 units installed at 6178 on 9/16 now report). The chart cannot separate the two;
// read it as neither a recovery nor a regression. Triage steps <before> -> <after> and
// the fleet awaiting-room-mapping line <before> -> <after> (the untagged pool is no
// longer counted); against the 2026-09-25 export they would read 161 -> 62 and 73 -> 3.
{ date: '<first record carrying consolidated values>', label: 'consolidated sheet' },
```

---

## 9. Decisions

**Decided by Ian, 2026-09-25**

| # | decision |
|---|---|
| **D1** | **ACCEPTED:** `DeviceId` is a `heartbeatstatus` lookup, plus typed cells (35 today). The build reads cached values. **Typed cells freeze and do not follow re-exports.** Assignments in formula cells move whenever Priya re-exports. A unit that has never reported can be placed only by typing its id. |
| **D2** | **ACCEPTED:** P2-0032 is counted at 9502 via `heartbeatstatus.Location`. On Reconciliation it is labelled **"attributed by export Location"**, and so is every Location-attributed device. The registry lists P2-0032 in the Lab, 9829 *and* 9502 tabs (room 425, installed 2025-10-27). No Fort Custer device leaks. |
| **D3** | **Untagged pool DROPPED**, as designed. P2-0799 goes to Priya (Q13). |
| **D4** | **FIX IN BLOCK 2.** Parse sheet datetimes as America/Chicago, DST-aware, with no new dependency. Verify each timestamp column against Particle wherever the same event exists, and do not assume one zone for the whole workbook (the shower formula subtracts `5/24`). |
| **D5** | **Export stamp:** a per-property "sheet export as of" on each card; the header shows the oldest. **Guard checks become validators that return findings.** Nothing ported from `resolveRoomOverride` may throw. |
| **D9** | **The Ok-but-stale/no-device rooms** (54 as of the Sep 25 export) are surfaced as a **Reconciliation list in Block 4**. Status is never overridden. |
| **H1** | **PENDING.** Plotting trend x by record index is a scope change, for Ian to decide before Block 3. |

**Decided by Ian for Block 2, 2026-09-25** (implemented on the `cutover` branch)

| # | decision |
|---|---|
| **D5b** | **An untagged device with more than one `heartbeatstatus.Location` is unattributable:** neither listed nor counted. (P2-0433 is two-valued today, but it is tagged and placed, so moot.) |
| **D6** | **The F4 rule exactly as §5:** recognise `Replaced with <name>`, `<name> installed` and `correct device … is <name>`; exclude battery and showerhead work; resolve by exact, trimmed, case-insensitive Particle name, never by digits. 28 findings; the unnamed `Replaced device` at 6178/302 is shown separately. |
| **D8** | **Display name = Particle name by id.** `Device# ` is never read and never resolved to an id. |
| **D10** | **No page list** for unplaced telemetry. It is logged in the normalize report; the live, attributable devices already appear in live-but-unmapped. |
| **D11** | **Split *no device* from *never* in the data** (6 → 17 blank DeviceIds). Display is Block 3. |
| **D13** | **Delete `rooms[].lastChecked`** with its lockstep sites (§7). |
| **D14** | **Delete the sheet-header date label** with its sites (§7). D5's per-property stamp supersedes it, and the Sep 25 export shows a header date cannot vouch for battery data. |
| **D15** | **Drop out-of-scope `roomstatus` rows, and log them.** |
| **D16** | **FAIL unless every in-scope row lands in exactly one property** (§2). |
| **D11 bars** | **The card's heartbeat bars draw a "No device" bucket in Block 2** (config `heartbeatAge.noDeviceBucket`, neutral tone). The D11 split had made every card's bars drop its no-device rooms, which is breakage rather than new UI. Every card's bars sum to its room count. The rest of D11's display waits for Block 3. |
| **No room number** | **A row with a configured Location but a blank room number is dropped and logged, like D15, and is never fatal.** D16 guards the partition, not room identity, and a half-typed row must not take the site down. Its count is reported beside the D15 count (0 today). |

**Pending for Block 3** (not implemented in Block 2)

| # | finding | options | recommendation |
|---|---|---|---|
| **D7** | `render.js:151` fails the build on "The Lab" / "Fort Custer" / "ESA 9829" anywhere in the payload. Free-text notes now reach the page (0 hits today). | Keep it fatal / fatal on structured fields and a finding on free text | **A finding on free text** |
| **D12** | The F2 blind spot (§5) | Show / omit | **Show** |
| **H1** | See above | — | — |
| **H2** | Clerical steps are unmarked outside the fleet Triage chart (§8) | Extend `annotate` / accept | **Extend** it to the fleet unmapped chart and the property charts |

---

## 10. Expected post-cutover numbers (as of the 2026-09-25 11:48 CDT export)

Each cell reads TODAY / REPLAYED / NEW.

| column | what it is | movement |
|---|---|---|
| TODAY | The live page as published on Sep 15 | — |
| REPLAYED | TODAY's assignments and sheet fields, re-measured against the Particle pull of 2026-09-25T18:55Z | **REPLAYED − TODAY is field movement:** 10.14 d of real time. |
| NEW | The approved design | **NEW − REPLAYED is everything the cutover brings in at once:** the source switch, the sheet's own re-triage, and the consolidated export's newer battery readings (real change surfacing late). |

**Nothing here is a recovery.**

| metric | 6197 | 6178 | 9502 | fleet |
|---|---|---|---|---|
| rooms | 94 / 94 / 94 | 109 / 109 / 109 | 116 / 116 / 116 | 319 / 319 / 319 |
| Ok | 57 / 57 / **68** | 13 / 13 / **105** | 72 / 72 / **84** | 142 / 142 / **257** |
| Issue | 29 / 29 / 26 | 69 / 69 / **2** | 44 / 44 / 22 | 142 / 142 / **50** |
| Check | 8 / 8 / 0 | 11 / 11 / 2 | 0 / 0 / 10 | 19 / 19 / 12 |
| Unknown | 0 | 16 / 16 / **0** | 0 | 16 / 16 / 0 |
| triage | 37 / 37 / 26 | 80 / 80 / **4** | 44 / 44 / 32 | 161 / 161 / **62** |
| rooms with a device | 92 / 92 / 91 | 108 / 108 / 102 | 113 / 113 / 109 | 313 / 313 / 302 (301 ids) |
| hb fresh | 52 / 46 / 46 | 48 / 43 / 54 | 65 / 71 / 70 | 165 / 160 / 170 |
| hb aging | 10 / 10 / 10 | 7 / 20 / 21 | 16 / 6 / 6 | 33 / 36 / 37 |
| hb stale | 30 / 36 / 35 | 53 / 45 / 27 | 32 / 36 / 33 | 115 / 117 / 95 |
| hb never | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| hb no device | 2 / 2 / 3 | 1 / 1 / 7 | 3 / 3 / 7 | 6 / 6 / **17** |
| battery ok / warn / crit / unknown (TODAY → NEW) | 54/11/15/14 → 50/16/12/16 | 61/14/11/23 → 55/15/14/25 | 77/13/16/10 → 77/7/16/16 | 192/38/42/47 → 182/38/42/57 |
| median battery age, d (build-style) | 24.9 / 35.0 / 10.9 | 25.8 / 35.9 / 9.8 | 20.8 / 31.0 / 9.5 | 23.2 / 33.3 / 9.8 |
| liveUnder2d | 52 / 46 / 46 | 48 / 43 / 54 | 65 / 71 / 70 | 165 / 160 / 170 |
| unmappedLive | 0 / 0 / 1 | 0 / 0 / 0 | 0 / 0 / 2 | 60 / 73 / 3 |

Battery-age notes:
- TODAY and REPLAYED were parsed as UTC, as the live page does, and carry about +0.2 d of error. NEW is Central-parsed, as D4 will make it.
- The page publishes no fleet median, so the TODAY fleet cell is derived.
- All buckets are `stale`.

**How to read the movement**

- **Status**
  - The sheet went 127 → 62 triage rows between the Sep 8 and Sep 17 exports: 108 rooms changed status, and 122 changed status or DeviceId. The Sep 25 export changed no status.
  - **54 NEW Ok rooms are stale or have no device** (6197 15, 6178 30, 9502 9). That compares with 24 TODAY and 30 REPLAYED, so +6 is field movement and +24 comes with the cutover. **20 Ok rooms read critical battery.** The union is 62. These are surfaced as a list, never overridden (D9).
- **Heartbeat**
  - Field: fresh −5, aging +3, stale +2.
  - At the cutover: fresh +10, aging +1, stale −22, no device +11. Mostly this is 6178 floor 4, where 11 rooms move from units silent 105–292 d to the units installed 9/16.
  - 12 rooms lose a device, and 11 of those devices were stale.
- **Battery age**
  - Like for like (both UTC-parsed), the fleet drop is −23.4 d.
  - Of that, −20.9 to −22.2 d is the consolidated export being newer than the Aug 25/26 legacy exports, plus recorded battery swaps.
  - Only −1.2 to −2.4 d is the source change.
- **Battery class:** 77 rooms change class.
  - 15 are corrections of readings today's page misattributes. These include all four of 9502's critical → ok.
  - 10 are device changes.
  - 12 are recorded battery swaps, which cover all ten of 6197's critical → ok.
  - 40 are same-device export refreshes.
- **Voltage**
  - 18 rooms lose a voltage and 8 gain one.
  - Two lose it because the consolidated export has no battery row for their device: 9502/402 (P2-0449) and 6197/103 (P2-0891).
  - 9502/101 and 104 (P2-0692/0694, both critical) reached a room only by room number, which the design forbids.

**Device changes TODAY → NEW: 33 rooms** (20 swapped, 12 lost, 1 gained)
- On the page, all 33 arrive with the cutover. The sheet records a physical event behind 28 of them, or 23 if "field" must mean the event *caused* the change.
- **(i) The ID reflects a recorded replacement: 19.**
  - 6178: 413, 415, 416, 417, 419, 420, 422, 423, 425, 429, 430, 432 (all 9/16 installs, all now live).
  - 6197: 110, 113, 117, 319, 340.
  - 9502: 126, 221.
- **(ii) The ID lags or contradicts the note: 7, all at 6178.**
  - 116, 201, 302, 404, 405 and 406: DeviceId is blank, lagging the note.
  - 418: DeviceId changed to `P-0823`, which does not match the note's `P2-0823`. `P-0823` was silent 133 d until it reported today. Unresolved; see Q3.
- **(iii) Everything else: 7.**
  - 6197/204: P2-0406 → blank (uninstall note).
  - 6178/132: P2-0796 → blank. That unit went to 432 on 9/16.
  - 9502/210, 307, 310 and 315: registry units silent 163–330 d → blank.
  - 9502/229: registry P2-0014 (336 d) → P2-0797 (143 d).
  - *6197/103 dropped out of this group: the Sep 25 export put back P2-0891, the unit today's page shows.*
- **5 changed rooms get a unit that has been silent longer than the one it replaces:** 6197/110, 113, 319 and 340, and 9502/221.

---

## 11. Block 5 deletion list (line numbers at `c561bd5`; locate by symbol after Blocks 2–4)

The verified site inventory has 246 sites: 101 delete, 70 change, 10 reuse, 65 keep. It is in `investigate/cutover/verify-inventory/inventory-final.json`.

An earlier draft of this list broke `fetch.js`, `normalize.js`, `render.js` and `template.html` when applied literally, so the lists below are kept separate on purpose.

**Delete outright**

| file | lines |
|---|---|
| `config.js` | `SHEET_IDS.registry` (24); `EXCLUDED_REGISTRY_TABS` (68-88) and its export (293); `PROPERTIES[].sheetKey` (114/121/128) and `.registryTab` (115/122/129) |
| `fetch.js` | Override paths and modes (28-48); `RoomOverrideError` (61); `loadRoomOverrides` and its helpers (129-303); the override load/copy in `fetchAll` (510-514, 516-526). **Keep 515**, the `mkdirSync(RAW_DIR)` the workbook write needs on a fresh checkout. |
| `normalize.js` | Override import (30-34); `readExcludedDeviceIds` (260-302); dead sheet reads (heartbeat 322-323, 345-346; shower 324-325, 347-348, 866-867); `hb.byRoom` (376-382); battery-export `byRoom`, voltage and `corruptHeartbeatRows` (397, 398, 403, 404, 407); `readRegistry` (412-461); `RoomOverrideApplyError`, `resolveRoomOverride` and `planRoomOverrideMerge` (467-685); registry/exclusion/override set-up (692-695, 699, 709-711, 715-718, 722-733, 740, 742-753, 762-769, 796-810); row fields `lastChecked` (870-873, per D13) and `registered`/`installDate`/`assignmentSource` (875-893), keeping `notes` at 874; `registryDevices`/`registryInventoryOnly` (933-934); replace/merge bookkeeping (959-1100); ghosts, unregistered reporters, mismatches, the no-registry note and orphan rooms (1102-1187); the corrupt-LastHeartbeat note (1225-1235); `hasRegistry` (1241); `hasDeviceColumn` (1242, if D8 picks the Particle name); exclusion counters (1286-1287, 1299-1316, 1373-1376); the `alsoInExcludedTabs` field (1331-1333); reconciliation output keys (1396-1399, 1404-1409); `report()` lines (1483-1485, 1508-1511, 1523-1525) |
| `render.js` | The `alsoInExcludedTabs` scrub comment and loop (141-145, 147-149); the override pair balance (155-165) |
| `template.html` | `.prov` CSS (257-271); `#reconOverrides` (410); `fmtDate` (459-463; its only callers are in 1374-1411); `NOW` (432) and `ageDays` (469-473), already dead today; the registry card note (1017-1019); the "ungrouped" fleet note (1092-1104) **and its use at 1122**; `fmtYmd` and the override banner (1136-1216); `freshWindowDays` (1233-1239); the five override blocks (1277-1360); the ghosts/unregistered/mismatch/orphan blocks (1374-1411) |
| other | `test-overrides.js` (whole file; the two-property-claim tests at 109-129 are rewritten as validator tests); `data/room-overrides.json`; the `.gitignore` negation (9) |

**Edit in place.** These lines also carry tokens that must stay.

| file | line(s) | edit |
|---|---|---|
| `fetch.js` | 103-113 | Replace the registry branch and its `else` with the unconditional required-tab loop over the new tab list. Deleting 103-108 alone is a SyntaxError. |
| `fetch.js` | 573-583 | Drop the override exports and fix the "13 requests" comment. `RAW_DIR` and `PARTICLE_FILE` (581-582) are not override exports: keep or drop them deliberately. |
| `normalize.js` | 28 | Remove `EXCLUDED_REGISTRY_TABS` only. |
| `normalize.js` | 355 | If D8 picks the Particle name, remove `hasDeviceColumn` from the return. `rows` stays, and `headerLabel` stays unless D14 deletes it. |
| `normalize.js` | 405, 409 | Drop `volts` from the record; return `{ byDevice, rowCount: rows.length }`. |
| `normalize.js` | 1335 | **Not deleted.** It is the per-property counter behind `unmappedLiveByGroup`, which feeds history (1565) and the card (`template.html:969`). Change it to `const bucket = prop.code;`, and skip unattributable devices before the push at 1322. |
| `normalize.js` | 1582-1584 | `module.exports = { normalize, report, dailyRecord, OUT_FILE }` |
| `render.js` | 146, 150 | Change together: `scrubbed` (146) is read by the kept banned-string scan (150), which D7 shapes. |
| `render.js` | 205 | Remove `'lastChecked'` only |
| `template.html` | 1263, 1266-1268 | Remove the "unattributed" branch and the "(also in …)" suffix. Add the "attributed by export Location" label (D2). |
| `.gitignore`, `package.json` | 2-7; 13 | Fix the comment; repoint or remove `scripts.test` |

**Must change in the same commit as the chain switch** (lockstep; these cannot wait for Block 5)
- **Assignment block** (`normalize.js:771-794`). It reads `tele`, `regRec`, `ovReplace`, `ovRec`, `mergeTouched` and `mergeRec`. It becomes `deviceId = t.deviceId`.
- **Battery join** (`normalize.js:812-816`). It becomes `batRec = deviceId ? bat.byDevice.get(deviceId) || null : null` and `volts = t.battery`.
- **`properties[].snapshot`.** It is read with no guard at `normalize.js:1429` and `:1561`, and at `template.html:1021`.
- **Reconciliation arrays.** They are read with no guard at `render.js:254-259`, and at `template.html:501-502`, `1374`, `1385`, `1394` and `1404`. A page-script throw is invisible to `verify-live.js`, which only parses the payload.
- **`lastChecked`.** All four sites in §7.
- **`hasRegistry`.** If it is removed without the template change, every card reads "No registry tab".

**Reuse as validators** (D5: they return findings and never throw)

| existing guard | becomes |
|---|---|
| `fetch.js:281` (cross-property) and `fetch.js:251` (within a property) | F1 |
| `normalize.js:543` | F2 |
| `normalize.js:510-528`, with the `byName` index at `:233` | F4 name resolution |
| `render.js:167-177` | An assertion that every live-but-unmapped row is attributed to a live property |

**Not deleted.** `probe/02-exports.js` reads `sheetKey` and the legacy tabs (11, 23-27), and `probe/03`, `06` and `07` consume its output. **Freeze them with a header note.** `probe/FINDINGS.md` is the evidence that battery is absent from the Cloud API.

**FINDINGS §12, re-judged under this design**

| verdict | items |
|---|---|
| applies | #3, #6, #7, #8, #15. 9502/101 and 104 go to unknown battery. Priya: battery worklist (80 warn/critical; 22 carry a Battery item, 55 no action; 25 Battery items in all, 3 of them on rooms reading ok). Priya: export scheduling. Not devicenames, no thresholds, no CSS cleanup. |
| applies, changed | #2 (sheetKey deleted; the one-property-per-row check is proposed as D16). #4. #5 (13 → **10**, not 11). #9 (DeviceId *is* the chain). #13 (CurrentTime per Location, decided in D5; lastChecked proposed for deletion in D13). The TRENDS annotation (wider: the pool step, H2). Priya: P2-0433, now flagged by F1 and F2. |
| moot | #10, #12, #14. Expected ghosts 6 → 8. 6178 room 208 (back in the sheet). Priya: room 208. |
| contradicted by design | #1 "keep registry" (retired; D2). #11 "fix bat.byRoom" (deleted). "No cross-property guard" (built in as the F1 and F2 validators). |

---

## 12. Open questions for Priya

1. **DeviceId mechanism.** `DeviceId` is a formula over `heartbeatstatus`, so a unit reaches a room only after the export sees it. Typed cells (35) freeze and do not follow re-exports. 27 notes dated 09/23/26 at 6178 lag the column. Should replacements be typed into `DeviceId` when they are installed?
2. **P2-0433** is in 6178/428 *and* 9502/308, in both `roomstatus` and `heartbeatstatus`. It is tagged `esa_6178`, and 428's note says P2-0553 replaced it on 9/16. Which row is right? (The P2-0306 duplicate was resolved by the Sep 25 export.)
3. **P2-0823** is named at both 6178/329 (09/23) and 6178/418 (9/16). Particle knows only `P-0823`: it is 418's DeviceId, and it reported today after being silent 133 d. Which unit is in each room?
4. **Two notes that contradict the telemetry.**
   - At 6197/340 the note names P2-0639 (silent 102 d). But P2-0856, live and tagged `esa-6197`, was the unit there on the Sep 15 page, and it is now in no room.
   - At 9502/221 the note names P2-0779 (silent 101 d), while the live P2-0799 was there. The two names are one digit apart.
5. **The June batch.** 13 named replacement units in flagged rows have not reported since they were installed. 16 of the 24 silent note-named units last reported on Jun 16–17. P2-0860 (6178/204) reported today after 100 d. Are the others powered and connected?
6. **P2-0032.** The registry lists it in the Lab and 9829 tabs, and also in the 9502 tab at room 425. The export places it at 9502/401, but that `DeviceId` cell was deleted, and 401 reads "Recheck device name". Is it installed at 9502, and in which room? (It is shown as "attributed by export Location".)
7. **P2-0556** is named for 6178/101, but `DeviceId` places it at 9502/233.
8. **The battery worklist.** Of 80 warn/critical rooms, 22 carry a Battery action item and 55 carry no action. Three more Battery items sit on rooms that read ok. 20 critical rooms are status Ok. Five rooms noted "Replaced batteries recently" still show pre-replacement readings: 6197/119, 211, 213 and 234, and 9502/329.
9. **Battery coverage.** 9502/402 (P2-0449) and 6197/103 (P2-0891) have no row in the consolidated `batterystatus`. Separately, 6197/321 is status Ok with "Replace device: WiFi not connecting".
10. **Export cadence.** The exports so far ran Sep 4 20:00, Sep 17 12:30 and Sep 25 11:48 CDT. **The Sep 25 export did not refresh `batterystatus`** (0 of 268 rows changed), so every battery badge is `stale` despite a same-day export. Is the battery collector part of the export? Scheduling it is still the highest-value fix.
11. **Time zone.** Does the export write Central wall-clock time, and does it switch to CST on Nov 1? The sheet's own `Days with no Shower` formula treats the timestamp as UTC (`-5/24`), but the telemetry says Central.
12. **9502/101 and 104.** P2-0692 and P2-0694 carry `batterystatus` rows for these rooms, both critical. They are untagged, have no `Location`, and have been silent 133 d, while both rooms' `DeviceId` is blank. Are those rooms without a unit?
13. **P2-0799** (`…017988`, untagged) was live at 9502/221 on the Sep 15 page, and was heard 0.5 d before the 18:55Z pull. The sheet now names P2-0779 there, and P2-0799 has no `heartbeatstatus` row, so the design counts it nowhere (D3). Where is it installed?

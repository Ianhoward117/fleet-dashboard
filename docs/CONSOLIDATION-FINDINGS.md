# Consolidated-workbook cutover — findings

**Read-only investigation, 2026-09-08/09. No build file was changed.**

Priya has consolidated the three per-property work-order workbooks into one. The three
legacy workbooks are dead (confirmed by Ian) and frozen at their Aug 25/26 export; the
consolidated workbook refreshed **2026-09-04**. The live dashboard is therefore rendering
two-week-old triage and battery data and will not get fresher on its own.

This document establishes exactly what the cutover requires. The cutover itself is the
**next** session's work.

- New workbook: `1_qlAjrnafeOQN-EYXGXf0Gks3BZySXtpWk_FKbpQQGI`
- Fetched the same way as everything else:
  `https://docs.google.com/spreadsheets/d/{ID}/export?format=xlsx`
- Tabs: `roomstatus`, `batterystatus`, `devicenames`, `heartbeatstatus`

Every number below came from a script run against the real workbook, the real Particle
device list (879 devices, pulled `2026-09-09T03:53:58.402Z`), and the real committed
override file. Where merge semantics mattered, `planRoomOverrideMerge` and
`resolveRoomOverride` were **imported from `normalize.js`** rather than reimplemented.
See §11 for method and for a caveat about the verification pass.

---

## 1. The single most important finding

**The assignment layer does not move at all.**

Room by room against today's live payload, under the proposed chain:

| | |
|---|---|
| rooms in today's page | 319 |
| rooms under the consolidated source | 318 |
| shared rooms | **318** |
| shared rooms resolving to the **identical** device | **318** |
| shared rooms resolving to a **different** device | **0** |
| rooms present today but not in the new source | **1 — 6178 room 208** |
| rooms present in the new source but not today | 0 |

Nothing gains a device, nothing loses one, nothing swaps. The heartbeat histogram is
consequently flat (fleet `164/35/114/6` → `163/35/114/6`, and the single moving unit *is*
room 208).

**Therefore the headline improvement is a re-scoring, not a recovery.** Ok goes 142 → 191
and the triage queue 161 → 127 purely because the `Status` and `Action Item` columns in
Priya's sheet were rewritten. No device changed state, no device changed room, no voltage
meaningfully moved. This project's own rule — CLAUDE.md, the 2026-08-29 merge decision —
says to quote the heartbeat histogram rather than the status counts. That rule applies
here with more force than in August: this is not even a measurement change in mapping.

Everything else in this document is secondary to that sentence.

---

## 2. Where reality differs from the cutover brief

Most of the brief's predictions land exactly. **Nine things differ**, and several are
hazards nobody had flagged.

### 2.1 HAZARD — the battery `byRoom` fallback goes cross-property (SILENT)

`normalize.js:815` resolves a room's voltage as:

```js
const batRec = (deviceId && bat.byDevice.get(deviceId)) || bat.byRoom.get(key) || null;
```

That fallback keys on **`RoomNumber` alone**. It was safe only because each legacy
workbook held exactly one property, so a room number was unique within the file.

**`batterystatus` in the consolidated workbook has no `Location` column.** Room numbers
are now reused across properties: **89 of 148 distinct room keys** carry more than one
device (max multiplicity 3), covering 214 of the 273 rows.

Ported unchanged onto one workbook, tested against the merged assignment:

| | rooms |
|---|---|
| where the fallback fires | **54** |
| taking **another property's** voltage | **44** |
| taking an unattributable device's voltage | 4 |
| defensibly same-property (still a different room) | 6 |

Examples: 6178 room 302 would show 3.737 V from a 6197 device; 6178 room 328 would show
3.233 V from a 9502 device. The build succeeds, the page shows a plausible number, nothing
warns anyone. Voltage drives the battery histogram **and** the `Battery` action type, so
this corrupts two visible things at once.

**It cannot simply be deleted, either.** Today the fallback legitimately supplies
**18 rooms** — 17 at 9502, 1 at 6178. Removing it costs 9502 seventeen battery timestamps.
The correct fix is to attribute each battery row to a property first (§6) and key the
fallback per property.

### 2.2 HAZARD — `heartbeatstatus` byRoom must be partitioned by `Location` (SILENT)

The same trap on the other tab, and here it would corrupt **assignment**, not a voltage.
`heartbeatstatus` does carry `Location`, so it *can* be partitioned; a straight port of
`readHeartbeatExport` would not be.

Measured: **164 rooms would resolve to a device from another property.** Every one of the
164 differences is cross-property.

Because this source is third in the chain and currently unreachable (§7.3), the bug is
**latent, not active** — which is exactly what makes it easy to ship.

### 2.3 HAZARD — the reconciliation lists blow up if telemetry is unioned fleet-wide

Today each property's telemetry set is `heartbeat ∪ battery` read from *that property's own
workbook*, so attribution was free. On one workbook it is not.

If the cutover reaches for the obvious fleet-wide union, **`unregisteredReporters` goes
from 78 to 440** (6178 63→254, 9502 15→186) and the Reconciliation tab fills with hundreds
of meaningless rows. The build succeeds either way. **SILENT.**

Separately, under a correct per-property split, **ghosts go 6 → 8**: `P2-38` (6178 room
201) and `P2-0088` (6178 room 432) are in the new `batterystatus` but absent from
`heartbeatstatus` entirely. Not a fault, but a visible +2 on cutover day with no field
cause — write it down in advance or it reads as a regression.

### 2.4 REGRESSION — five battery rows lose attribution the legacy design had for free

The predicted 273 / 267 / 1 / 5 split is exact (§6.1). But the five unattributable rows are
**not** lab or out-of-scope hardware — **all five are attributable in the legacy workbooks**
(three in `wo_6178`, two in `wo_9502`), all five are in `devicenames`, and all five are
known to Particle.

Two of them are **on the live page right now**: `P2-0692` and `P2-0694`, rendering as 9502
rooms 101 and 104, both classified **critical** at 2.800 V and 2.801 V. Those rooms have no
`DeviceId` in the new sheet, so after the cutover their voltage silently becomes *unknown*
and two critical rooms stop reading as critical.

This is a regression introduced by consolidation, not pre-existing noise.

### 2.5 The battery-freshness win is real but small, uneven, and decays daily

- Fleet median over all 273 rows: **6.6 d**, not the predicted ~5.
- **6197 does not leave the `stale` bucket** — 8.4 d, above the 7-day cutoff. Its card will
  still show a red badge. Only 6178 and 9502 move to `aging`.
- **The `current` (<2 d) bucket is structurally empty: 0 of 273 rows.** The newest
  `LastTimestamp` in the tab is `2026-09-05T00:59:35Z`, so there is a hard floor of
  **4.12 days** of pure export lag.
- Without another export, **6178 crosses back into `stale` in 0.89 days and 9502 in
  1.36 days.**

The consolidation does not fix the scheduling problem CLAUDE.md calls the highest-value
fix. It resets the clock. **Any freshness claim made on cutover day is false within
48 hours.**

### 2.6 6178 room 208 disappears from `roomstatus` while the same file still describes it

This is the "data does not match the documented schema — stop and show him" case.

Room 208 is absent from `roomstatus`, but **the same consolidated workbook still carries
it**: `heartbeatstatus` maps 6178/208 to `0a10aced202194944a017d48`, and `batterystatus`
carries that device at room 208 with a healthy **4.028 V**. The device is **P2-0328**,
tagged `esa_6178`, last heard **0.5 days** before the pull — bucket `fresh`. Today the page
shows it as *Issue / Battery / "New install - needs battery"*.

Consequences: a live, healthy, correctly-tagged unit vanishes from the page; the override
drops from 82/82 pairs landing to **81/82** with `overrideRoomsNotInRoster` for 6178 going
from empty to `["208"]`; and **6178's live-but-unmapped goes 0 → 1**, undoing the milestone
CLAUDE.md records for 2026-08-29 and putting a step back into the awaiting-room-mapping
trend line.

It is also the only device id present in `heartbeatstatus` but absent from `roomstatus`,
and it becomes the fleet's only `orphanTelemetryRoom`.

**This is a question for Priya, not an engineering fix.** Do not paper over it.

### 2.7 The `Battery` action item collapses while the voltages stand still

| | today | new |
|---|---|---|
| rows carrying a `Battery` action item | **88** | **10** |
| rooms at `critical` voltage | 42 | **42** |
| rooms at `warn` voltage | 38 | 39 |
| **warn-or-critical rooms with NO battery action item** | **48** | **71** |

The measured voltage distribution does not move — `critical` is 42 before and after — yet
the flags were removed anyway. The honest reading is that today's battery flags were
**stale**, not that batteries recovered.

But the operational consequence is sharp: **the page's action-type filter will return 10
rows while 81 rooms sit at warn or critical.** Anyone using that filter as the battery
worklist will under-count the work by roughly eightfold. Worth raising with Priya before
the meeting.

### 2.8 31 rooms get *worse*, and that is the best argument for the cutover

The headline totals only improve, which hides this: **14 rooms move Ok → Issue**, 14 move
Check → Issue, 1 Ok → Check and 2 Issue → Check.

Of the 14 Ok → Issue, live heartbeat buckets are **stale 11, aging 1, fresh 2**, with ages
up to 146.5 days. Rooms: 6197/203, 205, 228, 236, 311, 336; 6178/111, 224, 315, 404, 408,
410, 413; 9502/311.

**The old sheet was calling rooms Ok that had been silent for weeks under live Particle
data. The new source catches that.** It is invisible in the headline numbers and it is the
strongest substantive reason to cut over.

### 2.9 Smaller corrections

- **9502 displaces 16 devices, not 15.** The extra is **`P2-0523`** (room 431, silent
  142.5 d), missed by the prediction because it was assigned from the **registry**, not the
  sheet. It does not affect the live count.
- **9502's live-but-unmapped line does not move at all** — not to 2, as the brief assumed.
  Three independently sufficient reasons: (1) all 16 displaced devices are *already*
  unmapped today, so there is no step to take; (2) neither live device carries an anchored
  `esa_####` group tag (`P2-0519` is `baseline_6_shelves_esa_wifi_spi`, `P2-0032` is
  `baseline_6_shelves`), so `particleGroupCode` returns null and they can only land in the
  fleet pool; (3) `P2-0032` is in **The Lab_P2** and **ESA 9829** and, having no property
  tag, is dropped outright by the `excluded && !prop` rule. The line that *does* move is
  6178's, 0 → 1, for the unrelated room-208 reason. Fleet: 97 → 98.
- **312 of 318 rooms resolve, not ~306.** The prediction did not credit the registry step.
- **Two of the brief's three "known renames" are misstated** — see §5.3.

---

## 3. STEP 1 — the failure mode, proved

Ian's prediction was right, and the workbook fails **twice over**. Both are loud. Nothing
at this layer is silent.

The test ran the **verbatim** `readRoomStatus()` — extracted character-for-character out of
`normalize.js` into `investigate/_legacy-parser.js` — against the new `roomstatus` tab
presented under the legacy tab name.

**Failure 1 — the banner row is read as the header.** `sheet_to_json` takes row 1 as
headers, so the parser sees `["#Rooms to repair", "128"]` and the probe row's keys are
`["128", "#Rooms to repair", "__EMPTY", … "__EMPTY_10"]`.

```
NORMALIZE FAILED: "Room Status" is missing an Installed Rooms or Status column.
  headers seen: #Rooms to repair | 128
```

**Failure 2 — the column rename, which survives fixing the header row.** With the banner
dropped so row 2 becomes the header, the same parser still throws, because
`/^installed\s*rooms?$/i` does not match `Rooms`:

```
NORMALIZE FAILED: "Room Status" is missing an Installed Rooms or Status column.
  headers seen: Location | Rooms | DeviceId | Device#  | Last Heartbeat [Sep 4, 2026] | …
```

**Before either, `fetch.js` fails first.** `REQUIRED_WO_SHEETS` is
`['Room Status', 'py_export_batterystatus', 'py_export_heartbeatstatus']`; the new tabs are
`roomstatus` / `batterystatus` / `heartbeatstatus`, so `validateStructure()` rejects the
workbook before it is ever written to `data/raw/`.

### 3.1 The dangerous near-miss

Fixing *only* the room regex makes the parser succeed — and then nothing looks for
`Location` or `DeviceId`, the two new load-bearing columns. Because `config.js` maps one
workbook per property, pointing all three `sheetKey`s at the consolidated workbook would
give **each property all 318 rows** — a 954-room fleet, with `render.js`'s `assertSane()`
finding nothing wrong, because every count would be internally consistent.

**Property partitioning and column matching must change in the same commit.**

---

## 4. STEP 2 — inventory

| tab | `!ref` | header row | data rows | blank padding |
|---|---|---|---|---|
| `roomstatus` | `A1:M320` | **2** | **318** | 0 |
| `batterystatus` | `A1:E878` | 1 | **273** | **604** (all trailing) |
| `devicenames` | `A1:B880` | 1 | **879** | 0 |
| `heartbeatstatus` | `A1:F277` | 1 | **276** | 0 |

`batterystatus`'s 604 blank rows are all trailing, none interspersed. `sheet_to_json`
returns 877 objects of which 604 are all-null; `readBatteryExport` skips them but reports
`rowCount = 877`, which would make its note text read "N of 877 rows". **COSMETIC.**

### 4.1 `roomstatus` headers, verbatim

`Location` · `Rooms` · `DeviceId` · `Device# ` *(trailing space, length 8)* ·
`Last Heartbeat [Sep 4, 2026]` · `Days with no Heartbeat` · `Last Shower` ·
`Days with no Shower` · `Battery Status            [Sep 4, 2026]` *(12 internal spaces,
length 39)* · `Calibration Risk` · `Status` · `Action Item` · `Notes from/to Ops`

`Device# ` is the only header with leading or trailing whitespace — and note that
`devicenames`'s `Device#` has **no** trailing space (length 7). The two are not the same
string.

### 4.2 Column types

| column | types |
|---|---|
| `Location` | number 318 |
| `Rooms` | number 318 |
| `DeviceId` | string 318 (43 of them empty) |
| `Device# ` | string 318 |
| `Last Heartbeat [Sep 4, 2026]` | Date 274, string 44 (all `""`) |
| `Days with no Heartbeat` | **string 318** |
| `Last Shower` | Date 268, string 50 (all `""`) |
| `Days with no Shower` | number 268, string 50 |
| `Battery Status …` | number 268, string 50 |
| `Calibration Risk` / `Status` / `Action Item` | string 318 |
| `Notes from/to Ops` | null 295, string 23 |

Every non-Date/non-number cell in the four telemetry columns is the **empty string** —
there are no `NA` or `#N/A` tokens left in them.

---

## 5. STEP 2 continued — the column diff

### 5.1 Legacy `Room Status` headers

- **6178** `Installed Rooms` · `Device#` · `Last Heartbeat [Aug 26, 2026]` · `Days with no Heartbeat` · `Last Shower Timestamp.    [Aug 26, 2026]` · `Days with no Shower` · `Battery Status            [Aug 26, 2026]` · `Calibration Risk` · `Status` · `Action Item` · **`Notes`**
- **6197** … `Device# ` … **`Notes from/to Ops`**
- **9502** … `Device#` … **`Notes from Ops`**

### 5.2 The diff

| change | detail |
|---|---|
| **RENAMED** | `Installed Rooms` → `Rooms` — **the only fatal one** |
| **RENAMED** | `Last Shower Timestamp.    [Aug 26, 2026]` → `Last Shower` |
| **CONVERGED** | `Notes` (6178) / `Notes from Ops` (9502) / `Notes from/to Ops` (6197) → `Notes from/to Ops` |
| **ADDED** | **`Location`** — the only property discriminator |
| **ADDED** | **`DeviceId`** — a real device id in the sheet for the first time |
| **UNCHANGED** | `Device#`, `Last Heartbeat`, `Days with no Heartbeat`, `Days with no Shower`, `Battery Status`, `Calibration Risk`, `Status`, `Action Item` |

`batterystatus` headers are **identical** to the legacy `py_export_batterystatus`.
`heartbeatstatus` is the legacy tab **plus `Location`**.

### 5.3 Two of the brief's three "known renames" are misstated

- **`Last Shower Timestamp` never existed.** The legacy header is
  `Last Shower Timestamp.    [Aug 26, 2026]` — trailing **period**, four spaces, bracketed
  date, length 40. Anyone grepping the legacy books for the brief's string finds nothing.
  The rename also **drops a date stamp**: `Last Shower` no longer carries `[Sep 4, 2026]`,
  while `Last Heartbeat` and `Battery Status` both keep theirs. Inert today
  (`/^last shower/i` matches both), but it makes `Last Shower` the one date-bearing column
  that no longer bears a date.
- **`Notes` existed in one book only** (6178). 6197 was *already* `Notes from/to Ops`.
  This is a three-way convergence, not a rename of a common column. Inert for the build
  (`/^notes/i` matched all three), but the cutover session should not go looking for a
  `Notes` column in 6197 or 9502 — it was never there.

### 5.4 Column-matching audit

Nothing in the build asserts on the column set, so a column that stops being found produces
**no error at all**.

| `readRoomStatus` regex | matches? | consequence |
|---|---|---|
| `/^installed\s*rooms?$/i` | **NO** — column is `Rooms` | **BROKEN** (required; throws) |
| `/^status$/i` | yes → `Status` | — |
| `/^device\s*#/i` | yes → `Device# ` | — |
| `/^last heartbeat/i` | yes | — |
| `/^days with no heartbeat/i` | yes | value type changed, §6.3 |
| `/^last shower/i` | yes → `Last Shower` | — |
| `/^days with no shower/i` | yes | — |
| `/^battery status/i` | yes | — |
| `/^action item/i` | yes | — |
| `/^notes/i` | yes → `Notes from/to Ops` | — |
| *(none exists)* | **`Location`** | **SILENT** — property partitioning impossible |
| *(none exists)* | **`DeviceId`** | **SILENT** — best assignment source ignored |

`readHeartbeatExport` and `readBatteryExport` look columns up by exact property name; **all
of those still resolve**. Only `Location` is new and unread.

### 5.5 The export is now automated — which speaks to the standing scheduling item

`heartbeatstatus`'s per-property row counts (6178 = 86, 6197 = 83, 9502 = 107) are
**identical** to the three legacy books', which makes it look copied over. It is not:
`CurrentTime` is `2026-09-05T01:00:04Z`–`01:00:13Z` across all three properties — **a single
run ten seconds wide**, versus three separate manual runs spanning 2026-08-25 to 08-26 in
the legacy books. Device coverage is a strict superset (274 shared, 1 added, 0 dropped).

**The right freshness check is `CurrentTime`, not row counts.** And the single-run shape is
evidence the export is now triggered once for the whole fleet rather than by hand per
property — real progress against CLAUDE.md's "SCHEDULE the `py_export`" item, though a
scheduled *cadence* is still unproven from one sample.

---

## 6. STEP 3 — normalization surface

- **`Location` is a number** (`6178`), three distinct values.
- **Room numbers are numbers** in all three tabs. `normRoom()` already handles this
  (`102.0` → `"102"`) and preserves letter suffixes. **No room value in the new workbook
  defeats it.**
- **`Status` has no nulls at all**: 191 `Ok` / 124 `Issue` / 3 `Check` = 318.
- **`Calibration Risk`** (new, unread by the build): `No` 192 · `No data` 80 · `Yes` 24 ·
  `No savings` 12 · `Maybe risky` 8 · `Too many FPs` 2.
- **43 of 318 rows have an empty `DeviceId`**; 50 have no battery value.
- `BAD_TOKENS` catches every sentinel present. `batterystatus.LastHeartbeat` carries the
  literal `"NA"` (that column is ignored by design).

### 6.1 `Days with no Heartbeat` is now a string — and `normNum` mangles it ~100×

The column changed from numeric to strings shaped `"N days N hours"` on **100 % of rows**
(44 are `""`). `normNum()` strips everything outside `[0-9.eE+-]` and parses the remainder:

| raw | `normNum` |
|---|---|
| `"0 days 04 hours"` | `4` |
| `"1 days 21 hours"` | **`121`** |
| `"2 days 16 hours"` | **`216`** |
| `"75 days 23 hours"` | **`7523`** |

It returns a wrong non-null on **274 of 318 rows**.

**It cannot reach the page today.** `daysNoHeartbeat` is assigned at `normalize.js:346` and
read nowhere else; it appears **0 times** in `data/normalized.json`, dead since v2 moved
heartbeats to the Particle API. The sheet's own `lastHeartbeat` is likewise parsed and never
consumed.

Classification: **COSMETIC today, a loaded gun tomorrow.** Anyone who surfaces this field —
or uses it as a sanity check against the Particle-derived `daysSilent` — gets numbers wrong
by roughly 100× with no error and no visible tell.

### 6.2 The banner row is not reproducible — do not parse it

Row 1 reads `#Rooms to repair | 128`. No count derived from the data equals 128:

| candidate | value |
|---|---|
| `Issue` rows | 124 |
| `Issue` + `Check` | **127** |
| `Status` ≠ `Ok` | **127** |
| Action Item not `None` | **127** |
| Action starts `Replace device` | 114 |
| rows with no `DeviceId` | 43 |

It is a hand-maintained cell, off by one from every plausible definition. Treat it as
decoration; its only real consequence is displacing the header to row 2.

---

## 7. STEP 4 — property attribution, including battery

### 7.1 The chain, measured (exactly as predicted)

| stage | rows |
|---|---|
| total battery rows | **273** |
| attributable via `roomstatus.DeviceId` | **267** |
| additionally via `heartbeatstatus.ParticleDeviceId` | **1** |
| attributable by **neither** | **5** |

| device id | name | room | volts | Particle groups | last heard | in legacy book |
|---|---|---|---|---|---|---|
| `0a10aced202194944a017a10` | P2-0303 | 421 | 2.785 | `esa_6178` | 146.6 d | wo_6178 |
| `0a10aced202194944a017694` | P2-0692 | 101 | 2.800 | *(none)* | 116.6 d | wo_9502 |
| `0a10aced202194944a01769c` | P2-0694 | 104 | 2.801 | *(none)* | 116.7 d | wo_9502 |
| `0a10aced202194944a02b91c` | P2-38 | 201 | 3.660 | `esa-6178-non-spi` | 280.7 d | wo_6178 |
| `0a10aced202194944a02bd54` | P2-0088 | 432 | 4.313 | `esa-6178-non-spi` | 275.5 d | wo_6178 |

See §2.4 — this is a **regression**, and two of the five are visibly critical on the page
today.

Two partial rescues: the **Particle group tag** recovers 3 of the 5 (all tagged `…6178`),
and the **registry** independently places `P2-38` and `P2-0088` in 6178 rooms **201** and
**432** — exactly the two rooms the registry fallback rescues (§8.1).

No disagreement was found between sheet-derived attribution and the Particle group tag on
any row where both exist.

### 7.2 Battery age

Per-property medians as they would appear on the freshness badges (mapped rooms, measured
against the Particle pull instant):

| property | today | new | badge |
|---|---|---|---|
| 6197 | 18.2 d `stale` | **8.4 d** | still **`stale`** |
| 6178 | 19.1 d `stale` | **6.6 d** | → `aging` |
| 9502 | 14.1 d `stale` | **5.3 d** | → `aging` |

Over all 273 rows in the tab the median is **6.6 d**. See §2.5 for why this win is smaller,
more uneven and more perishable than it looks — and note that 9502's improvement is partly
flattered by the loss of its 17 oldest byRoom-fallback readings (§2.1).

---

## 8. STEP 5 — the assignment counterfactual

Chain under test:

```
override -> roomstatus.DeviceId -> heartbeatstatus byRoom -> registry byRoom -> null
```

Evaluated through the **real** `planRoomOverrideMerge` / `resolveRoomOverride`. The new
sheet-DeviceId source was fed in as the first entry of a composed `hb.byRoom`, so the
whole-property merge semantics — in particular rule (b), vacating a device out of another
room — are the pipeline's own.

**312 of 318 rooms resolve to a device; 6 do not.**

| property | override | `roomstatus.DeviceId` | `heartbeatstatus` | registry | none |
|---|---|---|---|---|---|
| 6178 | 81 | 24 | **0** | 2 | 1 |
| 6197 | 90 | 2 | **0** | 0 | 2 |
| 9502 | 32 | 76 | **0** | 5 | 3 |
| **fleet** | **203** | **102** | **0** | **7** | **6** |

Against the prediction (`6178: 81/24/3 none · 6197: 90/2/2 · 9502: 32/77/7`): 6178 and 6197
match once the registry is broken out. 9502 reads **76 sheet, not 77** — because room 401's
sheet device is vacated by the P2-0449 relocation (§8.3). *This is exactly the error the
brief's whole-property-merge requirement existed to prevent: a naive per-room fallback
counts 401 as a 77th sheet room and hides the vacate entirely.*

Deviceless rooms: **6178/415** · **6197/102** · **6197/231** · **9502/101** · **9502/104** ·
**9502/401**. Rooms 415 and 102 are already recorded in CLAUDE.md.

**9502 room 401 is worth a second look:** its status is `Ok` and the sheet gives it a real
device, but the merge vacates it. It renders as an `Ok` room showing no device.

### 8.1 The registry fallback carries exactly 7 rooms — all long-dead

Before the override, `heartbeatstatus` byRoom adds **0** rooms and the registry adds **8** —
6178 rooms **201, 432**; 9502 rooms **210, 229, 307, 310, 315, 431**. After the override
takes room 431, **7** remain.

**All 7 hold devices silent for 146.5 to 319.3 days.** Not one is live; six of the seven
rooms are already `Issue`. So keeping the fallback is not about preserving working
coverage — it is about preserving 7 actionable *"P2-0006, silent 313 d"* rows instead of 7
uninformative *"no device"* rows. That is the same argument the 2026-08-29 merge flip
already settled, so **keeping it is the consistent choice**.

### 8.2 6178 room 208 — non-fatal, but not harmless

The override names `208 -> P2-0328`. Room 208 is absent from the new 6178 roster
(109 → 108). `planRoomOverrideMerge` puts it in `notInRoster`, surfaced as
`overrideRoomsNotInRoster`. **The build does not fail.** It is the only `notInRoster` entry
fleet-wide. See §2.6 for why this needs Priya rather than code.

### 8.3 P2-0449 — the relocation works

The override places `P2-0449` in 9502 **room 402**; the new sheet has it in **room 401**.
The merge vacates 401, exactly as designed:

```
relocated: [{ name: "P2-0449", from: "401", to: "402", fromSource: "export" }]
```

Room 402 resolves to `P2-0449` via the override; **room 401 resolves to nothing**. The only
relocation fleet-wide.

### 8.4 The 16 displaced devices at 9502

All override-wins over a sheet or registry assignment. Fifteen were predicted; **`P2-0523`
was not** — it came from the registry path, which the prediction evidently did not model.

| device | room | last heard | live? |
|---|---|---|---|
| P2-0032 | 425 | 0.0 d | **yes** |
| P2-0519 | 402 | 0.1 d | **yes** |
| P2-0427 | 413 | 44.6 d | no |
| P2-0214 | 129 | 56.2 d | no |
| P2-0045 | 316 | 57.5 d | no |
| P2-45 | 224 | 58.0 d | no |
| P2-0117 | 103 | 76.0 d | no |
| P2-0454 | 223 | 113.6 d | no |
| P2-43 | 306 | 116.1 d | no |
| P2-0419 | 428 | 124.1 d | no |
| P2-0534 | 317 | 133.1 d | no |
| P2-0518 | 232 | 139.2 d | no |
| **P2-0523** | **431** | **142.5 d** | no |
| P2-0149 | 221 | 144.6 d | no |
| P2-0018 | 314 | 170.5 d | no |
| P2-0178 | 301 | 182.6 d | no |

**14 of 16 have been silent 44+ days.** All 16 are *already* unmapped today — see §2.9 for
why 9502's live-but-unmapped line does not move.

### 8.5 Guard checks

No device is assigned to two rooms within a property. Exactly one is assigned at two
different properties — `P2-0433` (§9).

---

## 9. STEP 6 — cross-property duplicates

### 9.1 One duplicate, now a contradiction *inside* the source

| | |
|---|---|
| device | `0a10aced202194944a017d18` — **P2-0433**, Particle group `esa_6178` |
| at | **6178 room 428**, `Issue`, "Replace device: WiFi not connecting", Calibration Risk `No` |
| and | **9502 room 308**, `Issue`, "Replace device: Unknown", Calibration Risk `No data` |

The two rows carry **byte-identical telemetry** (Last Heartbeat `2026-08-29T23:44:21.983Z`,
battery 2.786, Last Shower `2026-08-16T03:01:38.783Z`) and differ only in Action Item and
Calibration Risk. `heartbeatstatus` **independently** carries the same id twice, at 6178/428
and 9502/308.

This is materially different from what CLAUDE.md records. Previously the conflict was
*override vs export* — the override held 9502/308 out precisely because 6178 claimed the
device. **Now the consolidated workbook asserts both placements by itself**, in two rows a
human wrote, in two tabs.

**Every mitigation CLAUDE.md discusses operates on the override file, and after cutover none
of them can work.** Under merge the sheet answers for 9502/308 no matter what the override
says. The next session must **not** try to fix this by editing `room-overrides.json` — the
contradiction is in Priya's sheet. The Particle tag says `esa_6178`, which makes the
9502/308 row the false one, consistent with the existing `heldOut` note.

One physical device's single battery reading is now double-counted into two properties by
construction, and whichever row the code happens to take decides which property's histogram
is wrong.

### 9.2 The 6178 room 404 open item is retired

`P2-0457` (`…017d04`, groups `["esa-6197"]`) now appears **only at 6197 room 329**, `Ok`.
6178 room 404 now holds `P2-0409` (`…016d1c`), tagged `esa_6178` — correctly placed. The
legacy 6178 `Room Status` `Device#` column already said `P2-0409`; the export was the sole
dissenting source and it dies with the legacy workbook.

**The recorded "6178 room 404" instance is resolved by the consolidation.** The general gap
it illustrated — no cross-property guard on the export path — is not, and `P2-0433` is now
the live instance. It is also the **only** conflict between the new `roomstatus.DeviceId`
and the legacy export across all 318 rooms.

### 9.3 Group-tag coverage is too sparse for tag-based checking at 9502

Fleet-wide, **88 of 275 device-bearing rows carry a device with no `esa_` group tag at all**.
The split is very uneven:

| property | tagged | untagged |
|---|---|---|
| 6197 | 83 | 0 |
| 6178 | 83 | 2 |
| **9502** | **21** | **86** |
| **fleet** | **187** | **88** |

Across the 187 rows where a tag exists, the tag agrees with the sheet's `Location`
**186 times**, with exactly **one disagreement: 9502 room 308, `P2-0433`, tagged
`esa_6178`** — the same row §9.1 identifies as the false half of the duplicate. The Particle
tag and the override agree with each other and against that sheet row.

Any comparison of sheet `Location` against the Particle group tag is **structurally blind on
80 % of 9502's device-bearing rows**. A clean result at 9502 is mostly absence of evidence,
not evidence of absence. This bounds what a future guard session can achieve and should be
stated before anyone reads "one disagreement fleet-wide" as reassurance.

*(No guard was built — that remains a later session's work, as recorded.)*

---

## 10. STEP 7 — registry and devicenames

### 10.1 The registry is still load-bearing, mainly for exclusion

**Exclusion tabs.** `The Lab_P2` 293 ids · `Fort Custer Education Center` 40 ·
`ESA 9829 - Austin - Northwest` 196 · **338 distinct**.

Recomputed against the new chain: **13 live devices are filtered out** of live-but-unmapped
by the exclusion tabs — lab/9829 bench hardware, 0.0–2.4 days old. Without the registry
those 13 would appear on the Reconciliation tab. `P2-0032` is one of them.

**The registry must keep being fetched.** The Lab and Fort Custer are out of scope by the
brief and must never reach the page.

**byRoom fallback.** Exactly **7 rooms** (§8.1). Small, but it costs nothing — the workbook
is already fetched for exclusion.

**Other consumers.** `ghosts`, `unregisteredReporters`, `roomDeviceMismatches`,
`registryDevices`, `installDate` and the `registered` flag all read the registry. They
survive mechanically but compare against `py_export_*`-derived telemetry sets the cutover
replaces — see §2.3 for what goes wrong if that split is done fleet-wide. 6197 still has no
registry tab and still cannot be reconciled.

### 10.2 `devicenames` is exactly redundant — do not read it

Ian's read is confirmed with no qualifications:

| test | result |
|---|---|
| tab `Device#` == Particle `.name`, over all 879 ids | **879 match, 0 differ** |
| ids in the tab unknown to Particle | **0** |
| ids Particle knows that the tab lacks | **0** |
| tab agrees with `roomstatus."Device# "` (275 rows with a DeviceId) | **275 agree, 0 differ** |
| roomstatus rows with a DeviceId but a blank `Device#` | **0** |

A perfect 879/879 bijection. **Recommendation: do not read it.** Reading it adds a fourth
tab to validate and a second source of truth about device names, for zero gain.

**The `Device#` column stays display-only.** CLAUDE.md's rule holds, and the cutover
strengthens it: assignment now comes from the `DeviceId` column, which is a real device id,
so no name column feeds assignment anywhere in the chain. The override still keys on device
*name*, resolved against the Particle list — unchanged.

---

## 11. STEP 8 — delta report

Today = `data/normalized.json`, reproduced from the real pipeline and verified identical to
the bot's committed `history/2026-09-08.json` on every sheet-derived field.

### 11.1 Rooms and triage

| property | | rooms | Ok | Issue | Check | null | triage |
|---|---|---|---|---|---|---|---|
| 6197 | today | 94 | 57 | 29 | 8 | 0 | 37 |
| | **new** | 94 | **58** | **35** | **1** | 0 | **36** |
| 6178 | today | 109 | 13 | 69 | 11 | 16 | 80 |
| | **new** | **108** | **54** | **53** | **1** | **0** | **54** |
| 9502 | today | 116 | 72 | 44 | 0 | 0 | 44 |
| | **new** | 116 | **79** | **36** | **1** | 0 | **37** |
| **fleet** | today | 319 | 142 | 142 | 19 | 16 | 161 |
| | **new** | **318** | **191** | **124** | **3** | **0** | **127** |

Every predicted figure confirmed. `Check` is now exactly one row per property, and all
three are the same action — **"Run a shower"** (6178/407, 6197/136, 9502/415).

CLAUDE.md's standing open item — *"6178's statuses do not cover its roster: 13+69+11 = 93
against 109 rooms"* — is **resolved by the consolidation, not by engineering**.

### 11.2 Heartbeat buckets — flat, which is the whole story

| | fresh | aging | stale | never |
|---|---|---|---|---|
| fleet today | 164 | 35 | 114 | 6 |
| **fleet new** | **163** | **35** | **114** | **6** |

One device moves, and it is room 208's `P2-0328`. 6197 and 9502 are identical bucket for
bucket. See §1.

### 11.3 Battery distribution barely moves

| | ok | warn | critical | unknown |
|---|---|---|---|---|
| fleet today | 192 | 38 | 42 | 47 |
| **fleet new** | **190** | **39** | **42** | **47** |

Despite ~12 days fresher data, the classification is essentially unchanged — `critical` is
**42 in both columns**. **Fresher battery data did not reveal a hidden battery problem** —
which makes the 88 → 10 collapse in battery *action items* (§2.7) all the more conspicuous.

*(Device-keyed join plus the `Room Status` battery column, matching `normalize.js`
semantics. The `byRoom` fallback is deliberately not modelled — §2.1.)*

### 11.4 The triage queue changes character completely

| actionType | today | new |
|---|---|---|
| Battery | 87 | **10** |
| Replace device | 63 | **114** |
| Run a shower | 1 | 3 |
| None | 9 | 0 |
| Recheck device name | 1 | 0 |

The queue shrinks by 34 rows but **114 of 127 are now a single action**. The action-item
vocabulary also changed wholesale: `"Replace device: no data or no device"` appears 45 times
in the new source and **0 times today**; `"Replace device: Unknown"` falls 25 → 1.
`actionType()` already collapses all of these correctly, so **no code change is forced** —
but any saved link, screenshot or note quoting a per-action count is invalidated.

### 11.5 What to expect to be asked

- **"6178 went from 13 Ok to 54 Ok — did we fix it?"** No. §1. Not one room changed device;
  the sheet was re-scored.
- **"So the fleet is healthier?"** No. 31 rooms actually got *worse* (§2.8), and that is the
  good news — the new source catches silence the old one missed.
- **"Battery problems are down to 10?"** No. 80 rooms are at warn or critical; only 10 carry
  a battery action item (§2.7).
- **"Is battery data fresh now?"** At two of three properties, and only for about a day
  (§2.5). 6197's badge stays red.
- **"Why did the room count drop by one?"** 6178 room 208 (§2.6) — and it needs Priya.
- **"Why are 128 rooms flagged?"** They are not; the banner says 128, the data says 127
  (§6.2).

---

## 12. What the cutover session must change

**BROKEN** = build fails · **SILENT** = build succeeds, data wrong or missing ·
**COSMETIC**.

### `config.js`

| # | change | severity |
|---|---|---|
| 1 | Replace the three `wo_*` ids with the consolidated id. **Keep `registry`** — still needed (§10.1). | BROKEN |
| 2 | `PROPERTIES[].sheetKey` no longer selects a workbook; properties are selected by `Location`. Decide the shape deliberately rather than pointing all three at one workbook — §3.1. | **SILENT if fudged** |

### `fetch.js`

| # | change | severity |
|---|---|---|
| 3 | `REQUIRED_WO_SHEETS` → `['roomstatus', 'batterystatus', 'heartbeatstatus']`. Not `devicenames` — §10.2. | BROKEN |
| 4 | `validateStructure` branches on `key === 'registry'`; rework for one work-order workbook. | BROKEN |
| 5 | Request count drops 13 → **11** (4 workbooks → 2, plus 9 Particle pages). | COSMETIC |

### `normalize.js` — the bulk of the work

| # | change | severity |
|---|---|---|
| 6 | `readRoomStatus`: read the header from **row 2** (`sheet_to_json(..., { range: 1 })`). | BROKEN |
| 7 | `readRoomStatus`: `/^installed\s*rooms?$/i` must match `Rooms`. | BROKEN |
| 8 | Add matching for **`Location`** and partition all 318 rows by it. Without this every property gets all 318 rows. | **SILENT** |
| 9 | Add matching for **`DeviceId`**; insert directly after the override in the chain. | **SILENT** |
| 10 | **Partition `heartbeatstatus` byRoom by `Location`** before building the map — else 164 rooms take a foreign device (§2.2). | **SILENT** |
| 11 | **Fix the `bat.byRoom` fallback.** Attribute battery rows to a property first, then key per property. A verbatim port writes 44 foreign voltages onto the page; deleting it outright costs 18 rooms, 17 of them at 9502 (§2.1). | **SILENT** |
| 12 | Build per-property telemetry sets for `ghosts` / `unregisteredReporters` / `roomDeviceMismatches` via `heartbeatstatus.Location`. A fleet-wide union takes `unregisteredReporters` 78 → 440 (§2.3). | **SILENT** |
| 13 | `snapshot` / `currentTime` becomes one fleet-wide value (`2026-09-05T01:00:13.603Z`), not three. `render.js` requires `lastChecked` on **every** room row — keep populating it or `assertSane` fails. | BROKEN if dropped |
| 14 | Filter `batterystatus`'s 604 blank padding rows so `rowCount` and note text are honest. | COSMETIC |
| 15 | Delete the dead `daysNoHeartbeat` field rather than leave a ~100×-wrong value for someone to wire up (§6.1). | COSMETIC |

### Expect these on cutover day — write them down first

- **ghosts 6 → 8** (`P2-38`, `P2-0088`) — no field cause (§2.3).
- **6178 live-but-unmapped 0 → 1**, fleet 97 → 98 — room 208 (§2.6).
- **Two 9502 critical rooms (101, 104) go to unknown battery** (§2.4).
- Add a **`TRENDS` annotation** dated the first day the new numbers land. Triage steps
  161 → 127 and Ok steps 142 → 191 on a day when nothing happened in the field. Without an
  annotation the next reader calls it a fleet recovery — §1.

### Raise with Priya, not in code

- **Room 208** — `roomstatus` disagrees with `heartbeatstatus` and `batterystatus` in the
  same file, and a live healthy unit falls off the page (§2.6).
- **P2-0433 in two rooms at two properties** — a contradiction in the source that no
  override setting can suppress (§9.1).
- **80 warn/critical rooms, 10 battery action items** (§2.7).
- **Export scheduling** — still the highest-value fix (§2.5).

### Explicitly *not* this cutover

- **No cross-property guard on the export path** — its own session, as recorded. `P2-0433`
  is now the live instance.
- **No `devicenames` reader** — redundant (§10.2).
- **No threshold changes** — confirmed by Priya; cutoffs stand.
- **No CSS cleanup** — the duplicated phone-media-query block waits for a dedicated pass.

---

## 13. Method, and a caveat on verification

Scratch scripts live in `investigate/`, excluded via `.git/info/exclude` — no tracked file
was touched and `.gitignore` was not modified. This document is the only commit from this
session.

- `investigate/_norm.js` — value normalisers **extracted verbatim** from `normalize.js`
  (generated, with an in-script check that the text appears in the source).
- `investigate/_legacy-parser.js` — the real `readRoomStatus()` and its sheet helpers,
  extracted the same way, for the STEP 1 proof.
- `investigate/harness.js` — shared readers for the new workbook, the Particle device list,
  the registry and the committed override (through `fetch.js`'s own validator).
- `investigate/ian-*.js` — independent second derivations of the assignment counterfactual,
  live-but-unmapped, the delta, and the battery-fallback sizing.

All merge arithmetic used `planRoomOverrideMerge` and `resolveRoomOverride` imported from
`normalize.js`.

**Caveat.** The investigation ran seven parallel analysts, each of which was to have its
headline claims adversarially rechecked by independent skeptics. **The analysts all
completed; 41 of the 56 verification agents died on a usage limit**, so that pass is largely
missing.

What stands in its place: every headline number here was computed **twice, by two different
derivations** — once by a dimension analyst and once independently by the session lead — and
the two were reconciled. Two disagreements surfaced, and both were real:

- **Battery-fallback size, 42 vs 54 rooms.** Traced to testing against the raw sheet
  `DeviceId` rather than the merged assignment. Recomputed against the merged assignment
  and resolved to **54** (§2.1).
- **Warn/critical rooms with no battery action, 70 vs 71.** Same root cause. Resolved to
  **71**, and the same correction fixed the `critical` count, which does **not** move: it is
  42 before and after (§2.7, §11.3).

Both corrections came from the analyst's figure being right and the first lead derivation
being wrong, which is worth knowing before trusting any single pass.

Numbers still resting on **one** derivation: the `unregisteredReporters` 78 → 440 figure
(§2.3), the ghosts 6 → 8 figure (§2.3), and the room-level Ok→Issue list (§2.8). Re-verify
those first if anything downstream depends on them.

The Google Sheets were read only. The Particle Cloud API was read only through
`GET /v1/products/18173/devices`, and only by the existing `fetch.js`.

# Particle API probe — v2 feasibility findings

**Date:** 2026-08-19 · **Probe pull:** `2026-08-19T05:28:58Z` · **Product:** `18173`
(org `abstract-engineering-inc`, API user `fleet-dashboard+…@api.particle.io`)

Read-only probe. Nothing in the deployed pipeline was modified. All requests were
`GET` against `api.particle.io`, throttled to ≤4/sec. Raw pulls are in
`data/raw/particle-probe/` (gitignored); the scripts that produced them are in
`probe/`.

---

## Recommendation: **heartbeat-only GO**

Move heartbeat/liveness to the Particle API in v2. **Keep battery on the
`py_export` path** — it is not obtainable from the Cloud API, and no amount of
endpoint hunting changes that.

The probe also turned up something more urgent than the v2 question itself: the
`py_export` tabs are not merely *stale*, they are *incomplete*. See
"Coverage gap" below — that finding stands on its own regardless of what we
decide about v2.

---

## 1. Battery: verdict and mechanism

**Battery is not available anywhere in the Particle Cloud API for this fleet.**
All three doors were tried and all three are closed:

| Door | Endpoint | Result |
|---|---|---|
| **A — cached vitals** | `GET /v1/diagnostics/{id}/last` | 12/12 sampled devices returned **HTTP 200 with a full payload — and zero battery fields** |
| **B — Ledger** | `/v1/ledgers`, `/v1/products/18173/ledgers`, `/v1/orgs/abstract-engineering-inc/ledgers` | **200, all empty.** No ledger definitions exist at any scope. Also `/v1/logic/functions` → `[]` |
| **C — cloud variables** | device list + detail | **Ruled out twice:** 0/879 devices online, and 877 devices advertise `"variables": {}` |

There is also **no fleet-wide vitals endpoint**: `/v1/products/18173/diagnostics`
and `/v1/products/18173/fleet_health` both 404. Vitals are strictly one
request per device.

### Redacted sample vitals payload (Door A, a healthy device)

```json
{
  "diagnostics": {
    "deviceID": "<REDACTED>",
    "payload": {
      "device": {
        "network": {
          "signal": {
            "at": "Wi-Fi", "strength": 46, "strength_units": "%",
            "strengthv": -77, "strengthv_units": "dBm", "strengthv_type": "RSSI",
            "quality": 12.9, "quality_units": "%",
            "qualityv": 13, "qualityv_units": "dB", "qualityv_type": "SNR"
          },
          "connection": { "status": "connected", "error": 0, "disconnects": 0,
                          "attempts": 1, "disconnect_reason": "unknown" }
        },
        "cloud": {
          "connection": { "status": "connected", "error": 0, "attempts": 2,
                          "disconnects": 0, "disconnect_reason": "none" },
          "coap": { "transmit": 13, "retransmit": 0, "unack": 0, "round_trip": 531 },
          "publish": { "rate_limited": 0 }
        },
        "system": { "uptime": 15, "memory": { "used": 328356, "total": 3235716 } }
      },
      "service": {
        "device": { "status": "ok" },
        "cloud": { "uptime": 2, "publish": { "sent": 1 } },
        "coap": { "round_trip": 143 }
      }
    },
    "updated_at": "2026-08-17T00:07:50.581Z"
  }
}
```

That is the *entire* schema — network signal, cloud/CoAP counters, memory,
uptime. Nothing power-related.

### Why, and where the battery number actually comes from

Every device is **platform_id 32 (P2)** — 879/879. The P2 is a Wi-Fi module with
no PMIC and no fuel gauge, so Particle's stock vitals have no power section to
populate. Any battery voltage must be read by *our own firmware* off an ADC and
published as an application event.

That implies a **collection layer behind the current export pipeline**: firmware
publishes a voltage event → something subscribes and persists it → the
`py_export_batterystatus` script reads that store. This probe could not identify
the sink, because the token lacks the scopes:

- `/v1/products/18173/integrations` → `invalid_scope` (webhooks not enumerable)
- `/v1/products/18173/events` → `invalid_scope` (the event stream needs `events:get`)

Both returned an explicit scope denial rather than 404, so **those surfaces exist
— we just can't see them with this token.** That is the single highest-value
follow-up.

> **Architectural note.** Even *with* `events:get`, the Particle event stream is
> live SSE — there is no historical event query API. Capturing battery would
> require a **continuously running subscriber**, which a build-time Netlify fetch
> fundamentally cannot be. So battery via Particle means standing up a persistent
> collector, i.e. rebuilding the very layer that already exists. That is a real
> project, not a seam swap.

---

## 2. Fleet enumeration and field inventory

`GET /v1/products/18173/devices` — 9 pages at 100/page, **879 devices**.

Fields present on every record: `id`, `name`, `online`, `connected`,
`last_heard`, `last_handshake_at`, `last_ip_address`, `mac_wifi`,
`serial_number`, `platform_id`, `product_id`, `firmware_version`,
`system_firmware_version`, `current_build_target`, `groups`, `functions`,
`variables`, `status`, `quarantined`, `denied`, `development`, `owner`,
`user_id`, `device_protection`, `mobile_secret`.
Device detail adds `notes`, `default_build_target`, `firmware_updates_enabled`.

### Online ratio — the number that killed Door C

**0 of 879 devices are online (0.0%)** — yet **273 were heard within the last 2
days**. These are sleep-wake devices: they connect, publish, and drop. Cloud
variables and any on-demand read are therefore unusable for this fleet as a
matter of physics, not permissions.

Confirmed independently: `GET /v1/products/18173/devices/{id}/vitals` on the
freshest device in the fleet returned **HTTP 408 "Timed out"** — a live vitals
request cannot reach a sleeping device. *(Disclosure: this was one GET that asks
a device to report; it timed out, changed nothing, and was not repeated.)*

`last_heard` age across the fleet: **<2d: 273 · 2–7d: 96 · 7–30d: 33 · >30d: 475
· never: 2**.

---

## 3. Coverage gap — the most actionable finding

Join is on Particle device ID (`ParticleDeviceId` ↔ `id`).

**Join quality is perfect: 338/338 exported device IDs exist in the API. Zero
misses.** The API is a strict superset. Duplicate IDs on the API side: **0**.
Duplicate IDs *within* any single property export: **0**. Only **2** IDs appear
in two properties at once (`…4a017d04` in 6178+6197, `…4a02bc0c` in 6197+9829) —
far cleaner than the "known hygiene issue" framing suggested.

The gap runs the other way:

| | count |
|---|---|
| Devices in the Particle product | **879** |
| Unique device IDs across all four `py_export` tabs | **338** |
| **In the API but in no `py_export`** | **541** |
| …of those, **heard within the last 2 days** | **131** |

**131 live, currently-reporting devices are invisible to the dashboard.**

### Property group membership vs export coverage

| Property | in `esa_*` group | exported | in both | in group, not exported | **fresh & not exported** |
|---|---|---|---|---|---|
| 6178 | 106 | 32 | 28 | 78 | **44** |
| 6197 | 93 | 82 | 82 | 11 | 2 |
| 9502 | 10 | 107 | 10 | 0 | 0 |
| 9829 | 0 | 117 | 0 | 0 | 0 |

**This reframes 6178.** CLAUDE.md records it as the property in trouble — "60 of
93 rooms have never reported". The API says **106 devices carry an `esa_6178`
group tag and 44 of them reported within the last two days while appearing in no
export at all**, all on firmware 160. 6178 looks less like dead hardware and
more like an export that covers roughly a third of the property. Worth
confirming with Priya before we act on it, but the current dashboard reading of
6178 is probably wrong in the *pessimistic* direction.

**Particle groups cannot serve as the property map**: 9502 has only 10 group
members against 107 exported devices, and 9829 has no property group at all.

### No room number in the API

`notes` is empty on **all 879** devices; names are `P2-####` (873 of 879). Export
rooms are `301`, `202`, `432`, … There is **no room identifier anywhere in the
Particle payload**, so even a heartbeat-only v2 still needs the registry/export
for room mapping. This is the main reason v2 is not a clean `fetch.js` swap.

---

## 4. Heartbeat comparison

API `last_heard` vs each export's `LastHeartbeat`, per property:

| Property | export date | API newer | same (±30m) | **API older** | median (API − export) |
|---|---|---|---|---|---|
| 6197 | 2026-08-10 | 72 | 11 | 0 | +8.5 d |
| 9502 | 2026-07-14 | 89 | 17 | 1 | +35.3 d |
| 9829 | 2026-07-31 | 38 | 72 | 8 | 0.0 d |
| 6178 | 2026-06-24 | 12 | 16 | 4 | 0.0 d |

The median deltas track each export's age almost exactly at 6197 (+8.5d vs 8.4d
old) and 9502 (+35.3d vs 35.5d old) — those properties are alive and the export
is simply a stale photograph. At 9829 and 6178 the median is 0.0d, meaning most
devices' last contact *is* what the export recorded: genuinely dead units.

### 13 anomalies where the API looks OLDER than the export

| Prop | Device | Room | API `last_heard` | export `LastHeartbeat` | Δ days |
|---|---|---|---|---|---|
| 9829 | P2-0120 | 345a | 2026-05-22 | 2026-07-18 | **−56.3** |
| 9829 | P2-0174 | 348 | 2025-08-27 | 2025-09-24 | −28.4 |
| 9829 | P2-0028 | 216 | 2026-05-10 | 2026-06-03 | −24.0 |
| 9829 | P2-0153 | 315 | 2025-10-31 | 2025-11-21 | −20.2 |
| 6178 | P2-38 | 201 | 2025-12-02 | 2025-12-17 | −15.0 |
| 9829 | P2-0009 | 360 | 2025-07-20 | 2025-08-04 | −14.6 |
| 6178 | P2-0089 | 422 | 2026-06-12 | 2026-06-24 | −12.1 |
| 6178 | P2-0231 | 418 | 2026-06-12 | 2026-06-23 | −10.7 |
| 9829 | P2-0206 | 225 | 2026-03-08 | 2026-03-17 | −9.0 |
| 9829 | P2-0175 | 322 | 2026-03-06 | 2026-03-14 | −8.0 |
| 9502 | P2-0099 | 201 | 2026-06-29 | 2026-07-06 | −6.1 |
| 9829 | P2-0156 | 222 | 2026-06-11 | 2026-06-17 | −5.9 |
| 6178 | P2-0012 | 128 | 2026-05-24 | 2026-05-27 | −3.0 |

Every one is a device that has since gone permanently silent (up to 394 days),
and every anomalous export timestamp still predates its own export snapshot, so
this is not a clock-skew artifact of the export run. `last_heard` should be
monotonic and should never trail an application heartbeat. **Open question for
Priya — see §7.** Practically these are all long-dead devices, so this does not
block a heartbeat-only v2.

### What a live pull would actually change today

| Property | export says silent >7d | live API says silent >7d | would flip to healthy |
|---|---|---|---|
| 6178 | 12 | **25** | 0 |
| 6197 | 5 | **13** | 0 |
| 9502 | 17 | **29** | 2 |
| 9829 | 89 | 89 | 5 |

The API only ever *adds* silent devices. The stale exports are not producing
false alarms — they are producing **false reassurance**, hiding devices that died
after the last export (+13 at 6178, +8 at 6197, +12 at 9502).

---

## 5. Battery data we would be keeping on the old path

299 voltage readings underpin the dashboard's battery view. Their real age is
worse than the export dates suggest, because `py_export_batterystatus` has **no
`CurrentTime` column at all** — only a per-row `LastTimestamp`:

| Prop | rows | oldest | newest | median age vs today | median gap (API `last_heard` − battery `LastTimestamp`) |
|---|---|---|---|---|---|
| 6178 | 29 | 2025-11-26 | 2026-06-24 | 68.6 d | 3.0 d |
| 6197 | 80 | 2026-05-30 | 2026-08-10 | 11.1 d | 9.0 d |
| 9502 | 106 | 2026-03-05 | 2026-07-14 | 36.9 d | 35.5 d |
| 9829 | 84 | 2025-07-19 | 2026-07-31 | 83.6 d | 8.2 d |

Voltage ranges are plausible for Li-ion and need no transform (6197: 2.792–4.395,
median 3.945), so the "systematic offset vs scatter" question is moot — there is
no API-side battery series to compare against. The positive gap column is the
real point: at 9502 the median device has been heard from **35 days after** its
last recorded battery reading. The device is demonstrably alive; the voltage
next to it on the dashboard is over a month old.

---

## 6. Rate limiting

~60 requests total at ≤4/sec (260 ms spacing). **Zero 429s, zero backoff.**
Particle returned **no `X-RateLimit-*` headers** on any response, so there is no
published budget to read — pacing has to stay conservative by convention.

Cost shape for a hypothetical v2: the device list is **9 requests** for the whole
fleet, which is cheap and safe to run per build. Per-device vitals would be
**879 requests ≈ 4 minutes** at this pacing — but since vitals carry no battery,
there is no reason to pay it.

---

## 7. Open questions for Priya (she owns the export pipeline)

1. **Where does `BatteryVoltage_V` come from?** It is not in the Particle Cloud
   API. Which datastore does `py_export_batterystatus` query, and what writes to
   it — a webhook integration, a custom subscriber, something else?
2. **What is the event name** the firmware publishes voltage under, and is the
   subscriber still running? Battery `LastTimestamp` values at 9502 stop on
   2026-07-14 and at 6178 on 2026-06-24 — did collection stop, or just the export?
3. **Why does `py_export_batterystatus` have no `CurrentTime`** when the
   heartbeat tab does? Without it we cannot tell a stale export from a stalled
   collector.
4. **6178 coverage:** 44 devices tagged `esa_6178` reported in the last 2 days but
   are in no export. Is the export filtered to a registered subset, or has it
   silently stopped picking up newer installs?
5. **The 13 inverted timestamps:** how can an export `LastHeartbeat` be newer than
   Particle's `last_heard` for the same device ID — device replacement reusing a
   room, a backfill/replay, or a different upstream clock?
6. **Can we get a token with `events:get` and `integrations:list`?** Both are
   scope-blocked today and both are needed to close question 1 properly.

---

## 8. Scope of what was touched

- **Nothing in the deployed pipeline was modified.** `build.js`, `fetch.js`,
  `normalize.js`, `render.js`, `template.html`, `netlify.toml` and the Actions
  workflow are untouched.
- `fetch.js` was **run** once (its approved read-only path) to refresh
  `data/raw/`; all five workbooks validated clean.
- New files: `probe/` only, plus `.env.local` (gitignored, never committed).
- Raw API pulls: `data/raw/particle-probe/` (gitignored).
- The token was never printed, logged, or written to disk; `probe/lib.js`
  redacts it from every output path.

### Re-running the probe

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
node --env-file=.env.local probe/00-preflight.js       # token + product check
node --env-file=.env.local probe/01-devices.js         # fleet enumeration
node probe/02-exports.js                               # read py_export tabs
node --env-file=.env.local probe/03-doorA-vitals.js    # cached vitals sample
node --env-file=.env.local probe/04-doorB-ledger.js    # ledger + endpoint sweep
node --env-file=.env.local probe/05-collection-layer.js
node probe/06-join.js                                  # API vs py_export diff
node probe/07-analysis.js                              # groups, rooms, anomalies
```

`probe/lib.js` exposes only a `get()` helper — there is deliberately no
POST/PUT/DELETE path in the probe code.

---

## 9. v2 recommendation in one paragraph

**Heartbeat-only go.** The Particle API is a clean, complete, live source for
liveness: a perfect 338/338 join, a 9-request fleet pull, no rate-limit
pressure, and it exposes 131 live devices the current exports miss entirely.
**Battery is a no-go** — it does not exist in the Cloud API, and retrieving it
would mean building a persistent event subscriber, which is a separate project
and duplicates a collection layer that already exists somewhere. A v2 fetch seam
is therefore **not a drop-in swap**: it can replace the heartbeat half, but it
must still merge battery from `py_export_batterystatus` and room numbers from the
registry, since the API carries neither. Before building any of it, answer
Priya's questions 1–4 — if the battery collector has simply stopped, that is a
much cheaper fix than v2 and it is the actual thing making the dashboard stale.

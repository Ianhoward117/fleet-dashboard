# Claude Code Starter Brief — Shower Stream Fleet & Ops Dashboard

Second Claude Code session, first ground-up build. Session 1 (portfolio site) was
deploy-and-harden; this one starts from an empty folder. Expect it to take one
long sitting or two comfortable ones. Three things are different this time:

1. **You're building, not migrating** — fetch → normalize → render, from scratch.
2. **One deliberate npm dependency** (`xlsx` for parsing the workbooks). Everything
   else stays vanilla Node, same discipline as the portfolio pipeline.
3. **The build runs on Netlify's servers, not your laptop.** Because every input
   is a public link, there are zero secrets — so Netlify can fetch the sheets
   itself, which is what makes the daily auto-refresh possible.

---

## Part 1 — Before you launch Claude Code (~5 min)

**1. Skip the install if you did the portfolio session.** Otherwise:

```bash
curl -fsSL https://claude.ai/install.sh | bash   # native installer, auto-updates
claude --version                                  # confirm
node --version                                    # want v18+ (the pipeline needs it)
```

**2. Make the project folder and drop this brief in it:**

```bash
mkdir -p ~/Projects/fleet-dashboard && cd ~/Projects/fleet-dashboard
# save this file into the folder as BRIEF.md
```

**3. Have ready:** GitHub login (decide now: personal account or an Abstract
Engineering org — NOT txic-ut), Netlify login.

**4. Tokens to export: none.** Nothing to hide, nothing to leak. Launch:

```bash
claude
```

**Your ongoing loop after this ships:** nothing, for data — the dashboard
rebuilds itself daily. Code changes are `git add -A && git commit -m "..."` then
`git push`. Force an immediate data refresh anytime with the build-hook curl
command (it'll be in the README by the end of the session).

---

## Part 2 — PASTE-READY PROMPT (copy everything in the block below)

```
You are in an empty folder that will become the Shower Stream Fleet & Ops
Dashboard. This is my second-ever Claude Code session and my first ground-up
build, so: one-sentence explanation before each step, small clearly-messaged
commits, ask before anything destructive, and if the data doesn't match the
schema notes below, STOP and show me — don't improvise around it.
If BRIEF.md is in this folder, it's the reference copy of this prompt —
commit it under docs/.

CONTEXT
- Shower Stream (Abstract Engineering, Inc.) deploys IoT shower devices in
  Extended Stay America hotels. I co-founded it. This dashboard is an
  internal ops tool: fleet health + triage, NOT savings metrics (a separate
  savings dashboard already exists).
- Inputs are five Google Sheets, all fetchable WITHOUT auth via
  https://docs.google.com/spreadsheets/d/{ID}/export?format=xlsx
  (verified working via curl on 2026-08-11):

  SHEET_IDS = {
    registry: "19JCSzQ-vykHvhWL1IjR6r6EEIe_rUeCa",   // master device spreadsheet
    wo_6197:  "1aBSCjtVAgPVE54WhvkG2M4rHX5RRYoYrwh7yE5JQxHo",
    wo_9502:  "1SKzTkrNG2d727boPAKMRITDGHseUs3_QLpkd22JYUGo",
    wo_6178:  "1Hw0pYIWKSIOp8TRego3QayW4IlXLe0CPeGoyKSvr3Po",
    wo_9829:  "1ac_Lbr66Xwz2_p9TrHZhchhgJwbTIiQNYYBbkI6EgeM"
  }

SCHEMA NOTES (from a real inspection on 2026-08-11 — trust these over guesses)
- REGISTRY workbook tabs: "ESA 9829 - Austin - Northwest", "ESA 6178 -
  Austin - Southwest", "ESA 9502 - Austin - Austin Airp", "The Lab_P2",
  "Fort Custer Education Center". Columns A–F matter: Device Name (P2-####),
  Device ID (Particle hex), MAC, Room Number, Install Date, Notes. Ignore
  everything right of F (device counts, firmware snippets — scratch space).
  THERE IS NO 6197 TAB — handle that property gracefully (triage/telemetry
  only; reconciliation view notes the missing registry).
  9829's tab stacks replacement history (~186 device rows for ~91 rooms) —
  collapse to current-device-per-room by latest Install Date.
- WORK ORDER workbooks (one per property), three sheets each:
  1. "Room Status" — the human triage layer. 6197's has a "Device#" column;
     the other three don't (join those by room number). Shared columns:
     Installed Rooms, Last Heartbeat, Days with no Heartbeat, Last Shower
     Timestamp, Days with no Shower, Battery Status (voltage), Status,
     Action Item, Notes. Status values: Ok | Issue | Check. Action Items are
     free text with recurring patterns ("Replace device: WiFi...",
     "Battery", "Run a shower", "Recheck device name").
  2. "py_export_batterystatus" — ParticleDeviceId, RoomNumber,
     LastTimestamp, BatteryVoltage_V, LastHeartbeat.
  3. "py_export_heartbeatstatus" — ParticleDeviceId, RoomNumber,
     LastHeartbeat, CurrentTime, TimeDiff. CurrentTime = the snapshot
     timestamp for that property's export — this drives freshness badges.
- Data hygiene realities: room numbers arrive as floats (102.0 → "102");
  expect literal strings "NA", "No device in room", "#N/A"; dates are
  datetimes; one Particle ID can appear in multiple rows. Normalize all of
  it — no string of those leaking into the UI.

ARCHITECTURE (approved — don't redesign)
- Vanilla Node, ONE npm dependency: xlsx (SheetJS) for workbook parsing.
  Ask me before adding anything else.
- Files: config.js (SHEET_IDS, PROPERTIES metadata, THRESHOLDS),
  fetch.js (download 5 workbooks to data/raw/, gitignored; FAIL the build
  loudly if any workbook is missing or malformed — never render partial
  fleet data), normalize.js (merge registry ↔ telemetry ↔ triage into
  data/normalized.json + reconciliation lists; print per-property counts),
  render.js + template.html (static output to dist/), build.js
  (orchestrator: fetch → normalize → render).
- PROPERTIES in config.js, editable display metadata:
  6197 (name TBD by me), 6178 "Round Rock / Southwest", 9502 "Airport" with
  tag "active-mode paused", 9829 "Northwest" with tag "offboarding" (the
  franchisee is exiting). The Lab and Fort Custer are OUT OF SCOPE.
- THRESHOLDS in config.js as named constants. Propose defaults for
  heartbeat-age buckets (e.g. <2d / 2–7d / >7d / never) but ASK ME to
  confirm, and ASK ME for battery-voltage cutoffs — do NOT invent battery
  chemistry. Placeholder buckets clearly labeled "unconfirmed" are fine
  for the first render.

THE PAGE (one static index.html, three views as tabs, in this order)
1. OPS TRIAGE QUEUE (default view) — every Issue and Check row fleet-wide:
   property, room, device, status, days silent, battery, action item, notes.
   Client-side filters: property, status, action-type keyword; a search box.
   Sortable columns if cheap. This doubles as our consolidated diagnostic
   register, so it must be information-dense but phone-readable.
2. FLEET ROLLUP — one card per property: installed / reporting / silent
   counts, Ok-Issue-Check mix, battery distribution, heartbeat-age
   histogram, and a FRESHNESS BADGE (age of that property's CurrentTime
   snapshot) displayed prominently, color-coded.
3. RECONCILIATION — ghosts (in registry, never in telemetry), unregistered
   reporters (telemetry, no registry), room/device mismatches, and the
   6197-has-no-registry-tab note.
- Global header: "Data as of" per-property + "Page built" timestamp.
- <meta name="robots" content="noindex"> — public but unlisted.
- Design: clean internal-tool aesthetic, fast, no frameworks, works well
  on a phone (field use). Vanilla JS only.

TASKS, IN ORDER
1. Scaffold: git init, .gitignore (node_modules/, data/, .DS_Store,
   dist/ optional — dist is rebuilt by Netlify), package.json with xlsx,
   config.js. Commit.
2. fetch.js + normalize.js. Run locally, show me the per-property counts
   and the reconciliation summary before any rendering. I'll sanity-check.
3. render.js + template.html → dist/index.html. I'll open it locally and
   spot-check against the sheets. Reference numbers from the 2026-08-11
   pull (sheets are live, so verify directionally if they've been updated
   since): 6197 → 94 rooms, 57 Ok / 29 Issue / 8 Check, snapshot Aug 10;
   9502 → 116 rooms, 78/23/15, Jul 14; 6178 → 93 rooms, 13/69/11, Jun 24;
   9829 → 118 rooms, 37/76/5, Jul 31.
4. GitHub: PRIVATE repo "fleet-dashboard" — ask me whether personal or an
   Abstract Engineering org, then create and push (gh CLI if available,
   else click-by-click).
5. Netlify — I'll click, you guide, one step at a time: Import from GitHub
   → this repo → Build command: node build.js (Netlify auto-installs
   package.json deps first) → Publish directory: dist → NO env vars.
   Site name: generate an unguessable-ish name like ss-fleet-<4 random
   chars> and confirm with me. Verify deploy goes green and the live page
   fetches fresh data.
6. Auto-refresh: create a Netlify build hook named "daily-refresh". Add
   .github/workflows/rebuild.yml with schedule cron "0 11 * * *"
   (~5–6am Central year-round) plus workflow_dispatch, POSTing the hook
   URL from a GitHub Actions secret NETLIFY_BUILD_HOOK. Prove it: run the
   workflow manually via workflow_dispatch and confirm Netlify rebuilds.
7. README.md: architecture diagram in text, the manual-refresh curl
   command, how to edit thresholds/property metadata, the v2 seam (swap
   fetch.js to the Particle API without touching normalize/render).
   Final commit + push.

DEFINITION OF DONE — verify each, show me evidence:
[ ] Private repo pushed; zero secrets in the repo (the only secret in the
    whole system is the build-hook URL, stored as a GitHub Actions secret)
[ ] Build passes locally AND on Netlify; a missing workbook fails the
    build with a clear error
[ ] All four properties render; Lab/Fort Custer nowhere on the page
[ ] Triage queue row count ties to the sheets' Issue+Check counts
[ ] Freshness badges show correct per-property snapshot ages
[ ] noindex meta present; site name is non-obvious
[ ] Manual workflow_dispatch triggers a Netlify rebuild end to end;
    scheduled run is enabled
[ ] README complete, including the force-refresh command

OUT OF SCOPE — do not touch: Particle API (v2), auth/login of any kind,
Lab and Fort Custer, savings/water metrics, any write to any Google Sheet
(this system is strictly read-only), restructuring the sheets themselves.
```

---

## Part 3 — After this session (parking lot, not for Claude Code today)

1. **Threshold tuning with Priya** — replace the placeholder battery/heartbeat
   buckets with real cutoffs; one config.js edit + push.
2. **Share the link** with Greg, Priya, Brady. If room-level detail ever needs
   gating, Cloudflare Access bolts onto the same Netlify site later — the
   public-but-unlisted call is reversible.
3. **Trend history (v1.5)** — have the daily workflow also commit each day's
   `normalized.json` snapshot; a week of those and the rollup grows trend
   lines (Issues over time, per property). Cheap and very Greg-legible.
4. **v2: Particle API live pull** — kills the staleness problem at the source
   and removes the py_export dependency entirely. By design it's a fetch.js
   swap; nothing downstream changes.
5. **Mid-September ESA/David meeting** — the fleet rollup is the natural
   live exhibit for the active-rollout dataset; consider an aggregate-only
   toggle for external eyes.

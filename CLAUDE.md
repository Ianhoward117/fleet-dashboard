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

## Commands

```bash
node build.js        # fetch -> normalize -> render  (what Netlify runs)
node fetch.js        # re-download the 5 workbooks into data/raw/
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
  9502 Austin - Airport (`active-mode paused`) ·
  9829 Austin - Northwest Research (`offboarding`)
- **Tabs:** Fleet rollup (default) → All rooms → Reconciliation. The old
  triage tab is folded into All rooms as the `Issue + Check` status filter;
  legacy `?v=triage` links still resolve to it.
- **Days-silent is measured against each property's own export snapshot**, not
  against today, because that is what the source column means. The
  **Last checked** column and the freshness badges make that legible. Ian
  chose this over rebasing the figure to today.
- **Alerts go to the GitHub account owning the schedule**, not a shared inbox.
  Netlify email is Pro-only; the workflow's `verify-live.js` step is the
  watchdog instead. Escalation options are in the README.
- **Site is public-but-unlisted** by choice: no login, protection is the
  unguessable hostname plus `noindex`. Cloudflare Access bolts on later.

## Current state (2026-08-19)

- All four properties render; counts tie exactly to the source sheets:
  421 rooms, 185 Ok / 197 Issue / 39 Check, 236 needing attention.
- Daily refresh has run unattended and green on 16, 17 and 18 Aug.
- 3 days of history captured. **All trends are flat** (29/69/23/76 unchanged)
  because the `py_export_*` sheets have not been re-exported — the dashboard
  is faithfully reporting stale sources, not malfunctioning.
- Snapshot ages as of 19 Aug: 6197 ~8d, 9829 ~18d, 9502 ~35d, 6178 ~56d.

## Open items

- **6178 is the property in trouble:** 60 of 93 rooms have never reported,
  registry covers only 26 of 93, snapshot ~56 days stale.
- **The real bottleneck is the `py_export` refresh, not this dashboard.**
  Rebuilding more often cannot help. Fix is to schedule that Python export or
  bring v2 (Particle API) forward.
- `npm audit` flags xlsx 0.18.5 (prototype pollution, ReDoS). No npm-side fix
  exists; patched builds are only on SheetJS's own CDN. Judged acceptable for
  a build-time parser reading our own sheets.
- Thresholds are due a review with Priya.
- Consider access control before the mid-September ESA/David meeting if
  room-level detail will be on screen for external eyes.

## Working style Ian asked for

One-sentence explanation before each step; small, clearly-messaged commits;
ask before anything destructive. **If the data does not match the documented
schema, stop and show him rather than improvising around it** — that rule has
already caught several real discrepancies, all recorded in the README's
"Known data quirks".

'use strict';

/**
 * Central configuration for the Shower Stream Fleet & Ops Dashboard.
 *
 * Everything an operator is likely to edit lives in this one file:
 *   - SHEET_IDS   : which Google Sheets workbooks to pull
 *   - PARTICLE    : the one Particle Cloud API endpoint this build may call
 *   - PROPERTIES  : display metadata + page order for each property
 *   - THRESHOLDS  : the cutoffs that drive buckets and colour-coded badges
 *
 * Nothing in this file is a secret. Every workbook is fetched over a public,
 * unauthenticated export URL. The Particle call needs a token, but the token
 * itself lives only in PARTICLE_TOKEN - .env.local locally, a Netlify
 * environment variable in production - and never in this repository.
 */

// ---------------------------------------------------------------------------
// Source workbooks
// ---------------------------------------------------------------------------

// Fetched as .xlsx via https://docs.google.com/spreadsheets/d/{ID}/export?format=xlsx
//
// One workbook: Priya's consolidated export, which carries every property's
// rooms, triage, battery and heartbeat export on shared tabs, partitioned by
// its Location column. It replaced the three per-property work-order
// workbooks and the registry workbook at the cutover (CUTOVER.md §1-§2).
const SHEET_IDS = {
  consolidated: '1_qlAjrnafeOQN-EYXGXf0Gks3BZySXtpWk_FKbpQQGI',
};

// The tabs the build reads. A missing one fails the fetch. `devicenames` also
// exists in the workbook and is deliberately neither required nor read.
const SOURCE_TABS = ['roomstatus', 'batterystatus', 'heartbeatstatus'];

// The zone the sheet exports write their timestamps in. They are Central
// wall-clock times with no offset attached: read as Central they agree with
// Particle's last_heard, read as UTC they are five hours early (CUTOVER.md §3,
// D4). normalize.js parses every sheet datetime it reads in this zone,
// DST-aware, so the build gives the same instants in Austin and on Netlify.
const SHEET_TIME_ZONE = 'America/Chicago';

// Where the built dashboard is published. The daily workflow checks this URL
// after triggering a rebuild, so a refresh that silently stops working turns
// into a failed workflow rather than a page that quietly goes stale.
const SITE_URL = 'https://ss-fleet-rxsm.netlify.app';

// ---------------------------------------------------------------------------
// Particle Cloud API  (v2: heartbeat/liveness source)
// ---------------------------------------------------------------------------

/**
 * Heartbeats come from the Particle Cloud API as of v2. Battery, room mapping
 * and triage status stay on the sheets: the probe (probe/FINDINGS.md) proved
 * battery is not exposed by the Cloud API at all, and no room identifier ever
 * appears in a Particle payload.
 *
 * DELIBERATELY NARROW. The product device list is the only endpoint this
 * pipeline is permitted to call, ever. It is a plain read of cloud-held
 * records and touches no hardware. Anything that commands or wakes a device -
 * function calls, ping/signal/rename/claim/flash, and the per-device vitals
 * GET, which asks the device to report - is out of bounds: these are physical
 * units plumbed into occupied hotel water lines.
 *
 * The token is supplied out-of-band via PARTICLE_TOKEN and must never be
 * written into this file, logged, or committed.
 */
const PARTICLE = {
  productId: 18173,
  apiBase: 'https://api.particle.io',
  perPage: 100, // 879 devices at time of writing -> ~9 pages
  pacingMs: 260, // <= 4 req/sec, the ceiling agreed for this fleet
  maxRetries: 2, // then fail the build loudly rather than render a partial fleet
  tokenEnv: 'PARTICLE_TOKEN',
};

// The single permitted endpoint. Derived from productId so there is one place
// to change it and no way to accidentally point at a device-level route.
PARTICLE.devicesPath = () => '/v1/products/' + PARTICLE.productId + '/devices';

// ---------------------------------------------------------------------------
// Registry tabs read for exclusion only
// ---------------------------------------------------------------------------

/**
 * These registry tabs are read solely to learn which Particle device IDs are
 * NOT part of the in-scope fleet, so they can be filtered out of the
 * "live but unmapped" reconciliation list. Their devices are never rendered
 * anywhere on the page.
 *
 *   The Lab_P2                     - bench/lab hardware
 *   Fort Custer Education Center   - out of scope by the brief
 *   ESA 9829 - Austin - Northwest  - property fully uninstalled 2026-08-19
 *
 * Tab names must match the registry workbook exactly.
 *
 * RETIRED at the cutover and no longer read: an unmapped device now needs a
 * live esa_ tag or a heartbeatstatus Location to be listed at all, which is
 * what keeps this hardware off the page (CUTOVER.md §6). Block 5 deletes it.
 */
const EXCLUDED_REGISTRY_TABS = [
  'The Lab_P2',
  'Fort Custer Education Center',
  'ESA 9829 - Austin - Northwest',
];

/**
 * Out-of-scope site names that must never reach the page in a structured
 * field: the lab bench, Fort Custer, and the uninstalled 9829. render.js fails
 * the build if one appears anywhere in the page payload outside free-text
 * notes (D7). 9829 is matched on its full site name rather than the bare
 * number, because "9829" would false-positive on any device id that happens
 * to contain those hex digits.
 *
 * A NOTE that mentions one is not fatal: it is a finding in the build log,
 * and the note still renders as written, because it is what a person wrote
 * about that room. Names are matched exactly as written (case-sensitive).
 */
const OUT_OF_SCOPE_NAMES = ['The Lab', 'Fort Custer', 'ESA 9829'];

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

/**
 * Array order is the order properties appear on the page.
 *
 *   code        - ESA property number, used as the stable internal key. It is
 *                 also the value of the consolidated sheet's Location column.
 *   name        - free-text display name; edit at will
 *   sheetKey    - RETIRED at the cutover: the legacy work-order workbook.
 *   registryTab - RETIRED at the cutover: the legacy registry tab.
 *                 The build no longer reads either; probe/02-exports.js still
 *                 does. Block 5 of the cutover deletes both.
 *   tag         - optional status pill shown next to the name, or null
 *
 * The Lab_P2, Fort Custer Education Center and ESA 9829 tabs exist in the
 * registry workbook but are deliberately out of scope: they are not listed
 * here and therefore never reach the page. 9829 was fully uninstalled on
 * 2026-08-19; its tab is retained in the workbook for a later phase that
 * reuses it as an exclusion list.
 */
const PROPERTIES = [
  {
    code: '6197',
    name: 'Round Rock - Southwest',
    sheetKey: 'wo_6197',
    registryTab: null, // no registry tab exists - triage/telemetry only
    tag: null,
  },
  {
    code: '6178',
    name: 'Austin - Southwest',
    sheetKey: 'wo_6178',
    registryTab: 'ESA 6178 - Austin - Southwest',
    tag: null,
  },
  {
    code: '9502',
    name: 'Austin - Airport',
    sheetKey: 'wo_9502',
    registryTab: 'ESA 9502 - Austin - Austin Airp',
    tag: 'active-mode paused',
  },
];

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * Each threshold group carries a `confirmed` flag. Anything still false is
 * rendered on the page with an explicit "unconfirmed" marker, so nobody
 * mistakes a placeholder cutoff for an engineering decision.
 */
const THRESHOLDS = {
  /**
   * How long a device has gone without a heartbeat, in days.
   * Buckets are evaluated in order; `maxDays: null` means "no upper bound".
   */
  heartbeatAge: {
    confirmed: true, // confirmed by Ian, 2026-08-11
    buckets: [
      { key: 'fresh', label: '< 2 days', maxDays: 2, tone: 'good' },
      { key: 'aging', label: '2-7 days', maxDays: 7, tone: 'warn' },
      { key: 'stale', label: '> 7 days', maxDays: null, tone: 'bad' },
    ],
    // Devices with no heartbeat timestamp at all land here instead.
    neverBucket: { key: 'never', label: 'Never', tone: 'bad' },
    // Rooms whose DeviceId is blank: the sheet names no device, which is a
    // different statement from a device that has never reported (D11). Not a
    // cutoff - no threshold moves - and toned like a battery with no reading.
    noDeviceBucket: { key: 'noDevice', label: 'No device', tone: 'flat' },
  },

  /**
   * Age of a property's export snapshot (the CurrentTime column in
   * py_export_heartbeatstatus), in days. Drives the freshness badge.
   */
  snapshotFreshness: {
    confirmed: true, // mirrors the confirmed heartbeatAge cutoffs
    buckets: [
      { key: 'current', label: 'Current', maxDays: 2, tone: 'good' },
      { key: 'aging', label: 'Aging', maxDays: 7, tone: 'warn' },
      { key: 'stale', label: 'Stale', maxDays: null, tone: 'bad' },
    ],
  },

  /**
   * Age of a property's battery readings, in days, measured from build time
   * against each row's LastTimestamp. This drives the per-property freshness
   * badge as of v2: heartbeats are now live at build time, so battery is the
   * only part of a property's data that can meaningfully go stale.
   *
   * Same cutoffs and tones as the old snapshot badge, so the colours on the
   * rollup keep meaning what operators already read them as meaning.
   */
  batteryAge: {
    confirmed: true, // mirrors the confirmed heartbeatAge cutoffs
    buckets: [
      { key: 'current', label: 'Current', maxDays: 2, tone: 'good' },
      { key: 'aging', label: 'Aging', maxDays: 7, tone: 'warn' },
      { key: 'stale', label: 'Stale', maxDays: null, tone: 'bad' },
    ],
  },

  /**
   * Battery voltage cutoffs, in volts. Supplied by Ian on 2026-08-11.
   *
   *   >= 3.6        healthy
   *   3.2 .. < 3.6  marginal
   *   < 3.2         critical
   *
   * If `confirmed` is ever set back to false, the dashboard stops
   * classifying batteries and shows raw voltages with an "unconfirmed"
   * marker instead of inventing a cutoff.
   */
  batteryVoltage: {
    confirmed: true, // confirmed by Ian, 2026-08-11
    okAbove: 3.6, // volts at or above this are healthy
    warnAbove: 3.2, // volts at or above this are marginal; below is critical
  },

  /**
   * How old the page itself may get, in days since builtAt, before it says so.
   * From 2026-09-16 to 09-24 the daily build failed and the site kept serving
   * the Sep 15 build with nothing on screen to say so. The page now judges its
   * own age in the browser, against the viewer's clock, on load and hourly
   * while it stays open: past this cutoff a banner above every view says when
   * it last refreshed. A builtAt it cannot read shows the banner too; one in the
   * future (the viewer's clock is behind) does not. render.js fails the build
   * without a usable value, so the page never has to guess one.
   */
  pageAge: {
    confirmed: true, // Ian, 2026-09-25; matches the > 7 d stale cutoff
    maxDays: 7, // strictly older than this shows the banner
  },
};

// ---------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------

/**
 * Controls the sparklines drawn from the committed daily records in history/.
 *
 *   windowDays  - how many trailing CALENDAR DAYS the sparklines cover, ending
 *                 on the build's UTC date (H1). Trend x is the date, so a day
 *                 with no record takes its real width as a gap. render.js
 *                 ships only the records dated inside the window - never "the
 *                 last N records", which would pull older days in across an
 *                 outage. Nothing is lost either way: history/ keeps every
 *                 record ever written.
 *
 *   annotations - vertical markers for events that move a series without
 *                 anything in the field having changed. Each declares the
 *                 charts it is drawn on (H2), and the build fails if it does
 *                 not:
 *                   charts: 'all'               every chart on the page
 *                   charts: ['fleet', '6178']   the fleet strip, and 6178's card
 *                 'fleet' is the fleet strip's charts; a property code is that
 *                 property's card. Scope an entry to every chart whose line it
 *                 explains, and no others. A marker is drawn only when a
 *                 record exists on its date: date it on the FIRST RECORD THAT
 *                 CARRIES the new value, not on the day the change shipped.
 *
 * ADD AN ENTRY HERE whenever a property is added to or removed from
 * PROPERTIES. Without one, the fleet line shows an unexplained step and the
 * next person to look reads a clerical change as a fleet event - which is
 * precisely what the 2026-08-20 entry below exists to prevent. Pre-2026-08-20
 * records still carry 9829 as recorded (236 triage rows against today's 155),
 * because history files are a record and are never rewritten.
 *
 * THE GAP RULE, which the page implements and this file is the place to state:
 * a value that was not recorded is a gap - the line breaks and resumes. It is
 * never a zero. That covers a record written before a field existed, and (H1)
 * a day with no record at all, such as the 2026-09-16 .. 09-24 outage.
 * Coercing either to 0 would draw a cliff that never happened, and drawing
 * the days either side next to each other would hide that anything was
 * missing.
 */
const TRENDS = {
  windowDays: 30,
  annotations: [
    // A property left PROPERTIES, which moves only the fleet totals: a
    // property's own counts are unaffected by another leaving the page.
    { date: '2026-08-20', label: '9829 removed', charts: ['fleet'] },
    // 6178's room map moved from the registry/export to the committed override
    // in data/room-overrides.json. 32 more rooms at 6178 gained a device in one
    // step, so the fleet's awaiting-room-mapping line drops sharply. Nothing
    // happened in the field: the same devices were already live and already
    // counted, they simply became attributable to a room.
    //
    // Dated the 27th, not the 26th, though the change shipped on the 26th. An
    // annotation marks the first record that CARRIES the new value - the same
    // convention as "9829 removed" above, which sits on 2026-08-20 for a
    // removal made on the 19th. The daily workflow had already written
    // history/2026-08-26.json before this shipped, so that record holds the old
    // numbers and the step falls on the 27th. Until that record exists the
    // annotation simply does not render.
    { date: '2026-08-27', label: '6178 room map overridden', charts: ['fleet', '6178'] },
    // 6197 and 9502 gained merge-mode overrides: the override wins the rooms it
    // names, the rest of each property keeps its sheet-derived map. 6197 picks
    // up 9 rooms that had no device; 9502 has 16 rooms re-pointed and one
    // device moved between rooms. Both move the fleet's awaiting-room-mapping
    // line without anything having changed in the field.
    //
    // Dated the 27th for the same reason as the entry above: today's history
    // record was written by the cron before this shipped, so the step lands on
    // the next one. Both events share that date and the chart shows one marker.
    { date: '2026-08-27', label: '6197 + 9502 room overrides', charts: ['fleet', '6197', '9502'] },
    // 6178 moved from replace to merge. Replace took the property's assignments
    // entirely from the override file, so the 28 roster rooms it does not name
    // had no device at all; merge lets the sheets keep speaking for them. 27 of
    // those 28 became attributable to a device, so the fleet's
    // awaiting-room-mapping and silent lines both step.
    //
    // Nothing changed in the field. The step is clerical: the 2026-08-26
    // py_export refresh took the export's room->device map from ~32 rooms to 86,
    // and those devices were already live and already counted - they simply
    // became attributable to a room.
    //
    // Read the silent line carefully here. Only 4 of the 27 are live; the other
    // 23 are devices last heard 32-270 days ago, which move from "no device" to
    // "reporting, but stale". Silent falling 28 -> 1 is a clerical step and not
    // a recovery.
    //
    // Dated the 29th, not the 30th: history/2026-08-29.json had not been written
    // when this shipped, so today's record is the first one that carries the new
    // numbers - the same convention as the entries above.
    { date: '2026-08-29', label: '6178 override -> merge', charts: ['fleet', '6178'] },
    // The dashboard moved onto Priya's consolidated workbook: roomstatus.DeviceId is the
    // whole room->device chain; the legacy workbooks, registry and override are retired.
    // No single field event happened on this date, but the step folds that source change
    // together with field work the sheet recorded while the legacy sheets were frozen (e.g.
    // 12 units installed at 6178 on 9/16 now report). The chart cannot separate the two;
    // read it as neither a recovery nor a regression. Triage steps 161 -> 62 and the fleet
    // awaiting-room-mapping line 73 -> 3 (the untagged pool is no longer counted), exactly
    // as CUTOVER.md §10 predicted against the 2026-09-25 export; 6178's Ok line steps
    // 13 -> 105 on its card.
    //
    // Dated the 26th: history/2026-09-26.json, written by the run dispatched right after
    // the merge (03:07Z), is the first record carrying consolidated values. The 25th's
    // record was written by the legacy build and keeps legacy values. Scope 'all': the
    // source switch moves every chart, fleet and property alike.
    { date: '2026-09-26', label: 'consolidated sheet', charts: 'all' },
  ],
};

module.exports = {
  SHEET_IDS,
  SOURCE_TABS,
  SHEET_TIME_ZONE,
  SITE_URL,
  PARTICLE,
  EXCLUDED_REGISTRY_TABS,
  OUT_OF_SCOPE_NAMES,
  PROPERTIES,
  THRESHOLDS,
  TRENDS,
};

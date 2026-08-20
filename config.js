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
const SHEET_IDS = {
  registry: '19JCSzQ-vykHvhWL1IjR6r6EEIe_rUeCa', // master device spreadsheet
  wo_6197: '1aBSCjtVAgPVE54WhvkG2M4rHX5RRYoYrwh7yE5JQxHo',
  wo_9502: '1SKzTkrNG2d727boPAKMRITDGHseUs3_QLpkd22JYUGo',
  wo_6178: '1Hw0pYIWKSIOp8TRego3QayW4IlXLe0CPeGoyKSvr3Po',
};

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
 */
const EXCLUDED_REGISTRY_TABS = [
  'The Lab_P2',
  'Fort Custer Education Center',
  'ESA 9829 - Austin - Northwest',
];

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

/**
 * Array order is the order properties appear on the page.
 *
 *   code        - ESA property number, used as the stable internal key
 *   name        - free-text display name; edit at will
 *   sheetKey    - which SHEET_IDS entry holds this property's work order
 *   registryTab - exact tab name in the registry workbook, or null when the
 *                 property has no registry coverage at all (6197)
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
};

// ---------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------

/**
 * Controls the sparklines drawn from the committed daily records in history/.
 *
 *   windowDays  - how many trailing days the sparklines cover. render.js ships
 *                 exactly this many records to the page, so raising it makes
 *                 the payload bigger. Nothing is lost either way: history/
 *                 keeps every record ever written.
 *
 *   annotations - vertical markers drawn on the FLEET-level series only, for
 *                 events that move a fleet total without anything in the field
 *                 having changed. Per-property series never need one: a
 *                 property's own counts are unaffected by another property
 *                 leaving the dashboard.
 *
 * ADD AN ENTRY HERE whenever a property is added to or removed from
 * PROPERTIES. Without one, the fleet line shows an unexplained step and the
 * next person to look reads a clerical change as a fleet event - which is
 * precisely what the 2026-08-20 entry below exists to prevent. Pre-2026-08-20
 * records still carry 9829 as recorded (236 triage rows against today's 155),
 * because history files are a record and are never rewritten.
 *
 * THE GAP RULE, which the page implements and this file is the place to state:
 * a record written before a field existed carries no value for that field.
 * That is a gap - the line breaks and resumes. It is never a zero. Coercing an
 * absent field to 0 would draw a cliff that never happened.
 */
const TRENDS = {
  windowDays: 30,
  annotations: [{ date: '2026-08-20', label: '9829 removed' }],
};

module.exports = {
  SHEET_IDS,
  SITE_URL,
  PARTICLE,
  EXCLUDED_REGISTRY_TABS,
  PROPERTIES,
  THRESHOLDS,
  TRENDS,
};

'use strict';

/**
 * Central configuration for the Shower Stream Fleet & Ops Dashboard.
 *
 * Everything an operator is likely to edit lives in this one file:
 *   - SHEET_IDS   : which Google Sheets workbooks to pull
 *   - PROPERTIES  : display metadata + page order for each property
 *   - THRESHOLDS  : the cutoffs that drive buckets and colour-coded badges
 *
 * Nothing here is a secret. Every workbook below is fetched over a public,
 * unauthenticated export URL, which is what lets Netlify build this itself.
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
  wo_9829: '1ac_Lbr66Xwz2_p9TrHZhchhgJwbTIiQNYYBbkI6EgeM',
};

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
 * The Lab_P2 and Fort Custer Education Center tabs exist in the registry
 * workbook but are deliberately out of scope: they are not listed here and
 * therefore never reach the page.
 */
const PROPERTIES = [
  {
    code: '6197',
    name: 'ESA 6197', // TODO: confirm display name with Ian
    sheetKey: 'wo_6197',
    registryTab: null, // no registry tab exists - triage/telemetry only
    tag: null,
  },
  {
    code: '6178',
    name: 'Round Rock / Southwest',
    sheetKey: 'wo_6178',
    registryTab: 'ESA 6178 - Austin - Southwest',
    tag: null,
  },
  {
    code: '9502',
    name: 'Airport',
    sheetKey: 'wo_9502',
    registryTab: 'ESA 9502 - Austin - Austin Airp',
    tag: 'active-mode paused',
  },
  {
    code: '9829',
    name: 'Northwest',
    sheetKey: 'wo_9829',
    registryTab: 'ESA 9829 - Austin - Northwest',
    tag: 'offboarding',
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

module.exports = { SHEET_IDS, PROPERTIES, THRESHOLDS };

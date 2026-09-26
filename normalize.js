'use strict';

/**
 * Stage 2 of the pipeline: turn the consolidated workbook and the Particle
 * device list into one clean data/normalized.json, plus the reconciliation
 * lists and the sheet findings.
 *
 * Sources, as of the cutover (CUTOVER.md §1):
 *   - roomstatus           rooms, Location, DeviceId, triage, battery voltage
 *   - batterystatus        battery LastTimestamp, joined by device id only
 *   - heartbeatstatus      secondary: the per-property "sheet export as of"
 *                          stamp, and a fallback attribution for unmapped
 *                          devices - never an assignment
 *   - Particle API         when each device was actually last heard (v2)
 *
 * The room -> device chain is roomstatus.DeviceId, and nothing else: no
 * override, no registry, no heartbeatstatus or battery lookup by room. Sheet
 * conflicts are findings (F1-F4), written down and never failed on; only
 * structure - a missing tab or header, an empty property, a row that lands in
 * two properties - stops the build.
 *
 * Heartbeats are the Particle device list, read fresh at build time, so
 * days-silent means "vs now". Battery, rooms and triage status come from the
 * sheet: the probe proved battery is not in the Cloud API and no room
 * identifier ever appears in one.
 *
 * Everything that leaves this file is already normalized: no "NA", no
 * "#N/A", no "No device in room", no 102.0, no raw Date objects.
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const {
  PROPERTIES, THRESHOLDS, SHEET_TIME_ZONE, SOURCE_TABS, OUT_OF_SCOPE_NAMES,
} = require('./config');

const RAW_DIR = path.join(__dirname, 'data', 'raw');
const PARTICLE_FILE = path.join(RAW_DIR, 'particle-devices.json');
const OUT_FILE = path.join(__dirname, 'data', 'normalized.json');
const DAY_MS = 86400000;

// ---------------------------------------------------------------------------
// Value normalizers
// ---------------------------------------------------------------------------

// Strings the sheets use to mean "nothing here". Deliberately does NOT
// include "None", which is a real Action Item value meaning "no action".
const BAD_TOKENS = new Set([
  '', 'na', 'n/a', '#n/a', '#value!', '#ref!', '#div/0!', '#name?',
  'no device in room', 'no device', 'null', 'undefined', '-', '--',
]);

const isBad = (s) => BAD_TOKENS.has(String(s).trim().toLowerCase());

function normStr(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString();
  const s = String(v).trim().replace(/\s+/g, ' ');
  return isBad(s) ? null : s;
}

function normNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (isBad(s)) return null;
  const n = parseFloat(s.replace(/[^0-9.eE+-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Room numbers arrive as floats (102.0), ints, or suite halves ("213a").
 * Returns { key, display } - key is lowercased for joining, display keeps
 * the operator-facing form. Letter suffixes are preserved, never coerced.
 */
function normRoom(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    const s = Number.isInteger(v) ? String(v) : String(v);
    return { key: s.toLowerCase(), display: s };
  }
  const s = String(v).trim();
  if (isBad(s)) return null;
  // "102.0" -> "102", but "213a" stays "213a"
  const m = s.match(/^(\d+)\.0+$/);
  const display = m ? m[1] : s;
  return { key: display.toLowerCase(), display };
}

const iso = (d) => (d instanceof Date && !isNaN(d) ? d.toISOString() : null);

/** Median of a numeric array; null when empty. Used for battery-age summaries. */
function median(nums) {
  if (!nums.length) return null;
  const a = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
const round = (n, p = 2) => (n === null || n === undefined ? null : Math.round(n * 10 ** p) / 10 ** p);

// ---------------------------------------------------------------------------
// Sheet helpers
// ---------------------------------------------------------------------------

function readWorkbook(key, requiredSheets = [], opts = { cellDates: false }) {
  const file = path.join(RAW_DIR, `${key}.xlsx`);
  if (!fs.existsSync(file)) {
    throw new Error(`NORMALIZE FAILED: missing ${file}\n  Run fetch.js first (or let build.js do it).`);
  }
  let wb;
  try {
    wb = XLSX.readFile(file, opts);
  } catch (err) {
    throw new Error(`NORMALIZE FAILED: ${file} could not be parsed as a workbook.\n  ${err.message}`);
  }
  // A corrupt or truncated file can parse into an empty workbook rather than
  // throwing, so check for the sheets we actually depend on.
  const missing = requiredSheets.filter((s) => !wb.SheetNames.includes(s));
  if (missing.length || wb.SheetNames.length === 0) {
    throw new Error(
      `NORMALIZE FAILED: ${file} is not a usable workbook.\n` +
        `  missing sheet(s): ${missing.length ? missing.map((m) => JSON.stringify(m)).join(', ') : '(workbook has no sheets at all)'}\n` +
        `  sheets present: ${wb.SheetNames.length ? wb.SheetNames.map((s) => JSON.stringify(s)).join(', ') : '(none)'}\n` +
        `  Delete data/raw/ and re-run fetch.js to pull a clean copy.`
    );
  }
  return wb;
}

// ---------------------------------------------------------------------------
// Bucketing
// ---------------------------------------------------------------------------

function bucketByDays(days, group) {
  if (days === null || days === undefined) return group.neverBucket ? group.neverBucket.key : null;
  for (const b of group.buckets) {
    if (b.maxDays === null || days < b.maxDays) return b.key;
  }
  return group.buckets[group.buckets.length - 1].key;
}

/**
 * A property's battery-age summary, for its freshness badge. The median is
 * taken on each room's exact age, recomputed from its batteryTimestamp, and
 * rounded once to the room rows' 0.1 d: a median of ages that were already
 * rounded can land a step off (11.1 where the exact median is 11.165). A room
 * counts as a reading when its row carries a batteryAgeDays.
 */
function batteryAgeSummary(rooms, builtAt) {
  const read = rooms.filter((r) => r.batteryAgeDays !== null && r.batteryAgeDays !== undefined);
  const ages = read.map((r) => (builtAt - Date.parse(r.batteryTimestamp)) / DAY_MS);
  const med = median(ages);
  return {
    readings: ages.length,
    roomsWithout: rooms.length - ages.length,
    medianDays: round(med, 1),
    oldestDays: round(ages.length ? Math.max(...ages) : null, 1),
    bucket: bucketByDays(med, THRESHOLDS.batteryAge),
    approximate: true, // collector runs intermittently; timestamps are not precise
  };
}

/**
 * Action Items are free text with recurring patterns. Collapse them to a
 * small set of canonical types so the triage view can offer a real filter,
 * while the original text is still shown to the operator verbatim.
 */
function actionType(text) {
  if (!text) return 'None';
  const s = text.trim().toLowerCase();
  if (s === 'none') return 'None';
  if (/^battery\b/.test(s)) return 'Battery';
  if (/^replace device/.test(s)) return 'Replace device';
  if (/run a shower/.test(s)) return 'Run a shower';
  if (/^no device/.test(s)) return 'No device';
  if (/recheck device name/.test(s)) return 'Recheck device name';
  return 'Other';
}

function batteryClass(volts) {
  const t = THRESHOLDS.batteryVoltage;
  if (volts === null || volts === undefined) return 'unknown';
  if (!t.confirmed || t.okAbove === null || t.warnAbove === null) return 'unclassified';
  if (volts >= t.okAbove) return 'ok';
  if (volts >= t.warnAbove) return 'warn';
  return 'critical';
}

// ---------------------------------------------------------------------------
// Particle device list
// ---------------------------------------------------------------------------

/**
 * Read what fetch.js pulled from the Particle API.
 *
 * This is the heartbeat source of record as of v2. It is a strict superset of
 * the fleet we render: the product holds every device ever claimed, including
 * inventory, the lab, and decommissioned properties. Mapping to rooms happens
 * downstream; here we only index it.
 */
function readParticleDevices() {
  if (!fs.existsSync(PARTICLE_FILE)) {
    throw new Error(
      `NORMALIZE FAILED: missing ${PARTICLE_FILE}\n` +
        `  Run fetch.js first (build.js does this). Heartbeats come from the\n` +
        `  Particle API as of v2 and there is no fallback - rendering without\n` +
        `  them would show every device as silent.`
    );
  }
  const raw = JSON.parse(fs.readFileSync(PARTICLE_FILE, 'utf8'));
  if (!raw || !Array.isArray(raw.devices) || !raw.devices.length) {
    throw new Error(
      `NORMALIZE FAILED: ${PARTICLE_FILE} contains no devices.\n` +
        `  Refusing to render a fleet that would read as entirely silent.`
    );
  }
  const byId = new Map();
  // Device NAME index, for F4 (resolveNamedUnit): a replacement note names
  // the unit a person reads off it in a corridor, not a 24-hex id. Names are
  // not guaranteed unique by Particle, so every device is kept, and a name
  // several devices share is an F4 finding ('ambiguous name'), never an error.
  const byName = new Map();
  for (const d of raw.devices) {
    if (!d || !d.id) continue;
    byId.set(d.id, d);
    const nameKey = d.name === null || d.name === undefined ? '' : String(d.name).trim().toLowerCase();
    if (!nameKey) continue;
    if (!byName.has(nameKey)) byName.set(nameKey, []);
    byName.get(nameKey).push(d);
  }
  return {
    byId,
    byName,
    pulledAt: raw.pulledAt || null,
    count: raw.devices.length,
    devices: raw.devices,
  };
}

/** A device's Particle groups as strings; anything but an array reads as none. */
const groupsOf = (device) => (device && Array.isArray(device.groups) ? device.groups.map(String) : []);

/**
 * A device's live-property esa_ tag. The regex is anchored, so
 * "baseline_6_shelves_esa_wifi_spi" is not a tag, and a tag for a property this
 * dashboard does not render (esa_9829) is not a live tag.
 *
 * The first esa_#### / esa-#### group naming a live property is the tag;
 * several groups naming the SAME property agree. Groups naming two DIFFERENT
 * live properties are a conflict: the device is unattributable, as D5b treats
 * two heartbeatstatus Locations, and the caller logs it (Ian, 2026-09-25).
 */
function liveTagInfo(device, liveCodes) {
  let first = null;
  const codes = new Set();
  const groups = [];
  for (const g of groupsOf(device)) {
    const m = /^esa[-_](\d{4})/i.exec(g);
    if (!m || !liveCodes.has(m[1])) continue;
    codes.add(m[1]);
    groups.push(g);
    if (!first) first = { code: m[1], group: g };
  }
  if (codes.size > 1) return { tag: null, conflict: [...codes].sort(), groups };
  return { tag: first, conflict: null };
}

/** The live-property tag, or null when there is none or the device carries two (see liveTagInfo). */
const liveTagOf = (device, liveCodes) => liveTagInfo(device, liveCodes).tag;

// ---------------------------------------------------------------------------
// Sheet time (D4)
// ---------------------------------------------------------------------------

/**
 * The consolidated export writes America/Chicago wall-clock time: read as
 * Central, its timestamps agree with Particle's last_heard; read as UTC they
 * are exactly five hours early (CUTOVER.md §3).
 *
 * Datetimes arrive as Excel serials, and the workbook is read with cellDates
 * OFF. SheetJS's own serial-to-Date conversion builds the Date in the HOST
 * zone, so the same sheet would give Austin and Netlify different instants.
 * Here the serial becomes wall-clock fields by plain arithmetic, and the
 * wall clock becomes an instant through Intl. Nothing depends on TZ.
 */
const EXCEL_EPOCH_DAYS = 25569; // days from 1899-12-30 (the serial epoch) to 1970-01-01

const zoneFormatters = new Map();
function zonedParts(ms, timeZone) {
  let f = zoneFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    zoneFormatters.set(timeZone, f);
  }
  const out = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out;
}

/** The zone's offset from UTC at an instant, in ms (Central: -5 h or -6 h). */
function zoneOffsetMs(ms, timeZone) {
  const whole = Math.floor(ms / 1000) * 1000;
  const p = zonedParts(whole, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole;
}

/**
 * A wall-clock reading in `timeZone` -> UTC epoch ms.
 *
 * DST, decided rather than left to chance:
 *   - the fall-back hour happens twice; it reads as the EARLIER instant
 *     (daylight time), so 01:30 on 2026-11-01 is 06:30Z;
 *   - the spring-forward hour never happens; it reads with the offset in
 *     force just before the jump, so 02:30 on 2027-03-14 is 08:30Z, the
 *     same instant as 03:30 CDT.
 */
function zonedWallClockToUtc(wall, timeZone) {
  const naive = Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h || 0, wall.mi || 0, wall.s || 0, wall.ms || 0);
  // Central changes offset twice a year, never twice in two days, so the
  // offsets a day either side are the only two a reading can have.
  const before = zoneOffsetMs(naive - DAY_MS, timeZone);
  const after = zoneOffsetMs(naive + DAY_MS, timeZone);
  const valid = [...new Set([before, after])]
    .map((off) => naive - off)
    .filter((t) => zoneOffsetMs(t, timeZone) === naive - t);
  return valid.length ? Math.min(...valid) : naive - before;
}

// Serials for 1900-01-01 .. 9999-12-31. A number outside that is not a date
// cell (an epoch written as a number, say) and reads as no timestamp.
const SERIAL_MIN = 1;
const SERIAL_MAX = 2958465;

/** Excel serial -> wall-clock fields. Pure arithmetic in a UTC frame. */
function serialToWallClock(serial) {
  if (typeof serial !== 'number' || !Number.isFinite(serial)) return null;
  if (serial < SERIAL_MIN || serial > SERIAL_MAX) return null;
  const d = new Date(Math.round((serial - EXCEL_EPOCH_DAYS) * DAY_MS));
  if (isNaN(d)) return null;
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), ms: d.getUTCMilliseconds(),
  };
}

/**
 * Parse one sheet datetime cell as `timeZone` wall-clock time.
 *
 *   number                            an Excel serial (how the export writes it)
 *   "YYYY-MM-DD HH:MM[:SS[.fff]]"     wall-clock text, same zone
 *   the same with Z or +/-HH:MM       an explicit instant, taken as written
 *
 * Everything else is null: bad tokens, duration strings that have leaked
 * into timestamp columns before ("130 days 02:13:33"), month/day text that
 * cannot be read unambiguously, and Date objects - a Date here was built in
 * the host zone by the parser, which is exactly the error this exists to
 * remove, so it is refused rather than trusted.
 */
function parseSheetDateTime(v, timeZone = SHEET_TIME_ZONE) {
  if (v === null || v === undefined || v instanceof Date) return null;
  if (typeof v === 'number') {
    const w = serialToWallClock(v);
    return w ? new Date(zonedWallClockToUtc(w, timeZone)) : null;
  }
  const s = String(v).trim();
  if (isBad(s) || /^\d+\s+days?\b/i.test(s)) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
  if (!m) return null;
  const wall = {
    y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0),
    ms: m[7] ? +m[7].slice(0, 3).padEnd(3, '0') : 0,
  };
  if (wall.y < 1900 || wall.h > 23 || wall.mi > 59 || wall.s > 59) return null;
  // Date.UTC rolls 2026-02-31 into March; a date that does not survive the
  // round trip was never a real date.
  const check = new Date(Date.UTC(wall.y, wall.mo - 1, wall.d));
  if (check.getUTCFullYear() !== wall.y || check.getUTCMonth() !== wall.mo - 1 || check.getUTCDate() !== wall.d) return null;
  if (m[8]) {
    const z = m[8].toUpperCase();
    const off = z === 'Z' ? 0 : (z[0] === '-' ? -1 : 1) * (+z.slice(1, 3) * 60 + +z.slice(-2)) * 60000;
    return new Date(Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s, wall.ms) - off);
  }
  return new Date(zonedWallClockToUtc(wall, timeZone));
}

/**
 * The calendar date of an instant in `timeZone`, as YYYY-MM-DD. The daily
 * record's snapshot date is this, not an ISO slice: an export at 19:30 CDT is
 * 00:30Z the next day, and slicing would file it under the wrong date.
 */
function zonedDate(v, timeZone = SHEET_TIME_ZONE) {
  const d = v instanceof Date ? v : v ? new Date(v) : null;
  if (!d || isNaN(d)) return null;
  const p = zonedParts(d.getTime(), timeZone);
  return p.year + '-' + String(p.month).padStart(2, '0') + '-' + String(p.day).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// Consolidated workbook: rows
// ---------------------------------------------------------------------------

/**
 * Location arrives as a NUMBER (6197). PROPERTIES codes are strings, and a
 * number never equals a string: compared raw, roomstatus would partition into
 * zero rows and heartbeatstatus would lose every Location and CurrentTime
 * without a sound. So it becomes a 4-digit string before anything compares it.
 */
function locationCode(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') {
    return Number.isInteger(v) && v >= 0 && v <= 9999 ? String(v).padStart(4, '0') : null;
  }
  const m = /^(\d{1,4})(?:\.0+)?$/.exec(String(v).trim());
  return m ? m[1].padStart(4, '0') : null;
}

const DEVICE_ID_RE = /^[0-9a-f]{24}$/i;

// Spreadsheet error values. In DeviceId they mean the lookup formula broke,
// which is not the same statement as "no device" and must not read as one.
const SHEET_ERROR_RE = /^#(?:n\/a|value!|ref!|div\/0!|name\?|null!|num!|error!|spill!|calc!|getting_data)$/i;

/**
 * One roomstatus DeviceId cell. Blank - including the "" a lookup formula
 * returns when heartbeatstatus has no row for the room - means no device.
 * Anything else must be a 24-hex Particle id; ids are hex, so case is
 * normalised. A value that is not an id - a spreadsheet error included - is
 * kept for the finding (F3) and never joined on.
 */
function readDeviceIdCell(v) {
  const text = v === null || v === undefined ? '' : String(v).trim();
  if (SHEET_ERROR_RE.test(text)) return { id: null, raw: text, problem: 'sheet error' };
  const s = normStr(v);
  if (!s) return { id: null, raw: null, problem: null };
  if (!DEVICE_ID_RE.test(s)) return { id: null, raw: s, problem: 'malformed' };
  return { id: s.toLowerCase(), raw: s, problem: null };
}

/** A device id from a telemetry tab: lowercased when it is one, kept as-is when not. */
function telemetryDeviceId(v) {
  const s = normStr(v);
  if (!s) return null;
  return DEVICE_ID_RE.test(s) ? s.toLowerCase() : s;
}

const isBlankRow = (r) => Object.values(r).every((v) => v === null || v === undefined || String(v).trim() === '');
// sheet_to_json tags every row with its 0-based sheet index; blank rows it
// skips would otherwise shift a counted index off the real sheet row.
const sheetRowOf = (r, fallback) => (Number.isInteger(r.__rowNum__) ? r.__rowNum__ + 1 : fallback);

/** A header matched by pattern, never by exact string: several carry a date suffix or a trailing space. */
const headerKey = (headers, re) => headers.find((h) => re.test(String(h).trim())) || null;

/** The 0-based column whose header cell reads exactly `header`, or -1. */
function headerColumn(ws, headerRow, header) {
  if (!ws || !ws['!ref'] || !header) return -1;
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: headerRow, c })];
    if (cell && String(cell.v) === header) return c;
  }
  return -1;
}

/**
 * sheet_to_json turns an error cell (#REF!, #VALUE!) into null, so a broken
 * lookup would read as a blank. Put the error text back in one column.
 */
function restoreErrorCells(ws, rows, headerRow, header) {
  const col = headerColumn(ws, headerRow, header);
  if (col < 0) return;
  for (const r of rows) {
    if (!Number.isInteger(r.__rowNum__)) continue;
    const cell = ws[XLSX.utils.encode_cell({ r: r.__rowNum__, c: col })];
    if (cell && cell.t === 'e') r[header] = cell.w || '#ERROR!';
  }
}

/**
 * What each row's DeviceId cell is, by sheet row index: 'formula' (the
 * sheet's two-key lookup of heartbeatstatus, which follows every re-export),
 * 'typed' (a value typed over it, which never does), or 'empty' (no formula
 * and nothing in it). The workbook is read with SheetJS's default
 * cellFormula, which keeps each formula on its cell: `f` on a formula's own
 * cell, and only `F` (the range) on the other cells of a multi-cell array
 * formula, so either one makes a formula. Nothing is inferred from the
 * formula's text: a formula is a formula.
 */
function deviceIdCellKinds(ws, rows, headerRow, header) {
  const kinds = new Map();
  const col = headerColumn(ws, headerRow, header);
  if (col < 0) return kinds;
  for (const r of rows) {
    if (!Number.isInteger(r.__rowNum__)) continue;
    const cell = ws[XLSX.utils.encode_cell({ r: r.__rowNum__, c: col })];
    const typed = cell && cell.v !== null && cell.v !== undefined && String(cell.v).trim() !== '';
    kinds.set(r.__rowNum__, cell && (cell.f || cell.F) ? 'formula' : typed ? 'typed' : 'empty');
  }
  return kinds;
}

/**
 * One tab: its header row checked (fatal when a required header is missing),
 * then its data rows. For roomstatus, DeviceId keeps any error text, and
 * deviceIdCells says which of its cells are formulas.
 */
function readSheetTab(ws, name, headerRow) {
  const headers = (XLSX.utils.sheet_to_json(ws, { header: 1, range: headerRow, defval: null, raw: true })[0] || [])
    .filter((h) => h !== null)
    .map(String);
  const K = requireHeaders(name, headers);
  const rows = XLSX.utils.sheet_to_json(ws, { range: headerRow, defval: null, raw: true });
  if (name !== 'roomstatus') return { K, rows };
  restoreErrorCells(ws, rows, headerRow, K.deviceId);
  return { K, rows, deviceIdCells: deviceIdCellKinds(ws, rows, headerRow, K.deviceId) };
}

/**
 * Required headers, per tab. A missing one is structural and fails the build.
 * `Device# ` is deliberately absent: the display name comes from Particle by
 * id (D8), so that column is never read.
 */
const REQUIRED_HEADERS = {
  roomstatus: {
    location: /^location$/i,
    room: /^rooms?$/i,
    deviceId: /^deviceid$/i,
    status: /^status$/i,
    action: /^action item/i,
    notes: /^notes/i,
    battery: /^battery status/i,
    calibration: /^calibration risk/i,
  },
  batterystatus: {
    deviceId: /^particledeviceid$/i,
    lastTimestamp: /^lasttimestamp$/i,
  },
  heartbeatstatus: {
    deviceId: /^particledeviceid$/i,
    currentTime: /^currenttime$/i,
    location: /^location$/i,
  },
};

function requireHeaders(tab, headers) {
  const want = REQUIRED_HEADERS[tab];
  const K = {};
  const missing = [];
  for (const [field, re] of Object.entries(want)) {
    K[field] = headerKey(headers, re);
    if (!K[field]) missing.push(re.toString());
  }
  if (missing.length) {
    throw new Error(
      `NORMALIZE FAILED: tab "${tab}" is missing required header(s): ${missing.join(', ')}\n` +
        `  headers seen: ${headers.map((h) => JSON.stringify(h)).join(' | ')}\n` +
        `  A renamed column will do this. Refusing to build on a guess.`
    );
  }
  return K;
}

/**
 * roomstatus data rows -> records. Row 1 is a banner and row 2 the header, so
 * data starts on row 3. cellKinds is readSheetTab's deviceIdCells; without it
 * each row's deviceIdCell is null (unknown), never guessed.
 */
function parseRoomstatusRows(rawRows, K, cellKinds = null) {
  const rows = [];
  let blank = 0;
  rawRows.forEach((r, i) => {
    if (isBlankRow(r)) {
      blank++;
      return;
    }
    const cell = readDeviceIdCell(r[K.deviceId]);
    rows.push({
      sheetRow: sheetRowOf(r, i + 3),
      location: locationCode(r[K.location]),
      locationRaw: r[K.location] === undefined ? null : r[K.location],
      room: normRoom(r[K.room]),
      deviceId: cell.id,
      deviceIdRaw: cell.raw,
      deviceIdProblem: cell.problem,
      deviceIdCell: (cellKinds && Number.isInteger(r.__rowNum__) && cellKinds.get(r.__rowNum__)) || null,
      status: normStr(r[K.status]),
      actionItem: normStr(r[K.action]),
      notes: normStr(r[K.notes]),
      battery: normNum(r[K.battery]),
      calibrationRisk: normStr(r[K.calibration]),
    });
  });
  return { rows, blank };
}

function parseBatteryRows(rawRows, K, timeZone = SHEET_TIME_ZONE) {
  return rawRows
    .map((r, i) => ({ r, sheetRow: sheetRowOf(r, i + 2) }))
    .filter(({ r }) => !isBlankRow(r))
    .map(({ r, sheetRow }) => ({
      sheetRow,
      deviceId: telemetryDeviceId(r[K.deviceId]),
      lastTimestamp: parseSheetDateTime(r[K.lastTimestamp], timeZone),
    }));
}

function parseHeartbeatRows(rawRows, K, timeZone = SHEET_TIME_ZONE) {
  return rawRows
    .map((r, i) => ({ r, sheetRow: sheetRowOf(r, i + 2) }))
    .filter(({ r }) => !isBlankRow(r))
    .map(({ r, sheetRow }) => ({
      sheetRow,
      deviceId: telemetryDeviceId(r[K.deviceId]),
      location: locationCode(r[K.location]),
      currentTime: parseSheetDateTime(r[K.currentTime], timeZone),
    }));
}

/**
 * Split roomstatus rows by Location.
 *
 * Out-of-scope rows - a Location that is blank, unreadable, or not a
 * configured property - are dropped and returned for the log (D15). A row with
 * a configured Location but no room number is dropped and logged too, apart
 * from them, and is never fatal: D16 guards the partition, not room identity,
 * and a half-typed row in the sheet must not take the site down (Ian,
 * 2026-09-25). Neither kind is ever counted.
 *
 * Structural, and fatal:
 *   - D16: every in-scope row lands in exactly one property. This is the
 *     guard against the near-miss in CONSOLIDATION-FINDINGS §3.1, where every
 *     property received every row and all the counts still agreed.
 *   - a configured property with zero rows (checked after Location is a string).
 */
function partitionRoomRows(rows, properties) {
  const codes = new Set(properties.map((p) => p.code));
  const inScope = [];
  const outOfScope = [];
  const noRoom = [];
  for (const r of rows) {
    const reason = !r.location
      ? 'blank or unreadable Location'
      : !codes.has(r.location)
        ? 'Location ' + r.location + ' is not a configured property'
        : null;
    if (reason) {
      outOfScope.push({ sheetRow: r.sheetRow, location: r.locationRaw, room: r.room ? r.room.display : null, reason });
    } else if (!r.room) {
      noRoom.push({ sheetRow: r.sheetRow, location: r.location, status: r.status, deviceId: r.deviceId });
    } else {
      inScope.push(r);
    }
  }

  const landed = new Map(inScope.map((r) => [r, 0]));
  const byProperty = new Map();
  let placed = 0;
  for (const p of properties) {
    const mine = inScope.filter((r) => r.location === p.code);
    for (const r of mine) landed.set(r, landed.get(r) + 1);
    placed += mine.length;
    byProperty.set(p.code, mine.map((r) => ({ ...r, property: p.code })));
  }
  const strays = inScope.filter((r) => landed.get(r) !== 1);
  if (strays.length || placed !== inScope.length) {
    throw new Error(
      `NORMALIZE FAILED (D16): ${inScope.length} in-scope roomstatus rows were placed ${placed} times.\n` +
        `  Every row must land in exactly one property. ${strays.length} did not, e.g. sheet row(s) ` +
        strays.slice(0, 5).map((r) => r.sheetRow + ' (' + r.location + '/' + (r.room ? r.room.display : '?') +
          ', ' + landed.get(r) + 'x)').join(', ') + '.\n' +
        `  Check config.js PROPERTIES for a duplicated code. Refusing to build a fleet that counts rooms twice.`
    );
  }
  const empty = properties.filter((p) => !(byProperty.get(p.code) || []).length).map((p) => p.code);
  if (empty.length) {
    throw new Error(
      `NORMALIZE FAILED: no roomstatus rows for configured propert${empty.length === 1 ? 'y' : 'ies'} ${empty.join(', ')}.\n` +
        `  A property with no rows looks exactly like a property with nothing wrong.\n` +
        `  Check the sheet's Location column and config.js PROPERTIES.`
    );
  }
  return { byProperty, inScope, outOfScope, noRoom };
}

/** batterystatus by device id. The first row wins, as the sheet's own MATCH() lookup does. */
function batteryIndex(batRows) {
  const byDevice = new Map();
  const rowsById = new Map();
  for (const b of batRows) {
    if (!b.deviceId) continue;
    if (!rowsById.has(b.deviceId)) rowsById.set(b.deviceId, []);
    rowsById.get(b.deviceId).push(b.sheetRow);
    if (!byDevice.has(b.deviceId)) byDevice.set(b.deviceId, b);
  }
  const duplicates = [...rowsById].filter(([, v]) => v.length > 1).map(([deviceId, sheetRows]) => ({ deviceId, sheetRows }));
  return { byDevice, duplicates };
}

/**
 * heartbeatstatus is secondary: it supplies each property's "sheet export as
 * of" stamp and a fallback attribution for unmapped devices, never an
 * assignment. None of its oddities fail the build; each is returned as a
 * finding (D5).
 */
function heartbeatIndex(hbRows, codes) {
  const locationsById = new Map();
  const rowsById = new Map();
  const stamps = new Map(codes.map((c) => [c, []]));
  for (const h of hbRows) {
    if (h.location && stamps.has(h.location) && h.currentTime) stamps.get(h.location).push(h.currentTime);
    if (!h.deviceId) continue;
    if (!rowsById.has(h.deviceId)) rowsById.set(h.deviceId, []);
    rowsById.get(h.deviceId).push(h);
    if (h.location) {
      if (!locationsById.has(h.deviceId)) locationsById.set(h.deviceId, new Set());
      locationsById.get(h.deviceId).add(h.location);
    }
  }
  // Nulls are ignored; a property with no stamp at all is unknown (null).
  // Rows of one Location should share one CurrentTime. If they ever do not,
  // the latest is kept and the spread is reported.
  const currentTimeByProperty = new Map();
  const currentTimeSpread = [];
  for (const [code, list] of stamps) {
    const distinct = [...new Set(list.map((d) => d.getTime()))].sort((a, b) => a - b);
    currentTimeByProperty.set(code, distinct.length ? new Date(distinct[distinct.length - 1]) : null);
    if (distinct.length > 1) currentTimeSpread.push({ property: code, values: distinct.map((t) => new Date(t).toISOString()) });
  }
  return {
    locationsById,
    currentTimeByProperty,
    duplicateIds: [...rowsById].filter(([, v]) => v.length > 1)
      .map(([deviceId, v]) => ({ deviceId, sheetRows: v.map((h) => h.sheetRow), locations: v.map((h) => h.location) })),
    multiLocationIds: [...locationsById].filter(([, s]) => s.size > 1)
      .map(([deviceId, s]) => ({ deviceId, locations: [...s].sort() })),
    currentTimeSpread,
  };
}

/**
 * A room's heartbeat, from Particle by id. A blank DeviceId is "no device",
 * which is not the same statement as "never" (D11): never is a device the
 * sheet names that Particle has never heard, does not know, or that is not a
 * device id at all (F3).
 */
const NO_DEVICE_BUCKET = THRESHOLDS.heartbeatAge.noDeviceBucket.key;

/**
 * One Particle device's heartbeat as of builtAt: when it was last heard, how
 * many days ago, and its bucket. No device, or a last_heard that cannot be
 * read, is never heard. A room and a note-named unit are bucketed by this one
 * function, so the two can never disagree about the same device.
 */
function deviceHeartbeat(device, builtAt) {
  const heard = device && device.last_heard ? new Date(device.last_heard) : null;
  const reporting = Boolean(heard && !isNaN(heard));
  const daysSilent = reporting ? (builtAt - heard) / DAY_MS : null;
  return {
    reporting,
    lastHeartbeat: reporting ? heard : null,
    daysSilent,
    bucket: bucketByDays(daysSilent, THRESHOLDS.heartbeatAge),
  };
}

function roomHeartbeat(row, devicesById, builtAt) {
  const deviceId = row.deviceId || null;
  const api = deviceId ? devicesById.get(deviceId) || null : null;
  const hb = deviceHeartbeat(api, builtAt);
  const noDevice = !deviceId && !row.deviceIdProblem;
  return {
    deviceId,
    // D8: the display name is Particle's, by id. The sheet's Device# text is
    // never read, and no name is ever resolved into an assignment.
    deviceName: api && api.name ? String(api.name) : null,
    known: Boolean(api),
    reporting: hb.reporting,
    lastHeartbeat: hb.lastHeartbeat,
    daysSilent: hb.daysSilent,
    bucket: noDevice ? NO_DEVICE_BUCKET : hb.bucket,
  };
}

// ---------------------------------------------------------------------------
// Validators (D5): each returns findings and never throws
// ---------------------------------------------------------------------------

const shortId = (id) => (id ? String(id).slice(-6) : null);
const nameOf = (devicesById, id) => {
  const d = id && devicesById ? devicesById.get(id) : null;
  return d && d.name ? String(d.name) : null;
};
const roomOf = (r) => (r && r.room ? r.room.display : null);

/** F1: one device id in two or more rooms, within a property or across properties. */
function findDuplicateDevices(rows, devicesById) {
  const byId = new Map();
  for (const r of rows || []) {
    if (!r || !r.deviceId) continue;
    if (!byId.has(r.deviceId)) byId.set(r.deviceId, new Map());
    const key = r.property + '|' + (r.room ? r.room.key : '');
    if (!byId.get(r.deviceId).has(key)) byId.get(r.deviceId).set(key, { property: r.property, room: roomOf(r) });
  }
  const out = [];
  for (const [deviceId, rooms] of byId) {
    if (rooms.size < 2) continue;
    const list = [...rooms.values()];
    out.push({
      flag: 'F1',
      deviceId,
      deviceIdShort: shortId(deviceId),
      deviceName: nameOf(devicesById, deviceId),
      crossProperty: new Set(list.map((x) => x.property)).size > 1,
      rooms: list,
    });
  }
  return out;
}

/**
 * F2: a row's Location disagrees with the live-property esa_ tag on its
 * device. Only tagged devices can be checked, so coverage is returned with
 * the findings - at 9502 most devices carry no tag, and an empty list there
 * means "could not look", not "nothing wrong".
 */
function findLocationTagConflicts(rows, devicesById, liveCodes) {
  const findings = [];
  const coverage = {};
  for (const r of rows || []) {
    if (!r || !r.deviceId) continue;
    const c = coverage[r.property] || (coverage[r.property] = {
      deviceRows: 0, checkable: 0, untagged: 0, untaggedBaseline: 0, unknownToParticle: 0, conflictingTags: 0, pctCheckable: null,
    });
    c.deviceRows++;
    const d = devicesById ? devicesById.get(r.deviceId) : null;
    if (!d) {
      c.unknownToParticle++;
      continue;
    }
    const info = liveTagInfo(d, liveCodes);
    // Tags for two different live properties: there is no one property to
    // compare Location with, so the row cannot be checked (logged elsewhere).
    if (info.conflict) {
      c.conflictingTags++;
      continue;
    }
    const tag = info.tag;
    if (!tag) {
      c.untagged++;
      if (groupsOf(d).some((g) => /^baseline_/i.test(g))) c.untaggedBaseline++;
      continue;
    }
    c.checkable++;
    if (tag.code !== r.property) {
      findings.push({
        flag: 'F2',
        property: r.property,
        room: roomOf(r),
        sheetRow: r.sheetRow,
        deviceId: r.deviceId,
        deviceIdShort: shortId(r.deviceId),
        deviceName: d.name ? String(d.name) : null,
        group: tag.group,
        tagProperty: tag.code,
      });
    }
  }
  for (const c of Object.values(coverage)) c.pctCheckable = c.deviceRows ? round((100 * c.checkable) / c.deviceRows, 1) : null;
  return { findings, coverage };
}

/** F3: a DeviceId that is not a 24-hex id, or that Particle does not know. The room buckets as never. */
function findDeviceIdProblems(rows, devicesById) {
  const out = [];
  for (const r of rows || []) {
    if (!r) continue;
    if (r.deviceIdProblem) {
      const reason = r.deviceIdProblem === 'sheet error' ? 'spreadsheet error' : 'not a device id';
      out.push({ flag: 'F3', property: r.property, room: roomOf(r), sheetRow: r.sheetRow, reason, value: r.deviceIdRaw });
    } else if (r.deviceId && !(devicesById && devicesById.has(r.deviceId))) {
      out.push({ flag: 'F3', property: r.property, room: roomOf(r), sheetRow: r.sheetRow, reason: 'unknown to Particle', value: r.deviceId });
    }
  }
  return out;
}

/**
 * F4's note grammar, exactly as CUTOVER.md §5 (D6). Three phrasings name a
 * unit; "Replaced device" names none and is reported on its own. Battery and
 * showerhead work ("Replaced batteries recently", "Showerhead replaced") match
 * none of them. Notes are free text: this parse only ever produces a FINDING,
 * never an assignment.
 */
const NOTE_UNIT = /P\d?-?\d+/.source;
const NOTE_PHRASES = [
  { kind: 'replaced with', re: new RegExp('\\breplaced\\s+with\\s+(' + NOTE_UNIT + ')\\b', 'i') },
  { kind: 'installed', re: new RegExp('\\b(' + NOTE_UNIT + ')\\s+installed\\b', 'i') },
  { kind: 'correct device is', re: new RegExp('\\bcorrect\\s+device\\b[^.]*?\\bis\\s+(' + NOTE_UNIT + ')\\b', 'i') },
];
const NOTE_UNNAMED = /\breplaced\s+device\b/i;

function parseReplacementNote(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  for (const p of NOTE_PHRASES) {
    const m = p.re.exec(text);
    if (m) return { kind: p.kind, name: m[1] };
  }
  return NOTE_UNNAMED.test(text) ? { kind: 'unnamed', name: null } : null;
}

/**
 * A note's unit name -> exactly one Particle device, by exact, trimmed,
 * case-insensitive name. Never by digits: "P2-0823" does not become
 * "P-0823" - a digits-only match is how the wrong unit gets named.
 */
function resolveNamedUnit(name, devicesByName) {
  const key = name === null || name === undefined ? '' : String(name).trim().toLowerCase();
  const hits = (key && devicesByName && devicesByName.get(key)) || [];
  if (hits.length === 1) return { device: hits[0], problem: null, matches: 1 };
  return { device: null, problem: hits.length ? 'ambiguous name' : 'no exact Particle name', matches: hits.length };
}

/**
 * The unit a note names, as Particle's list has it: its id, its name as
 * Particle writes it, and whether it is reporting - the bucket and age a room
 * holding it would show (deviceHeartbeat). All null when the name resolves to
 * no device or to several: there is no one unit to describe.
 */
function namedUnitOf(device, builtAt) {
  if (!device) return { namedDeviceId: null, namedDeviceName: null, namedHeartbeatBucket: null, namedDaysSilent: null };
  const hb = deviceHeartbeat(device, builtAt);
  return {
    namedDeviceId: device.id,
    namedDeviceName: device.name ? String(device.name) : null,
    namedHeartbeatBucket: hb.bucket,
    namedDaysSilent: round(hb.daysSilent, 1),
  };
}

/**
 * F4: a note names a replacement that the DeviceId column does not show.
 * Each finding carries the named unit (namedUnitOf, measured against builtAt,
 * as rooms are) and the room's DeviceId cell kind, for the backfill list: a
 * typed cell is corrected in the sheet, a formula in what it looks up.
 */
function findNoteReplacementConflicts(rows, devicesByName, builtAt) {
  const findings = [];
  const unnamed = [];
  let recognised = 0;
  for (const r of rows || []) {
    const p = r ? parseReplacementNote(r.notes) : null;
    if (!p) continue;
    recognised++;
    const base = { flag: 'F4', property: r.property, room: roomOf(r), sheetRow: r.sheetRow, note: r.notes };
    const cell = { deviceIdCell: r.deviceIdCell || null };
    if (p.kind === 'unnamed') {
      unnamed.push({ ...base, kind: p.kind, deviceId: r.deviceId || null, ...cell });
      continue;
    }
    const res = resolveNamedUnit(p.name, devicesByName);
    if (!res.device) {
      findings.push({
        ...base, kind: p.kind, namedUnit: p.name, ...namedUnitOf(null), reason: res.problem, deviceId: r.deviceId || null, ...cell,
      });
      continue;
    }
    if (r.deviceId && r.deviceId === String(res.device.id).toLowerCase()) continue; // the sheet agrees
    findings.push({
      ...base,
      kind: p.kind,
      namedUnit: p.name,
      ...namedUnitOf(res.device, builtAt),
      reason: r.deviceId ? 'DeviceId shows another unit' : r.deviceIdProblem ? 'DeviceId is not a device id' : 'DeviceId is blank',
      deviceId: r.deviceId || null,
      ...cell,
    });
  }
  return { findings, unnamed, recognised };
}

/**
 * D7: notes that name an out-of-scope site. A finding for the build log only;
 * the note still renders as written, because it is what a person wrote about
 * that room. Names are matched exactly as written, as render.js matches them
 * in structured fields.
 */
function findNotesNamingOutOfScope(rows, names) {
  const out = [];
  for (const r of rows || []) {
    if (!r || typeof r.notes !== 'string') continue;
    const hit = (names || []).filter((n) => r.notes.includes(n));
    if (hit.length) out.push({ property: r.property, room: roomOf(r), sheetRow: r.sheetRow, names: hit });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Findings: what the page shows, and what only the log carries
// ---------------------------------------------------------------------------

/**
 * The split D7 draws. Page findings are the sheet conflicts a person can act
 * on from the dashboard: F1-F4 with their room references, and F2's coverage,
 * which says where F2 could not look. Log findings live in
 * data/normalized.json and the build log only - unplaced telemetry (D10),
 * dropped rows (D15, blank rooms), notes naming an out-of-scope site (D7),
 * devices tagged for two properties, sheet hygiene. render.js ships the first
 * list by name and fails the build if a key from the second reaches the page.
 */
const PAGE_FINDING_KEYS = ['f1', 'f2', 'f2Coverage', 'f3', 'f4', 'f4Unnamed', 'f4NotesRecognised'];
const LOG_FINDING_KEYS = [
  'unplacedTelemetry', 'conflictingTagDevices', 'outOfScopeRows', 'noRoomRows', 'blankRoomstatusRows',
  'notesNamingOutOfScope', 'sheetHygiene',
];

/**
 * Put each page finding on the room row it is about, as a code and a sentence
 * a person can read in a tooltip or a CSV cell. Every room gets a list, empty
 * when nothing is flagged.
 *
 * F2, F3 and F4 come from one sheet row each, and attach to that row by its
 * sheet row number - so of two rows for one room, only the row whose note or
 * DeviceId raised the finding is flagged. F1 is about a device: it attaches to
 * every row, in each room it names, that holds that device.
 */
function flagRooms(rooms, findings) {
  const f = findings || {};
  const bySheetRow = new Map();
  for (const r of rooms) {
    r.flags = [];
    if (Number.isInteger(r.sheetRow)) bySheetRow.set(r.sheetRow, r);
  }
  const shown = (r) => (r.deviceName ? r.deviceName : r.deviceId ? '…' + shortId(r.deviceId) : null);
  const deviceClause = (r) => (!r ? '' : r.deviceId ? 'DeviceId shows ' + shown(r) : 'DeviceId is blank');
  const put = (x, flag) => {
    const r = bySheetRow.get(x.sheetRow);
    if (r) r.flags.push(flag);
  };

  for (const x of f.f1 || []) {
    for (const here of x.rooms) {
      const others = x.rooms.filter((o) => o !== here);
      const away = others.filter((o) => o.property !== here.property).length;
      const where = ' is also listed in ' + others.map((o) => o.property + '/' + o.room).join(', ') +
        (!away ? '' : away === others.length ? ', another property' : ', including another property');
      for (const r of rooms) {
        if (r.property !== here.property || r.room !== here.room || r.deviceId !== x.deviceId) continue;
        r.flags.push({ code: 'F1', text: (x.deviceName || shown(r)) + where });
      }
    }
  }
  for (const x of f.f2 || []) {
    put(x, {
      code: 'F2',
      text: (x.deviceName || '…' + x.deviceIdShort) + ' is tagged ' + x.group + ' in Particle, which belongs to ' + x.tagProperty,
    });
  }
  for (const x of f.f3 || []) {
    const text = x.reason === 'spreadsheet error' ? 'DeviceId holds the spreadsheet error ' + x.value
      : x.reason === 'not a device id' ? 'DeviceId "' + x.value + '" is not a Particle device id'
        : 'DeviceId …' + shortId(x.value) + ' is not in the Particle product';
    put(x, { code: 'F3', text });
  }
  for (const x of f.f4 || []) {
    const r = bySheetRow.get(x.sheetRow);
    let text = 'note names ' + x.namedUnit;
    if (x.reason === 'no exact Particle name') {
      text += ', which matches no Particle device name exactly' + (r && r.deviceId ? '; ' + deviceClause(r) : '');
    } else if (x.reason === 'ambiguous name') {
      text += ', which several Particle devices share' + (r && r.deviceId ? '; ' + deviceClause(r) : '');
    } else if (x.reason === 'DeviceId is not a device id') {
      text += '; DeviceId is not a device id';
    } else {
      text += '; ' + deviceClause(r);
    }
    put(x, { code: 'F4', text });
  }
  // D6: the note that records a replacement without naming the unit is shown
  // apart from the 28. It carries the F4 code, marked unnamed, so the room is
  // not lost from an F4 filter while the F4 count stays the count of findings.
  for (const x of f.f4Unnamed || []) {
    const r = bySheetRow.get(x.sheetRow);
    put(x, { code: 'F4', unnamed: true, text: 'note records a replacement but names no unit; ' + deviceClause(r) });
  }
  return rooms;
}

// ---------------------------------------------------------------------------
// Attribution and live-but-unmapped (§6)
// ---------------------------------------------------------------------------

/**
 * Which live property an unmapped device belongs to: its live esa_ tag, or
 * else its heartbeatstatus Location. Never the registry, never a bare room
 * number. An untagged device heartbeatstatus places in more than one Location
 * is unattributable (D5b), as is one it places in none or outside the fleet.
 * So is a device tagged for two different live properties - and that one is
 * NOT then placed by Location: its own tags contradict each other, and the
 * export's opinion does not settle which is right.
 * Unattributable means neither listed nor counted anywhere.
 */
function attributeDevice(device, locationsById, liveCodes) {
  const info = liveTagInfo(device, liveCodes);
  if (info.conflict) return null;
  const tag = info.tag;
  if (tag) return { property: tag.code, via: 'tag', group: tag.group };
  const locs = device && locationsById ? locationsById.get(String(device.id).toLowerCase()) : null;
  if (!locs || locs.size !== 1) return null;
  const [code] = locs;
  return liveCodes.has(code) ? { property: code, via: 'exportLocation', group: null } : null;
}

/**
 * Live but unmapped: heard within the live window, held by no roomstatus row,
 * and attributable to a live property. The fleet figure is the sum of the
 * properties by construction - there is no unattributed pool any more (D3).
 */
function findLiveButUnmapped(devices, heldIds, locationsById, properties, builtAt, liveDays) {
  const liveCodes = new Set(properties.map((p) => p.code));
  const rows = [];
  const byProperty = {};
  let stale = 0;
  for (const d of devices || []) {
    if (!d || !d.id) continue;
    const id = String(d.id).toLowerCase();
    if (heldIds.has(id)) continue;
    const who = attributeDevice(d, locationsById, liveCodes);
    if (!who) continue;
    const heard = d.last_heard ? new Date(d.last_heard) : null;
    const age = heard && !isNaN(heard) ? (builtAt - heard) / DAY_MS : null;
    if (age === null || age > liveDays) {
      stale++;
      continue;
    }
    const prop = properties.find((p) => p.code === who.property);
    rows.push({
      property: prop.code,
      propertyName: prop.name,
      deviceName: d.name || null,
      deviceId: d.id,
      deviceIdShort: shortId(d.id),
      // The esa_ group the page has always shown; null when there is none.
      group: who.group || groupsOf(d).find((g) => /^esa[-_]\d{4}/i.test(g)) || null,
      // Every Particle group, so a device placed by export Location still
      // shows what it carries (baseline_* at 9502, typically).
      groups: groupsOf(d),
      attribution: who.via,
      lastHeard: d.last_heard || null,
      ageDays: round(age, 1),
    });
    byProperty[prop.code] = (byProperty[prop.code] || 0) + 1;
  }
  rows.sort((a, b) => (a.ageDays === null ? 1 : b.ageDays === null ? -1 : a.ageDays - b.ageDays));
  return { rows, byProperty, stale };
}

/**
 * Every Particle device tagged for two different live properties. A finding
 * for the build log only: such a device is unattributable, so it is never
 * listed or counted as live-but-unmapped, and F2 cannot check a room holding
 * it. heldByRoom says whether some roomstatus row names it.
 */
function findConflictingTagDevices(devices, heldIds, liveCodes) {
  const out = [];
  for (const d of devices || []) {
    if (!d || !d.id) continue;
    const info = liveTagInfo(d, liveCodes);
    if (!info.conflict) continue;
    const id = String(d.id).toLowerCase();
    out.push({
      deviceId: id,
      deviceIdShort: shortId(id),
      deviceName: d.name ? String(d.name) : null,
      groups: info.groups,
      conflict: info.conflict,
      heldByRoom: Boolean(heldIds && heldIds.has(id)),
      lastHeard: d.last_heard || null,
    });
  }
  return out;
}

/**
 * Unplaced telemetry (D10): battery or heartbeat rows for a device no room
 * holds. A finding for the build log, not a page list; the live, attributable
 * ones already appear in live-but-unmapped.
 */
function findUnplacedTelemetry(batRows, hbRows, heldIds, devicesById, locationsById, liveCodes) {
  const out = [];
  const add = (source, row) => {
    if (!row.deviceId || heldIds.has(row.deviceId)) return;
    const d = devicesById ? devicesById.get(row.deviceId) : null;
    out.push({
      source,
      sheetRow: row.sheetRow,
      deviceId: row.deviceId,
      deviceIdShort: shortId(row.deviceId),
      deviceName: d && d.name ? String(d.name) : null,
      groups: groupsOf(d),
      location: row.location || null,
      attribution: d ? attributeDevice(d, locationsById, liveCodes) : null,
      lastHeard: d ? d.last_heard || null : null,
    });
  };
  for (const b of batRows || []) add('batterystatus', b);
  for (const h of hbRows || []) add('heartbeatstatus', h);
  return out;
}

// ---------------------------------------------------------------------------
// Consolidated workbook: reader
// ---------------------------------------------------------------------------

// The SHEET_IDS key fetch.js writes as data/raw/consolidated.xlsx.
const SOURCE_KEY = 'consolidated';

/**
 * Read the three source tabs. Structure is checked first and is fatal: a
 * missing tab or a missing required header stops the build here.
 *
 * cellDates is OFF on purpose: timestamps must arrive as serials for
 * parseSheetDateTime, not as Dates SheetJS built in the host zone (D4).
 */
function readConsolidated() {
  const wb = readWorkbook(SOURCE_KEY, SOURCE_TABS, { cellDates: false });
  // roomstatus row 1 is a counter formula, not a header, and is never read.
  // Its header is row 2 (range: 1). The other tabs have theirs on row 1.
  const rs = readSheetTab(wb.Sheets.roomstatus, 'roomstatus', 1);
  const bs = readSheetTab(wb.Sheets.batterystatus, 'batterystatus', 0);
  const hs = readSheetTab(wb.Sheets.heartbeatstatus, 'heartbeatstatus', 0);
  return {
    rooms: parseRoomstatusRows(rs.rows, rs.K, rs.deviceIdCells),
    battery: parseBatteryRows(bs.rows, bs.K),
    heartbeat: parseHeartbeatRows(hs.rows, hs.K),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function normalize() {
  const builtAt = new Date();
  const particle = readParticleDevices();
  const liveCodes = new Set(PROPERTIES.map((p) => p.code));

  // Structure first. A missing tab or header, a property with no rows, or a
  // row that lands in more than one property (D16) stops the build here.
  // Rows outside the three properties are dropped and logged (D15).
  const src = readConsolidated();
  const part = partitionRoomRows(src.rooms.rows, PROPERTIES);
  const bat = batteryIndex(src.battery);
  const hb = heartbeatIndex(src.heartbeat, PROPERTIES.map((p) => p.code));

  // Every device id a room holds. Anything live in the API and absent from
  // this set is a candidate for live-but-unmapped.
  const heldIds = new Set(part.inScope.filter((r) => r.deviceId).map((r) => r.deviceId));
  const unknownToParticle = [];
  let joinAttempted = 0;
  let joinMatched = 0;

  const properties = [];
  const triage = [];
  const duplicateRoomRows = [];
  const notes = [];

  for (const prop of PROPERTIES) {
    // This property's "sheet export as of" (D5): heartbeatstatus.CurrentTime
    // for its Location, parsed as Central wall-clock time (D4). Null when the
    // export carries none for it - which the page reads as unknown.
    const currentTime = hb.currentTimeByProperty.get(prop.code) || null;
    const snapshotAgeDays = currentTime ? (builtAt - currentTime) / DAY_MS : null;

    const rooms = [];
    for (const t of part.byProperty.get(prop.code)) {
      // The whole room -> device chain: roomstatus.DeviceId, else no device.
      // Liveness and the display name are Particle's, by that id (D8).
      const h = roomHeartbeat(t, particle.byId, builtAt);
      if (h.deviceId) {
        joinAttempted++;
        if (h.known) joinMatched++;
        else {
          unknownToParticle.push({
            property: prop.code,
            propertyName: prop.name,
            room: t.room.display,
            deviceId: h.deviceId,
            deviceName: null,
          });
        }
      }

      // The voltage is roomstatus's own lookup of batterystatus. Its age is
      // batterystatus.LastTimestamp for the same device - by id, never by room.
      // Readings are collected intermittently and their timestamps are not
      // precise, so the page reports this age as approximate.
      const volts = t.battery;
      const batRec = h.deviceId ? bat.byDevice.get(h.deviceId) || null : null;
      const batteryTimestamp = batRec ? batRec.lastTimestamp : null;
      const batteryAgeDays = batteryTimestamp ? (builtAt - batteryTimestamp) / DAY_MS : null;

      rooms.push({
        property: prop.code,
        propertyName: prop.name,
        room: t.room.display,
        roomKey: t.room.key,
        // The roomstatus row this came from: how a finding finds its row.
        sheetRow: t.sheetRow,
        deviceName: h.deviceName,
        deviceId: h.deviceId,
        status: t.status || 'Unknown',
        reporting: h.reporting,
        lastHeartbeat: iso(h.lastHeartbeat),
        // Measured against build time, because the source is live.
        daysSilent: round(h.daysSilent, 1),
        // "noDevice" for a blank DeviceId, "never" for a device never heard
        // or not known - two statements, kept apart (D11).
        heartbeatBucket: h.bucket,
        battery: round(volts, 3),
        batteryClass: batteryClass(volts),
        batteryTimestamp: iso(batteryTimestamp),
        batteryAgeDays: round(batteryAgeDays, 1),
        actionItem: t.actionItem,
        actionType: actionType(t.actionItem),
        notes: t.notes,
        // Carried as text. How it is shown is a presentation choice, and no
        // savings figure is ever derived from it.
        calibrationRisk: t.calibrationRisk,
      });
    }

    // --- counts -----------------------------------------------------------
    const tallyBy = (arr, fn) =>
      arr.reduce((m, x) => {
        const k = fn(x);
        m[k] = (m[k] || 0) + 1;
        return m;
      }, {});

    // A room can legitimately occupy more than one row when its device was
    // swapped: each row carries its own action item and note. We keep every
    // row (they are separate pieces of triage) but record the duplication so
    // nobody reads a row count as a room count.
    const roomKeyCounts = new Map();
    for (const r of rooms) roomKeyCounts.set(r.roomKey, (roomKeyCounts.get(r.roomKey) || 0) + 1);
    for (const [key, count] of roomKeyCounts) {
      if (count < 2) continue;
      const dupRows = rooms.filter((r) => r.roomKey === key);
      duplicateRoomRows.push({
        property: prop.code,
        propertyName: prop.name,
        room: dupRows[0].room,
        count,
        entries: dupRows.map((r) => ({ status: r.status, actionItem: r.actionItem, notes: r.notes })),
      });
    }

    const statusCounts = tallyBy(rooms, (r) => r.status);
    const counts = {
      rooms: rooms.length,
      distinctRooms: roomKeyCounts.size,
      ok: statusCounts.Ok || 0,
      issue: statusCounts.Issue || 0,
      check: statusCounts.Check || 0,
      other: rooms.length - (statusCounts.Ok || 0) - (statusCounts.Issue || 0) - (statusCounts.Check || 0),
      reporting: rooms.filter((r) => r.reporting).length,
      silent: rooms.filter((r) => !r.reporting).length,
      // Rooms whose DeviceId is blank. Part of `silent`, but a different fact.
      noDevice: rooms.filter((r) => r.heartbeatBucket === NO_DEVICE_BUCKET).length,
    };

    const heartbeatHistogram = {};
    for (const b of THRESHOLDS.heartbeatAge.buckets) heartbeatHistogram[b.key] = 0;
    heartbeatHistogram[THRESHOLDS.heartbeatAge.neverBucket.key] = 0;
    heartbeatHistogram[NO_DEVICE_BUCKET] = 0;
    for (const r of rooms) heartbeatHistogram[r.heartbeatBucket] = (heartbeatHistogram[r.heartbeatBucket] || 0) + 1;

    const batteryHistogram = { ok: 0, warn: 0, critical: 0, unclassified: 0, unknown: 0 };
    for (const r of rooms) batteryHistogram[r.batteryClass] = (batteryHistogram[r.batteryClass] || 0) + 1;

    // Battery age drives the per-property freshness badge: heartbeats are
    // live at build time, so battery is the only thing that can go stale.
    const batteryAge = batteryAgeSummary(rooms, builtAt);

    if (counts.rooms !== counts.distinctRooms) {
      const dupList = duplicateRoomRows
        .filter((d) => d.property === prop.code)
        .map((d) => d.room)
        .join(', ');
      notes.push({
        property: prop.code,
        propertyName: prop.name,
        severity: 'warn',
        text:
          `roomstatus has ${counts.rooms} rows covering ${counts.distinctRooms} distinct rooms. ` +
          `Room(s) ${dupList} appear more than once, each row carrying a different action item. ` +
          `All rows are kept in the triage queue; counts here are row counts, not room counts.`,
      });
    }

    properties.push({
      code: prop.code,
      name: prop.name,
      tag: prop.tag,
      snapshot: {
        currentTime: iso(currentTime),
        // The Chicago calendar date of that stamp - what the daily record files it under.
        date: zonedDate(currentTime),
        ageDays: round(snapshotAgeDays, 1),
        bucket: bucketByDays(snapshotAgeDays, THRESHOLDS.snapshotFreshness),
      },
      counts,
      heartbeatHistogram,
      batteryHistogram,
      batteryAge,
      rooms,
    });

    for (const r of rooms) {
      if (r.status === 'Issue' || r.status === 'Check') triage.push(r);
    }
  }

  // -------------------------------------------------------------------------
  // Sheet findings (D5): flagged, never failed on
  // -------------------------------------------------------------------------
  const allRows = PROPERTIES.flatMap((p) => part.byProperty.get(p.code));
  const f2 = findLocationTagConflicts(allRows, particle.byId, liveCodes);
  const f4 = findNoteReplacementConflicts(allRows, particle.byName, builtAt);
  // Page findings (PAGE_FINDING_KEYS): F1-F4 with their rooms, and where F2
  // could not look. Each also lands on its room row as a flag.
  const findings = {
    f1: findDuplicateDevices(allRows, particle.byId),
    f2: f2.findings,
    f2Coverage: f2.coverage,
    f3: findDeviceIdProblems(allRows, particle.byId),
    f4: f4.findings,
    f4Unnamed: f4.unnamed,
    f4NotesRecognised: f4.recognised,
  };
  flagRooms(properties.flatMap((p) => p.rooms), findings);
  // Log-only findings (LOG_FINDING_KEYS; D7, D10, D15). They stay in this
  // file and the build log, and never reach the page payload.
  const logFindings = {
    unplacedTelemetry: findUnplacedTelemetry(src.battery, src.heartbeat, heldIds, particle.byId, hb.locationsById, liveCodes),
    conflictingTagDevices: findConflictingTagDevices(particle.devices, heldIds, liveCodes),
    outOfScopeRows: part.outOfScope,
    noRoomRows: part.noRoom,
    blankRoomstatusRows: src.rooms.blank,
    notesNamingOutOfScope: findNotesNamingOutOfScope(allRows, OUT_OF_SCOPE_NAMES),
    sheetHygiene: {
      heartbeatDuplicateIds: hb.duplicateIds,
      heartbeatMultiLocationIds: hb.multiLocationIds,
      currentTimeSpread: hb.currentTimeSpread,
      batteryDuplicateIds: bat.duplicates,
    },
  };

  // -------------------------------------------------------------------------
  // Fleet-level reconciliation against the Particle device list
  // -------------------------------------------------------------------------

  // The windows come from the confirmed heartbeat buckets so there is one
  // source of truth for what "fresh" and "live" mean on this page.
  const hbBuckets = THRESHOLDS.heartbeatAge.buckets;
  const freshDays = (hbBuckets.find((b) => b.key === 'fresh') || {}).maxDays || 2;
  const liveDays = (hbBuckets.find((b) => b.key === 'aging') || {}).maxDays || 7;

  // Live but unmapped (§6): heard within the live window, held by no room,
  // attributed by a live esa_ tag or else by heartbeatstatus.Location. A
  // device neither can place is not listed and not counted - which is what
  // keeps lab and out-of-scope hardware off the page, and why the fleet
  // figure is the sum of the properties.
  const lbu = findLiveButUnmapped(particle.devices, heldIds, hb.locationsById, PROPERTIES, builtAt, liveDays);

  if (unknownToParticle.length) {
    notes.push({
      property: null,
      propertyName: null,
      severity: 'warn',
      text:
        `${unknownToParticle.length} DeviceId(s) in roomstatus are absent from the Particle product ` +
        `device list entirely. The product holds every device ever claimed, so this should be zero; ` +
        `these rooms are bucketed as never-reporting and listed in reconciliation.`,
    });
  }

  const particleSummary = {
    pulledAt: particle.pulledAt,
    fleetDevices: particle.count,
    mappedDevices: heldIds.size,
    joinAttempted,
    joinMatched,
    joinRatePct: joinAttempted ? round((joinMatched / joinAttempted) * 100, 1) : null,
    unknownToParticle: unknownToParticle.length,
    freshWindowDays: freshDays,
    liveWindowDays: liveDays,
    unmappedLive: lbu.rows.length,
    unmappedLiveByGroup: lbu.byProperty,
    // Attributable only: an unattributable device is not counted here either.
    unmappedStale: lbu.stale,
  };

  // Triage order: worst first - Issue before Check, then longest silent.
  triage.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'Issue' ? -1 : 1;
    return (b.daysSilent ?? -1) - (a.daysSilent ?? -1);
  });

  const stamps = properties.map((p) => p.snapshot.currentTime).filter(Boolean).sort();
  const out = {
    builtAt: iso(builtAt),
    // Heartbeats are read live from the Particle API at build time, so this
    // single stamp covers the whole fleet.
    heartbeatsAsOf: iso(builtAt),
    // The OLDEST per-property "sheet export as of" (D5); null if none has one.
    sheetExportAsOf: stamps.length ? stamps[0] : null,
    particle: particleSummary,
    thresholds: THRESHOLDS,
    properties,
    triage,
    reconciliation: {
      duplicateRoomRows,
      unknownToParticle,
      liveButUnmapped: lbu.rows,
      notes,
    },
    // Shipped to the page by render.js, key by key (PAGE_FINDING_KEYS).
    findings,
    // Never shipped: the build log and this file only (D7).
    logFindings,
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  return out;
}

function report(data) {
  const pad = (s, n) => String(s).padEnd(n);
  const lpad = (s, n) => String(s).padStart(n);
  const nameOfId = (id) => {
    for (const p of data.properties) for (const r of p.rooms) if (r.deviceId === id && r.deviceName) return r.deviceName;
    return null;
  };

  console.log('NORMALIZE  per-property counts');
  console.log(
    `  ${pad('prop', 6)}${pad('name', 24)}${lpad('rooms', 6)}${lpad('Ok', 5)}${lpad('Issue', 6)}${lpad('Check', 6)}` +
      `${lpad('Unk', 5)}${lpad('rept', 6)}${lpad('silent', 7)}${lpad('noDev', 6)}  ${pad('battery age (med/oldest)', 26)}sheet export as of`
  );
  for (const p of data.properties) {
    const c = p.counts;
    const snap = p.snapshot.currentTime
      ? `${p.snapshot.date} (${p.snapshot.currentTime}, ${p.snapshot.ageDays}d)`
      : 'unknown';
    const ba = p.batteryAge;
    const baStr = ba.readings ? `${ba.medianDays}d / ${ba.oldestDays}d (${ba.bucket})` : 'no readings';
    console.log(
      `  ${pad(p.code, 6)}${pad(p.name.slice(0, 23), 24)}${lpad(c.rooms, 6)}${lpad(c.ok, 5)}${lpad(c.issue, 6)}` +
        `${lpad(c.check, 6)}${lpad(c.other, 5)}${lpad(c.reporting, 6)}${lpad(c.silent, 7)}${lpad(c.noDevice, 6)}  ${pad(baStr, 26)}${snap}`
    );
  }

  const tot = data.properties.reduce(
    (a, p) => ({
      rooms: a.rooms + p.counts.rooms,
      ok: a.ok + p.counts.ok,
      issue: a.issue + p.counts.issue,
      check: a.check + p.counts.check,
      other: a.other + p.counts.other,
    }),
    { rooms: 0, ok: 0, issue: 0, check: 0, other: 0 }
  );
  console.log(
    `  ${pad('TOTAL', 30)}${lpad(tot.rooms, 6)}${lpad(tot.ok, 5)}${lpad(tot.issue, 6)}${lpad(tot.check, 6)}${lpad(tot.other, 5)}`
  );
  console.log(`  triage queue rows (Issue + Check): ${data.triage.length}  [expect ${tot.issue + tot.check}]`);
  console.log(`  sheet export as of, oldest (header): ${data.sheetExportAsOf || 'unknown'}`);

  console.log('\nNORMALIZE  heartbeat-age histogram');
  for (const p of data.properties) {
    const h = p.heartbeatHistogram;
    console.log(`  ${pad(p.code, 6)}` + Object.entries(h).map(([k, v]) => `${k}=${v}`).join('  '));
  }

  console.log('\nNORMALIZE  battery distribution');
  for (const p of data.properties) {
    const b = p.batteryHistogram;
    console.log(`  ${pad(p.code, 6)}` + Object.entries(b).map(([k, v]) => `${k}=${v}`).join('  '));
  }

  const q = data.particle;
  const lum = data.reconciliation.liveButUnmapped;
  console.log('\nNORMALIZE  Particle join (heartbeat source)');
  console.log(`  device list pulled      : ${q.pulledAt}`);
  console.log(`  devices in product      : ${q.fleetDevices}`);
  console.log(`  distinct ids in rooms   : ${q.mappedDevices}`);
  console.log(`  join                    : ${q.joinMatched}/${q.joinAttempted} matched (${q.joinRatePct}%)`);
  console.log(`  unknown to Particle     : ${q.unknownToParticle}   [expect 0]`);
  console.log(`  live but unmapped (<=${q.liveWindowDays}d): ${q.unmappedLive}  = sum of properties ${JSON.stringify(q.unmappedLiveByGroup)}`);
  for (const u of lum) {
    console.log(
      `    ${pad(u.property, 6)}${pad(u.deviceName || '-', 10)}...${pad(u.deviceIdShort, 8)}${pad((u.groups || []).join('+') || '(no groups)', 34)}` +
        `${pad(u.attribution === 'tag' ? 'by tag' : 'by export Location', 20)}${u.ageDays}d`
    );
  }
  console.log(`  unmapped and stale (>${q.liveWindowDays}d), attributable: ${q.unmappedStale}  (count only, not listed)`);

  const f = data.findings;
  const where = (x) => `${x.property}/${x.room}`;
  console.log('\nNORMALIZE  sheet findings (flagged, never failed on)');
  console.log(`  F1 one device id in two or more rooms: ${f.f1.length}`);
  for (const x of f.f1) {
    console.log(`    ${x.deviceName || '-'} ...${x.deviceIdShort}  ${x.rooms.map((r) => r.property + '/' + r.room).join(', ')}` +
      `${x.crossProperty ? '  (cross-property)' : ''}`);
  }
  console.log(`  F2 Location vs live esa_ tag: ${f.f2.length}`);
  for (const x of f.f2) console.log(`    ${where(x)}  ${x.deviceName || '-'} ...${x.deviceIdShort}  ${x.group}`);
  console.log('  F2 coverage (device rows whose device carries a live esa_ tag):');
  for (const [code, c] of Object.entries(f.f2Coverage)) {
    console.log(
      `    ${pad(code, 6)}${c.checkable}/${c.deviceRows} = ${c.pctCheckable}%   untagged ${c.untagged}` +
        ` (${c.untaggedBaseline} baseline_*)   unknown to Particle ${c.unknownToParticle}` +
        (c.conflictingTags ? `   tagged for two properties ${c.conflictingTags}` : '')
    );
  }
  console.log(`  F3 DeviceId not an id, or unknown to Particle: ${f.f3.length}`);
  for (const x of f.f3) console.log(`    ${where(x)}  ${x.reason}: ${x.value}`);
  console.log(
    `  F4 note names a replacement DeviceId does not show: ${f.f4.length}` +
      `   (${f.f4NotesRecognised} notes recognised, incl. ${f.f4Unnamed.length} unnamed)`
  );
  const f4ByReason = {};
  for (const x of f.f4) f4ByReason[x.reason] = (f4ByReason[x.reason] || 0) + 1;
  console.log(`    by reason: ${JSON.stringify(f4ByReason)}`);
  for (const x of f.f4) {
    const shows = x.deviceId ? (nameOfId(x.deviceId) || '...' + String(x.deviceId).slice(-6)) : 'blank';
    const heard = !x.namedDeviceId ? '-' : x.namedDaysSilent === null ? 'never' : x.namedDaysSilent + 'd';
    console.log(
      `    ${pad(where(x), 11)}${pad(x.namedUnit, 9)}DeviceId ${pad(shows, 10)}${pad(x.reason, 29)}` +
        `named unit heard ${pad(heard, 7)}cell ${x.deviceIdCell || '?'}`
    );
  }
  for (const x of f.f4Unnamed) console.log(`    unnamed: ${where(x)}  ${JSON.stringify(x.note)}  cell ${x.deviceIdCell || '?'}`);
  const cells = [...f.f4, ...f.f4Unnamed].reduce((m, x) => ((m[x.deviceIdCell || '?'] = (m[x.deviceIdCell || '?'] || 0) + 1), m), {});
  console.log(`    DeviceId cells: ${JSON.stringify(cells)}  (typed and empty cells freeze: fix them in the sheet)`);

  // Everything below is log-only: data/normalized.json and this report, never the page (D7).
  const lf = data.logFindings;
  const ut = lf.unplacedTelemetry;
  const utDevices = [...new Set(ut.map((u) => u.deviceId))];
  const utBy = (s) => ut.filter((u) => u.source === s).length;
  console.log(
    `  unplaced telemetry (D10, log only): ${ut.length} rows (${utBy('batterystatus')} batterystatus + ` +
      `${utBy('heartbeatstatus')} heartbeatstatus), ${utDevices.length} devices no room holds`
  );
  for (const id of utDevices) {
    const rows = ut.filter((u) => u.deviceId === id);
    const u = rows[0];
    const a = u.attribution;
    const heard = u.lastHeard ? round((new Date(data.builtAt) - new Date(u.lastHeard)) / DAY_MS, 1) + 'd' : 'never';
    console.log(
      `    ${pad(u.deviceName || '-', 9)}...${pad(u.deviceIdShort, 8)}${pad(u.groups.join('+') || '(no group)', 34)}` +
        `${pad(a ? a.property + (a.via === 'tag' ? ' (tag)' : ' (export Location)') : 'unattributable', 24)}` +
        `heard ${pad(heard, 8)}${rows.map((r) => r.source.replace('status', '') + (r.location ? '@' + r.location : '')).join(', ')}`
    );
  }
  const ct = lf.conflictingTagDevices;
  console.log(`  devices tagged for two different live properties (unattributable, log only): ${ct.length}`);
  for (const x of ct) {
    console.log(
      `    ${pad(x.deviceName || '-', 9)}...${pad(x.deviceIdShort, 8)}${pad(x.groups.join('+'), 34)}` +
        `${x.heldByRoom ? 'held by a room (F2 cannot check it)' : 'in no room (not listed or counted)'}`
    );
  }
  console.log(`  out-of-scope roomstatus rows dropped (D15, log only): ${lf.outOfScopeRows.length}`);
  for (const o of lf.outOfScopeRows) console.log(`    sheet row ${o.sheetRow}  Location ${JSON.stringify(o.location)}  room ${o.room}  - ${o.reason}`);
  console.log(`  rows with a configured Location but no room number, dropped (log only, never fatal): ${lf.noRoomRows.length}`);
  for (const o of lf.noRoomRows) console.log(`    sheet row ${o.sheetRow}  Location ${o.location}  status ${o.status || '-'}  DeviceId ${o.deviceId || 'blank'}`);

  const nh = lf.notesNamingOutOfScope;
  console.log(`  notes naming an out-of-scope site (D7, log only; the note still renders): ${nh.length}`);
  for (const x of nh) console.log(`    ${pad(where(x), 11)}sheet row ${x.sheetRow}  names ${x.names.map((n) => JSON.stringify(n)).join(', ')}`);

  const sh = lf.sheetHygiene;
  console.log('  sheet hygiene (findings, not asserts):');
  console.log(
    `    heartbeatstatus ids on more than one row: ${sh.heartbeatDuplicateIds.length}` +
      (sh.heartbeatDuplicateIds.length
        ? '  (' + sh.heartbeatDuplicateIds.map((d) => '...' + d.deviceId.slice(-6) + ' ' + d.locations.join('+')).join('; ') + ')'
        : '')
  );
  console.log(
    `    heartbeatstatus ids in more than one Location: ${sh.heartbeatMultiLocationIds.length}` +
      (sh.heartbeatMultiLocationIds.length
        ? '  (' + sh.heartbeatMultiLocationIds.map((d) => '...' + d.deviceId.slice(-6) + ' ' + d.locations.join('+')).join('; ') + ')'
        : '')
  );
  console.log(`    properties with more than one CurrentTime: ${sh.currentTimeSpread.length}`);
  console.log(`    batterystatus ids on more than one row: ${sh.batteryDuplicateIds.length}`);

  const r = data.reconciliation;
  console.log('\nNORMALIZE  reconciliation summary');
  console.log(`  duplicated room rows : ${r.duplicateRoomRows.length}`);
  console.log(`  unknown to Particle : ${r.unknownToParticle.length}`);
  console.log(`  live but unmapped : ${r.liveButUnmapped.length}`);
  console.log(`  notes : ${r.notes.length}`);
  for (const n of r.notes) console.log(`    - [${n.property}/${n.severity}] ${n.text}`);

  console.log(`\nNORMALIZE  wrote ${path.relative(__dirname, OUT_FILE)}`);
}

/**
 * A compact, append-only record of one day's fleet state.
 *
 * Deliberately small - counts only, no room detail - because one of these is
 * committed per day forever and the point is trend lines, not an archive.
 * Roughly 500 bytes a day.
 */
function dailyRecord(data) {
  // v2 adds fields; it never changes or reorders the existing ones. History
  // files are an append-only series and a shape change would silently break
  // every trend drawn from the days either side of it.
  const q = data.particle || {};
  const hbB = data.thresholds.heartbeatAge.buckets;
  // Which histogram bucket counts as "live" - taken from config rather than
  // hardcoded, so retuning the cutoffs cannot quietly desync the series.
  const freshKey = (hbB.find((b) => b.maxDays === (q.freshWindowDays || 2)) || hbB[0]).key;
  const unmappedByGroup = q.unmappedLiveByGroup || {};

  const properties = {};
  let liveUnder2dTotal = 0;
  let unmappedLiveTotal = 0;
  for (const p of data.properties) {
    const c = p.counts;
    const liveUnder2d = p.heartbeatHistogram[freshKey] || 0;
    liveUnder2dTotal += liveUnder2d;
    const unmappedLive = unmappedByGroup[p.code] || 0;
    unmappedLiveTotal += unmappedLive;
    properties[p.code] = {
      rooms: c.rooms,
      ok: c.ok,
      issue: c.issue,
      check: c.check,
      reporting: c.reporting,
      silent: c.silent,
      // The Chicago calendar date of the export, not an ISO slice: an export
      // at 19:30 CDT is already tomorrow in UTC (D4, CUTOVER.md §7).
      snapshot: zonedDate(p.snapshot.currentTime),
      battery: p.batteryHistogram,
      // --- added in v2 -----------------------------------------------------
      liveUnder2d, // mapped rooms heard from within the fresh window
      unmappedLive, // live devices attributed here that no room holds
    };
  }
  return {
    date: data.builtAt.slice(0, 10),
    builtAt: data.builtAt,
    triageRows: data.triage.length,
    properties,
    // --- added in v2 ---------------------------------------------------------
    // Fleet unmappedLive IS the sum of the per-property figures as of the
    // cutover: a device no property can claim is not counted anywhere, so
    // there is no fleet-level pool (CUTOVER.md §6, D3). Records written
    // before the cutover carry the old pool and are left as recorded.
    liveUnder2d: liveUnder2dTotal,
    unmappedLive: unmappedLiveTotal,
  };
}

// normalize, report and dailyRecord are the pipeline's (build.js, snapshot.js);
// render.js and verify-live.js take PAGE_FINDING_KEYS and LOG_FINDING_KEYS.
// The rest is exported for test-cutover.js and test-page.js.
module.exports = {
  normalize, report, dailyRecord, OUT_FILE,
  locationCode, readDeviceIdCell, requireHeaders, readSheetTab, parseRoomstatusRows, parseBatteryRows, parseHeartbeatRows,
  partitionRoomRows, batteryIndex, heartbeatIndex, roomHeartbeat, NO_DEVICE_BUCKET,
  serialToWallClock, zonedWallClockToUtc, parseSheetDateTime, zonedDate, batteryAgeSummary,
  findDuplicateDevices, findLocationTagConflicts, findDeviceIdProblems, parseReplacementNote, resolveNamedUnit,
  findNoteReplacementConflicts, attributeDevice, findLiveButUnmapped, findUnplacedTelemetry, liveTagOf,
  liveTagInfo, findConflictingTagDevices, flagRooms, findNotesNamingOutOfScope, PAGE_FINDING_KEYS, LOG_FINDING_KEYS,
};

if (require.main === module) {
  try {
    report(normalize());
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

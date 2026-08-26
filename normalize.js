'use strict';

/**
 * Stage 2 of the pipeline: merge registry + telemetry + triage into one
 * clean data/normalized.json, plus the reconciliation lists.
 *
 * Four sources disagree with each other on purpose:
 *   - Room Status          what a human last decided about a room
 *   - Particle API         when each device was actually last heard (v2)
 *   - py_export_*          battery voltages, and the room<->device mapping
 *   - registry tabs        what we believe we installed
 * Reconciliation is where those disagreements get written down instead of
 * silently resolved.
 *
 * v2 changed where liveness comes from. Heartbeats are now the Particle
 * device list, read fresh at build time, so days-silent means "vs now" and
 * no longer "vs whenever this property was last exported". Battery, rooms
 * and triage status still come from the sheets: the probe proved battery is
 * not in the Cloud API and no room identifier ever appears in one.
 *
 * Everything that leaves this file is already normalized: no "NA", no
 * "#N/A", no "No device in room", no 102.0, no raw Date objects.
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { PROPERTIES, THRESHOLDS, EXCLUDED_REGISTRY_TABS, PARTICLE } = require('./config');
const PARTICLE_PRODUCT_ID = PARTICLE.productId;
// The override is a committed source file, not fetched data, so it is read
// through fetch.js's validator rather than from data/raw/. That way
// `node normalize.js` reflects an edit to it immediately, without spending
// 13 network requests on a re-fetch just to see the effect.
const { loadRoomOverrides } = require('./fetch');

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

function normDate(v) {
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (isBad(s)) return null;
  // Guard against duration strings like "242 days 07:46:38.018342" that
  // have leaked into timestamp columns in at least one export.
  if (/^\d+\s+days?\b/i.test(s)) return null;
  const d = new Date(s);
  return isNaN(d) ? null : d;
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

function readWorkbook(key, requiredSheets = []) {
  const file = path.join(RAW_DIR, `${key}.xlsx`);
  if (!fs.existsSync(file)) {
    throw new Error(`NORMALIZE FAILED: missing ${file}\n  Run fetch.js first (or let build.js do it).`);
  }
  let wb;
  try {
    wb = XLSX.readFile(file, { cellDates: true });
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

const WO_SHEETS = ['Room Status', 'py_export_batterystatus', 'py_export_heartbeatstatus'];

const sheetRows = (wb, name) =>
  XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null, raw: true });

const sheetHeaders = (wb, name) =>
  (XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null, raw: true })[0] || [])
    .filter((h) => h !== null)
    .map(String);

/**
 * Room Status headers embed a snapshot date that differs per property
 * ("Battery Status            [Jun 12, 2026]"), and 6197's device column
 * has a trailing space. So every column is found by pattern, never by
 * exact string or position.
 */
function findKey(row, re) {
  return Object.keys(row).find((k) => re.test(k.trim())) || null;
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
  // Device NAME index, for the room-assignment override - that file keys on
  // the name a person reads off a unit in a corridor, not on a 24-hex id.
  // Names are not guaranteed unique by Particle, so every device is kept and
  // ambiguity is only an error if an override actually asks for that name.
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

/** First esa_#### / esa-#### group on a device, as a bare property code. */
function particleGroupCode(device) {
  for (const g of device.groups || []) {
    const m = /^esa[-_](\d{4})/i.exec(String(g));
    if (m) return { code: m[1], group: g };
  }
  return null;
}

/**
 * Device IDs that are deliberately out of scope: the lab bench, Fort Custer,
 * and the fully-uninstalled 9829. Read from the registry workbook purely so
 * they can be filtered OUT of the live-but-unmapped list. Nothing from these
 * tabs is ever rendered.
 *
 * A missing tab fails the build rather than silently disabling the filter -
 * that would let decommissioned hardware surface on the page.
 */
function readExcludedDeviceIds(registryWb) {
  const byTab = {};
  const tabSets = new Map();
  const all = new Set();
  for (const tab of EXCLUDED_REGISTRY_TABS) {
    if (!registryWb.SheetNames.includes(tab)) {
      throw new Error(
        `NORMALIZE FAILED: registry workbook has no tab ${JSON.stringify(tab)}.\n` +
          `  It is listed in EXCLUDED_REGISTRY_TABS and is read to keep out-of-scope\n` +
          `  devices off the page. Refusing to build with the filter disabled.\n` +
          `  Tabs present: ${registryWb.SheetNames.map((n) => JSON.stringify(n)).join(', ')}`
      );
    }
    const ids = new Set();
    for (const r of sheetRows(registryWb, tab)) {
      const id = normStr(r['Device ID']);
      if (id) {
        ids.add(id);
        all.add(id);
      }
    }
    tabSets.set(tab, ids);
    byTab[tab] = ids.size;
  }
  // Logged here rather than returned into the payload: these tab names are
  // out-of-scope site names, and render.js rightly refuses to let them into
  // normalized data at all. The build log is the correct place for them.
  console.log('NORMALIZE  exclusion tabs read (devices kept off the page)');
  for (const [tab, count] of Object.entries(byTab)) {
    console.log(`  ${JSON.stringify(tab).padEnd(38)} ${String(count).padStart(4)} device ids`);
  }
  console.log(`  ${'total distinct excluded ids'.padEnd(38)} ${String(all.size).padStart(4)}`);
  return { all, byTab, tabSets };
}

// ---------------------------------------------------------------------------
// Per-source extraction
// ---------------------------------------------------------------------------

/** Room Status: the human triage layer. Spine of the room universe. */
function readRoomStatus(wb) {
  const rows = sheetRows(wb, 'Room Status');
  const headers = sheetHeaders(wb, 'Room Status');

  // Snapshot date the humans wrote into the header, e.g. "[Jun 12, 2026]".
  const hbHeader = headers.find((h) => /last heartbeat/i.test(h)) || '';
  const labelMatch = hbHeader.match(/\[([^\]]+)\]/);
  const headerLabel = labelMatch ? labelMatch[1].trim() : null;

  const probe = rows[0] || {};
  const K = {
    room: findKey(probe, /^installed\s*rooms?$/i),
    device: findKey(probe, /^device\s*#/i),
    lastHb: findKey(probe, /^last heartbeat/i),
    daysHb: findKey(probe, /^days with no heartbeat/i),
    lastShower: findKey(probe, /^last shower/i),
    daysShower: findKey(probe, /^days with no shower/i),
    battery: findKey(probe, /^battery status/i),
    status: findKey(probe, /^status$/i),
    action: findKey(probe, /^action item/i),
    notes: findKey(probe, /^notes/i),
  };
  if (!K.room || !K.status) {
    throw new Error(
      `NORMALIZE FAILED: "Room Status" is missing an Installed Rooms or Status column.\n` +
        `  headers seen: ${headers.join(' | ')}`
    );
  }

  const out = [];
  for (const r of rows) {
    const room = normRoom(r[K.room]);
    if (!room) continue; // blank spacer rows
    out.push({
      room,
      deviceName: K.device ? normStr(r[K.device]) : null,
      lastHeartbeat: K.lastHb ? normDate(r[K.lastHb]) : null,
      daysNoHeartbeat: K.daysHb ? normNum(r[K.daysHb]) : null,
      lastShower: K.lastShower ? normDate(r[K.lastShower]) : null,
      daysNoShower: K.daysShower ? normNum(r[K.daysShower]) : null,
      battery: K.battery ? normNum(r[K.battery]) : null,
      status: normStr(r[K.status]),
      actionItem: K.action ? normStr(r[K.action]) : null,
      notes: K.notes ? normStr(r[K.notes]) : null,
    });
  }
  return { rows: out, headerLabel, hasDeviceColumn: Boolean(K.device) };
}

/** py_export_heartbeatstatus: authoritative "what actually reported". */
function readHeartbeatExport(wb) {
  const rows = sheetRows(wb, 'py_export_heartbeatstatus');
  const byRoom = new Map();
  const byDevice = new Map();
  let currentTime = null;

  for (const r of rows) {
    const deviceId = normStr(r.ParticleDeviceId);
    const room = normRoom(r.RoomNumber);
    const lastHeartbeat = normDate(r.LastHeartbeat);
    const ct = normDate(r.CurrentTime);
    // Every row in an export carries the same CurrentTime; keep the latest
    // seen so a partially-refreshed export still reports honestly.
    if (ct && (!currentTime || ct > currentTime)) currentTime = ct;
    if (!deviceId) continue;
    const rec = { deviceId, room, lastHeartbeat, timeDiff: normStr(r.TimeDiff) };
    byDevice.set(deviceId, rec);
    if (room) {
      // If two devices claim one room, keep the more recent heartbeat.
      const prev = byRoom.get(room.key);
      if (!prev || (lastHeartbeat && prev.lastHeartbeat && lastHeartbeat > prev.lastHeartbeat) || !prev.lastHeartbeat) {
        byRoom.set(room.key, rec);
      }
    }
  }
  return { byRoom, byDevice, currentTime, rowCount: rows.length };
}

/**
 * py_export_batterystatus: voltages only.
 *
 * This sheet's own LastHeartbeat column is unreliable - at 6178 all 29 rows
 * contain a duration string rather than a timestamp - so it is ignored
 * entirely and heartbeats come from py_export_heartbeatstatus.
 */
function readBatteryExport(wb) {
  const rows = sheetRows(wb, 'py_export_batterystatus');
  const byDevice = new Map();
  const byRoom = new Map();
  let corruptHeartbeatRows = 0;

  for (const r of rows) {
    const deviceId = normStr(r.ParticleDeviceId);
    const room = normRoom(r.RoomNumber);
    const volts = normNum(r.BatteryVoltage_V);
    if (r.LastHeartbeat !== null && !(r.LastHeartbeat instanceof Date)) corruptHeartbeatRows++;
    const rec = { deviceId, room, volts, lastTimestamp: normDate(r.LastTimestamp) };
    if (deviceId) byDevice.set(deviceId, rec);
    if (room && !byRoom.has(room.key)) byRoom.set(room.key, rec);
  }
  return { byDevice, byRoom, rowCount: rows.length, corruptHeartbeatRows };
}

/**
 * Registry tab: what we believe we installed.
 *
 * Rows carrying a device but no room are inventory/spares, not placements;
 * they are counted but excluded from the room map. Where a room does stack
 * multiple devices (replacement history), the latest Install Date wins.
 */
function readRegistry(wb, tabName) {
  const rows = sheetRows(wb, tabName);
  const placements = [];
  let inventoryOnly = 0;

  for (const r of rows) {
    const deviceId = normStr(r['Device ID']);
    const room = normRoom(r['Room Number']);
    if (!deviceId) continue;
    if (!room) {
      inventoryOnly++;
      continue;
    }
    placements.push({
      deviceName: normStr(r['Device Name']),
      deviceId,
      mac: normStr(r['MAC Address']),
      room,
      installDate: normDate(r['Install Date']),
      notes: normStr(r['Notes']),
    });
  }

  // Collapse to current-device-per-room by latest Install Date.
  const byRoom = new Map();
  let collapsedRows = 0;
  for (const p of placements) {
    const prev = byRoom.get(p.room.key);
    if (!prev) {
      byRoom.set(p.room.key, p);
      continue;
    }
    collapsedRows++;
    const a = prev.installDate ? prev.installDate.getTime() : -Infinity;
    const b = p.installDate ? p.installDate.getTime() : -Infinity;
    if (b >= a) byRoom.set(p.room.key, p);
  }

  const byDevice = new Map();
  for (const p of placements) byDevice.set(p.deviceId, p);

  return { placements, byRoom, byDevice, inventoryOnly, collapsedRows, rowCount: rows.length };
}

// ---------------------------------------------------------------------------
// Room-assignment overrides
// ---------------------------------------------------------------------------

class RoomOverrideApplyError extends Error {}

/**
 * Turn one validated override block into a room-key -> device map.
 *
 * The override names devices; the pipeline joins on device id. Resolution
 * happens here, against the product device list already fetched, so no extra
 * request is made and there is no second opinion about which devices exist.
 *
 * Room keys are produced by the same normRoom() the roster uses, so a key can
 * only fail to match the roster because the room genuinely is not on it - not
 * because one side wrote "102" and the other 102.0. Rooms are never coerced
 * to numbers: "A322" is a real room at 6178.
 *
 * Everything here throws rather than skipping the offending row. Half an
 * override applied is the worst outcome available: the page reads as
 * corrected while some rooms still show the mapping the file exists to
 * replace.
 */
function resolveRoomOverride(prop, block, particle) {
  const where = 'room override for ' + prop.code;
  const liveCodes = new Set(PROPERTIES.map((p) => p.code));
  const byRoom = new Map();

  for (const entry of block.rooms) {
    const room = normRoom(entry.room);
    if (!room) {
      throw new RoomOverrideApplyError(
        'NORMALIZE FAILED: ' + where + ' has an unusable room key ' + JSON.stringify(entry.room) + '.'
      );
    }

    // Two distinct spellings that normalise onto one roster key ("102" and
    // "102.0") would otherwise let the later one silently win.
    const clash = byRoom.get(room.key);
    if (clash) {
      throw new RoomOverrideApplyError(
        'NORMALIZE FAILED: ' + where + ' has two entries for room ' + JSON.stringify(room.display) +
          ' (' + JSON.stringify(clash.sourceRoom) + ' and ' + JSON.stringify(entry.room) + ') once room ' +
          'numbers are normalised.\n  One room, one device. Refusing to guess which line is current.'
      );
    }

    const matches = particle.byName.get(entry.deviceName.trim().toLowerCase()) || [];
    if (!matches.length) {
      throw new RoomOverrideApplyError(
        'NORMALIZE FAILED: ' + where + ' names device ' + JSON.stringify(entry.deviceName) +
          ' for room ' + JSON.stringify(room.display) + ', which matches no device in product ' +
          PARTICLE_PRODUCT_ID + '.\n' +
          '  The product device list is the full inventory, so an unmatched name is a\n' +
          '  typo or a device that was never claimed into the product. Either way the\n' +
          '  room cannot be mapped, and guessing is not an option.'
      );
    }
    if (matches.length > 1) {
      throw new RoomOverrideApplyError(
        'NORMALIZE FAILED: ' + where + ' names device ' + JSON.stringify(entry.deviceName) +
          ' for room ' + JSON.stringify(room.display) + ', but ' + matches.length + ' devices in the ' +
          'product carry that name.\n  ids: ' + matches.map((d) => d.id).join(', ') +
          '\n  Refusing to guess which physical unit is in the room.'
      );
    }

    const device = matches[0];

    // A device tagged to a DIFFERENT live property is a real contradiction:
    // the override says it is here, the cloud says it is somewhere else we
    // also render. No group tag at all is ordinary and is not an error - the
    // tag is fleet housekeeping and plenty of units have never been given one.
    const groups = (device.groups || []).map(String);
    const foreign = groups
      .map((g) => {
        const m = /^esa[-_](\d{4})/i.exec(g);
        return m ? { code: m[1], group: g } : null;
      })
      .filter((g) => g && liveCodes.has(g.code) && g.code !== prop.code);
    if (foreign.length) {
      throw new RoomOverrideApplyError(
        'NORMALIZE FAILED: ' + where + ' assigns device ' + JSON.stringify(entry.deviceName) +
          ' to room ' + JSON.stringify(room.display) + ', but that device carries the group tag ' +
          foreign.map((g) => JSON.stringify(g.group)).join(', ') + ', which belongs to another live ' +
          'property.\n' +
          '  groups on the device: ' + (groups.length ? groups.join(', ') : '(none)') + '\n' +
          '  Two properties cannot both hold one unit. Resolve it in the field or in\n' +
          '  Particle before the override claims it.'
      );
    }

    byRoom.set(room.key, {
      sourceRoom: entry.room,
      room,
      deviceName: device.name || entry.deviceName,
      deviceId: device.id,
      groups,
    });
  }

  return byRoom;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function normalize() {
  const registryTabs = PROPERTIES.filter((p) => p.registryTab).map((p) => p.registryTab);
  // Exclusion tabs are required too: without them the live-but-unmapped list
  // would leak lab and 9829 hardware onto the page.
  const registryWb = readWorkbook('registry', [...registryTabs, ...EXCLUDED_REGISTRY_TABS]);
  const builtAt = new Date();

  const particle = readParticleDevices();
  const excluded = readExcludedDeviceIds(registryWb);

  // Every device ID this build considers "mapped" to an in-scope room, filled
  // in as each property is merged. Anything live in the API and absent from
  // this set is what reconciliation reports as live-but-unmapped.
  const mappedDeviceIds = new Set();
  const unknownToParticle = [];
  let joinAttempted = 0;
  let joinMatched = 0;

  // Committed room-assignment overrides. Validated at load; resolved against
  // the Particle device list per property below.
  const roomOverrides = loadRoomOverrides();

  const properties = [];
  const triage = [];
  const ghosts = [];
  const unregisteredReporters = [];
  const roomDeviceMismatches = [];
  const orphanTelemetryRooms = [];
  const duplicateRoomRows = [];
  const notes = [];

  // Override bookkeeping. None of these fail the build - they are the diff a
  // replace leaves behind, and the diff is the point: it is what the registry
  // backfill still has to reconcile.
  const roomOverrideSummaries = [];
  const overrideRoomsNotInRoster = [];
  const overrideRoomsWithoutDevice = [];
  const overrideDiscardedAssignments = [];

  for (const prop of PROPERTIES) {
    const wb = readWorkbook(prop.sheetKey, WO_SHEETS);
    const rs = readRoomStatus(wb);
    const hb = readHeartbeatExport(wb);
    const bat = readBatteryExport(wb);
    const reg = prop.registryTab ? readRegistry(registryWb, prop.registryTab) : null;

    // Room assignments for this property may be taken from the committed
    // override instead of the sheets. Resolution throws on anything it cannot
    // account for, so by this line the map is either complete or the build is
    // already over.
    const ovBlock = roomOverrides.properties[prop.code] || null;
    const ovReplace = ovBlock && ovBlock.mode === 'replace'
      ? resolveRoomOverride(prop, ovBlock, particle)
      : null;

    const currentTime = hb.currentTime;
    const snapshotAgeDays = currentTime ? (builtAt - currentTime) / DAY_MS : null;

    // --- merge, room by room, with Room Status as the spine ---------------
    const rooms = [];
    for (const t of rs.rows) {
      const key = t.room.key;
      const tele = hb.byRoom.get(key) || null;
      const regRec = reg ? reg.byRoom.get(key) || null : null;
      const ovRec = ovReplace ? ovReplace.get(key) || null : null;

      // What the sheets alone would have said. Kept even under an override so
      // the assignments a replace throws away can be listed rather than just
      // vanishing - that list is the registry backfill's worklist.
      const priorDeviceId = (tele && tele.deviceId) || (regRec && regRec.deviceId) || null;
      const priorSource = tele && tele.deviceId ? 'export' : regRec && regRec.deviceId ? 'registry' : null;

      // In replace mode the override IS the assignment layer for this
      // property: the export's room->device map and the registry's are both
      // discarded, not merely outranked. A room the override does not list
      // therefore has no device - which is the honest reading, because the
      // override is a field-verified map and its silence about a room is not
      // evidence that a stale sheet had it right.
      const deviceId = ovReplace ? (ovRec && ovRec.deviceId) || null : priorDeviceId;
      const deviceName = ovReplace
        ? (ovRec && ovRec.deviceName) || null
        : t.deviceName || (regRec && regRec.deviceName) || null;

      if (ovReplace && priorDeviceId && priorDeviceId !== deviceId) {
        overrideDiscardedAssignments.push({
          property: prop.code,
          propertyName: prop.name,
          room: t.room.display,
          roomKey: key,
          discardedFrom: priorSource,
          discardedDeviceId: priorDeviceId,
          discardedDeviceIdShort: String(priorDeviceId).slice(-6),
          discardedDeviceName:
            (regRec && regRec.deviceId === priorDeviceId ? regRec.deviceName : null) || t.deviceName || null,
          overrideDeviceName: ovRec ? ovRec.deviceName : null,
          overrideDeviceId: ovRec ? ovRec.deviceId : null,
        });
      }

      // Voltage: prefer the export keyed by device, then by room, then the
      // human-entered Room Status figure.
      const batRec =
        (deviceId && bat.byDevice.get(deviceId)) || bat.byRoom.get(key) || null;
      const volts = (batRec && batRec.volts !== null ? batRec.volts : t.battery);

      // Battery readings are collected intermittently and their timestamps are
      // not precise, so this age is reported as approximate on the page. It is
      // still the honest answer to "how old is this voltage".
      const batteryTimestamp = batRec ? batRec.lastTimestamp : null;
      const batteryAgeDays = batteryTimestamp ? (builtAt - batteryTimestamp) / DAY_MS : null;

      // --- heartbeat: the Particle API is the source of record as of v2 ---
      // Joined on ParticleDeviceId <-> device.id. The API is a strict superset
      // of what the exports carry, so a mapped device missing from it is a real
      // anomaly and gets written down rather than quietly bucketed as silent.
      if (deviceId) {
        mappedDeviceIds.add(deviceId);
        joinAttempted++;
      }
      const api = deviceId ? particle.byId.get(deviceId) || null : null;
      if (deviceId && api) joinMatched++;
      if (deviceId && !api) {
        unknownToParticle.push({
          property: prop.code,
          propertyName: prop.name,
          room: t.room.display,
          deviceId,
          deviceName,
        });
      }

      const lastHeartbeat = api && api.last_heard ? new Date(api.last_heard) : null;
      const reporting = Boolean(lastHeartbeat && !isNaN(lastHeartbeat));
      // Measured against build time, because the source is now live. This
      // deliberately supersedes the old export-relative figure.
      const daysSilent = reporting ? (builtAt - lastHeartbeat) / DAY_MS : null;

      rooms.push({
        property: prop.code,
        propertyName: prop.name,
        room: t.room.display,
        roomKey: key,
        deviceName,
        deviceId,
        status: t.status || 'Unknown',
        reporting,
        lastHeartbeat: iso(lastHeartbeat),
        daysSilent: round(daysSilent, 1),
        heartbeatBucket: bucketByDays(reporting ? daysSilent : null, THRESHOLDS.heartbeatAge),
        battery: round(volts, 3),
        batteryClass: batteryClass(volts),
        batteryTimestamp: iso(batteryTimestamp),
        batteryAgeDays: round(batteryAgeDays, 1),
        lastShower: iso(t.lastShower),
        daysNoShower: round(t.daysNoShower, 1),
        actionItem: t.actionItem,
        actionType: actionType(t.actionItem),
        // When this property's telemetry was last exported. Days-silent is
        // measured against this instant, not against today, so showing it on
        // every row is what makes the figure interpretable.
        lastChecked: iso(currentTime),
        notes: t.notes,
        registered: ovReplace ? Boolean(ovRec) : Boolean(regRec),
        // The override carries no install dates, so under a replace this is
        // absent rather than inherited from a mapping we just discarded.
        installDate: ovReplace ? null : regRec ? iso(regRec.installDate) : null,
        // Where this room's device assignment came from. Kept in
        // normalized.json for analysis; the page reads provenance off the
        // reconciliation block instead.
        assignmentSource: deviceId ? (ovRec ? 'override' : priorSource) : null,
      });
    }

    // --- counts -----------------------------------------------------------
    const tallyBy = (arr, fn) =>
      arr.reduce((m, x) => {
        const k = fn(x);
        m[k] = (m[k] || 0) + 1;
        return m;
      }, {});

    // A room can legitimately occupy more than one Room Status row when its
    // device was swapped: each row carries its own action item and note. We
    // keep every row (they are separate pieces of triage) but record the
    // duplication so nobody reads a row count as a room count.
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
      registryDevices: reg ? reg.byRoom.size : 0,
      registryInventoryOnly: reg ? reg.inventoryOnly : 0,
    };

    const heartbeatHistogram = {};
    for (const b of THRESHOLDS.heartbeatAge.buckets) heartbeatHistogram[b.key] = 0;
    heartbeatHistogram[THRESHOLDS.heartbeatAge.neverBucket.key] = 0;
    for (const r of rooms) heartbeatHistogram[r.heartbeatBucket] = (heartbeatHistogram[r.heartbeatBucket] || 0) + 1;

    const batteryHistogram = { ok: 0, warn: 0, critical: 0, unclassified: 0, unknown: 0 };
    for (const r of rooms) batteryHistogram[r.batteryClass] = (batteryHistogram[r.batteryClass] || 0) + 1;

    // Battery age drives the per-property freshness badge as of v2: heartbeats
    // are live at build time, so battery is the only thing that can go stale.
    const batteryAges = rooms.map((r) => r.batteryAgeDays).filter((n) => n !== null && n !== undefined);
    const batteryAgeMedian = median(batteryAges);
    const batteryAgeOldest = batteryAges.length ? Math.max(...batteryAges) : null;
    const batteryAge = {
      readings: batteryAges.length,
      roomsWithout: rooms.length - batteryAges.length,
      medianDays: round(batteryAgeMedian, 1),
      oldestDays: round(batteryAgeOldest, 1),
      bucket: bucketByDays(batteryAgeMedian, THRESHOLDS.batteryAge),
      approximate: true, // collector runs intermittently; timestamps are not precise
    };

    // --- override bookkeeping ---------------------------------------------
    // A replace is allowed to leave two kinds of gap, and both are reported
    // rather than papered over:
    //
    //   - the override names a room the sheet roster does not carry. No room
    //     row is invented for it. The roster and the denominators stay
    //     sheet-owned, so an override can never talk the property's Ok/Issue/
    //     Check counts up or down; the device simply stays unmapped and shows
    //     up in the live-but-unmapped list as before.
    //
    //   - the roster carries a room the override does not name. That room
    //     loses its device and reads as never-reporting, which is the honest
    //     consequence of a field-verified map not listing it.
    if (ovReplace) {
      const rosterKeys = new Set(rooms.map((r) => r.roomKey));

      for (const [roomKey, rec] of ovReplace) {
        if (rosterKeys.has(roomKey)) continue;
        overrideRoomsNotInRoster.push({
          property: prop.code,
          propertyName: prop.name,
          room: rec.room.display,
          deviceName: rec.deviceName,
          deviceId: rec.deviceId,
          deviceIdShort: String(rec.deviceId).slice(-6),
        });
      }

      const seenRoom = new Set();
      for (const r of rooms) {
        if (ovReplace.has(r.roomKey) || seenRoom.has(r.roomKey)) continue;
        seenRoom.add(r.roomKey);
        overrideRoomsWithoutDevice.push({
          property: prop.code,
          propertyName: prop.name,
          room: r.room,
          status: r.status,
        });
      }

      const mappedRooms = [...ovReplace.keys()].filter((k) => rosterKeys.has(k)).length;
      roomOverrideSummaries.push({
        property: prop.code,
        propertyName: prop.name,
        mode: ovBlock.mode,
        source: ovBlock.source,
        capturedAt: ovBlock.capturedAt,
        note: ovBlock.note,
        // Pairs in the file.
        pairs: ovBlock.rooms.length,
        // Pairs that landed on a room this dashboard actually renders.
        mappedRooms,
        // Pairs whose room is not on the sheet roster, so no row exists to
        // attach them to.
        roomsNotInRoster: ovBlock.rooms.length - mappedRooms,
        // Roster rooms the override does not name, now showing no device.
        rosterRoomsWithoutDevice: overrideRoomsWithoutDevice.filter((x) => x.property === prop.code).length,
        // Sheet-derived assignments this replace threw away.
        discardedAssignments: overrideDiscardedAssignments.filter((x) => x.property === prop.code).length,
      });
    }

    // --- reconciliation ---------------------------------------------------
    const telemetryDeviceIds = new Set([...hb.byDevice.keys(), ...bat.byDevice.keys()]);
    const triageRoomKeys = new Set(rooms.map((r) => r.roomKey));

    if (reg) {
      // Ghosts: registered placements whose device never appears in telemetry.
      for (const [, p] of reg.byRoom) {
        if (!telemetryDeviceIds.has(p.deviceId)) {
          ghosts.push({
            property: prop.code,
            propertyName: prop.name,
            room: p.room.display,
            deviceName: p.deviceName,
            deviceId: p.deviceId,
            installDate: iso(p.installDate),
            notes: p.notes,
          });
        }
      }
      // Unregistered reporters: telemetry devices absent from the registry.
      for (const id of telemetryDeviceIds) {
        if (!reg.byDevice.has(id)) {
          const rec = hb.byDevice.get(id) || bat.byDevice.get(id);
          unregisteredReporters.push({
            property: prop.code,
            propertyName: prop.name,
            room: rec && rec.room ? rec.room.display : null,
            deviceId: id,
            lastHeartbeat: rec && rec.lastHeartbeat ? iso(rec.lastHeartbeat) : null,
          });
        }
      }
      // Mismatches: registry and telemetry disagree about where a device is,
      // or about which device occupies a room.
      for (const [id, p] of reg.byDevice) {
        const tele = hb.byDevice.get(id);
        if (tele && tele.room && p.room.key !== tele.room.key) {
          roomDeviceMismatches.push({
            property: prop.code,
            propertyName: prop.name,
            kind: 'device in a different room than registered',
            deviceId: id,
            deviceName: p.deviceName,
            registryRoom: p.room.display,
            telemetryRoom: tele.room.display,
          });
        }
      }
      for (const [key, p] of reg.byRoom) {
        const tele = hb.byRoom.get(key);
        if (tele && tele.deviceId && tele.deviceId !== p.deviceId) {
          roomDeviceMismatches.push({
            property: prop.code,
            propertyName: prop.name,
            kind: 'room occupied by a different device than registered',
            room: p.room.display,
            deviceName: p.deviceName,
            registryDeviceId: p.deviceId,
            telemetryDeviceId: tele.deviceId,
          });
        }
      }
    } else {
      notes.push({
        property: prop.code,
        propertyName: prop.name,
        severity: 'warn',
        text:
          `${prop.code} has no tab in the registry workbook, so it cannot be reconciled. ` +
          `Its ${counts.rooms} rooms are shown from triage and telemetry only; ` +
          `ghosts and unregistered reporters cannot be computed for this property.`,
      });
    }

    // Telemetry reporting from a room that triage does not list as installed.
    for (const [key, rec] of hb.byRoom) {
      if (!triageRoomKeys.has(key)) {
        orphanTelemetryRooms.push({
          property: prop.code,
          propertyName: prop.name,
          room: rec.room ? rec.room.display : key,
          deviceId: rec.deviceId,
          lastHeartbeat: iso(rec.lastHeartbeat),
        });
      }
    }

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
          `Room Status has ${counts.rooms} rows covering ${counts.distinctRooms} distinct rooms. ` +
          `Room(s) ${dupList} appear more than once, each row carrying a different action item. ` +
          `All rows are kept in the triage queue; counts here are row counts, not room counts.`,
      });
    }

    // The human header label vs the machine snapshot.
    let labelMatchesSnapshot = null;
    if (rs.headerLabel && currentTime) {
      const labelDate = new Date(rs.headerLabel);
      labelMatchesSnapshot = !isNaN(labelDate)
        ? Math.abs(labelDate - currentTime) < 2 * DAY_MS
        : null;
      if (labelMatchesSnapshot === false) {
        notes.push({
          property: prop.code,
          propertyName: prop.name,
          severity: 'warn',
          text:
            `Room Status header is labelled "${rs.headerLabel}" but the machine export snapshot is ` +
            `${currentTime.toISOString().slice(0, 10)}. Freshness badges use the export timestamp; ` +
            `treat the sheet's own header date as out of date.`,
        });
      }
    }

    if (bat.corruptHeartbeatRows > 0) {
      notes.push({
        property: prop.code,
        propertyName: prop.name,
        severity: 'info',
        text:
          `${bat.corruptHeartbeatRows} of ${bat.rowCount} rows in py_export_batterystatus have a ` +
          `non-timestamp LastHeartbeat value. That column is ignored; heartbeats come from ` +
          `py_export_heartbeatstatus instead.`,
      });
    }

    properties.push({
      code: prop.code,
      name: prop.name,
      tag: prop.tag,
      hasRegistry: Boolean(prop.registryTab),
      hasDeviceColumn: rs.hasDeviceColumn,
      snapshot: {
        currentTime: iso(currentTime),
        ageDays: round(snapshotAgeDays, 1),
        bucket: bucketByDays(snapshotAgeDays, THRESHOLDS.snapshotFreshness),
        headerLabel: rs.headerLabel,
        labelMatchesSnapshot,
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
  // Fleet-level reconciliation against the Particle device list
  // -------------------------------------------------------------------------

  // The windows come from the confirmed heartbeat buckets so there is one
  // source of truth for what "fresh" and "live" mean on this page.
  const hbBuckets = THRESHOLDS.heartbeatAge.buckets;
  const freshDays = (hbBuckets.find((b) => b.key === 'fresh') || {}).maxDays || 2;
  const liveDays = (hbBuckets.find((b) => b.key === 'aging') || {}).maxDays || 7;

  const ageOf = (d) => {
    if (!d.last_heard) return null;
    const t = new Date(d.last_heard);
    return isNaN(t) ? null : (builtAt - t) / DAY_MS;
  };

  /**
   * Live but unmapped: devices the cloud has heard from recently that do not
   * correspond to any room we render. At 6178 this is mostly install progress
   * rather than breakage - see the note attached below.
   */
  const liveButUnmapped = [];
  const unmappedByGroup = {};
  let unmappedStale = 0;
  let excludedFiltered = 0;
  let excludedRecovered = 0;

  for (const d of particle.devices) {
    if (!d.id) continue;
    if (mappedDeviceIds.has(d.id)) continue;

    const age = ageOf(d);
    const isLive = age !== null && age <= liveDays;

    const g = particleGroupCode(d);
    const prop = g ? PROPERTIES.find((p) => p.code === g.code) : null;

    // Exclusion precedence. The exclusion tabs are transit logs, not rosters:
    // a device passes across the bench and is later installed at a live
    // property, and 152 of the 196 ids in the 9829 tab are also in the lab
    // tab. So membership alone cannot mean "out of scope".
    //
    // Rule: a device carrying a LIVE property's esa_ group tag is never
    // excluded. Its group is current fleet assignment; the tab membership is
    // history. It stays in the list, annotated with where else it appears.
    // Anything excluded without such a tag is dropped before it is recorded
    // and can never reach the page.
    if (excluded.all.has(d.id) && !prop) {
      if (isLive) excludedFiltered++;
      continue;
    }
    const alsoInExcludedTabs = excluded.all.has(d.id)
      ? EXCLUDED_REGISTRY_TABS.filter((t) => excluded.tabSets.get(t).has(d.id))
      : [];
    if (alsoInExcludedTabs.length && isLive) excludedRecovered++;

    if (!isLive) {
      unmappedStale++;
      continue;
    }
    liveButUnmapped.push({
      property: prop ? prop.code : null, // null = fleet-level pool, no usable group
      propertyName: prop ? prop.name : null,
      deviceName: d.name || null,
      deviceId: d.id,
      deviceIdShort: String(d.id).slice(-6),
      group: g ? g.group : null,
      lastHeard: d.last_heard || null,
      ageDays: round(age, 1),
      // Provenance, not scope: this device is live under a current property
      // group but also appears in one or more historical/out-of-scope tabs.
      alsoInExcludedTabs,
    });
    const bucket = prop ? prop.code : 'fleet';
    unmappedByGroup[bucket] = (unmappedByGroup[bucket] || 0) + 1;
  }

  // Freshest first: the newest arrivals are the ones worth chasing.
  liveButUnmapped.sort((a, b) => (a.ageDays === null ? 1 : b.ageDays === null ? -1 : a.ageDays - b.ageDays));

  // Priya owns the export pipeline; this is her reading of what the list means.
  const liveUnmappedNote =
    'Exports include a device only after its first data lands, and 6178 installs ' +
    'continued into June. Live-but-unmapped at 6178 therefore mostly means ' +
    '"installed, awaiting registry/export", not failure.';

  if (unknownToParticle.length) {
    notes.push({
      property: null,
      propertyName: null,
      severity: 'warn',
      text:
        `${unknownToParticle.length} mapped device(s) are absent from the Particle product ` +
        `device list entirely. The API is a strict superset of the exports, so this should ` +
        `be zero; these rooms are bucketed as never-reporting and listed in reconciliation.`,
    });
  }

  const particleSummary = {
    pulledAt: particle.pulledAt,
    fleetDevices: particle.count,
    mappedDevices: mappedDeviceIds.size,
    joinAttempted,
    joinMatched,
    joinRatePct: joinAttempted ? round((joinMatched / joinAttempted) * 100, 1) : null,
    unknownToParticle: unknownToParticle.length,
    freshWindowDays: freshDays,
    liveWindowDays: liveDays,
    unmappedLive: liveButUnmapped.length,
    unmappedLiveByGroup: unmappedByGroup,
    unmappedStale,
    excludedDeviceIds: excluded.all.size,
    excludedTabs: EXCLUDED_REGISTRY_TABS.length, // names deliberately not carried in the payload
    excludedLiveFiltered: excludedFiltered,
    excludedLiveRecovered: excludedRecovered, // kept despite tab membership, via a live group tag
  };

  // Triage order: worst first - Issue before Check, then longest silent.
  triage.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'Issue' ? -1 : 1;
    return (b.daysSilent ?? -1) - (a.daysSilent ?? -1);
  });

  const out = {
    builtAt: iso(builtAt),
    // Heartbeats are read live from the Particle API at build time, so this
    // single stamp covers the whole fleet. It replaces the old per-property
    // heartbeat staleness, which existed only because the exports were stale.
    heartbeatsAsOf: iso(builtAt),
    particle: particleSummary,
    thresholds: THRESHOLDS,
    properties,
    triage,
    reconciliation: {
      ghosts,
      unregisteredReporters,
      roomDeviceMismatches,
      orphanTelemetryRooms,
      duplicateRoomRows,
      unknownToParticle,
      liveButUnmapped,
      liveUnmappedNote,
      roomOverrides: roomOverrideSummaries,
      overrideRoomsNotInRoster,
      overrideRoomsWithoutDevice,
      overrideDiscardedAssignments,
      notes,
    },
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  return out;
}

function report(data) {
  console.log('NORMALIZE  per-property counts');
  const pad = (s, n) => String(s).padEnd(n);
  const lpad = (s, n) => String(s).padStart(n);
  console.log(
    `  ${pad('prop', 6)}${pad('name', 24)}${lpad('rooms', 6)}${lpad('Ok', 5)}${lpad('Issue', 6)}${lpad('Check', 6)}` +
      `${lpad('rept', 6)}${lpad('silent', 7)}${lpad('reg', 5)}  battery age (med/oldest)   export snapshot`
  );
  for (const p of data.properties) {
    const c = p.counts;
    const snap = p.snapshot.currentTime
      ? `${p.snapshot.currentTime.slice(0, 10)} (${p.snapshot.ageDays}d, ${p.snapshot.bucket})`
      : 'none';
    const ba = p.batteryAge;
    const baStr = ba.readings
      ? `${ba.medianDays}d / ${ba.oldestDays}d (${ba.bucket})`.padEnd(24)
      : 'no readings'.padEnd(24);
    console.log(
      `  ${pad(p.code, 6)}${pad(p.name.slice(0, 23), 24)}${lpad(c.rooms, 6)}${lpad(c.ok, 5)}${lpad(c.issue, 6)}` +
        `${lpad(c.check, 6)}${lpad(c.reporting, 6)}${lpad(c.silent, 7)}${lpad(p.hasRegistry ? c.registryDevices : '-', 5)}  ${baStr}   ${snap}`
    );
  }

  const tot = data.properties.reduce(
    (a, p) => ({
      rooms: a.rooms + p.counts.rooms,
      ok: a.ok + p.counts.ok,
      issue: a.issue + p.counts.issue,
      check: a.check + p.counts.check,
    }),
    { rooms: 0, ok: 0, issue: 0, check: 0 }
  );
  console.log(
    `  ${pad('TOTAL', 30)}${lpad(tot.rooms, 6)}${lpad(tot.ok, 5)}${lpad(tot.issue, 6)}${lpad(tot.check, 6)}`
  );
  console.log(`  triage queue rows (Issue + Check): ${data.triage.length}  [expect ${tot.issue + tot.check}]`);

  console.log('\nNORMALIZE  heartbeat-age histogram');
  for (const p of data.properties) {
    const h = p.heartbeatHistogram;
    console.log(
      `  ${pad(p.code, 6)}` +
        Object.entries(h).map(([k, v]) => `${k}=${v}`).join('  ')
    );
  }

  console.log('\nNORMALIZE  battery distribution');
  for (const p of data.properties) {
    const b = p.batteryHistogram;
    console.log(`  ${pad(p.code, 6)}` + Object.entries(b).map(([k, v]) => `${k}=${v}`).join('  '));
  }

  const q = data.particle;
  console.log('\nNORMALIZE  Particle join (heartbeat source)');
  console.log(`  device list pulled      : ${q.pulledAt}`);
  console.log(`  devices in product      : ${q.fleetDevices}`);
  console.log(`  mapped to an in-scope room: ${q.mappedDevices}`);
  console.log(
    `  join                    : ${q.joinMatched}/${q.joinAttempted} matched (${q.joinRatePct}%)`
  );
  console.log(`  unknown to Particle     : ${q.unknownToParticle}   [expect 0]`);
  console.log(`  live but unmapped (<=${q.liveWindowDays}d): ${q.unmappedLive}`);
  console.log(`    by group              : ${JSON.stringify(q.unmappedLiveByGroup)}`);
  console.log(`  unmapped and stale (>${q.liveWindowDays}d) : ${q.unmappedStale}  (count only, not listed)`);
  console.log(`  excluded device ids     : ${q.excludedDeviceIds} across ${q.excludedTabs} tabs (listed above)`);
  console.log(`  excluded devices that were live+unmapped and filtered out: ${q.excludedLiveFiltered}`);
  console.log(`  kept despite tab membership (live property group tag)     : ${q.excludedLiveRecovered}`);

  const ov = data.reconciliation.roomOverrides || [];
  if (ov.length) {
    console.log('\nNORMALIZE  room-assignment overrides applied');
    for (const o of ov) {
      console.log(`  ${o.property}  mode=${o.mode}  source: ${o.source || 'unstated'}  captured ${o.capturedAt || 'undated'}`);
      console.log(`    pairs in the file                  : ${o.pairs}`);
      console.log(`    mapped onto a room on the roster   : ${o.mappedRooms}`);
      console.log(`    rooms NOT on the sheet roster      : ${o.roomsNotInRoster}  (no row invented; devices stay unmapped)`);
      console.log(`    roster rooms now without a device  : ${o.rosterRoomsWithoutDevice}`);
      console.log(`    sheet assignments discarded        : ${o.discardedAssignments}  (the registry backfill's worklist)`);
    }
  }

  const r = data.reconciliation;
  console.log('\nNORMALIZE  reconciliation summary');
  console.log(`  ghosts (registered, never seen in telemetry) : ${r.ghosts.length}`);
  console.log(`  unregistered reporters (telemetry, no registry) : ${r.unregisteredReporters.length}`);
  console.log(`  room/device mismatches : ${r.roomDeviceMismatches.length}`);
  console.log(`  telemetry rooms not listed in triage : ${r.orphanTelemetryRooms.length}`);
  console.log(`  duplicated room rows : ${r.duplicateRoomRows.length}`);
  console.log(`  unknown to Particle : ${r.unknownToParticle.length}`);
  console.log(`  live but unmapped : ${r.liveButUnmapped.length}`);
  console.log(`  notes : ${r.notes.length}`);
  for (const n of r.notes) console.log(`    - [${n.property}/${n.severity}] ${n.text}`);

  const byProp = (arr) =>
    arr.reduce((m, x) => {
      m[x.property] = (m[x.property] || 0) + 1;
      return m;
    }, {});
  console.log(`  ghosts by property: ${JSON.stringify(byProp(r.ghosts))}`);
  console.log(`  unregistered by property: ${JSON.stringify(byProp(r.unregisteredReporters))}`);
  console.log(`  mismatches by property: ${JSON.stringify(byProp(r.roomDeviceMismatches))}`);

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
  for (const p of data.properties) {
    const c = p.counts;
    const liveUnder2d = p.heartbeatHistogram[freshKey] || 0;
    liveUnder2dTotal += liveUnder2d;
    properties[p.code] = {
      rooms: c.rooms,
      ok: c.ok,
      issue: c.issue,
      check: c.check,
      reporting: c.reporting,
      silent: c.silent,
      snapshot: p.snapshot.currentTime ? p.snapshot.currentTime.slice(0, 10) : null,
      battery: p.batteryHistogram,
      // --- added in v2 -----------------------------------------------------
      liveUnder2d, // mapped rooms heard from within the fresh window
      unmappedLive: unmappedByGroup[p.code] || 0, // live devices with no room here
    };
  }
  return {
    date: data.builtAt.slice(0, 10),
    builtAt: data.builtAt,
    triageRows: data.triage.length,
    properties,
    // --- added in v2 ---------------------------------------------------------
    // Fleet unmappedLive is NOT the sum of the per-property figures: devices
    // with no usable group tag land in a fleet-level pool and are attributed
    // to no property.
    liveUnder2d: liveUnder2dTotal,
    unmappedLive: q.unmappedLive || 0,
  };
}

module.exports = { normalize, report, dailyRecord, OUT_FILE };

if (require.main === module) {
  try {
    report(normalize());
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

'use strict';

/**
 * Stage 2 of the pipeline: merge registry + telemetry + triage into one
 * clean data/normalized.json, plus the reconciliation lists.
 *
 * Three sources disagree with each other on purpose:
 *   - Room Status          what a human last decided about a room
 *   - py_export_*          what the devices actually reported
 *   - registry tabs        what we believe we installed
 * Reconciliation is where those disagreements get written down instead of
 * silently resolved.
 *
 * Everything that leaves this file is already normalized: no "NA", no
 * "#N/A", no "No device in room", no 102.0, no raw Date objects.
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { PROPERTIES, THRESHOLDS } = require('./config');

const RAW_DIR = path.join(__dirname, 'data', 'raw');
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
const round = (n, p = 2) => (n === null || n === undefined ? null : Math.round(n * 10 ** p) / 10 ** p);

// ---------------------------------------------------------------------------
// Sheet helpers
// ---------------------------------------------------------------------------

function readWorkbook(key) {
  const file = path.join(RAW_DIR, `${key}.xlsx`);
  if (!fs.existsSync(file)) {
    throw new Error(`NORMALIZE FAILED: missing ${file}\n  Run fetch.js first (or let build.js do it).`);
  }
  return XLSX.readFile(file, { cellDates: true });
}

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

function batteryClass(volts) {
  const t = THRESHOLDS.batteryVoltage;
  if (volts === null || volts === undefined) return 'unknown';
  if (!t.confirmed || t.okAbove === null || t.warnAbove === null) return 'unclassified';
  if (volts >= t.okAbove) return 'ok';
  if (volts >= t.warnAbove) return 'warn';
  return 'critical';
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
// Main
// ---------------------------------------------------------------------------

function normalize() {
  const registryWb = readWorkbook('registry');
  const builtAt = new Date();

  const properties = [];
  const triage = [];
  const ghosts = [];
  const unregisteredReporters = [];
  const roomDeviceMismatches = [];
  const orphanTelemetryRooms = [];
  const duplicateRoomRows = [];
  const notes = [];

  for (const prop of PROPERTIES) {
    const wb = readWorkbook(prop.sheetKey);
    const rs = readRoomStatus(wb);
    const hb = readHeartbeatExport(wb);
    const bat = readBatteryExport(wb);
    const reg = prop.registryTab ? readRegistry(registryWb, prop.registryTab) : null;

    const currentTime = hb.currentTime;
    const snapshotAgeDays = currentTime ? (builtAt - currentTime) / DAY_MS : null;

    // --- merge, room by room, with Room Status as the spine ---------------
    const rooms = [];
    for (const t of rs.rows) {
      const key = t.room.key;
      const tele = hb.byRoom.get(key) || null;
      const regRec = reg ? reg.byRoom.get(key) || null : null;

      const deviceId = (tele && tele.deviceId) || (regRec && regRec.deviceId) || null;
      const deviceName = t.deviceName || (regRec && regRec.deviceName) || null;

      // Voltage: prefer the export keyed by device, then by room, then the
      // human-entered Room Status figure.
      const batRec =
        (deviceId && bat.byDevice.get(deviceId)) || bat.byRoom.get(key) || null;
      const volts = (batRec && batRec.volts !== null ? batRec.volts : t.battery);

      // Days silent is measured against this property's own snapshot, which
      // is what the sheet's own "days with no heartbeat" column means.
      let daysSilent = null;
      if (tele && tele.lastHeartbeat && currentTime) {
        daysSilent = (currentTime - tele.lastHeartbeat) / DAY_MS;
      } else if (t.daysNoHeartbeat !== null) {
        daysSilent = t.daysNoHeartbeat;
      }

      const lastHeartbeat = (tele && tele.lastHeartbeat) || t.lastHeartbeat || null;
      const reporting = Boolean(tele && tele.lastHeartbeat);

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
        lastShower: iso(t.lastShower),
        daysNoShower: round(t.daysNoShower, 1),
        actionItem: t.actionItem,
        notes: t.notes,
        registered: Boolean(regRec),
        installDate: regRec ? iso(regRec.installDate) : null,
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
      rooms,
    });

    for (const r of rooms) {
      if (r.status === 'Issue' || r.status === 'Check') triage.push(r);
    }
  }

  // Triage order: worst first - Issue before Check, then longest silent.
  triage.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'Issue' ? -1 : 1;
    return (b.daysSilent ?? -1) - (a.daysSilent ?? -1);
  });

  const out = {
    builtAt: iso(builtAt),
    thresholds: THRESHOLDS,
    properties,
    triage,
    reconciliation: {
      ghosts,
      unregisteredReporters,
      roomDeviceMismatches,
      orphanTelemetryRooms,
      duplicateRoomRows,
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
      `${lpad('rept', 6)}${lpad('silent', 7)}${lpad('reg', 5)}  snapshot`
  );
  for (const p of data.properties) {
    const c = p.counts;
    const snap = p.snapshot.currentTime
      ? `${p.snapshot.currentTime.slice(0, 10)} (${p.snapshot.ageDays}d, ${p.snapshot.bucket})`
      : 'none';
    console.log(
      `  ${pad(p.code, 6)}${pad(p.name.slice(0, 23), 24)}${lpad(c.rooms, 6)}${lpad(c.ok, 5)}${lpad(c.issue, 6)}` +
        `${lpad(c.check, 6)}${lpad(c.reporting, 6)}${lpad(c.silent, 7)}${lpad(p.hasRegistry ? c.registryDevices : '-', 5)}  ${snap}`
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

  const r = data.reconciliation;
  console.log('\nNORMALIZE  reconciliation summary');
  console.log(`  ghosts (registered, never seen in telemetry) : ${r.ghosts.length}`);
  console.log(`  unregistered reporters (telemetry, no registry) : ${r.unregisteredReporters.length}`);
  console.log(`  room/device mismatches : ${r.roomDeviceMismatches.length}`);
  console.log(`  telemetry rooms not listed in triage : ${r.orphanTelemetryRooms.length}`);
  console.log(`  duplicated room rows : ${r.duplicateRoomRows.length}`);
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

module.exports = { normalize, report, OUT_FILE };

if (require.main === module) {
  try {
    report(normalize());
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

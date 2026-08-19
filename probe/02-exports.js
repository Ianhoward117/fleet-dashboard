'use strict';

/**
 * Read the py_export tabs straight out of the freshly-fetched workbooks and
 * emit a flat join-ready JSON. Deliberately a separate, read-only reader:
 * normalize.js is production code and this probe must not touch it.
 */

const path = require('path');
const XLSX = require('xlsx');
const { PROPERTIES } = require('../config');
const { writeRaw } = require('./lib');

const RAW = path.join(__dirname, '..', 'data', 'raw');
const rows = (wb, name) =>
  wb.SheetNames.includes(name) ? XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null }) : [];
const str = (v) => (v === null || v === undefined ? null : String(v).trim() || null);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const date = (v) => (v instanceof Date && !isNaN(v) ? v.toISOString() : null);

const out = { pulledAt: new Date().toISOString(), properties: {} };

for (const p of PROPERTIES) {
  const wb = XLSX.readFile(path.join(RAW, `${p.sheetKey}.xlsx`), { cellDates: true });

  const hb = rows(wb, 'py_export_heartbeatstatus');
  const bat = rows(wb, 'py_export_batterystatus');

  const hbRows = hb.map((r) => ({
    deviceId: str(r.ParticleDeviceId),
    room: str(r.Room ?? r.RoomNumber ?? r.Room_Number),
    lastHeartbeat: date(r.LastHeartbeat),
    currentTime: date(r.CurrentTime),
    timeDiff: str(r.TimeDiff),
  }));
  const batRows = bat.map((r) => ({
    deviceId: str(r.ParticleDeviceId),
    room: str(r.Room ?? r.RoomNumber ?? r.Room_Number),
    volts: num(r.BatteryVoltage_V),
    lastTimestamp: date(r.LastTimestamp),
  }));

  const currentTime = hbRows.map((r) => r.currentTime).filter(Boolean).sort().pop() || null;
  const batCurrent = bat.map((r) => date(r.CurrentTime)).filter(Boolean).sort().pop() || null;

  out.properties[p.code] = {
    code: p.code, name: p.name,
    heartbeatCurrentTime: currentTime,
    batteryCurrentTime: batCurrent,
    heartbeatRows: hbRows, batteryRows: batRows,
    heartbeatHeaders: hb.length ? Object.keys(hb[0]) : [],
    batteryHeaders: bat.length ? Object.keys(bat[0]) : [],
  };

  const hbIds = hbRows.map((r) => r.deviceId).filter(Boolean);
  const batIds = batRows.map((r) => r.deviceId).filter(Boolean);
  const dupHb = hbIds.length - new Set(hbIds).size;
  const dupBat = batIds.length - new Set(batIds).size;
  console.log(
    `${p.code} ${p.name.padEnd(28)} hb=${String(hb.length).padStart(3)} rows (${new Set(hbIds).size} uniq ids, ${dupHb} dup)  ` +
    `bat=${String(bat.length).padStart(3)} rows (${new Set(batIds).size} uniq ids, ${dupBat} dup)  export=${(currentTime||'?').slice(0,10)}`
  );
  console.log(`     hb headers : ${(hb.length ? Object.keys(hb[0]) : []).join(', ')}`);
  console.log(`     bat headers: ${(bat.length ? Object.keys(bat[0]) : []).join(', ')}`);
}

console.log('\nwrote ->', writeRaw('py-exports.json', out));

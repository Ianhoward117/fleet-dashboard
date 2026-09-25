'use strict';

/**
 * Unit tests for the consolidated-workbook data layer (CUTOVER.md §3-§7).
 *
 * Synthetic fixtures only. Nothing here reads history/, data/ or the network.
 *
 * Run as `node test-cutover.js`. The file re-runs itself twice, under
 * TZ=UTC and TZ=America/Chicago, and passes only if both runs pass AND
 * produce an identical digest of every value the tests computed. Sheet time
 * must not depend on the host zone: Austin and Netlify have to agree.
 */

const assert = require('assert');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// Parent: run the suite in both zones and compare
// ---------------------------------------------------------------------------

if (!process.env.CUTOVER_TEST_ZONE_RUN) {
  const zones = ['UTC', 'America/Chicago'];
  const runs = zones.map((tz) => {
    const r = spawnSync(process.execPath, [__filename], {
      env: { ...process.env, TZ: tz, CUTOVER_TEST_ZONE_RUN: tz },
      encoding: 'utf8',
    });
    const out = (r.stdout || '') + (r.stderr || '');
    const pick = (re) => (out.match(re) || [])[1] || null;
    return { tz, status: r.status, out, digest: pick(/^DIGEST (\w+)$/m), offset: pick(/^HOST_OFFSET (-?\d+)$/m) };
  });
  let ok = true;
  for (const r of runs) {
    console.log(`\n=== TZ=${r.tz} ===`);
    process.stdout.write(r.out);
    if (r.status !== 0) ok = false;
  }
  console.log('\n=== zone comparison ===');
  const [a, b] = runs;
  if (a.offset === null || a.offset === b.offset) {
    console.log(`  FAIL  the two runs did not see different host zones (offsets ${a.offset} / ${b.offset})`);
    ok = false;
  } else {
    console.log(`  ok    host offsets differ (${a.offset} vs ${b.offset} min at 2026-09-25)`);
  }
  if (!a.digest || a.digest !== b.digest) {
    console.log(`  FAIL  results differ between zones: ${a.digest} vs ${b.digest}`);
    ok = false;
  } else {
    console.log(`  ok    identical results in both zones (digest ${a.digest.slice(0, 16)})`);
  }
  console.log('\n' + (ok ? 'CUTOVER TESTS PASS in both zones' : 'CUTOVER TESTS FAILED'));
  process.exit(ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Child: the suite itself
// ---------------------------------------------------------------------------

const N = require('./normalize');

let pass = 0;
let fail = 0;
const seen = []; // every computed value, for the cross-zone digest
const keep = (v) => {
  seen.push(v instanceof Date ? v.toISOString() : v);
  return v;
};
function t(name, fn) {
  try {
    fn();
    console.log('  ok    ' + name);
    pass++;
  } catch (e) {
    console.log('  FAIL  ' + name + '\n        ' + String(e.message).split('\n')[0]);
    fail++;
  }
}
const iso = (d) => (d instanceof Date ? d.toISOString() : d);
const DAY = 86400000;

// --- fixtures ---------------------------------------------------------------
const PROPS = [
  { code: '6197', name: 'Round Rock - Southwest' },
  { code: '6178', name: 'Austin - Southwest' },
  { code: '9502', name: 'Austin - Airport' },
];
const LIVE = new Set(PROPS.map((p) => p.code));
const hex = (n) => '0a10aced202194944a' + String(n).padStart(6, '0'); // 24 hex chars
const dev = (n, name, groups = [], lastHeard = null) => ({ id: hex(n), name, groups, last_heard: lastHeard });
const indexDevices = (list) => {
  const byId = new Map();
  const byName = new Map();
  for (const d of list) {
    byId.set(d.id, d);
    const k = String(d.name || '').trim().toLowerCase();
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(d);
  }
  return { byId, byName };
};
const BUILT = new Date('2026-09-25T18:00:00Z');
const ago = (days) => new Date(BUILT.getTime() - days * DAY).toISOString();
// A partitioned roomstatus row, as partitionRoomRows returns it.
const row = (property, room, deviceId, extra = {}) => ({
  property,
  location: property,
  room: { key: String(room).toLowerCase(), display: String(room) },
  deviceId: deviceId || null,
  deviceIdProblem: null,
  deviceIdRaw: deviceId || null,
  notes: null,
  ...extra,
});
// Raw roomstatus rows keyed by the real header text, as sheet_to_json gives them.
const RS_HEADERS = [
  'Location', 'Rooms', 'DeviceId', 'Device# ', 'Last Heartbeat [Sep 25, 2026]', 'Days with no Heartbeat',
  'Last Shower', 'Days with no Shower', 'Battery Status            [Sep 25, 2026]', 'Calibration Risk',
  'Status', 'Action Item', 'Notes from/to Ops',
];
const K = () => N.requireHeaders('roomstatus', RS_HEADERS);
const raw = (loc, room, id, extra = {}) => {
  const r = {};
  for (const h of RS_HEADERS) r[h] = null;
  r.Location = loc;
  r.Rooms = room;
  r.DeviceId = id;
  r.Status = 'Ok';
  r['Action Item'] = 'None';
  return Object.assign(r, extra);
};

// ===========================================================================
console.log('LOCATION AND ROOMS (§3)');

t('Location number -> 4-digit string code', () => {
  assert.strictEqual(keep(N.locationCode(6197)), '6197');
  assert.strictEqual(N.locationCode(9502), '9502');
  assert.strictEqual(N.locationCode('6178'), '6178');
  assert.strictEqual(N.locationCode(' 6178 '), '6178');
  assert.strictEqual(N.locationCode('6178.0'), '6178');
  assert.strictEqual(keep(N.locationCode(502)), '0502');
});
t('Location that is not a code -> null', () => {
  for (const v of [null, undefined, '', 'ESA 6197', 6197.5, -1, 12345, 'n/a']) {
    assert.strictEqual(N.locationCode(v), null, JSON.stringify(v));
  }
});
t('a number never equals a code: the reader converts before comparing', () => {
  assert.notStrictEqual(6197, '6197');
  const { rows } = N.parseRoomstatusRows([raw(6197, 101, null)], K());
  assert.strictEqual(rows[0].location, '6197');
  const part = N.partitionRoomRows(rows, PROPS.slice(0, 1));
  assert.strictEqual(part.byProperty.get('6197').length, 1);
});
t('rooms normalise: 102.0 -> 102, letter suffix kept, key lowercased', () => {
  const { rows } = N.parseRoomstatusRows(
    [raw(6197, 102, null), raw(6197, '102.0', null), raw(6178, '213A', null), raw(6178, ' 101 ', null)],
    K()
  );
  assert.deepStrictEqual(keep(rows.map((r) => r.room)), [
    { key: '102', display: '102' },
    { key: '102', display: '102' },
    { key: '213a', display: '213A' },
    { key: '101', display: '101' },
  ]);
});
t('fully blank rows are skipped, not counted', () => {
  const r = N.parseRoomstatusRows([raw(6197, 101, null), raw(null, null, null, { Status: null, 'Action Item': null })], K());
  assert.strictEqual(r.rows.length, 1);
  assert.strictEqual(r.blank, 1);
});

// ===========================================================================
console.log('\nSTRUCTURE: headers, D15, D16, zero rows');

t('required headers are found by pattern (date suffix, trailing space)', () => {
  const k = K();
  assert.strictEqual(k.battery, 'Battery Status            [Sep 25, 2026]');
  assert.strictEqual(k.notes, 'Notes from/to Ops');
  assert.strictEqual(k.room, 'Rooms');
});
t('Device# is not required (D8)', () => {
  const k = N.requireHeaders('roomstatus', RS_HEADERS.filter((h) => h !== 'Device# '));
  assert.strictEqual('device' in k, false);
});
t('a missing required header fails loudly', () => {
  assert.throws(() => N.requireHeaders('roomstatus', RS_HEADERS.filter((h) => h !== 'DeviceId')), /missing required header/);
  assert.throws(() => N.requireHeaders('heartbeatstatus', ['ParticleDeviceId', 'CurrentTime']), /location/i);
  assert.throws(() => N.requireHeaders('batterystatus', ['ParticleDeviceId', 'RoomNumber']), /lasttimestamp/i);
});
t('D15: out-of-scope rows are dropped and returned for the log', () => {
  const { rows } = N.parseRoomstatusRows(
    [raw(6197, 101, null), raw(9829, 101, null), raw(null, 102, null), raw('Lab', 103, null), raw(6178, null, null), raw(6178, 104, null)],
    K()
  );
  const part = N.partitionRoomRows(rows, PROPS.slice(0, 2));
  assert.strictEqual(part.inScope.length, 2);
  assert.deepStrictEqual(keep(part.outOfScope.map((o) => o.reason)), [
    'Location 9829 is not a configured property',
    'blank or unreadable Location',
    'blank or unreadable Location',
  ]);
  assert.strictEqual(part.outOfScope[0].location, 9829);
});
t('a configured Location with no room number is dropped and logged apart, never fatal', () => {
  const { rows } = N.parseRoomstatusRows(
    [raw(6197, 101, null), raw(6178, null, hex(4), { Status: 'Issue' }), raw(6178, 104, null)],
    K()
  );
  let part;
  assert.doesNotThrow(() => { part = N.partitionRoomRows(rows, PROPS.slice(0, 2)); });
  assert.strictEqual(part.outOfScope.length, 0);
  assert.deepStrictEqual(keep(part.noRoom.map((o) => [o.location, o.status, o.deviceId])), [['6178', 'Issue', hex(4)]]);
  assert.strictEqual(part.byProperty.get('6178').length, 1, 'never counted');
  // Even when it is the property's only row, the zero-rows check - not D16 - is what fires.
  const lone = N.parseRoomstatusRows([raw(6197, 101, null), raw(6178, null, null)], K()).rows;
  assert.throws(() => N.partitionRoomRows(lone, PROPS.slice(0, 2)), /no roomstatus rows.*6178/);
});
t('D15: an out-of-scope row is never counted in any property', () => {
  const { rows } = N.parseRoomstatusRows([raw(6197, 101, null), raw(6178, 101, null), raw(9829, 101, null)], K());
  const part = N.partitionRoomRows(rows, PROPS.slice(0, 2));
  const total = [...part.byProperty.values()].reduce((n, l) => n + l.length, 0);
  assert.strictEqual(total, 2);
});
t('D16: a row landing in two properties is FATAL', () => {
  const { rows } = N.parseRoomstatusRows([raw(6197, 101, null), raw(6178, 102, null)], K());
  const dupConfig = [{ code: '6197', name: 'a' }, { code: '6178', name: 'b' }, { code: '6197', name: 'again' }];
  assert.throws(() => N.partitionRoomRows(rows, dupConfig), /D16/);
});
t('D16: rows land exactly once when codes are distinct', () => {
  const { rows } = N.parseRoomstatusRows([raw(6197, 101, null), raw(6178, 102, null), raw(9502, 103, null)], K());
  const part = N.partitionRoomRows(rows, PROPS);
  assert.deepStrictEqual([...part.byProperty].map(([c, l]) => [c, l.length]), [['6197', 1], ['6178', 1], ['9502', 1]]);
  assert.strictEqual(part.byProperty.get('9502')[0].property, '9502');
});
t('a configured property with zero rows is FATAL', () => {
  const { rows } = N.parseRoomstatusRows([raw(6197, 101, null), raw(6178, 102, null)], K());
  assert.throws(() => N.partitionRoomRows(rows, PROPS), /no roomstatus rows.*9502/);
});

// ===========================================================================
console.log('\nDEVICEID (§3) AND F3');

t('24-hex is valid, lowercased, trimmed', () => {
  assert.deepStrictEqual(keep(N.readDeviceIdCell(' 0A10ACED202194944A017D18 ')), {
    id: '0a10aced202194944a017d18', raw: '0A10ACED202194944A017D18', problem: null,
  });
});
t('blank means no device: null, the formula "", whitespace, NA', () => {
  for (const v of [null, undefined, '', '   ', 'NA', 'No device']) {
    assert.deepStrictEqual(N.readDeviceIdCell(v), { id: null, raw: null, problem: null }, JSON.stringify(v));
  }
});
t('a spreadsheet error is not a blank: it is F3 and buckets never', () => {
  for (const v of ['#REF!', '#VALUE!', '#N/A', '#NAME?', ' #ERROR! ']) {
    const c = N.readDeviceIdCell(v);
    assert.strictEqual(c.problem, 'sheet error', v);
    assert.strictEqual(c.id, null);
    assert.strictEqual(c.raw, v.trim());
  }
  const r = row('6178', 330, null, { deviceIdProblem: 'sheet error', deviceIdRaw: '#REF!' });
  assert.deepStrictEqual(keep(N.findDeviceIdProblems([r], new Map()).map((f) => f.reason)), ['spreadsheet error']);
  assert.strictEqual(N.roomHeartbeat(r, new Map(), BUILT).bucket, 'never');
});
t('an error CELL in DeviceId survives the sheet reader (sheet_to_json would null it)', () => {
  const XLSX = require('xlsx');
  const ws = {
    '!ref': 'A1:D4',
    A1: { t: 's', v: '#Rooms to repair' }, B1: { t: 'n', v: 64 },
    A2: { t: 's', v: 'Location' }, B2: { t: 's', v: 'Rooms' }, C2: { t: 's', v: 'DeviceId' }, D2: { t: 's', v: 'Status' },
    A3: { t: 'n', v: 6178 }, B3: { t: 'n', v: 330 }, C3: { t: 'e', v: 0x17, w: '#REF!' }, D3: { t: 's', v: 'Ok' },
    A4: { t: 'n', v: 6178 }, B4: { t: 'n', v: 331 }, C4: { t: 's', v: '' }, D4: { t: 's', v: 'Ok' },
  };
  assert.strictEqual(XLSX.utils.sheet_to_json(ws, { range: 1, defval: null, raw: true })[0].DeviceId, null, 'the trap is real');
  const hdrs = ['Location', 'Rooms', 'DeviceId', 'Status', 'Action Item', 'Notes', 'Battery Status [x]', 'Calibration Risk'];
  const full = { ...ws, '!ref': 'A1:H4' };
  hdrs.slice(4).forEach((h, i) => { full[String.fromCharCode(69 + i) + '2'] = { t: 's', v: h }; });
  const tab = N.readSheetTab(full, 'roomstatus', 1);
  const { rows } = N.parseRoomstatusRows(tab.rows, tab.K);
  assert.deepStrictEqual(keep(rows.map((r) => [r.room.display, r.deviceIdProblem, r.deviceIdRaw])), [
    ['330', 'sheet error', '#REF!'],
    ['331', null, null],
  ]);
  assert.strictEqual(rows[0].sheetRow, 3);
});
t('malformed values are kept for the finding and never joined', () => {
  for (const v of ['P2-0433', '0a10aced202194944a017d1', '0a10aced202194944a017d188', '0a10aced202194944a017dzz']) {
    const c = N.readDeviceIdCell(v);
    assert.strictEqual(c.id, null, v);
    assert.strictEqual(c.problem, 'malformed', v);
    assert.strictEqual(c.raw, v);
  }
});
t('F3 flags malformed and unknown ids; the room buckets never', () => {
  const { byId } = indexDevices([dev(1, 'P2-0001', [], ago(1))]);
  const rows = [
    row('6197', 101, hex(1)),
    row('6197', 102, null, { deviceIdProblem: 'malformed', deviceIdRaw: 'P2-0433' }),
    row('6178', 103, hex(999)),
    row('6178', 104, null),
  ];
  const f3 = N.findDeviceIdProblems(rows, byId);
  assert.deepStrictEqual(keep(f3.map((f) => [f.property, f.room, f.reason, f.value])), [
    ['6197', '102', 'not a device id', 'P2-0433'],
    ['6178', '103', 'unknown to Particle', hex(999)],
  ]);
  assert.strictEqual(N.roomHeartbeat(rows[1], byId, BUILT).bucket, 'never');
  assert.strictEqual(N.roomHeartbeat(rows[2], byId, BUILT).bucket, 'never');
});

// ===========================================================================
console.log('\nHEARTBEAT BUCKETS: no device vs never (D11)');

t('blank DeviceId -> noDevice, not never', () => {
  const h = N.roomHeartbeat(row('6197', 101, null), new Map(), BUILT);
  assert.strictEqual(h.bucket, N.NO_DEVICE_BUCKET);
  assert.strictEqual(h.bucket, 'noDevice');
  assert.strictEqual(h.reporting, false);
});
t('the no-device bucket is defined in config, labelled for the page, cutoffs untouched', () => {
  const { THRESHOLDS: TH } = require('./config');
  assert.deepStrictEqual(keep(TH.heartbeatAge.noDeviceBucket), { key: 'noDevice', label: 'No device', tone: 'flat' });
  assert.strictEqual(N.NO_DEVICE_BUCKET, TH.heartbeatAge.noDeviceBucket.key);
  assert.deepStrictEqual(TH.heartbeatAge.buckets.map((b) => b.maxDays), [2, 7, null]);
});
t('a known device never heard -> never; heard 1 d ago -> fresh; 3 d -> aging; 30 d -> stale', () => {
  const { byId } = indexDevices([dev(1, 'A'), dev(2, 'B', [], ago(1)), dev(3, 'C', [], ago(3)), dev(4, 'D', [], ago(30))]);
  const b = (n) => N.roomHeartbeat(row('6197', n, hex(n)), byId, BUILT);
  assert.deepStrictEqual(keep([1, 2, 3, 4].map((n) => b(n).bucket)), ['never', 'fresh', 'aging', 'stale']);
  assert.strictEqual(b(2).deviceName, 'B');
  assert.strictEqual(Math.round(b(4).daysSilent), 30);
});
t('the display name is Particle by id (D8); the sheet Device# text is never consulted', () => {
  const { byId } = indexDevices([dev(1, 'P-0823', [], ago(1))]);
  const h = N.roomHeartbeat(row('6178', 418, hex(1), { deviceName: 'P2-0823' }), byId, BUILT);
  assert.strictEqual(h.deviceName, 'P-0823');
});

// ===========================================================================
console.log('\nF1: one device in two rooms');

t('within a property', () => {
  const f = N.findDuplicateDevices([row('6197', 101, hex(1)), row('6197', 102, hex(1)), row('6197', 103, hex(2))]);
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].crossProperty, false);
  assert.deepStrictEqual(keep(f[0].rooms), [{ property: '6197', room: '101' }, { property: '6197', room: '102' }]);
});
t('across properties', () => {
  const f = N.findDuplicateDevices([row('6178', 428, hex(7)), row('9502', 308, hex(7))]);
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].crossProperty, true);
});
t('the same row twice for one room is not two rooms', () => {
  assert.strictEqual(N.findDuplicateDevices([row('6197', 101, hex(1)), row('6197', 101, hex(1))]).length, 0);
});
// Ported from test-overrides.js 109-129: the two-property claims, now findings.
t('ported: same device claimed by two properties -> a finding, not a throw', () => {
  const rows = N.partitionRoomRows(
    N.parseRoomstatusRows([raw(6178, 101, hex(433)), raw(9502, 308, hex(433)), raw(6197, 100, null)], K()).rows,
    PROPS
  ).inScope.map((r) => ({ ...r, property: r.location }));
  let f;
  assert.doesNotThrow(() => { f = N.findDuplicateDevices(rows); });
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].crossProperty, true);
  assert.deepStrictEqual(f[0].rooms.map((x) => x.property), ['6178', '9502']);
});
t('ported: duplicate detected case- and whitespace-insensitively', () => {
  const rows = N.parseRoomstatusRows(
    [raw(6178, 101, hex(433).toUpperCase()), raw(6197, 100, '  ' + hex(433) + ' ')],
    K()
  ).rows.map((r) => ({ ...r, property: r.location }));
  const f = N.findDuplicateDevices(rows);
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].crossProperty, true);
});
t('ported: distinct ids across properties are fine', () => {
  const rows = [row('6178', 101, hex(1)), row('9502', 308, hex(2))];
  assert.strictEqual(N.findDuplicateDevices(rows).length, 0);
});

// ===========================================================================
console.log('\nF2: Location vs live esa_ tag');

t('a live tag for another property is a finding', () => {
  const { byId } = indexDevices([dev(1, 'P2-0433', ['esa_6178'])]);
  const r = N.findLocationTagConflicts([row('9502', 308, hex(1))], byId, LIVE);
  assert.deepStrictEqual(keep(r.findings.map((f) => [f.property, f.room, f.group, f.tagProperty])), [['9502', '308', 'esa_6178', '6178']]);
});
t('a matching tag, and the esa-####-suffix spelling, are fine', () => {
  const { byId } = indexDevices([dev(1, 'A', ['esa-9502-non-spi']), dev(2, 'B', ['esa_6197'])]);
  const r = N.findLocationTagConflicts([row('9502', 1, hex(1)), row('6197', 2, hex(2))], byId, LIVE);
  assert.strictEqual(r.findings.length, 0);
  assert.strictEqual(r.coverage['9502'].checkable, 1);
});
t('the anchored regex rejects baseline_6_shelves_esa_wifi_spi', () => {
  const d = dev(1, 'P2-0519', ['baseline_6_shelves_esa_wifi_spi']);
  assert.strictEqual(N.liveTagOf(d, LIVE), null);
  const r = N.findLocationTagConflicts([row('6178', 101, hex(1))], indexDevices([d]).byId, LIVE);
  assert.strictEqual(r.findings.length, 0);
  assert.deepStrictEqual(keep(r.coverage['6178']), {
    deviceRows: 1, checkable: 0, untagged: 1, untaggedBaseline: 1, unknownToParticle: 0, pctCheckable: 0,
  });
});
t('a tag for a property the page does not render is not a live tag', () => {
  const { byId } = indexDevices([dev(1, 'X', ['esa_9829'])]);
  const r = N.findLocationTagConflicts([row('9502', 1, hex(1))], byId, LIVE);
  assert.strictEqual(r.findings.length, 0);
  assert.strictEqual(r.coverage['9502'].untagged, 1);
});
t('coverage is reported per property, blind spot included', () => {
  const { byId } = indexDevices([dev(1, 'A', ['esa_9502']), dev(2, 'B', []), dev(3, 'C', ['baseline_6_shelves'])]);
  const rows = [row('9502', 1, hex(1)), row('9502', 2, hex(2)), row('9502', 3, hex(3)), row('9502', 4, hex(9)), row('9502', 5, null)];
  const c = N.findLocationTagConflicts(rows, byId, LIVE).coverage['9502'];
  assert.deepStrictEqual(keep(c), { deviceRows: 4, checkable: 1, untagged: 2, untaggedBaseline: 1, unknownToParticle: 1, pctCheckable: 25 });
});

// ===========================================================================
console.log('\nF4: notes naming a replacement');

const NOTES = {
  'Replaced with P2-0556 on 09/23/26.': ['replaced with', 'P2-0556'],
  'Replaced with P2-0859 on 09/23/26': ['replaced with', 'P2-0859'],
  'Replaced with P2-0658.': ['replaced with', 'P2-0658'],
  'Flashing red LED - replaced with P2-0823 on 9/16.': ['replaced with', 'P2-0823'],
  'Confirmed flashing red LED - 9/16/26. Replaced with P2-0867 on 09/23/26.': ['replaced with', 'P2-0867'],
  'Uninstalled by staff due to guest complaint. Replaced with P2-0587 on 09/23/26.': ['replaced with', 'P2-0587'],
  'Uninstalled by staff due to guest complaint. P2-0821 installed on 9/16/26.': ['installed', 'P2-0821'],
  'Uninstalled by staff. This device is incorrect. The correct device for this room is P2-0775.': ['correct device is', 'P2-0775'],
  'Replaced device on 9/23/26.': ['unnamed', null],
};
const EXCLUDED = [
  'Replaced batteries recently.',
  'Currently on active mode. Replaced batteries recently.',
  'Showerhead replaced on 09/23/26.',
  'Changed batteries on 09/23/26.',
  'Out of batteries since initial install. Changed batteries on 09/23/26.',
  'Uninstalled by staff due to guest complaint',
  'Uninstalled by staff.',
  'Ran a test shower - did not shut off water.',
  '',
];
t('the three recognised phrasings, and the unnamed one', () => {
  for (const [text, [kind, name]] of Object.entries(NOTES)) {
    assert.deepStrictEqual(keep(N.parseReplacementNote(text)), { kind, name }, text);
  }
});
t('battery and showerhead work, and other notes, are not recognised', () => {
  for (const text of EXCLUDED) assert.strictEqual(N.parseReplacementNote(text), null, text);
  assert.strictEqual(N.parseReplacementNote(null), null);
  assert.strictEqual(N.parseReplacementNote(undefined), null);
});
t('resolution is exact, trimmed and case-insensitive', () => {
  const { byName } = indexDevices([dev(1, ' p2-0556 ')]);
  const r = N.resolveNamedUnit('P2-0556', new Map([['p2-0556', byName.get('p2-0556')]]));
  assert.strictEqual(r.device.id, hex(1));
  const r2 = N.resolveNamedUnit('  P2-0556  ', new Map([['p2-0556', byName.get('p2-0556')]]));
  assert.strictEqual(r2.device.id, hex(1));
});
t('P2-0823 does not resolve to P-0823: never by digits alone', () => {
  const { byName } = indexDevices([dev(1, 'P-0823'), dev(2, 'P2-08230')]);
  const r = N.resolveNamedUnit('P2-0823', byName);
  assert.strictEqual(r.device, null);
  assert.strictEqual(keep(r.problem), 'no exact Particle name');
});
t('several devices sharing a name is ambiguous, not a guess', () => {
  const { byName } = indexDevices([dev(1, 'P2-0100'), dev(2, 'p2-0100')]);
  const r = N.resolveNamedUnit('P2-0100', byName);
  assert.strictEqual(r.device, null);
  assert.strictEqual(r.problem, 'ambiguous name');
  assert.strictEqual(r.matches, 2);
});
t('F4 classifies: agrees / shows another unit / blank / unresolvable; unnamed apart', () => {
  const { byName } = indexDevices([dev(1, 'P2-0001'), dev(2, 'P2-0002'), dev(3, 'P-0823')]);
  const rows = [
    row('6178', 101, hex(1), { notes: 'Replaced with P2-0001 on 09/23/26.' }), // agrees
    row('6178', 102, hex(3), { notes: 'Replaced with P2-0002 on 09/23/26.' }), // shows another unit
    row('6178', 103, null, { notes: 'P2-0002 installed on 9/16/26.' }), // blank
    row('6178', 418, hex(3), { notes: 'Flashing red LED - replaced with P2-0823 on 9/16.' }), // unresolvable
    row('6178', 302, hex(1), { notes: 'Replaced device on 9/23/26.' }), // unnamed
    row('6197', 103, hex(2), { notes: 'Replaced batteries recently.' }), // not recognised
  ];
  const r = N.findNoteReplacementConflicts(rows, byName);
  assert.strictEqual(r.recognised, 5);
  assert.deepStrictEqual(keep(r.findings.map((f) => [f.room, f.reason])), [
    ['102', 'DeviceId shows another unit'],
    ['103', 'DeviceId is blank'],
    ['418', 'no exact Particle name'],
  ]);
  assert.deepStrictEqual(r.unnamed.map((u) => u.room), ['302']);
  assert.strictEqual(r.findings[0].namedDeviceId, hex(2));
});

// ===========================================================================
console.log('\nATTRIBUTION AND LIVE-BUT-UNMAPPED (§6, D5b)');

const locs = (pairs) => new Map(pairs.map(([n, codes]) => [hex(n), new Set(codes)]));
t('a live tag wins, even against heartbeatstatus.Location', () => {
  const a = N.attributeDevice(dev(1, 'A', ['esa_6197']), locs([[1, ['9502']]]), LIVE);
  assert.deepStrictEqual(keep(a), { property: '6197', via: 'tag', group: 'esa_6197' });
});
t('untagged: one heartbeatstatus Location attributes it', () => {
  const a = N.attributeDevice(dev(1, 'P2-0032', ['baseline_6_shelves']), locs([[1, ['9502']]]), LIVE);
  assert.deepStrictEqual(keep(a), { property: '9502', via: 'exportLocation', group: null });
});
t('untagged with no heartbeatstatus row is unattributable', () => {
  assert.strictEqual(N.attributeDevice(dev(1, 'P2-0692', []), locs([]), LIVE), null);
});
t('D5b: untagged with more than one Location is unattributable', () => {
  assert.strictEqual(N.attributeDevice(dev(1, 'A', []), locs([[1, ['9502', '6178']]]), LIVE), null);
});
t('untagged with a Location outside the fleet is unattributable', () => {
  assert.strictEqual(N.attributeDevice(dev(1, 'A', ['esa_9829']), locs([[1, ['9829']]]), LIVE), null);
});
t('live-but-unmapped: held devices skipped, unattributable never listed or counted, fleet = sum', () => {
  const devices = [
    dev(1, 'held', ['esa_6197'], ago(0.5)), // in a room
    dev(2, 'P2-0856', ['esa-6197'], ago(0.2)), // tag -> 6197
    dev(3, 'P2-0519', ['baseline_6_shelves_esa_wifi_spi'], ago(0.2)), // Location -> 9502
    dev(4, 'P2-0032', ['baseline_6_shelves'], ago(0.3)), // Location -> 9502
    dev(5, 'lab', [], ago(0.1)), // unattributable, live
    dev(6, 'lab-old', [], ago(50)), // unattributable, stale
    dev(7, 'old-6178', ['esa_6178'], ago(30)), // attributable, stale
    dev(8, 'edge', ['esa_6178'], ago(7)), // exactly the 7-day edge: live
    dev(9, 'never', ['esa_6178'], null), // never heard: not live
  ];
  const r = N.findLiveButUnmapped(devices, new Set([hex(1)]), locs([[3, ['9502']], [4, ['9502']], [5, ['9502', '6178']]]), PROPS, BUILT, 7);
  assert.deepStrictEqual(keep(r.rows.map((x) => [x.deviceName, x.property, x.attribution])), [
    ['P2-0856', '6197', 'tag'],
    ['P2-0519', '9502', 'exportLocation'],
    ['P2-0032', '9502', 'exportLocation'],
    ['edge', '6178', 'tag'],
  ]);
  assert.deepStrictEqual(keep(r.byProperty), { 6197: 1, 9502: 2, 6178: 1 });
  const sum = Object.values(r.byProperty).reduce((a, b) => a + b, 0);
  assert.strictEqual(sum, r.rows.length);
  assert.strictEqual(r.stale, 2, 'old-6178 and never; the unattributable stale one is not counted');
  assert.ok(!r.rows.some((x) => x.deviceName === 'lab' || x.deviceName === 'lab-old'));
  // A device placed by export Location still shows the groups it carries.
  const p0519 = r.rows.find((x) => x.deviceName === 'P2-0519');
  assert.strictEqual(p0519.group, null, 'no esa_ tag');
  assert.deepStrictEqual(keep(p0519.groups), ['baseline_6_shelves_esa_wifi_spi']);
  assert.strictEqual(r.rows.find((x) => x.deviceName === 'P2-0856').group, 'esa-6197');
});
t('unplaced telemetry lists rows no room holds, with attribution', () => {
  const { byId } = indexDevices([dev(1, 'held'), dev(2, 'P2-0117', ['esa-9502-non-spi']), dev(3, 'P2-0692', [])]);
  const out = N.findUnplacedTelemetry(
    [{ sheetRow: 2, deviceId: hex(1) }, { sheetRow: 3, deviceId: hex(2) }, { sheetRow: 4, deviceId: hex(3) }],
    [{ sheetRow: 5, deviceId: hex(2), location: '9502' }],
    new Set([hex(1)]), byId, locs([[2, ['9502']]]), LIVE
  );
  assert.deepStrictEqual(keep(out.map((u) => [u.source, u.deviceName, u.attribution && u.attribution.property])), [
    ['batterystatus', 'P2-0117', '9502'],
    ['batterystatus', 'P2-0692', null],
    ['heartbeatstatus', 'P2-0117', '9502'],
  ]);
});

// ===========================================================================
console.log('\nTELEMETRY TABS: battery join, heartbeat index');

t('battery is joined by device id only; first row wins, duplicates reported', () => {
  const rows = N.parseBatteryRows(
    [
      { ParticleDeviceId: hex(1).toUpperCase(), RoomNumber: 101, LastTimestamp: 46276.5 },
      { ParticleDeviceId: hex(1), RoomNumber: 999, LastTimestamp: 46270.5 },
      { ParticleDeviceId: null, RoomNumber: null, LastTimestamp: null },
    ],
    { deviceId: 'ParticleDeviceId', lastTimestamp: 'LastTimestamp' }
  );
  assert.strictEqual(rows.length, 2, 'the blank padding row is dropped');
  const idx = N.batteryIndex(rows);
  assert.strictEqual(keep(iso(idx.byDevice.get(hex(1)).lastTimestamp)), '2026-09-11T17:00:00.000Z');
  assert.deepStrictEqual(idx.duplicates.map((d) => d.deviceId), [hex(1)]);
  assert.strictEqual('room' in idx.byDevice.get(hex(1)), false, 'RoomNumber is never read');
});
t('heartbeatstatus: per-property CurrentTime, nulls ignored, none -> null; ids with two Locations reported', () => {
  const hb = N.parseHeartbeatRows(
    [
      { ParticleDeviceId: hex(1), Location: 9502, CurrentTime: 46290.49197251036 },
      { ParticleDeviceId: hex(2), Location: 6178, CurrentTime: null },
      { ParticleDeviceId: hex(3), Location: 6178, CurrentTime: 46290.49203397963 },
      { ParticleDeviceId: hex(3), Location: 9502, CurrentTime: 46290.49197251036 },
    ],
    { deviceId: 'ParticleDeviceId', location: 'Location', currentTime: 'CurrentTime' }
  );
  const idx = N.heartbeatIndex(hb, ['6197', '6178', '9502']);
  assert.strictEqual(idx.currentTimeByProperty.get('6197'), null);
  assert.strictEqual(keep(iso(idx.currentTimeByProperty.get('9502'))), '2026-09-25T16:48:26.425Z');
  assert.strictEqual(keep(iso(idx.currentTimeByProperty.get('6178'))), '2026-09-25T16:48:31.736Z');
  assert.deepStrictEqual(idx.multiLocationIds, [{ deviceId: hex(3), locations: ['6178', '9502'] }]);
  assert.deepStrictEqual(idx.duplicateIds.map((d) => d.deviceId), [hex(3)]);
  assert.deepStrictEqual([...idx.locationsById.get(hex(1))], ['9502']);
});

// ===========================================================================
console.log('\nCHICAGO TIME (D4)');

const serialOf = (y, mo, d, h, mi, s) => Date.UTC(y, mo - 1, d, h, mi, s) / DAY + 25569;
const central = (y, mo, d, h, mi, s = 0) => iso(N.parseSheetDateTime(serialOf(y, mo, d, h, mi, s)));

t('serial -> wall clock is pure arithmetic', () => {
  assert.deepStrictEqual(keep(N.serialToWallClock(46290.49197251036)), { y: 2026, mo: 9, d: 25, h: 11, mi: 48, s: 26, ms: 425 });
  assert.strictEqual(N.serialToWallClock('46290'), null);
  assert.strictEqual(N.serialToWallClock(NaN), null);
});
t('the Sep 25 export stamp reads as 11:48:26 CDT = 16:48:26Z', () => {
  assert.strictEqual(keep(iso(N.parseSheetDateTime(46290.49197251036))), '2026-09-25T16:48:26.425Z');
});
t('summer is UTC-5, winter UTC-6', () => {
  assert.strictEqual(keep(central(2026, 7, 4, 12, 0)), '2026-07-04T17:00:00.000Z');
  assert.strictEqual(keep(central(2026, 12, 15, 12, 0)), '2026-12-15T18:00:00.000Z');
});
t('fall back, 2026-11-01: 00:30 CDT, 01:30 ambiguous -> the earlier (CDT), 02:30 and 03:00 CST', () => {
  assert.strictEqual(keep(central(2026, 11, 1, 0, 30)), '2026-11-01T05:30:00.000Z');
  assert.strictEqual(keep(central(2026, 11, 1, 1, 30)), '2026-11-01T06:30:00.000Z');
  assert.strictEqual(keep(central(2026, 11, 1, 2, 30)), '2026-11-01T08:30:00.000Z');
  assert.strictEqual(keep(central(2026, 11, 1, 3, 0)), '2026-11-01T09:00:00.000Z');
});
t('spring forward, 2027-03-14: 01:30 CST, 02:30 never happens -> read as CST, 03:30 CDT', () => {
  assert.strictEqual(keep(central(2027, 3, 14, 1, 30)), '2027-03-14T07:30:00.000Z');
  assert.strictEqual(keep(central(2027, 3, 14, 2, 30)), '2027-03-14T08:30:00.000Z');
  assert.strictEqual(keep(central(2027, 3, 14, 3, 30)), '2027-03-14T08:30:00.000Z');
  assert.strictEqual(keep(central(2027, 3, 14, 4, 0)), '2027-03-14T09:00:00.000Z');
});
t('the instant either side of each transition is continuous', () => {
  // 01:59:59 CDT -> 06:59:59Z, and 01:00:00 CST (the second 01:00) is 07:00:00Z, one second later.
  assert.strictEqual(central(2026, 11, 1, 1, 59, 59), '2026-11-01T06:59:59.000Z');
  assert.strictEqual(central(2027, 3, 14, 1, 59, 59), '2027-03-14T07:59:59.000Z');
  assert.strictEqual(central(2027, 3, 14, 3, 0, 0), '2027-03-14T08:00:00.000Z');
});
t('wall-clock text reads as Central; text with an offset is taken as written', () => {
  assert.strictEqual(keep(iso(N.parseSheetDateTime('2026-09-25 11:48:26'))), '2026-09-25T16:48:26.000Z');
  assert.strictEqual(iso(N.parseSheetDateTime('2026-09-11 17:31:54.018342')), '2026-09-11T22:31:54.018Z');
  assert.strictEqual(iso(N.parseSheetDateTime('2026-09-25T16:48:26Z')), '2026-09-25T16:48:26.000Z');
  assert.strictEqual(iso(N.parseSheetDateTime('2026-09-25T11:48:26-05:00')), '2026-09-25T16:48:26.000Z');
  assert.strictEqual(iso(N.parseSheetDateTime('2026-12-15')), '2026-12-15T06:00:00.000Z');
});
t('durations, bad tokens, ambiguous text and host-built Dates are refused', () => {
  for (const v of [null, undefined, '', 'NA', '#N/A', '130 days 02:13:33.721863', '9/22/2026 15:13:05', '2026-13-01 00:00', new Date(0)]) {
    assert.strictEqual(N.parseSheetDateTime(v), null, String(v));
  }
});
t('a number that is not a date serial reads as no timestamp, never a throw', () => {
  for (const v of [1758822506, 1758822506000, 1e12, 0, -5, 2958466, Infinity, NaN]) {
    let out;
    assert.doesNotThrow(() => { out = N.parseSheetDateTime(v); }, String(v));
    assert.strictEqual(out, null, String(v));
  }
  assert.strictEqual(iso(N.parseSheetDateTime(2958465)), '9999-12-31T06:00:00.000Z');
});
t('text dates that do not exist are refused, not rolled into the next month', () => {
  for (const v of ['2026-02-31 10:00', '2026-09-31', '2026-04-31 00:00:00', '0050-01-01', '2026-00-10']) {
    assert.strictEqual(N.parseSheetDateTime(v), null, v);
  }
  assert.strictEqual(iso(N.parseSheetDateTime('2028-02-29 12:00')), '2028-02-29T18:00:00.000Z');
});
t('the snapshot date is the Chicago calendar date', () => {
  // A 19:30 CDT export is 00:30Z the next day; it records as the day it was made.
  assert.strictEqual(keep(N.zonedDate('2026-09-26T00:30:00.000Z')), '2026-09-25');
  assert.strictEqual(N.zonedDate(N.parseSheetDateTime(serialOf(2026, 9, 25, 19, 30, 0))), '2026-09-25');
  assert.strictEqual(N.zonedDate('2026-09-25T04:59:59.000Z'), '2026-09-24');
  assert.strictEqual(N.zonedDate('2026-09-25T05:00:00.000Z'), '2026-09-25');
  assert.strictEqual(N.zonedDate('2026-12-01T05:30:00.000Z'), '2026-11-30'); // CST: 23:30 the day before
  assert.strictEqual(N.zonedDate(null), null);
  assert.strictEqual(N.zonedDate('not a date'), null);
});

// ===========================================================================
console.log('\nDAILY RECORD (§6, §7, §8)');

const { THRESHOLDS } = require('./config');
const recordOf = (currentTimes, byGroup) =>
  N.dailyRecord({
    builtAt: '2026-09-26T11:00:00.000Z',
    thresholds: THRESHOLDS,
    particle: { freshWindowDays: 2, unmappedLive: 99, unmappedLiveByGroup: byGroup },
    triage: [{}, {}],
    properties: PROPS.map((p, i) => ({
      code: p.code,
      counts: { rooms: 10, ok: 7, issue: 2, check: 1, reporting: 9, silent: 1 },
      heartbeatHistogram: { fresh: 5, aging: 2, stale: 2, never: 0, noDevice: 1 },
      batteryHistogram: { ok: 8, warn: 1, critical: 1, unclassified: 0, unknown: 0 },
      snapshot: { currentTime: currentTimes[i] },
    })),
  });

t('each property files its export under the Chicago calendar date', () => {
  const rec = recordOf(['2026-09-26T00:30:00.000Z', '2026-09-25T16:48:31.736Z', null], { 6197: 1 });
  assert.strictEqual(keep(rec.properties['6197'].snapshot), '2026-09-25'); // 19:30 CDT on the 25th
  assert.strictEqual(rec.properties['6178'].snapshot, '2026-09-25');
  assert.strictEqual(rec.properties['9502'].snapshot, null);
  assert.strictEqual(rec.date, '2026-09-26', 'the record itself is still dated by its build');
});
t('fleet unmappedLive is the sum of the properties, whatever the particle total says', () => {
  const rec = recordOf([null, null, null], { 6197: 1, 9502: 2 });
  assert.deepStrictEqual(keep(PROPS.map((p) => rec.properties[p.code].unmappedLive)), [1, 0, 2]);
  assert.strictEqual(rec.unmappedLive, 3);
});
t('the record shape does not change', () => {
  const rec = recordOf([null, null, null], {});
  assert.deepStrictEqual(Object.keys(rec), ['date', 'builtAt', 'triageRows', 'properties', 'liveUnder2d', 'unmappedLive']);
  assert.deepStrictEqual(Object.keys(rec.properties['6197']), [
    'rooms', 'ok', 'issue', 'check', 'reporting', 'silent', 'snapshot', 'battery', 'liveUnder2d', 'unmappedLive',
  ]);
  assert.strictEqual(rec.liveUnder2d, 15);
});

// ===========================================================================
console.log('\nVALIDATORS NEVER THROW (D5)');

t('garbage in, findings (or nothing) out', () => {
  const junk = [null, undefined, {}, { deviceId: hex(1) }, row('6197', 1, hex(1), { notes: 42 }), { room: null, notes: 'Replaced with' }];
  const empty = new Map();
  assert.doesNotThrow(() => N.findDuplicateDevices(junk, empty));
  assert.doesNotThrow(() => N.findDuplicateDevices(undefined));
  assert.doesNotThrow(() => N.findLocationTagConflicts(junk, empty, LIVE));
  assert.doesNotThrow(() => N.findLocationTagConflicts(junk, null, LIVE));
  assert.doesNotThrow(() => N.findDeviceIdProblems(junk, empty));
  assert.doesNotThrow(() => N.findDeviceIdProblems(junk, null));
  assert.doesNotThrow(() => N.findNoteReplacementConflicts(junk, empty));
  assert.doesNotThrow(() => N.findNoteReplacementConflicts(junk, null));
  assert.doesNotThrow(() => N.resolveNamedUnit(undefined, null));
  assert.doesNotThrow(() => N.attributeDevice(null, null, LIVE));
  assert.doesNotThrow(() => N.findLiveButUnmapped([null, {}, dev(1, 'x', null)], new Set(), new Map(), PROPS, BUILT, 7));
  assert.doesNotThrow(() => N.findUnplacedTelemetry(null, [{}], new Set(), null, null, LIVE));
  // groups that is not an array, as a malformed API page could deliver
  const odd = { id: hex(5), name: 'odd', groups: 'esa_6197', last_heard: ago(0.1) };
  const { byId } = indexDevices([odd]);
  assert.doesNotThrow(() => N.findLocationTagConflicts([row('6197', 1, hex(5))], byId, LIVE));
  assert.doesNotThrow(() => N.findUnplacedTelemetry([{ sheetRow: 2, deviceId: hex(5) }], [], new Set(), byId, new Map(), LIVE));
  assert.doesNotThrow(() => N.findLiveButUnmapped([odd], new Set(), new Map(), PROPS, BUILT, 7));
  assert.strictEqual(N.liveTagOf(odd, LIVE), null);
});

// ---------------------------------------------------------------------------
console.log('\n' + (fail ? 'FAILED ' : 'ALL PASS ') + pass + ' passed, ' + fail + ' failed');
// Evidence the zone really changed: the host offset at the export instant.
console.log('HOST_OFFSET ' + new Date('2026-09-25T16:48:26Z').getTimezoneOffset());
console.log('DIGEST ' + crypto.createHash('sha256').update(JSON.stringify(seen)).digest('hex'));
process.exit(fail ? 1 : 0);

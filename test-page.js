'use strict';

/**
 * Unit tests for the page layer: what render.js ships (the payload, D7, the
 * findings split) and what template.html draws from it (trends, flags, stamps).
 *
 * Synthetic fixtures only, held in memory. Nothing here reads or writes
 * history/, data/ or the network: history records for the trend tests are
 * built in this file and handed straight to the page.
 *
 * Run as `node test-page.js`. Like test-cutover.js, the file re-runs itself
 * under TZ=UTC and TZ=America/Chicago and passes only if both runs pass and
 * compute identical results. History dates are date-only, and a date-only
 * string parsed as UTC midnight formats as the day before anywhere west of
 * Greenwich - so the page's date labels have to agree in both zones.
 */

const assert = require('assert');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// Parent: run the suite in both zones and compare
// ---------------------------------------------------------------------------

if (!process.env.PAGE_TEST_ZONE_RUN) {
  const zones = ['UTC', 'America/Chicago'];
  const runs = zones.map((tz) => {
    const r = spawnSync(process.execPath, [__filename], {
      env: { ...process.env, TZ: tz, PAGE_TEST_ZONE_RUN: tz },
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
  console.log('\n' + (ok ? 'PAGE TESTS PASS in both zones' : 'PAGE TESTS FAILED'));
  process.exit(ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Child: the suite itself
// ---------------------------------------------------------------------------

const N = require('./normalize');
const R = require('./render');
const { THRESHOLDS, OUT_OF_SCOPE_NAMES } = require('./config');

let pass = 0;
let fail = 0;
const seen = []; // every computed value, for the cross-zone digest
const keep = (v) => {
  seen.push(v);
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
const clone = (v) => JSON.parse(JSON.stringify(v));

// --- fixtures ---------------------------------------------------------------

const BUILT = '2026-09-25T18:00:00.000Z';
const hex = (n) => '0a10aced202194944a' + String(n).padStart(6, '0');
const NAMES = { 6197: 'Round Rock - Southwest', 6178: 'Austin - Southwest', 9502: 'Austin - Airport' };

/** One normalized room row. */
function room(property, rm, spec = {}) {
  const deviceId = spec.deviceId === undefined ? hex(Number(rm)) : spec.deviceId;
  const bucket = spec.bucket || (deviceId ? 'fresh' : 'noDevice');
  const daysSilent = bucket === 'fresh' ? 0.5 : bucket === 'aging' ? 3 : bucket === 'stale' ? 30 : null;
  return {
    property,
    propertyName: NAMES[property],
    room: String(rm),
    roomKey: String(rm).toLowerCase(),
    sheetRow: spec.sheetRow || Number(rm),
    deviceName: deviceId ? spec.deviceName || 'P2-' + String(rm).padStart(4, '0') : null,
    deviceId,
    status: spec.status || 'Ok',
    reporting: daysSilent !== null,
    lastHeartbeat: daysSilent === null ? null : new Date(Date.parse(BUILT) - daysSilent * 86400000).toISOString(),
    daysSilent,
    heartbeatBucket: bucket,
    battery: spec.battery === undefined ? 3.9 : spec.battery,
    batteryClass: spec.battery === null ? 'unknown' : 'ok',
    batteryTimestamp: '2026-09-17T17:24:00.000Z',
    batteryAgeDays: 8.0,
    actionItem: spec.actionItem || 'None',
    actionType: 'None',
    notes: spec.notes === undefined ? null : spec.notes,
    calibrationRisk: 'No',
    flags: spec.flags || [],
  };
}

/** A property with counts and histograms that agree with its rooms, as normalize builds them. */
function property(code, rooms, currentTime = '2026-09-25T16:48:26.425Z') {
  const n = (fn) => rooms.filter(fn).length;
  const hb = { fresh: 0, aging: 0, stale: 0, never: 0, noDevice: 0 };
  for (const r of rooms) hb[r.heartbeatBucket]++;
  const bat = { ok: 0, warn: 0, critical: 0, unclassified: 0, unknown: 0 };
  for (const r of rooms) bat[r.batteryClass]++;
  const ok = n((r) => r.status === 'Ok');
  const issue = n((r) => r.status === 'Issue');
  const check = n((r) => r.status === 'Check');
  return {
    code,
    name: NAMES[code],
    tag: null,
    snapshot: { currentTime, date: currentTime ? currentTime.slice(0, 10) : null, ageDays: 0.1, bucket: 'current' },
    counts: {
      rooms: rooms.length, distinctRooms: new Set(rooms.map((r) => r.roomKey)).size,
      ok, issue, check, other: rooms.length - ok - issue - check,
      reporting: n((r) => r.reporting), silent: n((r) => !r.reporting), noDevice: hb.noDevice,
    },
    heartbeatHistogram: hb,
    batteryHistogram: bat,
    batteryAge: { readings: rooms.length, roomsWithout: 0, medianDays: 8, oldestDays: 8, bucket: 'stale', approximate: true },
    rooms,
  };
}

function fixture() {
  const props = [
    property('6197', [room('6197', 101), room('6197', 102, { status: 'Issue' }), room('6197', 103, { deviceId: null })]),
    property('6178', [
      room('6178', 101, { notes: 'Replaced with P2-0556 on 09/23/26.', flags: [{ code: 'F4', text: 'note names P2-0556; DeviceId shows P2-0101' }] }),
      room('6178', 428, { status: 'Check', deviceId: hex(433), deviceName: 'P2-0433' }),
    ]),
    property('9502', [room('9502', 308, { deviceId: hex(433), deviceName: 'P2-0433', bucket: 'stale' })], '2026-09-25T16:48:36.928Z'),
  ];
  const all = props.flatMap((p) => p.rooms);
  return {
    builtAt: BUILT,
    heartbeatsAsOf: BUILT,
    sheetExportAsOf: '2026-09-25T16:48:26.425Z',
    particle: {
      pulledAt: BUILT, fleetDevices: 9, mappedDevices: 6, joinAttempted: 6, joinMatched: 6, joinRatePct: 100,
      unknownToParticle: 0, freshWindowDays: 2, liveWindowDays: 7, unmappedLive: 1, unmappedLiveByGroup: { 6197: 1 }, unmappedStale: 0,
    },
    thresholds: THRESHOLDS,
    properties: props,
    triage: all.filter((r) => r.status === 'Issue' || r.status === 'Check'),
    reconciliation: {
      duplicateRoomRows: [],
      unknownToParticle: [],
      liveButUnmapped: [{
        property: '6197', propertyName: NAMES[6197], deviceName: 'P2-0856', deviceId: hex(856), deviceIdShort: '000856',
        group: 'esa-6197', groups: ['esa-6197'], attribution: 'tag', lastHeard: BUILT, ageDays: 0.7,
      }],
      notes: [],
    },
    findings: {
      f1: [{ flag: 'F1', deviceId: hex(433), deviceIdShort: '000433', deviceName: 'P2-0433', crossProperty: true,
        rooms: [{ property: '6178', room: '428' }, { property: '9502', room: '308' }] }],
      f2: [],
      f2Coverage: { 6197: { deviceRows: 2, checkable: 2, pctCheckable: 100 } },
      f3: [],
      f4: [{ flag: 'F4', property: '6178', room: '101', sheetRow: 101, note: 'Replaced with P2-0556 on 09/23/26.', kind: 'replaced with',
        namedUnit: 'P2-0556', reason: 'DeviceId shows another unit', deviceId: hex(101) }],
      f4Unnamed: [],
      f4NotesRecognised: 1,
    },
    logFindings: {
      unplacedTelemetry: [], conflictingTagDevices: [], outOfScopeRows: [], noRoomRows: [], blankRoomstatusRows: 0,
      notesNamingOutOfScope: [], sheetHygiene: {},
    },
  };
}
const payloadOf = (data, history = []) => R.buildPayload(data, history);

// ===========================================================================
console.log('PAYLOAD: what render.js ships');

t('the fixture is sane and its payload is clean', () => {
  const data = fixture();
  assert.deepStrictEqual(R.sanityProblems(data), []);
  assert.deepStrictEqual(R.payloadProblems(payloadOf(data)), []);
});
t('the payload carries the page findings by name, and F4 leaves its note on the room row', () => {
  const p = payloadOf(fixture());
  assert.deepStrictEqual(keep(Object.keys(p.findings)), N.PAGE_FINDING_KEYS);
  assert.strictEqual('note' in p.findings.f4[0], false);
  assert.strictEqual(p.rooms.find((r) => r.room === '101' && r.property === '6178').notes, 'Replaced with P2-0556 on 09/23/26.');
});
t('rooms ship their flags; calibrationRisk, roomKey and sheetRow stay off the page', () => {
  const p = payloadOf(fixture());
  assert.deepStrictEqual(keep(p.rooms.find((r) => r.property === '6178' && r.room === '101').flags),
    [{ code: 'F4', text: 'note names P2-0556; DeviceId shows P2-0101' }]);
  for (const k of ['calibrationRisk', 'roomKey', 'sheetRow']) assert.ok(!(k in p.rooms[0]), k);
});
t('the payload carries every stamp: sheet export (oldest), heartbeats, built, and one per property', () => {
  const p = payloadOf(fixture());
  assert.strictEqual(p.sheetExportAsOf, '2026-09-25T16:48:26.425Z');
  assert.strictEqual(p.heartbeatsAsOf, BUILT);
  assert.strictEqual(p.builtAt, BUILT);
  assert.deepStrictEqual(keep(p.properties.map((x) => x.snapshot.currentTime)),
    ['2026-09-25T16:48:26.425Z', '2026-09-25T16:48:26.425Z', '2026-09-25T16:48:36.928Z']);
});
t('log-only findings never reach the payload', () => {
  const data = fixture();
  data.logFindings.unplacedTelemetry = [{ deviceId: hex(1) }];
  const p = payloadOf(data);
  const blob = JSON.stringify(p);
  for (const k of N.LOG_FINDING_KEYS) assert.ok(!blob.includes('"' + k + '"'), k);
});
t('a log-only key that leaks in, at any depth, is a payload problem', () => {
  const p = payloadOf(fixture());
  p.reconciliation.extra = { nested: [{ unplacedTelemetry: [] }] };
  assert.deepStrictEqual(keep(R.payloadProblems(p)), ['log-only finding(s) reached the payload: unplacedTelemetry']);
  const q = payloadOf(fixture());
  q.findings.outOfScopeRows = [];
  assert.strictEqual(R.payloadProblems(q).length, 1);
});
t('a missing page finding, or a room without a flags list, fails the sanity check', () => {
  const a = fixture();
  delete a.findings.f2Coverage;
  assert.deepStrictEqual(keep(R.sanityProblems(a)), ['page findings missing from normalized data: f2Coverage']);
  const b = fixture();
  delete b.properties[0].rooms[0].flags;
  assert.strictEqual(R.sanityProblems(b).length, 1);
});

// ===========================================================================
console.log('\nD7: out-of-scope names');

t('the names are the three the page has always refused', () => {
  assert.deepStrictEqual(keep(OUT_OF_SCOPE_NAMES), ['The Lab', 'Fort Custer', 'ESA 9829']);
});
t('a structured-field hit fails the build, wherever it is', () => {
  const cases = [
    (d) => { d.properties[0].rooms[0].actionItem = 'Return unit to The Lab'; },
    (d) => { d.properties[1].rooms[1].deviceName = 'Fort Custer 7'; },
    (d) => { d.reconciliation.liveButUnmapped[0].groups = ['ESA 9829 spares']; },
    (d) => { d.reconciliation.notes = [{ property: null, severity: 'warn', text: 'rows from The Lab' }]; },
    (d) => { d.properties[1].rooms[0].flags = [{ code: 'F3', text: 'DeviceId "The Lab" is not a Particle device id' }]; },
    (d) => { d.properties[2].name = 'Fort Custer'; },
  ];
  for (const [i, mutate] of cases.entries()) {
    const d = fixture();
    mutate(d);
    const problems = R.payloadProblems(payloadOf(d));
    assert.strictEqual(problems.length, 1, 'case ' + i + ': ' + JSON.stringify(problems));
    assert.ok(/structured field/.test(problems[0]), problems[0]);
  }
});
t('a note hit renders as written and is not fatal', () => {
  const d = fixture();
  d.properties[0].rooms[1].notes = 'Unit came back from The Lab; Fort Custer spare.';
  d.reconciliation.duplicateRoomRows = [{ property: '6197', propertyName: NAMES[6197], room: '102', count: 2,
    entries: [{ status: 'Issue', actionItem: 'None', notes: 'Sent to ESA 9829 first' }] }];
  const p = payloadOf(d);
  assert.deepStrictEqual(R.payloadProblems(p), []);
  assert.strictEqual(p.rooms[1].notes, 'Unit came back from The Lab; Fort Custer spare.', 'the note still renders');
  assert.strictEqual(p.reconciliation.duplicateRoomRows[0].entries[0].notes, 'Sent to ESA 9829 first');
});
t('the note hit is logged by normalize, which names the room and the site', () => {
  const rows = [{ property: '6197', room: { key: '102', display: '102' }, sheetRow: 5, notes: 'Unit came back from The Lab' }];
  assert.deepStrictEqual(keep(N.findNotesNamingOutOfScope(rows, OUT_OF_SCOPE_NAMES)),
    [{ property: '6197', room: '102', sheetRow: 5, names: ['The Lab'] }]);
});
t('a dropped out-of-scope row mentioning The Lab is logged, not fatal, and absent from the payload', () => {
  const RS = ['Location', 'Rooms', 'DeviceId', 'Status', 'Action Item', 'Notes from/to Ops', 'Battery Status [Sep 25, 2026]', 'Calibration Risk'];
  const K = N.requireHeaders('roomstatus', RS);
  const raw = (loc, rm, notes) => ({ Location: loc, Rooms: rm, DeviceId: null, Status: 'Ok', 'Action Item': 'None',
    'Notes from/to Ops': notes, 'Battery Status [Sep 25, 2026]': null, 'Calibration Risk': 'No' });
  const { rows } = N.parseRoomstatusRows(
    [raw(6197, 101, null), raw(6178, 101, null), raw(9502, 101, null), raw('The Lab', 12, 'Bench unit, The Lab')], K);
  let part;
  assert.doesNotThrow(() => { part = N.partitionRoomRows(rows, [{ code: '6197' }, { code: '6178' }, { code: '9502' }]); });
  assert.deepStrictEqual(keep(part.outOfScope.map((o) => [o.location, o.room, o.reason])),
    [['The Lab', '12', 'blank or unreadable Location']]);
  const d = fixture();
  d.logFindings.outOfScopeRows = part.outOfScope;
  const p = payloadOf(d);
  assert.deepStrictEqual(R.payloadProblems(p), []);
  assert.ok(!JSON.stringify(p).includes('The Lab'));
});

// ===========================================================================
// The page script, run in memory
// ===========================================================================

/**
 * Run template.html's page script against a payload, with just enough DOM for
 * it to draw: elements by id that hold innerHTML/textContent/value/hidden and
 * their listeners. What the page drew is then read back as strings. A throw
 * anywhere in the page script fails the test that ran it.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const PAGE_SCRIPT = (() => {
  const html = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('template.html has no inline page script');
  return m[1];
})();

function runPage(payload, search = '') {
  const els = new Map();
  const blobs = [];
  const mk = (id, tag) => {
    const e = {
      id, tagName: tag || 'div', innerHTML: '', textContent: '', value: '', hidden: false, children: [],
      dataset: {}, attrs: {}, listeners: {},
      appendChild(c) { this.children.push(c); return c; },
      removeChild() {},
      addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      removeAttribute(k) { delete this.attrs[k]; },
      click() { for (const fn of this.listeners.click || []) fn({ preventDefault() {} }); },
      fire(ev) { for (const fn of this.listeners[ev] || []) fn({ preventDefault() {} }); },
    };
    return e;
  };
  const byId = (id) => {
    if (!els.has(id)) els.set(id, mk(id));
    return els.get(id);
  };
  byId('payload').textContent = JSON.stringify(payload);
  const tabs = ['rollup', 'rooms', 'recon'].map((v) => Object.assign(mk(null, 'button'), { dataset: { view: v } }));
  const docListeners = [];
  const document = {
    getElementById: byId,
    createElement: (tag) => mk(null, tag),
    querySelectorAll: (sel) => (sel === '#tabs button' ? tabs : []),
    addEventListener: (ev, fn) => docListeners.push([ev, fn]),
    body: { appendChild() {}, removeChild() {} },
  };
  class FakeBlob {
    constructor(parts) { blobs.push(parts.join('')); }
  }
  const ctx = {
    document,
    location: { search, hash: '', pathname: '/' },
    history: { replaceState() {} },
    URLSearchParams,
    Blob: FakeBlob,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    console,
  };
  vm.runInNewContext(PAGE_SCRIPT, ctx, { filename: 'template.html' });
  return {
    html: (id) => byId(id).innerHTML,
    text: (id) => byId(id).textContent,
    el: byId,
    csv() {
      byId('fCsv').click();
      return blobs[blobs.length - 1].replace(/^﻿/, '');
    },
    // A link the page drew with data-goto, followed as a click would.
    goto(attrs) {
      const target = { getAttribute: (k) => (k in attrs ? attrs[k] : null) };
      for (const [ev, fn] of docListeners) {
        if (ev === 'click') fn({ target: { closest: () => target }, preventDefault() {} });
      }
    },
  };
}
const rowsOf = (html) => (html.match(/<tr>[\s\S]*?<\/tr>/g) || []);
const titlesOf = (html, cls) => [...html.matchAll(new RegExp('<span class="' + cls + '[^"]*" title="([^"]*)"', 'g'))].map((m) => m[1]);
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// ===========================================================================
console.log('\nPAGE: stamps (D5, §7)');

t('the page script runs on the fixture without throwing', () => {
  assert.doesNotThrow(() => runPage(payloadOf(fixture())));
});
t('the header carries all three stamps; sheet export is the oldest property stamp', () => {
  const p = payloadOf(fixture());
  const page = runPage(p);
  const fmt = (iso) => new Date(iso).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  assert.strictEqual(page.text('sheetAsOf'), fmt('2026-09-25T16:48:26.425Z'));
  assert.strictEqual(page.text('hbAsOf'), fmt(BUILT));
  assert.strictEqual(page.text('builtAt'), fmt(BUILT));
});
t('a payload with no export stamp says unknown rather than blank', () => {
  const d = fixture();
  d.sheetExportAsOf = null;
  d.properties[2].snapshot.currentTime = null;
  const page = runPage(payloadOf(d));
  assert.strictEqual(page.text('sheetAsOf'), 'unknown');
  const cards = page.html('cards').split('<div class="card">').slice(1);
  assert.ok(/Sheet export as of[^<]*<b>unknown<\/b>/.test(cards[2]), cards[2].slice(0, 400));
});
t('each property card shows its own sheet export stamp; the battery badge stays', () => {
  const page = runPage(payloadOf(fixture()));
  const cards = page.html('cards').split('<div class="card">').slice(1);
  assert.strictEqual(cards.length, 3);
  const fmt = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  assert.ok(cards[2].includes('Sheet export as of <b>' + fmt('2026-09-25T16:48:36.928Z') + '</b>'), cards[2].slice(0, 600));
  for (const c of cards) assert.ok(c.includes('<div class="fl">Battery data</div>'));
});

// ===========================================================================
console.log('\nPAGE: no device is its own state (D11)');

t('card KPIs split never-heard from no device, and the three sum to the rooms', () => {
  const page = runPage(payloadOf(fixture()));
  const card = page.html('cards').split('<div class="card">')[1];
  const kpi = (label) => Number((card.match(new RegExp('<div class="v"[^>]*>(\\d+)</div><div class="l">' + label + '</div>')) || [])[1]);
  assert.deepStrictEqual(keep([kpi('Rooms'), kpi('Reporting'), kpi('Never heard'), kpi('No device')]), [3, 2, 0, 1]);
  assert.ok(!/<div class="l">Silent<\/div>/.test(card), 'no "Silent" KPI lumping the two together');
});
t('All rooms: a no-device room reads "No device", not a dash, and can be filtered', () => {
  const page = runPage(payloadOf(fixture()), '?v=rooms&hb=noDevice');
  const rows = rowsOf(page.html('tableBody'));
  assert.strictEqual(keep(rows.length), 1);
  assert.ok(/data-label="Days silent"[^>]*><span class="muted">No device<\/span>/.test(rows[0]), rows[0]);
  assert.strictEqual(page.text('rowCount'), '1 of 6 rooms');
});
t('the heartbeat filter offers every drawn bucket, with counts', () => {
  const page = runPage(payloadOf(fixture()), '?v=rooms');
  const opts = [...page.html('fHeartbeat').matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map((m) => [m[1], unesc(m[2])]);
  assert.deepStrictEqual(keep(opts), [
    ['', 'All (6)'], ['fresh', '< 2 days (4)'], ['aging', '2-7 days (0)'], ['stale', '> 7 days (1)'],
    ['never', 'Never (0)'], ['noDevice', 'No device (1)'],
  ]);
});

// ===========================================================================
console.log('\nPAGE: per-room findings (F1-F4)');

t('flagged rooms carry a tag per finding, with the plain-language tooltip', () => {
  const page = runPage(payloadOf(fixture()), '?v=rooms');
  const tips = titlesOf(page.html('tableBody'), 'flag').map(unesc);
  assert.deepStrictEqual(keep(tips), ['F4 · note names P2-0556; DeviceId shows P2-0101']);
});
t('the unnamed replacement note is tagged F4 but drawn apart', () => {
  const d = fixture();
  d.properties[1].rooms[1].flags = [{ code: 'F4', unnamed: true, text: 'note records a replacement but names no unit; DeviceId is blank' }];
  const page = runPage(payloadOf(d), '?v=rooms&flag=F4');
  const body = page.html('tableBody');
  assert.strictEqual(rowsOf(body).length, 2, 'the F4 filter keeps the room');
  assert.ok(/<span class="flag unnamed"/.test(body));
});
t('the finding filter narrows to flagged rooms and offers counts', () => {
  const d = fixture();
  d.properties[1].rooms[1].flags = [{ code: 'F1', text: 'P2-0433 is also listed in 9502/308, another property' }];
  d.properties[2].rooms[0].flags = [
    { code: 'F1', text: 'P2-0433 is also listed in 6178/428, another property' },
    { code: 'F2', text: 'P2-0433 is tagged esa_6178 in Particle, which belongs to 6178' },
  ];
  const any = runPage(payloadOf(d), '?v=rooms&flag=any');
  assert.strictEqual(rowsOf(any.html('tableBody')).length, 3);
  const f2 = runPage(payloadOf(d), '?v=rooms&flag=F2');
  assert.strictEqual(rowsOf(f2.html('tableBody')).length, 1);
  const opts = [...any.html('fFlag').matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map((m) => m[1] + '=' + m[2]);
  assert.deepStrictEqual(keep(opts), [
    '=All rooms (6)', 'any=Any finding (3)', 'F1=F1 · one device, two rooms (2)', 'F2=F2 · Location vs Particle tag (1)',
    'F3=F3 · DeviceId not usable (0)', 'F4=F4 · note vs DeviceId (1)',
  ]);
});
t('search finds a room by the words in its flags', () => {
  const page = runPage(payloadOf(fixture()), '?v=rooms&q=' + encodeURIComponent('names P2-0556'));
  assert.strictEqual(rowsOf(page.html('tableBody')).length, 1);
});
t('the CSV carries heartbeat state and findings, exactly what is on screen', () => {
  const page = runPage(payloadOf(fixture()), '?v=rooms');
  const lines = page.csv().split('\r\n');
  const head = lines[0].split(',');
  assert.ok(head.includes('Heartbeat') && head.includes('Findings'), lines[0]);
  const col = (line, name) => {
    // Enough CSV for this fixture: no field here holds an embedded comma except quoted ones.
    const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'));
    return cells[head.indexOf(name)];
  };
  const byRoom = (p, rm) => lines.find((l) => l.startsWith(p + ',') && col(l, 'Room') === rm);
  assert.strictEqual(col(byRoom('6197', '103'), 'Heartbeat'), 'No device');
  assert.strictEqual(col(byRoom('6197', '101'), 'Heartbeat'), '< 2 days');
  assert.strictEqual(keep(col(byRoom('6178', '101'), 'Findings')), 'F4: note names P2-0556; DeviceId shows P2-0101');
  assert.strictEqual(lines.length, 1 + 6);
});

// ===========================================================================
console.log('\nPAGE: Reconciliation');

t('a findings summary gives F1-F4 counts, F2 with its coverage (D12)', () => {
  const d = fixture();
  d.findings.f2Coverage = {
    6197: { deviceRows: 91, checkable: 85, pctCheckable: 93.4 },
    6178: { deviceRows: 102, checkable: 88, pctCheckable: 86.3 },
    9502: { deviceRows: 109, checkable: 35, pctCheckable: 32.1 },
  };
  d.findings.f4Unnamed = [{ flag: 'F4', property: '6178', room: '302', sheetRow: 20, kind: 'unnamed', deviceId: null }];
  const page = runPage(payloadOf(d));
  const s = page.html('reconFindings');
  const count = (code) => Number((s.match(new RegExp('<td[^>]*data-label="Flag"><b>' + code + '</b></td>[\\s\\S]*?data-label="Count"><b>(\\d+)</b>')) || [])[1]);
  assert.deepStrictEqual(keep(['F1', 'F2', 'F3', 'F4'].map(count)), [1, 0, 0, 1]);
  assert.ok(s.includes('6197 93.4&nbsp;% &middot; 6178 86.3&nbsp;% &middot; 9502 32.1&nbsp;%'), s);
  assert.ok(/\+1 note records a replacement without naming the unit/.test(s), s);
});
t('each finding count links to All rooms filtered to that finding', () => {
  const page = runPage(payloadOf(fixture()));
  assert.ok(/data-goto="rooms" data-flag="F4"/.test(page.html('reconFindings')));
  page.goto({ 'data-goto': 'rooms', 'data-flag': 'F4' });
  assert.strictEqual(rowsOf(page.html('tableBody')).length, 1);
  assert.strictEqual(page.el('fFlag').value, 'F4');
});
t('live-but-unmapped rows say how they were attributed (D2)', () => {
  const d = fixture();
  d.reconciliation.liveButUnmapped.push({
    property: '9502', propertyName: NAMES[9502], deviceName: 'P2-0032', deviceId: hex(32), deviceIdShort: '000032',
    group: null, groups: ['baseline_6_shelves'], attribution: 'exportLocation', lastHeard: BUILT, ageDays: 0.4,
  });
  d.particle.unmappedLive = 2;
  d.particle.unmappedLiveByGroup = { 6197: 1, 9502: 1 };
  const page = runPage(payloadOf(d));
  const how = [...page.html('reconBlocks').matchAll(/data-label="Attributed by">([^<]*)</g)].map((m) => m[1]);
  assert.deepStrictEqual(keep(how), ['tag esa-6197', 'attributed by export Location']);
  assert.ok(!/unattributed/.test(page.html('reconBlocks')));
});
t('the fleet strip no longer explains an untagged pool', () => {
  const hist = [
    { date: '2026-09-24', triageRows: 60, unmappedLive: 73, properties: {} },
    { date: '2026-09-25', triageRows: 62, unmappedLive: 73, properties: {} },
  ];
  const page = runPage(payloadOf(fixture(), hist));
  assert.ok(!/property group tag at all/.test(page.html('fleetStrip')));
  assert.ok(!/fleetnote/.test(page.html('fleetStrip')));
});

// ---------------------------------------------------------------------------
console.log('\n' + (fail ? 'FAILED ' : 'ALL PASS ') + pass + ' passed, ' + fail + ' failed');
// Evidence the zone really changed: the host offset at the export instant.
console.log('HOST_OFFSET ' + new Date('2026-09-25T16:48:26Z').getTimezoneOffset());
console.log('DIGEST ' + crypto.createHash('sha256').update(JSON.stringify(seen)).digest('hex'));
process.exit(fail ? 1 : 0);

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
  const daysSilent = spec.daysSilent !== undefined ? spec.daysSilent
    : bucket === 'fresh' ? 0.5 : bucket === 'aging' ? 3 : bucket === 'stale' ? 30 : null;
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
    batteryClass: spec.batteryClass || (spec.battery === null ? 'unknown' : 'ok'),
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
        namedUnit: 'P2-0556', namedDeviceId: hex(556), namedDeviceName: 'P2-0556', namedHeartbeatBucket: 'fresh', namedDaysSilent: 0.4,
        reason: 'DeviceId shows another unit', deviceId: hex(101), deviceIdCell: 'formula' }],
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

function runPage(payload, search = '', opts = {}) {
  const els = new Map();
  const blobs = [];
  const urls = []; // every address the page wrote with replaceState, in order
  const focused = { id: null }; // the element the page last moved focus to
  // The viewer's clock. With opts.now, Date.now() and a bare new Date() read
  // it; every other use of Date is the real one. Without it the page runs on
  // the real clock, as it always has. Interval timers never fire on their own:
  // advance() moves the clock and fires each one as often as its period says.
  const clock = { now: opts.now };
  const timers = [];
  class ClockDate extends Date {
    constructor(...a) {
      if (a.length) super(...a);
      else super(clock.now);
    }
    static now() { return clock.now; }
  }
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
      focus() { focused.id = this.id; },
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
  const created = []; // every element the page made itself: the CSV links carry their file name
  const document = {
    getElementById: byId,
    createElement: (tag) => { const e = mk(null, tag); created.push(e); return e; },
    querySelectorAll: (sel) => (sel === '#tabs button' ? tabs : []),
    addEventListener: (ev, fn) => docListeners.push([ev, fn]),
    body: { appendChild() {}, removeChild() {} },
  };
  class FakeBlob {
    constructor(parts) { blobs.push(parts.join('')); }
  }
  const ctx = {
    document,
    location: { search, hash: opts.hash || '', pathname: '/' },
    history: { replaceState(s, t, u) { urls.push(u); } },
    URLSearchParams,
    Blob: FakeBlob,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    setInterval: (fn, ms) => timers.push({ fn, ms, next: clock.now + ms }),
    console,
  };
  if (opts.now !== undefined) ctx.Date = ClockDate;
  // opts.tolerateThrow keeps what the page drew before it threw, as error.
  let error = null;
  try {
    vm.runInNewContext(PAGE_SCRIPT, ctx, { filename: 'template.html' });
  } catch (e) {
    if (!opts.tolerateThrow) throw e;
    error = e;
  }
  return {
    error,
    html: (id) => byId(id).innerHTML,
    text: (id) => byId(id).textContent,
    el: byId,
    ids: () => [...els.keys()],
    url: () => urls[urls.length - 1],
    focused: () => focused.id,
    intervals: () => timers.map((x) => x.ms),
    advance(ms) {
      const end = clock.now + ms;
      for (;;) {
        const due = timers.filter((x) => x.next <= end).sort((a, b) => a.next - b.next)[0];
        if (!due) break;
        clock.now = due.next;
        due.next += due.ms;
        due.fn();
      }
      clock.now = end;
    },
    csv() {
      byId('fCsv').click();
      return blobs[blobs.length - 1].replace(/^﻿/, '');
    },
    // A link or button the page drew, clicked: attrs are its attributes. closest()
    // matches an [attr] selector only when the element carries that attribute,
    // as a browser would. mods holds modifier keys (e.g. { metaKey: true }).
    // Returns whether the page kept the browser from following it.
    goto(attrs, mods = {}) {
      const target = { getAttribute: (k) => (k in attrs ? attrs[k] : null) };
      const closest = (sel) => {
        const m = /^\[([\w-]+)\]$/.exec(sel);
        return !m || m[1] in attrs ? target : null;
      };
      let prevented = false;
      for (const [ev, fn] of docListeners) {
        if (ev === 'click') fn({ target: { closest }, preventDefault() { prevented = true; }, ...mods });
      }
      return prevented;
    },
    // A worklist's CSV, as its Download CSV button makes it: [text, file name].
    listCsv(key) {
      const before = blobs.length;
      this.goto({ 'data-csv': key });
      if (blobs.length === before) return null;
      const link = created.filter((e) => e.tagName === 'a').pop();
      return [blobs[blobs.length - 1].replace(/^﻿/, ''), link && link.download];
    },
  };
}
const rowsOf = (html) => (html.match(/<tr>[\s\S]*?<\/tr>/g) || []);
const titlesOf = (html, cls) => [...html.matchAll(new RegExp('<span class="' + cls + '[^"]*" title="([^"]*)"', 'g'))].map((m) => m[1]);
const ENTITIES = { quot: '"', lt: '<', gt: '>', middot: '·', ndash: '–', mdash: '—', nbsp: ' ', rsquo: '’', rarr: '→', amp: '&' };
const unesc = (s) => s.replace(/&(\w+);/g, (m, e) => (e in ENTITIES ? ENTITIES[e] : m));

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
  assert.ok(/href="\?v=rooms&amp;flag=F4" data-goto="rooms"/.test(page.html('reconFindings')), page.html('reconFindings'));
  page.goto({ 'data-goto': 'rooms', href: '?v=rooms&flag=F4' });
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
t('duplicated room rows are described in the consolidated sheet’s terms, not the retired Room Status tab', () => {
  const s = runPage(payloadOf(fixture())).html('reconBlocks');
  assert.ok(/roomstatus tab/.test(s), s.slice(0, 400));
  assert.ok(!/Room Status/.test(s));
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

// ===========================================================================
console.log('\nTRENDS: the window is the last 30 calendar days (H1)');

// A daily record as snapshot.js writes it, for a day given as an offset from
// the build date (0 = the build's own UTC date, -29 = the window's first day).
const addDays = (ymd, n) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const END = BUILT.slice(0, 10);
const rec = (offset, triageRows, extra = {}) => ({
  date: addDays(END, offset), builtAt: addDays(END, offset) + 'T11:00:00.000Z', triageRows, unmappedLive: 3, liveUnder2d: 160,
  properties: {
    6197: { rooms: 94, ok: 60, issue: 30, check: 4, liveUnder2d: 50, unmappedLive: 1 },
    6178: { rooms: 109, ok: 20, issue: 80, check: 9, liveUnder2d: 45, unmappedLive: 0 },
    9502: { rooms: 116, ok: 70, issue: 40, check: 6, liveUnder2d: 65, unmappedLive: 2 },
    9829: { rooms: 118, ok: 1, issue: 2, check: 3 },
  },
  ...extra,
});
const TRENDS0 = { windowDays: 30, annotations: [] };

t('the window runs from 29 days before the build date to the build date, inclusive', () => {
  const p = R.buildPayload(fixture(), [], TRENDS0);
  assert.deepStrictEqual(keep([p.trends.windowDays, p.trends.windowStart, p.trends.windowEnd]), [30, '2026-08-27', '2026-09-25']);
});
t('records are kept by date, not by count: both edges in, one day beyond out, a future date out', () => {
  const records = [rec(-40, 1), rec(-30, 2), rec(-29, 3), rec(-10, 4), rec(-1, 5), rec(0, 6), rec(1, 7)];
  const p = R.buildPayload(fixture(), records, TRENDS0);
  assert.deepStrictEqual(keep(p.history.map((h) => h.date)), ['2026-08-27', '2026-09-15', '2026-09-24', '2026-09-25']);
});
t('fewer records than days never pulls in an older record to make up the count', () => {
  const p = R.buildPayload(fixture(), [rec(-45, 1), rec(-31, 1), rec(-5, 1)], TRENDS0);
  assert.deepStrictEqual(p.history.map((h) => h.date), ['2026-09-20']);
});
t('records are sorted by date, and one with no readable date is left out', () => {
  const odd = { ...rec(-3, 9), date: '9/22/2026' };
  const p = R.buildPayload(fixture(), [rec(-1, 1), odd, rec(-7, 2), null], TRENDS0);
  assert.deepStrictEqual(p.history.map((h) => h.date), ['2026-09-18', '2026-09-24']);
});
t('a removed property is trimmed from records; fleet fields and absent fields are left as recorded', () => {
  const old = rec(-2, 236);
  delete old.liveUnder2d;
  delete old.properties['6178'].unmappedLive;
  const p = R.buildPayload(fixture(), [old], TRENDS0);
  const h = p.history[0];
  assert.deepStrictEqual(keep(Object.keys(h.properties).sort()), ['6178', '6197', '9502']);
  assert.strictEqual(h.triageRows, 236);
  assert.strictEqual('liveUnder2d' in h, false, 'absent stays absent: the gap rule');
  assert.strictEqual('unmappedLive' in h.properties['6178'], false);
});

// ===========================================================================
console.log('\nTRENDS: annotations declare their charts (H2)');

t('each existing annotation carries the scope its comment describes', () => {
  const { TRENDS } = require('./config');
  assert.deepStrictEqual(keep(TRENDS.annotations.map((a) => [a.date, a.label, a.charts])), [
    ['2026-08-20', '9829 removed', ['fleet']],
    ['2026-08-27', '6178 room map overridden', ['fleet', '6178']],
    ['2026-08-27', '6197 + 9502 room overrides', ['fleet', '6197', '9502']],
    ['2026-08-29', '6178 room map filled in', ['fleet', '6178']],
    ['2026-09-26', 'consolidated sheet', 'all'],
  ]);
  assert.deepStrictEqual(R.annotationProblems(TRENDS, ['6197', '6178', '9502']), []);
});
t('an annotation must declare fleet, a configured property, or all', () => {
  const codes = ['6197', '6178', '9502'];
  const probs = (a) => R.annotationProblems({ windowDays: 30, annotations: [a] }, codes);
  assert.deepStrictEqual(probs({ date: '2026-09-25', label: 'x', charts: 'all' }), []);
  assert.deepStrictEqual(probs({ date: '2026-09-25', label: 'x', charts: ['fleet', '9502'] }), []);
  for (const bad of [
    { date: '2026-09-25', label: 'no scope' },
    { date: '2026-09-25', label: 'empty', charts: [] },
    { date: '2026-09-25', label: 'typo', charts: ['6187'] },
    { date: '2026-09-25', label: 'word', charts: 'fleet' },
    { date: '9/25/2026', label: 'date', charts: 'all' },
    { date: '2026-09-25', label: '', charts: 'all' },
  ]) {
    assert.strictEqual(probs(bad).length, 1, JSON.stringify(bad));
  }
});
t('the payload carries each annotation with its charts', () => {
  const trends = { windowDays: 30, annotations: [{ date: '2026-09-25', label: 'consolidated sheet', charts: 'all' }] };
  assert.deepStrictEqual(keep(R.buildPayload(fixture(), [], trends).trends.annotations),
    [{ date: '2026-09-25', label: 'consolidated sheet', charts: 'all' }]);
});

// ===========================================================================
console.log('\nTRENDS: what the page draws');

// The fleet triage chart is 260 wide with 2.5 of padding; x is linear in the day.
const FLEET_W = 260;
const xOf = (day, w = FLEET_W, days = 30) => (2.5 + (day / (days - 1)) * (w - 5)).toFixed(1);
const svgsOf = (html) => html.match(/<svg[\s\S]*?<\/svg>/g) || [];
const pathsOf = (svg) => [...svg.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
const xsOfPath = (d) => [...d.matchAll(/[ML](-?[\d.]+) /g)].map((m) => m[1]);
const dotsOf = (svg) => [...svg.matchAll(/<circle cx="([\d.]+)"/g)].map((m) => m[1]);
const marksOf = (svg) => [...svg.matchAll(/<line x1="([\d.]+)"/g)].map((m) => m[1]);
const pageWith = (records, annotations = []) => runPage(R.buildPayload(fixture(), records, { windowDays: 30, annotations }));

t('a missing day breaks the line: points sit on their calendar day, not beside each other', () => {
  // Days 20..23 recorded, 24..27 missing, 28 and 29 recorded.
  const page = pageWith([-9, -8, -7, -6, -1, 0].map((o, i) => rec(o, 100 + i)));
  const triage = svgsOf(page.html('fleetStrip'))[0];
  const paths = pathsOf(triage);
  assert.strictEqual(keep(paths.length), 2);
  assert.deepStrictEqual(keep(xsOfPath(paths[0])), [xOf(20), xOf(21), xOf(22), xOf(23)]);
  assert.deepStrictEqual(xsOfPath(paths[1]), [xOf(28), xOf(29)]);
});
t('a lone day between two gaps is drawn as a dot at its own date', () => {
  const page = pageWith([rec(-20, 5), rec(-10, 6), rec(-9, 7), rec(0, 8)]);
  const triage = svgsOf(page.html('fleetStrip'))[0];
  assert.deepStrictEqual(keep(dotsOf(triage)), [xOf(9), xOf(29)]);
  assert.deepStrictEqual(pathsOf(triage).map(xsOfPath), [[xOf(19), xOf(20)]]);
});
t('the window edges: the first day draws at the left pad, the build date at the right', () => {
  const page = pageWith([rec(-29, 1), rec(-28, 2), rec(-1, 3), rec(0, 4)]);
  const xs = pathsOf(svgsOf(page.html('fleetStrip'))[0]).flatMap(xsOfPath);
  assert.deepStrictEqual(keep(xs), ['2.5', xOf(1), xOf(28), '257.5']);
});
t('the same gap shows on every chart: fleet, and each card', () => {
  const page = pageWith([-12, -11, -10, -1, 0].map((o) => rec(o, 50)));
  const fleet = svgsOf(page.html('fleetStrip'));
  const cards = svgsOf(page.html('cards'));
  assert.strictEqual(fleet.length, 2);
  assert.ok(cards.length >= 6, 'status and live charts on three cards');
  for (const svg of fleet.concat(cards)) {
    // Every line in every chart is split at the gap: each path lies wholly on
    // one side of it, and each chart has a path on both sides.
    const w = Number(svg.match(/width="(\d+)"/)[1]);
    const paths = pathsOf(svg).map((d) => xsOfPath(d).map(Number));
    const before = paths.filter((xs) => xs.every((x) => x <= Number(xOf(19, w))));
    const after = paths.filter((xs) => xs.every((x) => x >= Number(xOf(28, w))));
    assert.strictEqual(before.length + after.length, paths.length, 'a path crosses the gap: ' + svg.slice(0, 300));
    assert.ok(before.length && after.length && before.length === after.length, svg.slice(0, 300));
  }
});
t('the key under a line counts days, and says how many were not recorded', () => {
  const page = pageWith([-9, -8, -7, -6, -1, 0].map((o) => rec(o, 60)));
  const sd = page.html('fleetStrip').match(/<span class="muted sdays">([^<]*)<\/span>/)[1];
  assert.strictEqual(keep(unesc(sd)), 'over 10 days · 4 not recorded');
  const full = pageWith([-2, -1, 0].map((o) => rec(o, 60))).html('fleetStrip').match(/<span class="muted sdays">([^<]*)<\/span>/)[1];
  assert.strictEqual(full, 'over 3 days');
});
t('the caption names the window by date and the days with no record', () => {
  const page = pageWith([-29, -28, -9, -8, -7, 0].map((o) => rec(o, 60)));
  const cap = unesc(page.html('fleetStrip').match(/<div class="trendcap">([\s\S]*?)<\/div>/)[1]);
  assert.ok(cap.includes('Trends cover the last 30 days, Aug 27 – Sep 25.'), cap);
  assert.ok(cap.includes('No daily record for Aug 29 – Sep 15 and Sep 19 – Sep 24.'), cap);
  assert.ok(/gap, never as a zero/.test(cap), cap);
  keep(cap);
});
t('a field that starts partway through the window is named in the caption; one present throughout is not', () => {
  const early = rec(-5, 60);
  delete early.liveUnder2d;
  const page = pageWith([early, rec(-4, 60), rec(0, 60)]);
  const cap = unesc(page.html('fleetStrip').match(/<div class="trendcap">([\s\S]*?)<\/div>/)[1]);
  assert.ok(/began Sep 21 2026/.test(cap), cap);
  const plain = pageWith([rec(-4, 60), rec(0, 60)]);
  assert.ok(!/began/.test(plain.html('fleetStrip')));
});
t('a series with one point shows its value and the day tracking started, zone-free', () => {
  const page = pageWith([rec(-3, 77)]);
  const txt = page.html('fleetStrip').match(/<div class="collecting">([\s\S]*?)<\/div>/)[1];
  assert.strictEqual(keep(unesc(txt.replace(/<[^>]+>/g, ''))), '77 triage rows · tracking since Sep 22');
});
t('same-day marker: two annotations on one date draw one line, at that date, and both are named', () => {
  const page = pageWith([-12, -11, -10, -1, 0].map((o) => rec(o, 50)), [
    { date: addDays(END, -11), label: 'first', charts: ['fleet', '6178'] },
    { date: addDays(END, -11), label: 'second', charts: ['fleet', '6197'] },
  ]);
  const fleet = svgsOf(page.html('fleetStrip'));
  assert.deepStrictEqual(keep(fleet.map(marksOf)), [[xOf(18)], [xOf(18)]], 'both fleet charts, one line each');
  const annos = page.html('fleetStrip').match(/<div class="annos">([\s\S]*?)<\/div>/)[1];
  assert.deepStrictEqual(keep([...annos.matchAll(/&middot; ([^<]*)<\/span>/g)].map((m) => m[1])), ['first', 'second']);
});
t('a scoped annotation draws only on the charts it names', () => {
  const page = pageWith([-12, -11, -10, -1, 0].map((o) => rec(o, 50)), [
    { date: addDays(END, -11), label: '6178 only', charts: ['6178'] },
    { date: addDays(END, -1), label: 'fleet only', charts: ['fleet'] },
  ]);
  const cards = page.html('cards').split('<div class="card">').slice(1);
  const marks = (html) => svgsOf(html).map(marksOf);
  assert.ok(marks(page.html('fleetStrip')).every((m) => m.length === 1 && m[0] === xOf(28)));
  assert.ok(marks(cards[1]).every((m) => m.length === 1), '6178: every chart marked');
  assert.ok(marks(cards[0]).every((m) => m.length === 0), '6197: unmarked');
  assert.ok(/6178 only/.test(cards[1]) && !/6178 only/.test(cards[0]) && !/fleet only/.test(cards[1]));
});
t('an "all" annotation draws on every chart and is named on every card and the fleet strip', () => {
  const page = pageWith([-12, -11, -10, -1, 0].map((o) => rec(o, 50)), [{ date: END, label: 'consolidated sheet', charts: 'all' }]);
  const all = svgsOf(page.html('fleetStrip')).concat(svgsOf(page.html('cards')));
  assert.ok(all.length >= 8);
  for (const svg of all) {
    const w = Number(svg.match(/width="(\d+)"/)[1]);
    assert.deepStrictEqual(marksOf(svg), [xOf(29, w)]);
  }
  assert.strictEqual((page.html('cards').match(/consolidated sheet/g) || []).length, 3);
  assert.ok(/consolidated sheet/.test(page.html('fleetStrip')));
});
t('an annotation on a day with no record is not drawn (the record carries the step)', () => {
  const page = pageWith([rec(-12, 50), rec(-11, 50), rec(0, 50)], [{ date: addDays(END, -5), label: 'nothing here', charts: 'all' }]);
  assert.ok(svgsOf(page.html('fleetStrip')).every((s) => marksOf(s).length === 0));
  assert.ok(!/nothing here/.test(page.html('fleetStrip') + page.html('cards')));
});

t('the Aug 29 marker reads "6178 room map filled in" on the fleet strip and 6178’s card, and nowhere else', () => {
  const { TRENDS } = require('./config');
  const page = runPage(R.buildPayload(fixture(), [rec(-28, 60), rec(-27, 50), rec(-26, 50)], TRENDS));
  const annos = (html) => [...html.matchAll(/<span class="anno"><i><\/i>([^<]*)<\/span>/g)].map((m) => unesc(m[1]));
  const cards = page.html('cards').split('<div class="card">').slice(1);
  assert.deepStrictEqual(keep([annos(page.html('fleetStrip')), ...cards.map(annos)]),
    [['Aug 29 · 6178 room map filled in'], [], ['Aug 29 · 6178 room map filled in'], []]);
  assert.ok(!/override/.test(page.html('fleetStrip') + page.html('cards')));
  assert.deepStrictEqual(svgsOf(page.html('fleetStrip')).map(marksOf), [[xOf(2)], [xOf(2)]], 'drawn on its own date');
});
// ===========================================================================
console.log('\nPAGE: the stale-page banner (THRESHOLDS.pageAge)');

// The page judges its own age against the viewer's clock. Every case runs the
// page on a fixed clock set relative to the fixture's build time. The banner's
// date is local wall clock, so it is compared with the same formatting in this
// zone and never kept for the cross-zone digest; the day count is.
const MIN = 60000;
const HOUR = 60 * MIN;
const DAYMS = 24 * HOUR;
const AT = Date.parse(BUILT);
const fmtFull = (iso) => new Date(iso).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const bannerOf = (page) => {
  const b = page.el('staleBanner');
  return b.hidden ? null : unesc(b.innerHTML.replace(/<[^>]*>/g, ''));
};
const STALE = (n) => 'This page hasn’t refreshed since ' + fmtFull(BUILT) + ' (' + n + ' days ago). The figures may be out of date.';
const BLIND = 'This page can’t tell when it was last refreshed. The figures may be out of date.';
const daysIn = (text) => keep(Number((String(text).match(/\((\d+) days? ago\)/) || [])[1]));
const withPageAge = (pageAge) => {
  const p = payloadOf(fixture());
  // A copy: the fixture's thresholds object is config.js's own.
  p.thresholds = { ...p.thresholds, pageAge };
  return p;
};

t('the cutoff lives in config, confirmed, and reaches the page in the payload', () => {
  assert.deepStrictEqual(keep(THRESHOLDS.pageAge), { confirmed: true, maxDays: 7 });
  assert.deepStrictEqual(payloadOf(fixture()).thresholds.pageAge, { confirmed: true, maxDays: 7 });
});
t('normalized data without a usable cutoff fails the sanity check', () => {
  for (const bad of [undefined, { confirmed: true }, { confirmed: true, maxDays: 0 }, { confirmed: true, maxDays: '7' },
    { confirmed: true, maxDays: Infinity }]) {
    const d = fixture();
    d.thresholds = { ...THRESHOLDS, pageAge: bad };
    if (bad === undefined) delete d.thresholds.pageAge;
    const problems = R.sanityProblems(d);
    assert.strictEqual(problems.length, 1, JSON.stringify(bad) + ' -> ' + JSON.stringify(problems));
    assert.ok(/pageAge/.test(problems[0]), problems[0]);
  }
});
t('the banner sits above the header, outside every view, and starts hidden', () => {
  const html = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
  const tag = (html.match(/<div id="staleBanner"[^>]*>/) || [])[0];
  assert.ok(tag, 'no #staleBanner element');
  assert.ok(/\shidden[\s>]/.test(tag), tag);
  assert.ok(/\srole="alert"/.test(tag), tag);
  const at = html.indexOf(tag);
  assert.ok(at > html.indexOf('<body>') && at < html.indexOf('<header>'), 'the banner must come before the header');
});
t('6 d 23 h old, and exactly 7 d old: no banner', () => {
  assert.strictEqual(keep(bannerOf(runPage(payloadOf(fixture()), '', { now: AT + 6 * DAYMS + 23 * HOUR }))), null);
  assert.strictEqual(keep(bannerOf(runPage(payloadOf(fixture()), '', { now: AT + 7 * DAYMS }))), null);
});
t('7 d + 1 min old: the banner, with the build time in local terms and the whole days since', () => {
  const a = bannerOf(runPage(payloadOf(fixture()), '', { now: AT + 7 * DAYMS + MIN }));
  assert.strictEqual(a, STALE(7));
  assert.strictEqual(daysIn(a), 7);
  const b = bannerOf(runPage(payloadOf(fixture()), '', { now: AT + 9 * DAYMS + 23 * HOUR }));
  assert.strictEqual(b, STALE(9));
  assert.strictEqual(daysIn(b), 9);
});
t('a missing or unreadable builtAt: the banner, since the page cannot vouch for itself', () => {
  for (const v of [undefined, null, '', 'garbage', '2026-13-45T99:00:00Z', AT]) {
    const p = payloadOf(fixture());
    if (v === undefined) delete p.builtAt;
    else p.builtAt = v;
    assert.strictEqual(bannerOf(runPage(p, '', { now: AT + HOUR })), BLIND, JSON.stringify(v));
  }
  // The build refuses to ship without a cutoff; a page that has none anyway says the same.
  const p = payloadOf(fixture());
  p.thresholds = { ...p.thresholds };
  delete p.thresholds.pageAge;
  assert.strictEqual(bannerOf(runPage(p, '', { now: AT + HOUR })), BLIND);
  keep('blind');
});
t('a builtAt in the future (the viewer’s clock is behind): no banner', () => {
  for (const behind of [MIN, 3 * DAYMS, 400 * DAYMS]) {
    assert.strictEqual(keep(bannerOf(runPage(payloadOf(fixture()), '', { now: AT - behind }))), null, String(behind));
  }
});
t('left open, the page re-checks hourly: crossing the cutoff turns the banner on without a reload', () => {
  const page = runPage(payloadOf(fixture()), '', { now: AT + 6 * DAYMS + 23 * HOUR + 30 * MIN });
  assert.strictEqual(bannerOf(page), null);
  assert.deepStrictEqual(keep(page.intervals()), [HOUR]);
  page.advance(59 * MIN);
  assert.strictEqual(bannerOf(page), null, 'no check has run yet');
  page.advance(MIN);
  assert.strictEqual(bannerOf(page), STALE(7));
  page.advance(DAYMS);
  assert.strictEqual(daysIn(bannerOf(page)), 8);
});
t('an hourly check that finds the same text leaves the banner alone, so it is not announced again', () => {
  const page = runPage(payloadOf(fixture()), '', { now: AT + 8 * DAYMS });
  const el = page.el('staleBanner');
  el.innerHTML = 'untouched';
  page.advance(HOUR);
  assert.strictEqual(el.innerHTML, 'untouched');
  page.advance(DAYMS);
  assert.strictEqual(daysIn(bannerOf(page)), 9);
});
t('the banner is set before anything else, so a page that breaks further down still shows it', () => {
  const p = payloadOf(fixture());
  p.rooms = null;
  const page = runPage(p, '', { now: AT + 8 * DAYMS, tolerateThrow: true });
  assert.ok(page.error, 'this payload should break the rest of the page');
  assert.strictEqual(bannerOf(page), STALE(8));
});
t('the banner stands on every view', () => {
  for (const v of ['', '?v=rooms', '?v=recon', '?v=triage']) {
    const page = runPage(payloadOf(fixture()), v, { now: AT + 8 * DAYMS });
    assert.strictEqual(bannerOf(page), STALE(8), v);
  }
});
t('the cutoff is read from the payload, never typed into the page', () => {
  assert.strictEqual(daysIn(bannerOf(runPage(withPageAge({ confirmed: true, maxDays: 3 }), '', { now: AT + 3 * DAYMS + MIN }))), 3);
  assert.strictEqual(keep(bannerOf(runPage(withPageAge({ confirmed: true, maxDays: 30 }), '', { now: AT + 29 * DAYMS }))), null);
});
t('an unconfirmed cutoff says so on the banner', () => {
  const text = bannerOf(runPage(withPageAge({ confirmed: false, maxDays: 7 }), '', { now: AT + 8 * DAYMS }));
  assert.strictEqual(text, STALE(8) + ' (7-day cutoff unconfirmed)');
});

// ===========================================================================
console.log('\nPAGE: summary view (a presentation switch, not access control)');

/* What a viewer can see: every element the page drew, unless it or the
   region it sits in is hidden. Regions are read from template.html, so an
   element moved out of a hidden section is caught here. What the page drew
   counts attributes and all (a tooltip is one hover away). The template's
   static markup is not seen here, and the fake DOM applies no CSS: each has
   a test of its own below. The payload script is never drawn:
   it carries every room in every view, which is why summary view is not
   access control. */
const TEMPLATE_HTML = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
const REGIONS = [['view-table', '</section>'], ['view-rollup', '</section>'], ['view-recon', '</section>'],
  ['tabs', '</nav>'], ['summaryBar', '</div>']];
function regionOf(id) {
  const at = TEMPLATE_HTML.indexOf(' id="' + id + '"');
  for (const [rid, close] of REGIONS) {
    const s = TEMPLATE_HTML.indexOf(' id="' + rid + '"');
    if (id !== rid && s !== -1 && at > s && at < TEMPLATE_HTML.indexOf(close, s)) return rid;
  }
  return null;
}
function onScreen(page) {
  return page.ids().filter((id) => {
    if (id === 'payload' || page.el(id).hidden) return false;
    const r = regionOf(id);
    return !(r && page.el(r).hidden);
  }).map((id) => page.el(id).innerHTML + '\n' + page.el(id).textContent).join('\n');
}
const DEVICE_NAME = /\bP2?-\d{3,4}\b/;
const SUMMARY_HIST = [-12, -11, -10, -1, 0].map((o) => rec(o, 50));
const SUMMARY_TRENDS = { windowDays: 30, annotations: [{ date: END, label: 'consolidated sheet', charts: 'all' }] };
const summaryPayload = (data = fixture()) => R.buildPayload(data, SUMMARY_HIST, SUMMARY_TRENDS);
const modeOf = (page) => keep({
  pressed: page.el('summaryToggle').getAttribute('aria-pressed'),
  marker: !page.el('summaryBar').hidden,
  tabs: !page.el('tabs').hidden,
  views: ['view-rollup', 'view-table', 'view-recon'].filter((id) => !page.el(id).hidden),
  url: page.url(),
});
const SUMMARY_MODE = { pressed: 'true', marker: true, tabs: false, views: ['view-rollup'], url: '?view=summary' };

t('the switch is a header button with aria-pressed; the marker starts hidden and has its own way back', () => {
  const header = TEMPLATE_HTML.slice(TEMPLATE_HTML.indexOf('<header>'), TEMPLATE_HTML.indexOf('</header>'));
  const btn = (header.match(/<button\b[^>]*\bid="summaryToggle"[^>]*>/) || [])[0];
  assert.ok(btn, 'no #summaryToggle button in the header');
  assert.ok(/\saria-pressed="false"/.test(btn) && /\stype="button"/.test(btn), btn);
  const bar = (TEMPLATE_HTML.match(/<div\b[^>]*\bid="summaryBar"[^>]*>[\s\S]*?<\/div>/) || [])[0];
  assert.ok(bar, 'no #summaryBar');
  assert.ok(/^<div\b[^>]*\shidden[\s>]/.test(bar), bar);
  assert.ok(/Summary view/.test(bar), bar);
  assert.ok(/<button\b[^>]*\bid="summaryExit"/.test(bar), bar);
});
t('?view=summary opens in summary view: marker on, tabs and room views hidden, only the mode in the URL', () => {
  assert.deepStrictEqual(modeOf(runPage(summaryPayload(), '?view=summary')), SUMMARY_MODE);
});
t('without it the page opens as it always has', () => {
  assert.deepStrictEqual(modeOf(runPage(summaryPayload(), '')),
    { pressed: 'false', marker: false, tabs: true, views: ['view-rollup'], url: '?v=rollup' });
  assert.deepStrictEqual(modeOf(runPage(summaryPayload(), '?view=full&v=recon')),
    { pressed: 'false', marker: false, tabs: true, views: ['view-recon'], url: '?v=recon' });
});
t('the switch toggles the mode and the URL; switching back restores the view and its filters', () => {
  const page = runPage(summaryPayload(), '?v=rooms&prop=6178&status=attention');
  const normal = { pressed: 'false', marker: false, tabs: true, views: ['view-table'], url: '?v=rooms&prop=6178&status=attention' };
  assert.deepStrictEqual(modeOf(page), normal);
  page.el('summaryToggle').click();
  assert.deepStrictEqual(modeOf(page), SUMMARY_MODE);
  page.el('summaryToggle').click();
  assert.deepStrictEqual(modeOf(page), normal);
  assert.strictEqual(rowsOf(page.html('tableBody')).length, 1);
  // The marker's own button is the one-click way back, and focus does not
  // vanish with the bar that held it.
  page.el('summaryToggle').click();
  page.el('summaryExit').click();
  assert.deepStrictEqual(modeOf(page), normal);
  assert.strictEqual(page.focused(), 'summaryToggle');
});
t('the stylesheet lets [hidden] win over the flex display the tabs and the marker are given', () => {
  // The browser's own [hidden] rule loses to any author display rule, and nav
  // and .viewbar have one: without these the tabs show in summary and the
  // marker in the full view.
  const css = TEMPLATE_HTML.match(/<style>([\s\S]*?)<\/style>/)[1];
  const hiders = [...css.matchAll(/([^{}]+)\{\s*display:\s*none;?\s*\}/g)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim()));
  for (const sel of ['section[hidden]', 'nav[hidden]', '.viewbar[hidden]']) assert.ok(hiders.includes(sel), sel);
  assert.ok(/<nav id="tabs"/.test(TEMPLATE_HTML) && /<div id="summaryBar" class="viewbar"/.test(TEMPLATE_HTML));
});
t('the template’s own markup outside the room views names no device and quotes no note', () => {
  let html = TEMPLATE_HTML.slice(TEMPLATE_HTML.indexOf('<body>'), TEMPLATE_HTML.indexOf('<script'));
  for (const [open, close] of [['<nav id="tabs"', '</nav>'], ['<section id="view-table"', '</section>'], ['<section id="view-recon"', '</section>']]) {
    const s = html.indexOf(open);
    html = html.slice(0, s) + html.slice(html.indexOf(close, s));
  }
  assert.ok(/id="summaryToggle"/.test(html) && /id="summaryBar"/.test(html), 'the header and marker are scanned');
  assert.ok(!DEVICE_NAME.test(html), (html.match(DEVICE_NAME) || [])[0]);
});
t('with both ?view=summary and ?v=, summary wins; leaving it lands on the ?v= view', () => {
  for (const s of ['?v=rooms&view=summary', '?view=summary&v=recon', '?v=triage&view=summary']) {
    assert.deepStrictEqual(modeOf(runPage(summaryPayload(), s)), SUMMARY_MODE, s);
  }
  const page = runPage(summaryPayload(), '?v=triage&view=summary');
  page.el('summaryExit').click();
  assert.deepStrictEqual(modeOf(page).url, '?v=rooms&status=attention');
  assert.strictEqual(page.el('fStatus').value, 'attention');
});
t('summary shows each card: Ok / Issue / Check, triage count, heartbeat buckets, battery classes, battery badge', () => {
  const page = runPage(summaryPayload(), '?view=summary');
  const cards = page.html('cards').split('<div class="card">').slice(1);
  assert.strictEqual(cards.length, 3);
  const kpi = (card, label) => Number((card.match(new RegExp('<div class="v"[^>]*>(\\d+)</div><div class="l">' + label + '</div>')) || [])[1]);
  assert.deepStrictEqual(keep(cards.map((c) => kpi(c, 'Triage'))), [1, 1, 0], 'Issue + Check per property');
  assert.deepStrictEqual(keep(cards.map((c) => ['Rooms', 'Reporting', 'Never heard', 'No device'].map((l) => kpi(c, l)))),
    [[3, 2, 0, 1], [2, 2, 0, 0], [1, 1, 0, 0]]);
  for (const c of cards) {
    const mix = [...c.matchAll(/<span style="width:[^"]*" title="([^"]*)"/g)].map((m) => m[1].split(':')[0]);
    assert.ok(['Ok', 'Check', 'Issue'].every((s) => mix.includes(s)), mix.join());
    assert.deepStrictEqual([...c.matchAll(/<span class="bl">([^<]*)<\/span>/g)].map((m) => unesc(m[1])),
      ['< 2 days', '2-7 days', '> 7 days', 'Never', 'No device']);
    assert.ok(/<div class="mh">Battery/.test(c) && /Healthy <span class="n">\d+/.test(c), c.slice(0, 300));
    assert.ok(c.includes('<div class="fl">Battery data</div>') && c.includes('~8.0d old'));
    assert.ok(/Sheet export as of <b>/.test(c));
  }
});
t('summary shows the three stamps, and the status, live and fleet triage trends with their markers', () => {
  const page = runPage(summaryPayload(), '?view=summary');
  const fmt = (iso) => new Date(iso).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  assert.deepStrictEqual([page.text('sheetAsOf'), page.text('hbAsOf'), page.text('builtAt')],
    [fmt('2026-09-25T16:48:26.425Z'), fmt(BUILT), fmt(BUILT)]);
  const fleet = svgsOf(page.html('fleetStrip'));
  assert.strictEqual(keep(fleet.length), 1, 'the fleet triage trend only');
  assert.ok(/<div class="mh">Triage rows<\/div>/.test(page.html('fleetStrip')));
  const cards = page.html('cards').split('<div class="card">').slice(1);
  for (const c of cards) {
    assert.ok(/<div class="mh">Status trend<\/div>/.test(c) && /<div class="mh">Devices heard from<\/div>/.test(c));
    assert.strictEqual(svgsOf(c).length, 2, 'status and live, nothing else');
  }
  for (const svg of fleet.concat(svgsOf(page.html('cards')))) {
    assert.deepStrictEqual(marksOf(svg), [xOf(29, Number(svg.match(/width="(\d+)"/)[1]))]);
  }
  assert.strictEqual((page.html('cards').match(/consolidated sheet/g) || []).length, 3);
  assert.ok(/consolidated sheet/.test(page.html('fleetStrip')));
});
t('summary hides the room list, Reconciliation, the tabs with their counts, and the CSV export', () => {
  // Where each lives in the template: every one sits in a region summary hides.
  assert.deepStrictEqual(keep(['tableBody', 'fCsv', 'fSearch', 'nRooms', 'nRecon', 'reconFindings', 'reconNotes', 'reconBlocks']
    .map(regionOf)), ['view-table', 'view-table', 'view-table', 'tabs', 'tabs', 'view-recon', 'view-recon', 'view-recon']);
  const page = runPage(summaryPayload(), '?view=summary');
  for (const id of ['view-table', 'view-recon', 'tabs']) assert.strictEqual(page.el(id).hidden, true, id);
  assert.strictEqual(page.html('tableBody'), '', 'a cold summary load never draws the room list');
});
t('summary hides findings, F2 coverage and every awaiting-room-mapping count and chart', () => {
  const d = fixture();
  d.properties[1].rooms[1].flags = [{ code: 'F1', text: 'P2-0433 is also listed in 9502/308, another property' }];
  const normal = onScreen(runPage(summaryPayload(d), '')) + onScreen(runPage(summaryPayload(d), '?v=recon'));
  assert.ok(/awaiting room mapping/.test(normal) && /F2 can only check/.test(normal) && /data-goto/.test(normal), 'control');
  const s = onScreen(runPage(summaryPayload(d), '?view=summary'));
  for (const re of [/awaiting room mapping/i, /Live, awaiting/, /class="flag/, /F2 can only check/, /Sheet findings/,
    /data-goto/, /Reconciliation/, /\bF[1-4]\b/]) {
    assert.ok(!re.test(s), re + ' is on screen: ' + (s.match(re) || [])[0]);
  }
});
t('nothing on screen in summary names a device or quotes a note, loaded cold or switched from any view', () => {
  const d = fixture();
  d.properties[0].rooms[1].notes = 'Guest says the head drips';
  d.reconciliation.duplicateRoomRows = [{ property: '6197', propertyName: NAMES[6197], room: '102', count: 2,
    entries: [{ status: 'Issue', actionItem: 'None', notes: 'Second row says it drips too' }] }];
  const p = summaryPayload(d);
  const NOTE = /head drips|drips too|Replaced with/;
  const control = onScreen(runPage(p, '?v=rooms')) + onScreen(runPage(p, '?v=recon'));
  assert.ok(DEVICE_NAME.test(control) && NOTE.test(control), 'control: the full views do show them');
  const switched = (from) => { const x = runPage(p, from); x.el('summaryToggle').click(); return x; };
  for (const [label, page] of [['cold', runPage(p, '?view=summary')], ['from rooms', switched('?v=rooms&q=P2')],
    ['from recon', switched('?v=recon')], ['from rollup', switched('')]]) {
    const s = onScreen(page);
    assert.ok(!DEVICE_NAME.test(s), label + ': ' + (s.match(DEVICE_NAME) || [])[0]);
    assert.ok(!NOTE.test(s), label + ': ' + (s.match(NOTE) || [])[0]);
    assert.strictEqual(page.url(), '?view=summary', label + ': no search text or filter left in the address bar');
  }
});
t('the caption names awaiting room mapping in the full view only, and is otherwise the same sentence', () => {
  const early = [-12, -11].map((o) => { const r = rec(o, 50); delete r.liveUnder2d; return r; });
  const p = R.buildPayload(fixture(), early.concat([-10, -1, 0].map((o) => rec(o, 50))), SUMMARY_TRENDS);
  const cap = (search) => unesc(runPage(p, search).html('fleetStrip').match(/<div class="trendcap">([\s\S]*?)<\/div>/)[1]);
  const full = cap('');
  const sum = cap('?view=summary');
  assert.ok(full.endsWith(' Live-series tracking — devices heard from, and devices awaiting room mapping — began Sep 15 2026.'), full);
  assert.ok(sum.endsWith(' Live-series tracking — devices heard from — began Sep 15 2026.'), sum);
  assert.strictEqual(sum, full.replace(', and devices awaiting room mapping', ''));
  keep(sum);
});
t('a card’s duplicated-rows caveat stays in summary: it qualifies the room count on screen and names no room', () => {
  const d = fixture();
  d.properties[0] = property('6197', d.properties[0].rooms.concat([room('6197', 102, { status: 'Issue', notes: 'Second row for this room' })]));
  const card = runPage(summaryPayload(d), '?view=summary').html('cards').split('<div class="card">')[1];
  const note = unesc((card.match(/<div class="cardnote">([\s\S]*?)<\/div>/) || [])[1] || '');
  assert.strictEqual(keep(note), '4 rows cover 3 distinct rooms — some rooms appear twice.');
});
t('the stale banner stands in summary view, and switching does not touch it', () => {
  const page = runPage(payloadOf(fixture()), '?view=summary', { now: AT + 8 * DAYMS });
  assert.strictEqual(bannerOf(page), STALE(8));
  page.el('summaryExit').click();
  assert.strictEqual(bannerOf(page), STALE(8));
  page.el('summaryToggle').click();
  assert.strictEqual(daysIn(bannerOf(page)), 8);
  assert.strictEqual(keep(bannerOf(runPage(payloadOf(fixture()), '?view=summary', { now: AT + HOUR }))), null);
});
t('the normal view is unchanged: no triage KPI, awaiting lines kept, and a summary round trip redraws it exactly', () => {
  const page = runPage(summaryPayload(), '');
  const before = [page.html('cards'), page.html('fleetStrip')];
  assert.ok(!/<div class="l">Triage<\/div>/.test(before[0]));
  assert.ok(/awaiting room mapping/.test(before[0]) && /Live, awaiting room mapping/.test(before[1]));
  assert.strictEqual(svgsOf(before[1]).length, 2);
  page.el('summaryToggle').click();
  assert.notStrictEqual(page.html('fleetStrip'), before[1]);
  page.el('summaryToggle').click();
  assert.deepStrictEqual([page.html('cards'), page.html('fleetStrip')], before);
  keep(before[1].length);
});

// ===========================================================================
console.log('\nPAGE: Reconciliation worklists (Block 4)');

/* A fixture with a room for every reason a worklist takes one, and rooms that
   must stay off each list. Findings are in normalize's shape, notes on the
   room rows as render.js ships them; F4 is listed out of order on purpose. */
function listFixture() {
  const F4 = (text, extra = {}) => ({ flags: [{ code: 'F4', text, ...extra }] });
  const props = [
    property('6197', [
      room('6197', 101), // Ok, fresh, healthy: on no list
      room('6197', 102, { status: 'Issue' }),
      room('6197', 103, { deviceId: null }), // Ok, no device
      room('6197', 104, { battery: 3.05, batteryClass: 'critical', daysSilent: 1.2 }), // Ok, battery only
      room('6197', 105, { bucket: 'stale', daysSilent: 12.5, battery: 3.1, batteryClass: 'critical' }), // Ok, two reasons
      room('6197', 106, { bucket: 'aging', daysSilent: 5 }), // Ok, aging is not stale
      room('6197', 107, { status: 'Issue', bucket: 'stale', daysSilent: 40, battery: 3.0, batteryClass: 'critical' }), // not Ok
      room('6197', 108, { battery: 3.3, batteryClass: 'warn' }), // Ok, marginal is not critical
    ]),
    property('6178', [
      room('6178', 101, { notes: 'Replaced with P2-0556 on 09/23/26.', ...F4('note names P2-0556; DeviceId shows P2-0101') }),
      room('6178', 101, { notes: 'Replaced batteries recently.' }), // a second row for the room, unflagged
      room('6178', 116, { deviceId: null, notes: 'Replaced with P2-0564 on 09/23/26.', ...F4('note names P2-0564; DeviceId is blank') }),
      room('6178', 302, { notes: 'Replaced device on 9/23/26.',
        ...F4('note records a replacement but names no unit; DeviceId shows P2-0302', { unnamed: true }) }),
      room('6178', 330, { bucket: 'never' }), // Ok, a device Particle never heard
      room('6178', 418, { status: 'Check', deviceName: 'P-0823', notes: 'Flashing red LED - replaced with P2-0823 on 9/16.',
        ...F4('note names P2-0823, which matches no Particle device name exactly; DeviceId shows P-0823') }),
      room('6178', 428, { status: 'Check', deviceId: hex(433), deviceName: 'P2-0433',
        flags: [{ code: 'F1', text: 'P2-0433 is also listed in 9502/308, another property' }] }),
    ]),
    property('9502', [
      room('9502', 308, { deviceId: hex(433), deviceName: 'P2-0433', bucket: 'stale', daysSilent: 30, flags: [
        { code: 'F1', text: 'P2-0433 is also listed in 6178/428, another property' },
        { code: 'F2', text: 'P2-0433 is tagged esa_6178 in Particle, which belongs to 6178' }] }),
      room('9502', 309, { bucket: 'stale', daysSilent: 90 }),
    ], '2026-09-25T16:48:36.928Z'),
  ];
  const d = fixture();
  d.properties = props;
  d.triage = props.flatMap((p) => p.rooms).filter((r) => r.status === 'Issue' || r.status === 'Check');
  const named = (rm, unit, id, bucket, days, reason, deviceId, cell, note) => ({
    flag: 'F4', property: '6178', room: rm, sheetRow: Number(rm), note, kind: 'replaced with', namedUnit: unit,
    namedDeviceId: id, namedDeviceName: id ? unit : null, namedHeartbeatBucket: bucket, namedDaysSilent: days,
    reason, deviceId, deviceIdCell: cell,
  });
  d.findings = {
    f1: fixture().findings.f1,
    f2: [{ flag: 'F2', property: '9502', room: '308', sheetRow: 308, deviceId: hex(433), deviceIdShort: '000433',
      deviceName: 'P2-0433', group: 'esa_6178', tagProperty: '6178' }],
    f2Coverage: { 6197: { deviceRows: 7, checkable: 7, pctCheckable: 100 } },
    f3: [],
    f4: [
      named('418', 'P2-0823', null, null, null, 'no exact Particle name', hex(418), 'typed', 'Flashing red LED - replaced with P2-0823 on 9/16.'),
      named('101', 'P2-0556', hex(556), 'fresh', 0.4, 'DeviceId shows another unit', hex(101), 'formula', 'Replaced with P2-0556 on 09/23/26.'),
      named('116', 'P2-0564', hex(564), 'stale', 21.3, 'DeviceId is blank', null, 'formula', 'Replaced with P2-0564 on 09/23/26.'),
    ],
    f4Unnamed: [{ flag: 'F4', property: '6178', room: '302', sheetRow: 302, note: 'Replaced device on 9/23/26.', kind: 'unnamed',
      deviceId: hex(302), deviceIdCell: 'formula' }],
    f4NotesRecognised: 4,
  };
  return d;
}
const textOf = (html) => unesc(String(html).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
function listBlock(page, key) {
  const html = page.html('reconLists');
  const at = html.indexOf(' id="list-' + key + '"');
  if (at < 0) return null;
  const next = html.indexOf(' id="list-', at + 1);
  return html.slice(at, next < 0 ? html.length : next);
}
// A list's body rows: its table header is a <tr> too.
const listRows = (block) => rowsOf((block.match(/<tbody>([\s\S]*?)<\/tbody>/) || [])[1] || '');
const headOf = (block) => [textOf(block.match(/<h2>([\s\S]*?)<\/h2>/)[1]), Number(block.match(/<span class="n">(\d+)<\/span>/)[1])];
const cellsOf = (tr) => Object.fromEntries([...tr.matchAll(/<td[^>]*\bdata-label="([^"]*)"[^>]*>([\s\S]*?)<\/td>/g)]
  .map((m) => [unesc(m[1]), textOf(m[2])]));
const whereOf = (c) => c.Prop.split(' ')[0] + '/' + c.Room;
const linksOf = (block) => [...block.matchAll(/<a\b[^>]*\bhref="(\?[^"]*)"[^>]*>([\s\S]*?)<\/a>/g)]
  .map((m) => [unesc(m[1]), textOf(m[2])]);
function parseCsv(text) {
  const out = [];
  let rowCells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { rowCells.push(cell); cell = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { rowCells.push(cell); out.push(rowCells); rowCells = []; cell = ''; i++; }
    else cell += c;
  }
  rowCells.push(cell);
  out.push(rowCells);
  return out;
}
const csvRecords = (text) => {
  const [head, ...rest] = parseCsv(text);
  return rest.map((cells) => Object.fromEntries(head.map((h, i) => [h, cells[i]])));
};
const CSV_NAME = /^shower-stream-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.csv$/;

t('the lists stand on Reconciliation, in working order, each with a count in its heading', () => {
  const page = runPage(payloadOf(listFixture()), '?v=recon');
  assert.strictEqual(regionOf('reconLists'), 'view-recon');
  const order = [...page.html('reconLists').matchAll(/ id="list-([a-z0-9]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(keep(order), ['f4', 'okbut', 'f1', 'f2', 'f3']);
  assert.deepStrictEqual(keep(order.map((k) => headOf(listBlock(page, k)))), [
    ['Replacement not in DeviceId', 4], ['Marked Ok, but…', 7], ['One device, two rooms', 1],
    ['Location vs Particle tag', 1], ['DeviceId not usable', 0],
  ]);
});
t('F4: one row per flagged room, by property then room, the unnamed note among them', () => {
  const page = runPage(payloadOf(listFixture()), '?v=recon');
  const rows = listRows(listBlock(page, 'f4')).map(cellsOf);
  assert.deepStrictEqual(keep(rows.map((c) => [whereOf(c), c['DeviceId shows'], c['Note names'], c['Named unit'], c.Cell, c.Note])), [
    ['6178/101', 'P2-0101', 'P2-0556', 'heard 10h ago', 'lookup', 'Replaced with P2-0556 on 09/23/26.'],
    ['6178/116', 'blank', 'P2-0564', 'heard 21d ago', 'lookup', 'Replaced with P2-0564 on 09/23/26.'],
    ['6178/302', 'P2-0302', 'unnamed', '—', 'lookup', 'Replaced device on 9/23/26.'],
    ['6178/418', 'P-0823', 'P2-0823', 'not in Particle', 'typed', 'Flashing red LED - replaced with P2-0823 on 9/16.'],
  ]);
});
t('F4: the named unit reads its own state - never heard, a shared name, and each heartbeat bucket in its tone', () => {
  const d = listFixture();
  const [, live, silent] = d.findings.f4;
  Object.assign(live, { namedHeartbeatBucket: 'never', namedDaysSilent: null });
  Object.assign(silent, { namedDeviceId: null, namedDeviceName: null, namedHeartbeatBucket: null, namedDaysSilent: null, reason: 'ambiguous name' });
  const block = listBlock(runPage(payloadOf(d), '?v=recon'), 'f4');
  const named = listRows(block).map(cellsOf).map((c) => c['Named unit']);
  assert.deepStrictEqual(keep(named), ['never heard', 'name not unique in Particle', '—', 'not in Particle']);
  const tone = listRows(listBlock(runPage(payloadOf(listFixture()), '?v=recon'), 'f4'))
    .map((tr) => (tr.match(/data-label="Named unit"[^>]*><span style="color:([^;"]*)/) || [])[1] || null);
  assert.deepStrictEqual(keep(tone), ['var(--good-fg)', 'var(--bad-fg)', null, null]);
});
t('F4: the CSV carries every column the list shows, plus the ids and the finding', () => {
  const [csv, name] = runPage(payloadOf(listFixture()), '?v=recon').listCsv('f4');
  assert.ok(CSV_NAME.test(name) && /-f4-/.test(name), name);
  const recs = csvRecords(csv);
  assert.deepStrictEqual(keep(Object.keys(recs[0])), ['Property', 'Property name', 'Room', 'DeviceId shows', 'DeviceId (Particle ID)',
    'Note names', 'Named unit Particle ID', 'Named unit heartbeat', 'Named unit days silent', 'DeviceId cell', 'Finding', 'Note']);
  assert.deepStrictEqual(keep(recs.map((r) => [r.Room, r['DeviceId shows'], r['DeviceId (Particle ID)'], r['Note names'],
    r['Named unit Particle ID'], r['Named unit heartbeat'], r['Named unit days silent'], r['DeviceId cell']])), [
    ['101', 'P2-0101', hex(101), 'P2-0556', hex(556), '< 2 days', '0.4', 'lookup'],
    ['116', 'blank', '', 'P2-0564', hex(564), '> 7 days', '21.3', 'lookup'],
    ['302', 'P2-0302', hex(302), 'unnamed', '', '', '', 'lookup'],
    ['418', 'P-0823', hex(418), 'P2-0823', '', 'not in Particle', '', 'typed'],
  ]);
  assert.strictEqual(recs[3].Finding, 'F4: note names P2-0823, which matches no Particle device name exactly; DeviceId shows P-0823');
  assert.strictEqual(recs[0].Note, 'Replaced with P2-0556 on 09/23/26.', 'the flagged row’s note, not the second row’s');
});
t('F4: one room, two rows on one DeviceId - an unnamed note first, then a named one - keeps each note with its own finding', () => {
  const d = listFixture();
  const rows6178 = d.properties[1].rooms.slice();
  rows6178.splice(rows6178.findIndex((r) => r.room === '302') + 1, 0, room('6178', 302, {
    notes: 'Replaced with P2-0610 on 09/23/26.', flags: [{ code: 'F4', text: 'note names P2-0610; DeviceId shows P2-0302' }] }));
  d.properties[1] = property('6178', rows6178);
  d.findings.f4.push({ flag: 'F4', property: '6178', room: '302', sheetRow: 303, note: 'Replaced with P2-0610 on 09/23/26.',
    kind: 'replaced with', namedUnit: 'P2-0610', namedDeviceId: hex(610), namedDeviceName: 'P2-0610', namedHeartbeatBucket: 'stale',
    namedDaysSilent: 101, reason: 'DeviceId shows another unit', deviceId: hex(302), deviceIdCell: 'formula' });
  const page = runPage(payloadOf(d), '?v=recon');
  const shown = listRows(listBlock(page, 'f4')).map(cellsOf).filter((c) => c.Room === '302').map((c) => [c['Note names'], c.Note]);
  assert.deepStrictEqual(keep(shown), [['P2-0610', 'Replaced with P2-0610 on 09/23/26.'], ['unnamed', 'Replaced device on 9/23/26.']]);
  const csv = csvRecords(page.listCsv('f4')[0]).filter((r) => r.Room === '302').map((r) => [r['Note names'], r.Finding]);
  assert.deepStrictEqual(csv, [['P2-0610', 'F4: note names P2-0610; DeviceId shows P2-0302'],
    ['unnamed', 'F4: note records a replacement but names no unit; DeviceId shows P2-0302']]);
});
t('F4: a finding with no room row to join is still listed, and its CSV still downloads', () => {
  const d = listFixture();
  d.properties[1].rooms.find((r) => r.room === '101' && r.flags.length).flags = [];
  const page = runPage(payloadOf(d), '?v=recon');
  const row = listRows(listBlock(page, 'f4')).map(cellsOf).find((c) => c.Room === '101');
  assert.deepStrictEqual(keep([row['DeviceId shows'], row['Note names'], row.Note]), ['—', 'P2-0556', '']);
  const rec = csvRecords(page.listCsv('f4')[0]).find((r) => r.Room === '101');
  assert.deepStrictEqual([rec['DeviceId (Particle ID)'], rec.Finding, rec.Note], [hex(101), '', '']);
});
t('Marked Ok, but…: Ok rooms the data disagrees with, by reason and then days silent, with the reasons as chips', () => {
  const page = runPage(payloadOf(listFixture()), '?v=recon');
  const rows = listRows(listBlock(page, 'okbut'));
  const chips = (tr) => [...tr.matchAll(/<span class="why[^"]*"[^>]*>([^<]*)<\/span>/g)].map((m) => unesc(m[1]));
  assert.deepStrictEqual(keep(rows.map((tr) => [whereOf(cellsOf(tr)), chips(tr), cellsOf(tr)['Days silent']])), [
    ['6197/103', ['no device'], 'No device'],
    ['6178/116', ['no device'], 'No device'],
    ['6178/330', ['never heard'], 'Never'],
    ['9502/309', ['not heard in over 7 days'], '90d'],
    ['9502/308', ['not heard in over 7 days'], '30d'],
    ['6197/105', ['not heard in over 7 days', 'battery critical'], '13d'],
    ['6197/104', ['battery critical'], '1.2d'],
  ]);
});
t('Marked Ok, but… never changes a status: the rooms still read Ok everywhere else', () => {
  const p = payloadOf(listFixture());
  const page = runPage(p, '?v=rooms&status=Ok');
  assert.strictEqual(rowsOf(page.html('tableBody')).length, p.rooms.filter((r) => r.status === 'Ok').length);
  for (const r of rowsOf(page.html('tableBody'))) assert.strictEqual(cellsOf(r).Status, 'Ok');
});
t('the stale reason’s words come from the thresholds, never typed into the page', () => {
  const p = payloadOf(listFixture());
  p.thresholds = clone(p.thresholds);
  p.thresholds.heartbeatAge.buckets[1].maxDays = 10;
  assert.ok(/>not heard in over 10 days</.test(listBlock(runPage(p, '?v=recon'), 'okbut')));
});
t('Marked Ok, but…: its CSV lists the same rooms in the same order, reasons in words', () => {
  const [csv, name] = runPage(payloadOf(listFixture()), '?v=recon').listCsv('okbut');
  assert.ok(CSV_NAME.test(name) && /-ok-but-/.test(name), name);
  const recs = csvRecords(csv);
  assert.deepStrictEqual(keep(Object.keys(recs[0])), ['Property', 'Property name', 'Room', 'Device', 'Particle ID', 'Why', 'Heartbeat',
    'Days silent', 'Last heartbeat', 'Battery V', 'Battery class', 'Action item', 'Notes']);
  assert.deepStrictEqual(keep(recs.map((r) => [r.Property + '/' + r.Room, r.Why, r.Heartbeat])), [
    ['6197/103', 'no device', 'No device'], ['6178/116', 'no device', 'No device'], ['6178/330', 'never heard', 'Never'],
    ['9502/309', 'not heard in over 7 days', '> 7 days'], ['9502/308', 'not heard in over 7 days', '> 7 days'],
    ['6197/105', 'not heard in over 7 days; battery critical', '> 7 days'], ['6197/104', 'battery critical', '< 2 days'],
  ]);
});
t('F1 and F2: small lists naming the device, its rooms, and the tag that disagrees', () => {
  const page = runPage(payloadOf(listFixture()), '?v=recon');
  assert.deepStrictEqual(keep(listRows(listBlock(page, 'f1')).map(cellsOf)),
    [{ Device: 'P2-0433', 'Particle ID': hex(433), Rooms: '6178/428 · 9502/308', 'Across properties': 'yes' }]);
  const f2 = listRows(listBlock(page, 'f2')).map(cellsOf);
  assert.deepStrictEqual(keep(f2.map((c) => [whereOf(c), c.Device, c['Particle tag'], c['Tag belongs to']])),
    [['9502/308', 'P2-0433', 'esa_6178', '6178 Austin - Southwest']]);
  const f1csv = csvRecords(page.listCsv('f1')[0]);
  assert.deepStrictEqual(keep(f1csv), [{ Device: 'P2-0433', 'Particle ID': hex(433), Rooms: '6178/428; 9502/308', 'Across properties': 'yes' }]);
  const f2csv = csvRecords(page.listCsv('f2')[0]);
  assert.deepStrictEqual(keep(f2csv), [{ Property: '9502', 'Property name': 'Austin - Airport', Room: '308', Device: 'P2-0433',
    'Particle ID': hex(433), 'Particle tag': 'esa_6178', 'Tag belongs to': '6178' }]);
});
t('F3 with nothing to list shows an empty state - no blank table, no CSV, no link', () => {
  const block = listBlock(runPage(payloadOf(listFixture()), '?v=recon'), 'f3');
  assert.ok(!/<table/.test(block), block);
  const empty = textOf((block.match(/<div class="empty">([\s\S]*?)<\/div>/) || [])[1] || '');
  assert.strictEqual(keep(empty), 'None today: every DeviceId is blank or the id of a device Particle knows.');
  assert.ok(!/data-csv/.test(block) && !linksOf(block).length, block);
  assert.strictEqual(runPage(payloadOf(listFixture()), '?v=recon').listCsv('f3'), null);
});
t('F3 with findings lists each, with its CSV and its link', () => {
  const d = listFixture();
  d.findings.f3 = [{ flag: 'F3', property: '6178', room: '330', sheetRow: 330, reason: 'unknown to Particle', value: hex(330) }];
  d.properties[1].rooms.find((r) => r.room === '330').flags = [{ code: 'F3', text: 'DeviceId …000330 is not in the Particle product' }];
  const page = runPage(payloadOf(d), '?v=recon');
  const block = listBlock(page, 'f3');
  assert.deepStrictEqual(keep(headOf(block)), ['DeviceId not usable', 1]);
  assert.deepStrictEqual(listRows(block).map(cellsOf).map((c) => [whereOf(c), c.Problem, c['DeviceId holds']]),
    [['6178/330', 'unknown to Particle', hex(330)]]);
  assert.deepStrictEqual(linksOf(block), [['?v=rooms&flag=F3', 'Open in All rooms →']]);
  assert.deepStrictEqual(csvRecords(page.listCsv('f3')[0]), [{ Property: '6178', 'Property name': 'Austin - Southwest', Room: '330',
    Problem: 'unknown to Particle', 'DeviceId holds': hex(330) }]);
});
t('each list opens All rooms on the rooms it names, where the existing filters can say so', () => {
  const p = payloadOf(listFixture());
  const page = runPage(p, '?v=recon');
  const links = ['f4', 'okbut', 'f1', 'f2'].map((k) => [k, linksOf(listBlock(page, k))]);
  assert.deepStrictEqual(keep(links), [
    ['f4', [['?v=rooms&flag=F4', 'Open in All rooms →']]],
    ['okbut', [['?v=rooms&status=Ok&hb=noDevice', 'no device (2)'], ['?v=rooms&status=Ok&hb=never', 'never heard (1)'],
      ['?v=rooms&status=Ok&hb=stale', 'not heard in over 7 days (3)'], ['?v=rooms&status=Ok&batt=critical', 'battery critical (2)']]],
    ['f1', [['?v=rooms&flag=F1', 'Open in All rooms →']]],
    ['f2', [['?v=rooms&flag=F2', 'Open in All rooms →']]],
  ]);
  const expect = { F4: 4, F1: 2, F2: 1 };
  for (const [, list] of links) {
    for (const [href, label] of list) {
      const at = runPage(p, '?v=recon&prop=9502&q=zzz'); // filters already set are replaced, not added to
      assert.strictEqual(at.goto({ 'data-goto': 'rooms', href }), true, href);
      assert.strictEqual(at.url(), href, 'the address bar is the link: it can be shared as it stands');
      assert.strictEqual(at.el('view-table').hidden, false);
      const n = rowsOf(at.html('tableBody')).length;
      const want = /flag=(F\d)/.test(href) ? expect[href.match(/flag=(F\d)/)[1]] : Number(label.match(/\((\d+)\)$/)[1]);
      assert.strictEqual(n, want, href);
    }
  }
});
t('summary view shows no worklist, list link or list CSV button - loaded cold, or switched from Reconciliation', () => {
  const p = R.buildPayload(listFixture(), SUMMARY_HIST, SUMMARY_TRENDS);
  const LISTS = /Replacement not in DeviceId|Marked Ok, but|One device, two rooms|Location vs Particle tag|DeviceId not usable|data-csv|Download CSV|href="\?v=rooms|Open in All rooms|class="why/;
  const control = onScreen(runPage(p, '?v=recon'));
  assert.ok(LISTS.test(control) && DEVICE_NAME.test(control), 'control: the full view shows the lists');
  const switched = runPage(p, '?v=recon');
  switched.el('summaryToggle').click();
  for (const [label, page] of [['cold', runPage(p, '?view=summary')], ['switched', switched], ['cold, recon underneath', runPage(p, '?view=summary&v=recon')]]) {
    const s = onScreen(page);
    assert.ok(!LISTS.test(s), label + ': ' + (s.match(LISTS) || [])[0]);
    assert.ok(!DEVICE_NAME.test(s), label + ': ' + (s.match(DEVICE_NAME) || [])[0]);
    assert.strictEqual(page.url(), '?view=summary', label);
  }
  keep('summary hides the lists');
});
t('a list link opened in a new tab (a modified click) is left to the browser', () => {
  const page = runPage(payloadOf(listFixture()), '?v=recon');
  for (const mods of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }]) {
    assert.strictEqual(page.goto({ 'data-goto': 'rooms', href: '?v=rooms&flag=F4' }, mods), false, JSON.stringify(mods));
    assert.strictEqual(page.url(), '?v=recon');
  }
});

// ===========================================================================
console.log('\nPAGE: filters in the URL');

t('changing a filter writes it to the address bar at once; Clear takes it away', () => {
  const page = runPage(payloadOf(fixture()), '?v=rooms');
  const set = (id, v, ev = 'change') => { page.el(id).value = v; page.el(id).fire(ev); return page.url(); };
  assert.strictEqual(set('fFlag', 'F4'), '?v=rooms&flag=F4');
  assert.strictEqual(set('fProperty', '6178'), '?v=rooms&prop=6178&flag=F4');
  assert.strictEqual(set('fSearch', 'drips', 'input'), '?v=rooms&prop=6178&flag=F4&q=drips');
  assert.strictEqual(keep(set('fBattery', 'critical')), '?v=rooms&prop=6178&batt=critical&flag=F4&q=drips');
  page.el('fClear').click();
  assert.strictEqual(page.url(), '?v=rooms');
});
t('a link with filters opens with them applied, shown in the controls, and in the order written', () => {
  const search = '?v=rooms&prop=6197&status=Ok&batt=critical&sort=daysSilent&dir=desc';
  const page = runPage(payloadOf(listFixture()), search);
  assert.deepStrictEqual(keep(['fProperty', 'fStatus', 'fBattery', 'fHeartbeat', 'fFlag'].map((id) => page.el(id).value)),
    ['6197', 'Ok', 'critical', '', '']);
  assert.deepStrictEqual(keep(rowsOf(page.html('tableBody')).map((tr) => whereOf(cellsOf(tr)))), ['6197/105', '6197/104']);
  assert.strictEqual(page.url(), search);
});
t('a refresh keeps the filters: the address written, reloaded, gives the same list and controls', () => {
  const p = payloadOf(listFixture());
  const first = runPage(p, '?v=rooms');
  for (const [id, v, ev] of [['fStatus', 'Ok', 'change'], ['fHeartbeat', 'stale', 'change'], ['fSearch', '9502', 'input']]) {
    first.el(id).value = v;
    first.el(id).fire(ev);
  }
  const again = runPage(p, first.url());
  assert.strictEqual(keep(again.url()), first.url());
  assert.strictEqual(again.html('tableBody'), first.html('tableBody'));
  assert.strictEqual(rowsOf(again.html('tableBody')).length, 2);
  for (const id of ['fProperty', 'fStatus', 'fAction', 'fBattery', 'fHeartbeat', 'fFlag', 'fSearch']) {
    assert.strictEqual(again.el(id).value, first.el(id).value, id);
  }
});
t('legacy links still resolve: ?v=triage with or without filters, and #view hashes', () => {
  const p = payloadOf(fixture());
  const cases = [
    ['?v=triage', '', '?v=rooms&status=attention'],
    ['?v=triage&prop=6178', '', '?v=rooms&prop=6178&status=attention'],
    ['?v=triage&status=Issue', '', '?v=rooms&status=Issue'],
    ['', '#recon', '?v=recon'],
    ['', '#rooms', '?v=rooms'],
  ];
  for (const [search, hash, url] of cases) assert.strictEqual(keep(runPage(p, search, { hash }).url()), url, search + hash);
  assert.strictEqual(runPage(p, '?v=triage').el('view-table').hidden, false);
});
t('a value the controls cannot show is dropped, never applied unseen', () => {
  const p = payloadOf(fixture());
  const page = runPage(p, '?v=rooms&prop=9829&status=ok&action=Nope&batt=dead&hb=soon&flag=F9&sort=evil&dir=desc');
  assert.deepStrictEqual(keep(['fProperty', 'fStatus', 'fAction', 'fBattery', 'fHeartbeat', 'fFlag'].map((id) => page.el(id).value)),
    ['', '', '', '', '', '']);
  assert.strictEqual(page.url(), '?v=rooms');
  assert.strictEqual(page.text('rowCount'), '6 of 6 rooms');
  const ok = runPage(p, '?v=rooms&hb=stale&flag=F9');
  assert.strictEqual(ok.url(), '?v=rooms&hb=stale', 'a valid filter survives beside an invalid one');
  assert.strictEqual(rowsOf(ok.html('tableBody')).length, 1);
});
t('a view name that is not a view - even one every object inherits - opens the rollup', () => {
  const p = payloadOf(fixture());
  for (const [search, hash] of [['?v=constructor', ''], ['?v=__proto__', ''], ['?v=hasOwnProperty&flag=F4', ''], ['', '#toString']]) {
    const page = runPage(p, search, { hash });
    assert.deepStrictEqual(keep(['view-rollup', 'view-table', 'view-recon'].filter((id) => !page.el(id).hidden)), ['view-rollup'], search + hash);
    assert.ok(/^\?v=rollup(&|$)/.test(page.url()), search + hash + ' -> ' + page.url());
  }
});
t('every value a control offers survives a link: filters, and every sortable column', () => {
  const p = payloadOf(listFixture());
  const page = runPage(p, '?v=rooms');
  const optionsOf = (html) => [...html.matchAll(/<option value="([^"]*)">/g)].map((m) => unesc(m[1])).filter(Boolean);
  const battery = optionsOf((TEMPLATE_HTML.match(/<select id="fBattery">([\s\S]*?)<\/select>/) || [])[1] || '');
  const sortKeys = [...TEMPLATE_HTML.matchAll(/<th class="sortable" data-key="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(keep(battery), ['critical', 'warn', 'ok', 'unknown']);
  assert.strictEqual(keep(sortKeys.length), 8);
  const offered = [
    ['prop', optionsOf(page.html('fProperty')).concat(p.properties.map((x) => x.code))],
    ['status', optionsOf(page.html('fStatus'))], ['action', optionsOf(page.html('fAction')).concat(['None'])],
    ['batt', battery], ['hb', optionsOf(page.html('fHeartbeat'))], ['flag', optionsOf(page.html('fFlag'))],
  ];
  for (const [param, values] of offered) {
    assert.ok(values.length, param);
    for (const v of values) {
      const search = '?v=rooms&' + param + '=' + encodeURIComponent(v);
      assert.strictEqual(runPage(p, search).url(), search, search);
    }
  }
  for (const k of sortKeys) {
    const search = '?v=rooms&sort=' + k + '&dir=desc';
    assert.strictEqual(runPage(p, search).url(), search, search);
  }
});
t('summary still wins over filters in the URL, and keeps them for the full view', () => {
  const page = runPage(payloadOf(listFixture()), '?view=summary&v=rooms&flag=F4');
  assert.deepStrictEqual(modeOf(page), SUMMARY_MODE);
  page.el('summaryExit').click();
  assert.strictEqual(page.url(), '?v=rooms&flag=F4');
  assert.strictEqual(rowsOf(page.html('tableBody')).length, 4);
});

// ===========================================================================
console.log('\nverify-live.js: what the published page must carry');

const V = require('./verify-live');
const HTML = '<meta name="robots" content="noindex, nofollow">';
t('a healthy payload passes', () => {
  assert.deepStrictEqual(V.pageProblems(HTML, payloadOf(fixture())), { problems: [], notes: [] });
});
t('the header stamp and every property stamp must be present; null is a note, not a failure', () => {
  const p = payloadOf(fixture());
  delete p.sheetExportAsOf;
  delete p.properties[1].snapshot.currentTime;
  p.properties[2].snapshot.currentTime = null;
  const r = V.pageProblems(HTML, p);
  assert.deepStrictEqual(keep(r.problems), [
    'the payload carries no sheetExportAsOf (header) stamp',
    'property 6178 carries no sheet export stamp (snapshot.currentTime)',
  ]);
  assert.deepStrictEqual(r.notes, ['property 9502: the sheet export carried no stamp for it; its card reads "unknown"']);
});
t('an unreadable stamp fails', () => {
  const p = payloadOf(fixture());
  p.properties[0].snapshot.currentTime = 'Sep 25';
  assert.strictEqual(V.pageProblems(HTML, p).problems.length, 1);
});
t('missing page findings, or any log-only finding key, fail', () => {
  const p = payloadOf(fixture());
  delete p.findings.f4;
  p.reconciliation.notesNamingOutOfScope = [];
  assert.deepStrictEqual(keep(V.pageProblems(HTML, p).problems), [
    'page findings missing from the payload: f4',
    'log-only finding(s) published on the page: notesNamingOutOfScope',
  ]);
});
t('the older checks stand: every property, some rooms, noindex', () => {
  const p = payloadOf(fixture());
  p.properties = p.properties.slice(0, 2);
  p.rooms = [];
  assert.strictEqual(V.pageProblems('<meta name="robots" content="all">', p).problems.length, 3);
});

/**
 * verifyLive() against a fake site, in a child process: the module reads its
 * tolerances from the environment when it loads, and fetch is stubbed there.
 * `pages` is the sequence of payloads served, one per probe; the last repeats.
 */
function verifyAgainst(pages, env) {
  const script = `
    const pages = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    let n = 0;
    globalThis.fetch = async () => {
      const p = pages[Math.min(n++, pages.length - 1)];
      const html = '<meta name="robots" content="noindex, nofollow"><script type="application/json" id="payload">'
        + JSON.stringify(p) + '</scr' + 'ipt>';
      return { ok: true, status: 200, statusText: 'OK', text: async () => html };
    };
    require(${JSON.stringify(path.join(__dirname, 'verify-live.js'))}).verifyLive()
      .then(() => console.log('RESULT ok after ' + n + ' probes'))
      .catch((e) => console.log('RESULT fail after ' + n + ' probes: ' + e.message.split('\\n').slice(0, 3).join(' / ')));
  `;
  const r = spawnSync(process.execPath, ['-e', script], {
    input: JSON.stringify(pages),
    encoding: 'utf8',
    env: { ...process.env, VERIFY_POLL_MS: '20', VERIFY_MAX_WAIT_MS: '400', VERIFY_NEWER_THAN: '', ...env },
  });
  return ((r.stdout || '').match(/^RESULT .*$/m) || [r.stdout + r.stderr])[0];
}
// A page as the legacy build published it: no stamps, no findings. Recent, so
// "fresh" by age alone.
const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
const oldShape = (builtAt) => {
  const p = payloadOf(fixture());
  delete p.sheetExportAsOf;
  delete p.findings;
  for (const x of p.properties) delete x.snapshot;
  return { ...p, builtAt };
};
const newShape = (builtAt) => ({ ...payloadOf(fixture()), builtAt });

t('right after a push, with no previous stamp, the old page is waited out, not failed', () => {
  const r = verifyAgainst([oldShape(minutesAgo(30)), oldShape(minutesAgo(30)), newShape(minutesAgo(0))], {});
  assert.ok(/^RESULT ok after 3 probes/.test(r), r);
});
t('with no previous stamp, a page that stays wrong still fails - at the deadline, naming what is wrong', () => {
  const r = verifyAgainst([oldShape(minutesAgo(30))], {});
  assert.ok(/^RESULT fail after \d+ probes: VERIFY FAILED: the published page is reachable but wrong/.test(r), r);
  assert.ok(/sheetExportAsOf/.test(r), r);
});
t('with VERIFY_NEWER_THAN, the old page is waited out and the new one checked', () => {
  const before = minutesAgo(30);
  const r = verifyAgainst([oldShape(before), oldShape(before), newShape(minutesAgo(0))], { VERIFY_NEWER_THAN: before });
  assert.ok(/^RESULT ok after 3 probes/.test(r), r);
});
t('with VERIFY_NEWER_THAN, a newer page that is wrong fails at once', () => {
  const before = minutesAgo(30);
  const r = verifyAgainst([oldShape(minutesAgo(0))], { VERIFY_NEWER_THAN: before });
  assert.ok(/^RESULT fail after 1 probes: the published page is reachable but wrong/.test(r), r);
});

// ---------------------------------------------------------------------------
console.log('\n' + (fail ? 'FAILED ' : 'ALL PASS ') + pass + ' passed, ' + fail + ' failed');
// Evidence the zone really changed: the host offset at the export instant.
console.log('HOST_OFFSET ' + new Date('2026-09-25T16:48:26Z').getTimezoneOffset());
console.log('DIGEST ' + crypto.createHash('sha256').update(JSON.stringify(seen)).digest('hex'));
process.exit(fail ? 1 : 0);

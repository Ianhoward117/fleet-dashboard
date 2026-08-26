const assert=require('assert');
const fs=require('fs'),path=require('path');
const REPO=__dirname;
const {planRoomOverrideMerge,resolveRoomOverride}=require(REPO+'/normalize');
const {loadRoomOverrides,RoomOverrideError}=require(REPO+'/fetch');
const SP=require('os').tmpdir();

let pass=0,fail=0;
function t(name,fn){ try{ fn(); console.log('  ok    '+name); pass++; }
  catch(e){ console.log('  FAIL  '+name+'\n        '+e.message.split('\n')[0]); fail++; } }

// --- fixtures ---------------------------------------------------------------
const prop={code:'6197',name:'Round Rock - Southwest'};
const R=(n)=>({room:{key:String(n).toLowerCase(),display:String(n)},deviceName:null});
// roster rows: rooms 100,101,102,103 (103 twice, a duplicated Room Status row)
const roster=[R(100),R(101),R(102),R(103),R(103)];
// current sheet assignments: 100->DA(export), 101->DB(export), 102->DC(registry)
const hb={byRoom:new Map([['100',{deviceId:'idA'}],['101',{deviceId:'idB'}]])};
const reg={byRoom:new Map([['102',{deviceId:'idC',deviceName:'P2-0C',installDate:null}]])};
const ov=(pairs)=>new Map(pairs.map(([room,name,id])=>[String(room).toLowerCase(),
  {sourceRoom:String(room),room:{key:String(room).toLowerCase(),display:String(room)},deviceName:name,deviceId:id,groups:[]}]));

console.log('MERGE SEMANTICS');

// (a) override device wins a room; the previous device is dropped and logged
t('(a) override wins the room it names, prior device dropped + logged',()=>{
  const p=planRoomOverrideMerge(prop,roster,hb,reg,ov([[100,'P2-NEW','idNEW']]));
  assert.strictEqual(p.assigned.get('100').deviceId,'idNEW');
  assert.strictEqual(p.assigned.get('100').source,'override');
  assert.strictEqual(p.overwritten.length,1);
  assert.strictEqual(p.overwritten[0].fromDeviceId,'idA');
  assert.strictEqual(p.overwritten[0].toDeviceId,'idNEW');
  assert.strictEqual(p.overwritten[0].room,'100');
  assert.ok(p.touched.has('100'));
});

// (b) THE NEW FAILURE MODE: device already in another room of this property
t('(b) device moved from another room; old room vacated, move logged',()=>{
  const p=planRoomOverrideMerge(prop,roster,hb,reg,ov([[101,'P2-A','idA']]));
  assert.strictEqual(p.assigned.get('101').deviceId,'idA');
  assert.strictEqual(p.assigned.has('100'),false,'room 100 must be vacated');
  assert.strictEqual(p.relocated.length,1);
  assert.strictEqual(p.relocated[0].fromRoom,'100');
  assert.strictEqual(p.relocated[0].toRoom,'101');
  assert.strictEqual(p.relocated[0].deviceId,'idA');
  assert.ok(p.touched.has('100')&&p.touched.has('101'));
  // and the displaced occupant of 101 is recorded too
  assert.strictEqual(p.overwritten.length,1);
  assert.strictEqual(p.overwritten[0].fromDeviceId,'idB');
});
t('(b) no device ends up in two rooms',()=>{
  const p=planRoomOverrideMerge(prop,roster,hb,reg,ov([[101,'P2-A','idA'],[102,'P2-B','idB']]));
  const ids=[...p.assigned.values()].map(a=>a.deviceId);
  assert.strictEqual(new Set(ids).size,ids.length,'duplicate device across rooms: '+ids);
  assert.strictEqual(p.assigned.has('100'),false);
  assert.strictEqual(p.assigned.get('101').deviceId,'idA');
  assert.strictEqual(p.assigned.get('102').deviceId,'idB');
});
t('(b) a straight swap of two occupied rooms leaves neither doubled',()=>{
  const p=planRoomOverrideMerge(prop,roster,hb,reg,ov([[100,'P2-B','idB'],[101,'P2-A','idA']]));
  assert.strictEqual(p.assigned.get('100').deviceId,'idB');
  assert.strictEqual(p.assigned.get('101').deviceId,'idA');
  const ids=[...p.assigned.values()].map(a=>a.deviceId);
  assert.strictEqual(new Set(ids).size,ids.length);
});

// (c) untouched rooms keep their assignment
t('(c) rooms the override does not name are untouched',()=>{
  const p=planRoomOverrideMerge(prop,roster,hb,reg,ov([[100,'P2-NEW','idNEW']]));
  assert.strictEqual(p.assigned.get('101').deviceId,'idB','101 kept');
  assert.strictEqual(p.assigned.get('101').source,'export');
  assert.strictEqual(p.assigned.get('102').deviceId,'idC','102 kept');
  assert.strictEqual(p.assigned.get('102').source,'registry');
  assert.ok(!p.touched.has('101')&&!p.touched.has('102'));
  assert.strictEqual(p.untouchedCheck===undefined,true);
});
t('(c) an empty override changes nothing at all',()=>{
  const p=planRoomOverrideMerge(prop,roster,hb,reg,ov([]));
  assert.strictEqual(p.touched.size,0);
  assert.strictEqual(p.overwritten.length,0);
  assert.strictEqual(p.relocated.length,0);
  assert.strictEqual(p.assigned.get('100').deviceId,'idA');
  assert.strictEqual(p.assigned.get('101').deviceId,'idB');
  assert.strictEqual(p.assigned.get('102').deviceId,'idC');
});

// (d) override rooms absent from the roster
t('(d) off-roster override room is recorded and invents nothing',()=>{
  const p=planRoomOverrideMerge(prop,roster,hb,reg,ov([[999,'P2-X','idX']]));
  assert.strictEqual(p.notInRoster.length,1);
  assert.strictEqual(p.notInRoster[0].room.display,'999');
  assert.strictEqual(p.assigned.has('999'),false,'no room invented');
  assert.strictEqual(p.touched.has('999'),false);
  assert.strictEqual(p.rosterKeys.size,4,'roster still 4 distinct rooms');
});
t('(d) duplicated Room Status rows count as ONE room',()=>{
  const p=planRoomOverrideMerge(prop,roster,hb,reg,ov([]));
  assert.strictEqual(p.rosterKeys.size,4);
});

// assigning the same device to the room it already occupies is a no-op
t('re-stating an existing assignment logs nothing',()=>{
  const p=planRoomOverrideMerge(prop,roster,hb,reg,ov([[100,'P2-A','idA']]));
  assert.strictEqual(p.overwritten.length,0);
  assert.strictEqual(p.relocated.length,0);
  assert.strictEqual(p.assigned.get('100').deviceId,'idA');
});

console.log('\nFLEET-WIDE DUPLICATE DEVICE NAME');
function write(o){const f=path.join(SP,'dup.json');fs.writeFileSync(f,JSON.stringify(o));return f;}
t('same device claimed by two properties fails loud',()=>{
  const f=write({properties:{
    '6178':{mode:'replace',rooms:{'101':'P2-0433'}},
    '9502':{mode:'merge',rooms:{'308':'P2-0433'}}}});
  assert.throws(()=>loadRoomOverrides(f),(e)=>e instanceof RoomOverrideError&&/claimed by two properties/.test(e.message));
});
t('duplicate detected case/whitespace-insensitively',()=>{
  const f=write({properties:{
    '6178':{mode:'replace',rooms:{'101':'P2-0433'}},
    '6197':{mode:'merge',rooms:{'100':'  p2-0433 '}}}});
  assert.throws(()=>loadRoomOverrides(f),(e)=>e instanceof RoomOverrideError&&/claimed by two properties/.test(e.message));
});
t('distinct names across properties are fine',()=>{
  const f=write({properties:{
    '6178':{mode:'replace',rooms:{'101':'P2-0001'}},
    '9502':{mode:'merge',rooms:{'308':'P2-0002'}}}});
  const r=loadRoomOverrides(f);
  assert.strictEqual(Object.keys(r.properties).length,2);
});
t('"merge" is now an accepted mode',()=>{
  const f=write({properties:{'6197':{mode:'merge',rooms:{'100':'P2-0001'}}}});
  assert.strictEqual(loadRoomOverrides(f).properties['6197'].mode,'merge');
});
t('an unimplemented mode still fails',()=>{
  const f=write({properties:{'6197':{mode:'append',rooms:{'100':'P2-0001'}}}});
  assert.throws(()=>loadRoomOverrides(f),(e)=>e instanceof RoomOverrideError);
});
t('heldOut is accepted and ignored',()=>{
  const f=write({properties:{'6197':{mode:'merge',rooms:{'100':'P2-0001'},
    heldOut:{'112':'ADA only','110':'two devices listed'}}}});
  const b=loadRoomOverrides(f).properties['6197'];
  assert.strictEqual(b.rooms.length,1);
  assert.strictEqual('heldOut' in b,false,'heldOut must not reach the pipeline');
});

console.log('\n'+(fail?'FAILED ':'ALL PASS ')+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);

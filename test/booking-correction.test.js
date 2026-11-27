'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const express=require('express');
const C=require('../booking-correction');
const {createBookingCorrectionService,installBookingCorrectionRoutes}=require('../booking-correction-api');
const ADMIN='test-only-management-code';
const boss={id:'boss',password:'test-only-boss-password'},manager={id:'manager',password:'test-only-manager-password'};
const item={id:1,name:'全背徒手調理放鬆',price:800,durationMinutes:60,durationLabel:'60分'};
const foot={id:7,name:'腳底按摩筋膜調理放鬆',price:900,durationMinutes:60,durationLabel:'60分'};
const bowl={id:20,name:'頌缽音波課程（一對一）',price:2000,durationMinutes:60,durationLabel:'60分'};
const base={id:'B001',name:'測試客人',custId:'C001',phone:'0912345678',status:'accepted',dateKey:'2026-10-20',date:'10/20',year:2026,time:'14:00',bed:1,
  svc:item.name,items:[item],dur:'60分',durationMinutes:60,price:800,subtotalPrice:800,originalPrice:800,payablePrice:800,discountAmount:0,note:'原備註',extraMins:0,
  startTime:null,endTime:null,acceptedBy:'employee',_updated:'2026-10-19T10:00:00Z'};
const coupon={instanceId:'CP001',name:'指定頌缽體驗券',code:'BOWL90',type:'percent',value:10,minSpend:0,serviceScope:'selected_services',applicableServiceIds:[20],
  discountAmount:200,status:'reserved'};

class MemoryDb{
  constructor(records={}){this.records=new Map(Object.entries({
    'employees/boss':{pw:boss.password,role:'boss',name:'測試店長'},'employees/manager':{pw:manager.password,role:'manager',name:'測試管理人員'},
    'employees/employee':{pw:'test-only-employee-password',role:'staff'},'bookings/B001':base,...records
  }).map(([key,value])=>[key,structuredClone(value)]));this.lock=Promise.resolve();}
  snap(path){const value=this.records.get(path);return {id:path.split('/').pop(),exists:value!==undefined,data:()=>structuredClone(value)};}
  collection(name){const db=this;return {
    doc(id){const path=name+'/'+id;return {path,id,get:async()=>db.snap(path)};},
    where(field,op,value){assert.equal(op,'==');const query={query:true,name,field,value,get:async()=>db.query(query)};return query;}
  };}
  query(q){return {docs:[...this.records.keys()].filter(key=>key.startsWith(q.name+'/')&&this.records.get(key)[q.field]===q.value).map(key=>this.snap(key))};}
  async runTransaction(action){const prior=this.lock;let release;this.lock=new Promise(resolve=>release=resolve);await prior;const writes=[];
    try{const value=await action({get:async ref=>{assert.equal(writes.length,0,'no reads after writes');return ref.query?this.query(ref):this.snap(ref.path);},
      set:(ref,value)=>writes.push([ref.path,structuredClone(value)])});writes.forEach(([key,value])=>this.records.set(key,value));return value;
    }finally{release();}
  }
}
function fixture(records={}){const db=new MemoryDb(records);return {db,service:createBookingCorrectionService({db,managementCode:ADMIN,clock:()=>Date.parse('2026-10-20T06:00:00Z')})};}
function input(f,overrides={}){
  const current=f.db.records.get('bookings/B001');
  return {actor:boss,recoveryCode:ADMIN,bookingId:'B001',requestId:crypto.randomUUID(),expectedFingerprint:crypto.createHash('sha256').update(C.stateString(current)).digest('hex'),
    items:[foot],reason:'客人更換服務',note:'更正備註',finalPrice:700,discountAmount:0,...overrides};
}
const audits=f=>[...f.db.records].filter(([key])=>key.startsWith('bookingCorrections/')).map(([,value])=>value);

test('legacy and migrated bookings produce the same fingerprint; field order does not matter',async()=>{
  const old={...base,dateKey:undefined,durationMinutes:undefined},migrated={...old,dateKey:'2026-10-20',durationMinutes:60};
  assert.equal(C.stateString(old),C.stateString(migrated));
  assert.equal(await C.fingerprint(base),crypto.createHash('sha256').update(C.stateString(base)).digest('hex'));
  assert.equal(C.stable({b:2,a:1}),C.stable({a:1,b:2}));
});
test('reject invalid money/duration, empty items, excessive totals, and missing reasons',()=>{
  for(const patch of [{items:[]},{items:[{...item,price:-1}]},{items:[{...item,price:1.5}]},{items:[{...item,durationMinutes:0}]},{items:[{...item,price:1000001}]},{reason:''}]){
    assert.throws(()=>C.plan(base,{items:[item],reason:'核對修正',...patch}));
  }
  assert.throws(()=>C.plan({...base,status:'done'},{items:[item],reason:'核對修正',finalPrice:'',discountAmount:0}));
});
test('completed correction updates structured items and totals while preserving actual receipts and timing',async()=>{
  const finished={...base,status:'done',finalPrice:700,startTime:'14:05',startTimestamp:1792476300000,endTime:'14:55',endTimestamp:1792479300000,actualElapsedMins:50};
  const f=fixture({'bookings/B001':finished});const result=await f.service.correct(input(f));
  assert.equal(result.booking.svc,foot.name);assert.deepEqual(result.booking.items,[foot]);
  assert.equal(result.booking.price,900);assert.equal(result.booking.subtotalPrice,900);assert.equal(result.booking.payablePrice,900);
  assert.equal(result.booking.finalPrice,700);assert.equal(result.booking.startTimestamp,finished.startTimestamp);assert.equal(result.booking.endTimestamp,finished.endTimestamp);
  assert.equal(result.booking.actualElapsedMins,50);assert.equal(result.booking.status,'done');assert.equal(audits(f).length,1);
  assert.equal(audits(f)[0].before.svc,item.name);assert.equal(audits(f)[0].after.svc,foot.name);assert.equal(audits(f)[0].byId,'boss');
});
test('completed coupon correction never returns or reissues a consumed coupon',async()=>{
  const used={...coupon,status:'used'};const wallet={coupons:[{id:'CP001',status:'used',used:true,usedBookingId:'B001'}]};
  const f=fixture({'bookings/B001':{...base,status:'done',svc:bowl.name,items:[bowl],price:2000,subtotalPrice:2000,payablePrice:1800,discountAmount:200,coupon:used,couponStatus:'used',finalPrice:1800},'customers/C001':wallet});
  const result=await f.service.correct(input(f,{discountAmount:200,finalPrice:1800}));
  assert.deepEqual(f.db.records.get('customers/C001'),wallet);assert.equal(result.booking.couponStatus,'used');assert.equal(result.booking.coupon.status,'used');
  assert.equal(audits(f)[0].couponOverride,true);assert.equal(result.booking.finalPrice,1800);
});
test('completed records require actual boss role AND the private management code',async()=>{
  const f=fixture({'bookings/B001':{...base,status:'done',finalPrice:800}});
  for(const patch of [{actor:manager},{recoveryCode:'wrong'},{actor:{id:'employee',password:'test-only-employee-password',role:'boss'}}]){
    await assert.rejects(f.service.correct(input(f,patch)),error=>error.status===403);
  }
  assert.equal(audits(f).length,0);assert.equal(f.db.records.get('bookings/B001').finalPrice,800);
});
test('pending or in-progress service changes do not require cutting the order',async()=>{
  for(const started of [false,true]){
    const b={...base,startTime:started?'14:00':null,startTimestamp:started?Date.parse('2026-10-20T06:00:00Z'):null};
    const f=fixture({'bookings/B001':b});const result=await f.service.correct(input(f,{actor:manager,recoveryCode:''}));
    assert.equal(result.booking.status,'accepted');assert.equal(result.booking.svc,foot.name);assert.equal(result.booking.startTime,b.startTime);
    assert.equal(result.booking.startTimestamp,b.startTimestamp);assert.equal(result.booking.payablePrice,900);assert.equal(result.booking.finalPrice,undefined);
    assert.equal(f.db.records.get('bedLocks/2026-10-20_bed1').reservations[0].end,910);
  }
});
test('manager may select catalog prices; arbitrary names or custom price overrides require the boss',async()=>{
  const f=fixture();await assert.rejects(f.service.correct(input(f,{actor:manager,items:[{...foot,price:5}]})),error=>error.status===403);
  await assert.rejects(f.service.correct(input(f,{items:[{...bowl,name:'偽造服務'}]})),/SERVICE_ID_MISMATCH/);
  await assert.rejects(f.service.correct(input(f,{actor:manager,items:[{id:null,name:'手動品項',durationMinutes:60,price:800}]})),error=>error.status===403);
});
test('a legacy service without an item ID can be preserved by a manager',async()=>{
  const legacy={...base,items:undefined};const f=fixture({'bookings/B001':legacy});
  const result=await f.service.correct(input(f,{actor:manager,items:C.itemsFrom(legacy)}));assert.equal(result.booking.svc,item.name);
});
test('a matching reserved coupon is recalculated without duplicate claims or changed wallet state',async()=>{
  const f=fixture({'bookings/B001':{...base,svc:bowl.name,items:[bowl],price:2000,subtotalPrice:2000,payablePrice:1800,discountAmount:200,coupon,couponStatus:'reserved'},
    'customers/C001':{coupons:[{id:'CP001',status:'reserved',reservedBookingId:'B001',used:false}]}});
  const larger={...bowl,price:4000,durationMinutes:120,durationLabel:'120分'};
  const result=await f.service.correct(input(f,{items:[larger]}));assert.equal(result.booking.discountAmount,400);assert.equal(result.booking.payablePrice,3600);
  assert.equal(result.booking.coupon.discountAmount,400);assert.equal(f.db.records.get('customers/C001').coupons.length,1);
  assert.equal(f.db.records.get('customers/C001').coupons[0].status,'reserved');
});
test('changing to ineligible service requires explicit coupon release and returns it atomically',async()=>{
  const f=fixture({'bookings/B001':{...base,coupon,couponStatus:'reserved'},'customers/C001':{coupons:[{id:'CP001',status:'reserved',reservedBookingId:'B001',reservedAt:'old',used:false}]}});
  await assert.rejects(f.service.correct(input(f)),/COUPON_RELEASE_REQUIRED/);assert.equal(audits(f).length,0);
  const result=await f.service.correct(input(f,{releaseCoupon:true}));assert.equal(result.booking.coupon,null);assert.equal(result.booking.discountAmount,0);
  const returned=f.db.records.get('customers/C001').coupons[0];assert.equal(returned.status,'available');assert.equal(returned.reservedBookingId,undefined);
});
test('coupon reserved by another order cannot be released or overwritten',async()=>{
  const f=fixture({'bookings/B001':{...base,coupon,couponStatus:'reserved'},'customers/C001':{coupons:[{id:'CP001',status:'reserved',reservedBookingId:'OTHER'}]}});
  await assert.rejects(f.service.correct(input(f,{releaseCoupon:true})),/COUPON_STATE_CHANGED/);assert.equal(audits(f).length,0);
});
test('service extension checks existing bookings even if bedLocks is missing',async()=>{
  const nextBooking={...base,id:'B002',time:'15:10',items:[item]};const f=fixture({'bookings/B002':nextBooking});
  const larger={...item,durationMinutes:120,durationLabel:'120分',price:1600};
  await assert.rejects(f.service.correct(input(f,{items:[larger]})),/BED_CONFLICT/);
  assert.equal(f.db.records.get('bookings/B001').durationMinutes,60);assert.equal(audits(f).length,0);
});
test('bed buffer can be zero; adjacent slots do not become false conflicts',async()=>{
  const f=fixture({'settings/appConfig':{bedBuffer:0},'bookings/B002':{...base,id:'B002',time:'15:00'}});
  assert.equal((await f.service.correct(input(f))).booking.svc,foot.name);
});
test('unassigned booking may end at closing but cannot be extended past closing', async () => {
  const original = { ...base, bed: null, time: '20:30' };
  const f = fixture({ 'bookings/B001': original });
  await assert.rejects(
    f.service.correct(input(f, { items: [{ ...item, durationMinutes: 120 }] })),
    /AFTER_CLOSING/
  );
  assert.deepEqual(f.db.records.get('bookings/B001'), original);
  assert.equal(audits(f).length, 0);
  const result = await f.service.correct(input(f, { items: [{ ...item, durationMinutes: 90 }] }));
  assert.equal(result.booking.durationMinutes, 90);
});

test('unstarted service extension past closing is rejected',async()=>{
  const f=fixture({'bookings/B001':{...base,time:'21:00'}});
  await assert.rejects(f.service.correct(input(f,{items:[{...item,price:1600,durationMinutes:120}]})),/AFTER_CLOSING/);
});
test('stale data, changed status, or a concurrent amount correction never overwrite the latest booking',async()=>{
  for(const change of [{status:'done',finalPrice:800},{note:'另一台已更新'},{price:900,finalPrice:650}]){
    const f=fixture(),request=input(f);f.db.records.set('bookings/B001',{...base,...change});
    await assert.rejects(f.service.correct(request),/BOOKING_CHANGED/);assert.equal(audits(f).length,0);
  }
});
test('parallel edits allow one commit, reject the stale request, and preserve one audit',async()=>{
  const f=fixture();const a=input(f),b=input(f,{items:[item],note:'另一個更正'});
  const results=await Promise.allSettled([f.service.correct(a),f.service.correct(b)]);
  assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(audits(f).length,1);
});
test('replaying a request is idempotent; reusing an ID for changed content is rejected',async()=>{
  const f=fixture(),request=input(f);await f.service.correct(request);
  assert.equal((await f.service.correct(request)).alreadyApplied,true);assert.equal(audits(f).length,1);
  await assert.rejects(f.service.correct({...request,note:'不同資料'}),/REQUEST_REUSED/);
});
test('a lost older response replay returns the most current state',async()=>{
  const f=fixture(),first=input(f);await f.service.correct(first);
  const second=input(f,{items:[item],reason:'第二次更正'});await f.service.correct(second);
  const replay=await f.service.correct(first);assert.equal(replay.booking.svc,item.name);assert.equal(replay.booking.correctionRevision,2);
});
test('audit records are boss-only and exclude login credentials',async()=>{
  const f=fixture();await f.service.correct(input(f));
  await assert.rejects(f.service.history({actor:manager,recoveryCode:ADMIN,bookingId:'B001'}),error=>error.status===403);
  const result=await f.service.history({actor:boss,recoveryCode:ADMIN,bookingId:'B001'});assert.equal(result.history.length,1);
  assert.ok(!JSON.stringify(result).includes(boss.password));assert.ok(!JSON.stringify(result).includes(ADMIN));
});
test('data checks flag inconsistent names, amounts, minutes, receipts, and coupon state without mutation',()=>{
  const record={...base,status:'done',svc:'舊的錯誤名稱',durationMinutes:90,subtotalPrice:200,discountAmount:300,finalPrice:undefined,coupon,couponStatus:'reserved'};
  const original=JSON.stringify(record),issues=C.issues(record);assert.equal(issues.length,6);assert.equal(JSON.stringify(record),original);
  assert.deepEqual(C.issues({...base,status:'done',finalPrice:800}),[]);
});

test('a bed conflict rolls back coupon release, order changes, and audit as one transaction',async()=>{
  const wallet={coupons:[{id:'CP001',status:'reserved',reservedBookingId:'B001',used:false}]};
  const f=fixture({'bookings/B001':{...base,coupon,couponStatus:'reserved'},'customers/C001':wallet,'bookings/B002':{...base,id:'B002',time:'15:10'}});
  await assert.rejects(f.service.correct(input(f,{items:[{...foot,durationMinutes:120,price:1800}],releaseCoupon:true})),/BED_CONFLICT/);
  assert.deepEqual(f.db.records.get('customers/C001'),wallet);assert.equal(f.db.records.get('bookings/B001').svc,item.name);assert.equal(audits(f).length,0);
});
test('HTTP correction and history routes enforce the same permissions and never return secrets',async t=>{
  const f=fixture({'bookings/B001':{...base,status:'done',finalPrice:800}}),app=express();app.use(express.json());
  installBookingCorrectionRoutes({app,service:f.service,limiter:(req,res,next)=>next()});
  const server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url='http://127.0.0.1:'+server.address().port;
  const post=(path,body)=>fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const denied=await post('/api/admin/correct-booking',input(f,{actor:manager}));assert.equal(denied.status,403);
  const response=await post('/api/admin/correct-booking',input(f));assert.equal(response.status,200);assert.equal((await response.json()).booking.svc,foot.name);
  const history=await post('/api/admin/booking-corrections',{actor:boss,recoveryCode:ADMIN,bookingId:'B001'});
  assert.equal(history.status,200);const text=await history.text();assert.ok(!text.includes(ADMIN));assert.ok(!text.includes(boss.password));
});

test('longer service on another bed cannot overlap a therapist or helper on an existing booking',async()=>{
  for(const other of [{therapistId:'T031'}, {therapistId:'T043',supportId:'T031'}]){
    const f=fixture({'bookings/B001':{...base,therapistId:'T031'},
      'bookings/B002':{...base,...other,id:'B002',bed:2,time:'15:00'}});
    await assert.rejects(f.service.correct(input(f,{items:[{...item,durationMinutes:90}]})),{code:'therapist-conflict'});
    assert.equal(f.db.records.get('bookings/B001').durationMinutes,60);
    assert.equal(audits(f).length,0);
  }
});

'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const staff = require('../therapist-schedule');
const correction = require('../booking-correction');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const first = {id:'A', dateKey:'2026-11-27', status:'accepted', bed:1, therapistId:'T031', time:'10:00', durationMinutes:60};
const second = {...first, id:'B', status:'new', bed:2, time:'10:30'};
const nobody = () => null;

test('customer slot uses the full service interval across beds and allows consecutive appointments', () => {
  assert.equal(staff.conflicts(second, [first], nobody), true);
  assert.equal(staff.conflicts({...second, time:'09:30'}, [first], nobody), true);
  assert.equal(staff.conflicts({...second, time:'11:00'}, [first], nobody), false);
  assert.equal(staff.conflicts({...second, therapistId:'T043'}, [first], nobody), false);
  assert.equal(staff.conflicts({...second, therapistId:null}, [first], nobody), false);
  assert.equal(staff.conflicts(second, [{...first, status:'new'}], nobody), true);
  for (const status of ['declined','done']) assert.equal(staff.conflicts(second, [{...first,status}], nobody), false);
});
test('checks legacy dates, mapped assignees, helpers, actual start, extra time and midnight', () => {
  const employeeFor = id => id === 'legacy' ? {therapistId:'T031'} : null;
  const legacy = {...first, therapistId:null, acceptedBy:'legacy', dateKey:null, date:'11/27', year:2026};
  assert.equal(staff.conflicts(second,[legacy],employeeFor), true);
  assert.equal(staff.conflicts(second,[{...first,therapistId:'T043',supportId:'T031'}],nobody), true);
  assert.equal(staff.conflicts({...second,time:'11:20'},[{...first,startTime:'10:15',extraMins:15}],nobody), true);
  const night = {...first,startTime:'23:30',startTimestamp:Date.parse('2026-11-27T23:30:00+08:00')};
  assert.equal(staff.conflicts({...second,dateKey:'2026-11-28',time:'00:10'},[night],nobody),true);
});

// Minimal optimistic transaction store. A version mismatch retries all reads, including the server query.
function screen(seed = {}) {
  const records = new Map(Object.entries(seed)), versions = new Map();
  const snapshot = (id, value) => ({id:id.split('/').pop(), exists:() => value !== undefined, data:() => structuredClone(value)});
  const sdk = {
    doc:(_, col, id) => col+'/'+id, collection:(_, col) => col, where:(...args) => args, query:(col, condition) => ({col,condition}),
    async getDocsFromServer({col,condition:[field,op,values]}) {
      assert.equal(op,'in');
      return {docs:[...records].filter(([key,row]) => key.startsWith(col+'/') && values.includes(row[field])).map(([key,row]) => snapshot(key,row))};
    },
    async runTransaction(_, perform) {
      for (let attempt=0; attempt<8; attempt++) {
        const reads = new Map(), writes = new Map();
        const result = await perform({
          async get(key){assert.equal(writes.size,0);reads.set(key,versions.get(key)||0);return snapshot(key,records.get(key));},
          set(key,data){writes.set(key,structuredClone(data));}
        });
        if ([...reads].some(([key,v]) => (versions.get(key)||0)!==v)) continue;
        for (const [key,data] of writes) {records.set(key,data);versions.set(key,(versions.get(key)||0)+1);}
        return result;
      }
      throw new Error('too many transaction retries');
    }
  };
  const ctx = vm.createContext({TherapistSchedule:staff,db:async()=>({}),fs:()=>sdk,bookingDateKey:correction.dateKey,
    bookingInterval:b=>{const s=staff.windowFor(b);return {start:s.start/60000,end:s.end/60000+10};},
    intervalsOverlap:(a,b,c,d)=>a<d&&c<b,now:()=>'09:00',bookings:[],employees:[],selectedTotalDuration:()=>60});
  for (const name of ['staffBusy','requestedStaffBusy','prepareEditedBeds','checkStaffTransaction','createBookingAtomic','updateBookingAtomic','acceptBookingAtomic','updateBookingAndCouponAtomic']) {
    const start = html.search(new RegExp('^(?:async )?function '+name+'\\(', 'm'));
    assert.ok(start>=0,name);
    vm.runInContext(html.slice(start,html.indexOf('\n}',start)+2),ctx);
  }
  return {ctx,records};
}
test('customer selector, server-backed submit and accept all reject the example with a pre-upgrade booking', async () => {
  const {ctx,records} = screen({'bookings/A':first,'bookings/B':second});
  ctx.bookings=[first];
  assert.equal(ctx.requestedStaffBusy('T031',second.dateKey,second.time), true);
  assert.equal(ctx.requestedStaffBusy('T043',second.dateKey,second.time), false);
  ctx.bookings=[]; // A stale screen still cannot reserve the therapist.
  await assert.rejects(ctx.createBookingAtomic({...second,id:'C'}), {code:'therapist-conflict'});
  const manager={id:'manager',name:'值班'};
  await assert.rejects(ctx.acceptBookingAtomic('B',manager,{id:'T031',name:'31號'},manager),{code:'therapist-conflict'});
  assert.equal(records.get('bookings/B').status,'new');
  await ctx.acceptBookingAtomic('B',manager,{id:'T043',name:'43號'},manager);
  assert.equal(records.get('bookings/B').therapistId,'T043');
});
test('two simultaneous requests for one therapist on different beds commit exactly once', async () => {
  const {ctx,records}=screen();
  const same = await Promise.allSettled([ctx.createBookingAtomic(first), ctx.createBookingAtomic(second)]);
  assert.equal(same.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(same.find(r=>r.status==='rejected').reason.code,'therapist-conflict');
  assert.equal([...records.keys()].filter(k=>k.startsWith('bookings/')).length,1);
  const both=screen();
  await Promise.all([both.ctx.createBookingAtomic(first), both.ctx.createBookingAtomic({...second,therapistId:'T043'})]);
  assert.equal(both.records.get('bookings/B').therapistId,'T043');
});
test('failed edits, add-time and bed overrides preserve the original booking and bed; cancellation frees staff', async () => {
  const {ctx,records}=screen({'bookings/A':first});
  await ctx.createBookingAtomic({...second,time:'11:00'});
  const before=structuredClone(records.get('bedLocks/2026-11-27_bed2'));
  await assert.rejects(ctx.updateBookingAtomic('B', row=>({...row,bed:3,time:'10:30'}),{force:true}),{code:'therapist-conflict'});
  assert.deepEqual(records.get('bedLocks/2026-11-27_bed2'),before);
  assert.equal(records.has('bedLocks/2026-11-27_bed3'),false);
  await assert.rejects(ctx.updateBookingAtomic('A', row=>({...row,extraMins:15})),{code:'therapist-conflict'});
  assert.equal(records.get('bookings/A').extraMins,undefined);
  await ctx.updateBookingAndCouponAtomic('A',row=>({...row,status:'declined'}),'release');
  await ctx.updateBookingAtomic('B',row=>({...row,time:'10:30'}),{force:false});
  assert.equal(records.get('bookings/B').time,'10:30');
});

'use strict';
const crypto=require('node:crypto');
const C=require('./booking-correction');
const catalog=require('./service-catalog');
function fail(status,code,message){return Object.assign(new Error(code),{status,publicMessage:message});}
function equal(a,b){const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return y.length>0&&x.length===y.length&&crypto.timingSafeEqual(x,y);}
function id(value){return typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value)?value:'';}
function hash(value){return crypto.createHash('sha256').update(value).digest('hex');}
function minutes(value){const match=/^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(value||''));return match&&Number(match[1])<24&&Number(match[2])<60?Number(match[1])*60+Number(match[2]):NaN;}
function interval(b,buffer){
  const started=Number(b.startTimestamp),finished=Number(b.endTimestamp);
  const localMinutes=timestamp=>{const d=new Date(timestamp+8*3600000);return d.getUTCHours()*60+d.getUTCMinutes();};
  const start=b.startTime?(started>0?localMinutes(started):minutes(b.startTime)):minutes(b.time);
  let end=b.endTime?(finished>0?localMinutes(finished):minutes(b.endTime)):start+C.bookingMinutes(b)+Number(b.extraMins||0);
  if(b.endTime&&end<start)end+=1440;
  return {start,end:end+buffer};
}
function createBookingCorrectionService({db,managementCode,clock=Date.now}){
  function ready(){if(!db)throw fail(503,'DATABASE_UNAVAILABLE','改單服務尚未連線，請先部署後端');}
  async function actorIn(tx,actor){
    if(!actor||!id(actor.id)||typeof actor.password!=='string'||actor.password.length>128)throw fail(403,'AUTH_REQUIRED','請重新登入店長或管理人員帳號');
    const snapshot=await tx.get(db.collection('employees').doc(actor.id)),employee=snapshot.exists?snapshot.data():{};
    if(!equal(actor.password,employee.pw)||!['boss','manager'].includes(employee.role))throw fail(403,'ROLE_DENIED','此帳號沒有改單權限');
    return {id:snapshot.id,name:C.text(employee.name||snapshot.id,80),role:employee.role};
  }
  function requireBoss(actor,code){if(actor.role!=='boss'||!equal(code,managementCode))throw fail(403,'BOSS_CODE_REQUIRED','更正完成單據或查看修改紀錄需輸入正確的店長管理碼');}
  async function correct(body){
    ready();const bookingId=id(body.bookingId),requestId=String(body.requestId||'');
    if(!bookingId||!/^[a-f0-9-]{36}$/i.test(requestId)||!/^[a-f0-9]{64}$/i.test(body.expectedFingerprint||''))throw fail(400,'INPUT_INVALID','改單資料不完整，請關閉後重新開啟');
    const input={items:body.items,note:body.note,reason:body.reason,discountAmount:body.discountAmount,finalPrice:body.finalPrice,releaseCoupon:body.releaseCoupon===true};
    const payloadHash=hash(C.stable(input)),ref=db.collection('bookings').doc(bookingId),auditRef=db.collection('bookingCorrections').doc(bookingId+'_'+requestId);
    return db.runTransaction(async tx=>{
      const actor=await actorIn(tx,body.actor);
      const snapshot=await tx.get(ref);if(!snapshot.exists)throw fail(404,'BOOKING_NOT_FOUND','找不到這筆預約');
      const current={...snapshot.data(),id:bookingId};
      if(current.status==='done')requireBoss(actor,body.recoveryCode);
      const prior=await tx.get(auditRef);
      if(prior.exists){if(prior.data().payloadHash!==payloadHash||prior.data().byId!==actor.id)throw fail(409,'REQUEST_REUSED','此操作編號已用於其他更正，請重新開啟單據');return {booking:current,alreadyApplied:true};}
      if(hash(C.stateString(current))!==body.expectedFingerprint)throw fail(409,'BOOKING_CHANGED','此單已在其他裝置變更，請重新開啟後確認，避免蓋掉新資料');
      const result=C.plan(current,input),next=result.booking;
      // Validate service identity against the same catalog used by the browser.
      const customSnapshot=await tx.get(db.collection('settings').doc('customSvcs'));
      const customs=customSnapshot.exists&&Array.isArray(customSnapshot.data().list)?customSnapshot.data().list:[];
      for(const row of next.items){
        const preset=typeof row.id==='number'?catalog.find(service=>service.id===row.id):null;
        const custom=typeof row.id==='string'?customs.find(service=>'custom_'+service.id===row.id):null;
        if((preset&&row.name!==preset.name)||(custom&&row.name!==custom.name)||(!preset&&!custom&&row.id!==null))throw fail(400,'SERVICE_ID_MISMATCH','服務編號與名稱不符，請重新選擇服務');
        if(actor.role!=='boss'){
          const unchanged=C.normalizeItems(C.itemsFrom(current)).some(old=>C.stable(old)===C.stable(row));
          const option=preset&&preset.prices.some(price=>price.p===row.price&&C.duration(price.l,C.duration(preset.prices[0].l))===row.durationMinutes);
          if(!unchanged&&!option&&!(custom&&Number(custom.price)===row.price&&Number(custom.dur)===row.durationMinutes))throw fail(403,'CUSTOM_PRICE_BOSS_ONLY','手動服務、分鐘或價格調整請由店長操作');
        }
      }
      let customerRef=null,customer=null;
      // Changing an unfinished coupon booking uses the SAME reservation, not a new claim.
      if(current.status!=='done'&&current.coupon&&(current.couponStatus||current.coupon.status)!=='released'){
        const customerId=id(current.custId);if(!customerId||!current.coupon.instanceId)throw fail(409,'COUPON_RECORD_INVALID','找不到優惠券綁定紀錄，請先核對會員資料');
        customerRef=db.collection('customers').doc(customerId);
        const customerSnapshot=await tx.get(customerRef);if(!customerSnapshot.exists)throw fail(409,'CUSTOMER_MISSING','優惠券所屬會員已不存在，未更動此單');
        customer={...customerSnapshot.data(),id:customerId};
        const wallet=Array.isArray(customer.coupons)?customer.coupons.map(c=>({...c})):[];
        const index=wallet.findIndex((c,i)=>(c.id||'LEGACY_'+String(c.code||'COUPON').toUpperCase()+'_'+i)===current.coupon.instanceId);
        if(index<0||wallet[index].status!=='reserved'||wallet[index].reservedBookingId!==bookingId)throw fail(409,'COUPON_STATE_CHANGED','優惠券鎖定狀態已改變，未更動此單');
        if(result.releaseCoupon){const coupon={...wallet[index],status:'available',used:false,releasedAt:new Date(clock()).toISOString()};delete coupon.reservedBookingId;delete coupon.reservedAt;wallet[index]=coupon;}
        customer={...customer,coupons:wallet,couponUpdatedAt:new Date(clock()).toISOString()};
      }
      let lockRef=null,lockData=null;
      if(current.status!=='done'&&current.bed){
        const key=C.dateKey(current);if(!key)throw fail(409,'DATE_INVALID','預約日期不完整，請先修正日期');
        const config=await tx.get(db.collection('settings').doc('appConfig'));
        const configured=config.exists?Number(config.data().bedBuffer):NaN;
        const buffer=Number.isFinite(configured)?Math.max(0,Math.min(120,configured)):10;
        lockRef=db.collection('bedLocks').doc(key+'_bed'+current.bed);
        const locked=await tx.get(lockRef);lockData=locked.exists?locked.data():{};
        const all=await tx.get(db.collection('bookings').where('dateKey','==',key));
        const currentInterval=interval(next,buffer);
        if(!Number.isFinite(currentInterval.start)||!Number.isFinite(currentInterval.end))throw fail(400,'TIME_INVALID','預約開始時間不正確');
        const oldInterval=interval(current,buffer);
        if(!current.startTime&&currentInterval.end>oldInterval.end&&currentInterval.end-buffer>1320)throw fail(409,'AFTER_CLOSING','新服務總時間超過 22:00，請先調整預約時間');
        const rows=(Array.isArray(lockData.reservations)?lockData.reservations:[]).filter(row=>row&&row.bookingId!==bookingId&&row.status!=='declined');
        const comparisons=rows.concat(all.docs.filter(doc=>doc.id!==bookingId).map(doc=>doc.data()).filter(b=>b.status!=='declined'&&Number(b.bed)===Number(current.bed)).map(b=>interval(b,buffer)));
        if(comparisons.some(other=>currentInterval.start<Number(other.end)&&currentInterval.end>Number(other.start)))throw fail(409,'BED_CONFLICT','新服務時間與同床位其他預約重疊，請先換床位或調整時間');
        lockData={...lockData,dateKey:key,bed:current.bed,reservations:[...rows,{bookingId,start:currentInterval.start,end:currentInterval.end,status:current.status,updatedAt:new Date(clock()).toISOString()}]};
      }
      const at=new Date(clock()).toISOString();
      next.correctionRevision=(Number(current.correctionRevision)||0)+1;
      next.lastCorrection={at,byId:actor.id,byName:actor.name,reason:result.reason,requestId,couponOverride:result.couponOverride};
      next.reportEditedAt=at;next.reportEditedBy=actor.id;next._updated=at;
      // Read everything first; all writes, coupon release, lock, and audit commit together.
      tx.set(ref,next);
      if(customerRef)tx.set(customerRef,customer);
      if(lockRef)tx.set(lockRef,{...lockData,_updated:at});
      tx.set(auditRef,{bookingId,requestId,payloadHash,byId:actor.id,byName:actor.name,at,reason:result.reason,
        revision:next.correctionRevision,couponReleased:result.releaseCoupon,couponOverride:result.couponOverride,
        before:C.state(current),after:C.state(next)});
      return {booking:next,customer:customer?{id:customer.id,coupons:customer.coupons}:null};
    });
  }
  async function history(body){
    ready();const bookingId=id(body.bookingId);if(!bookingId)throw fail(400,'BOOKING_ID_REQUIRED','請指定單據');
    await db.runTransaction(async tx=>{const actor=await actorIn(tx,body.actor);requireBoss(actor,body.recoveryCode);});
    const records=await db.collection('bookingCorrections').where('bookingId','==',bookingId).get();
    return {history:records.docs.map(doc=>{const {payloadHash,...record}=doc.data();return record;}).sort((a,b)=>b.at.localeCompare(a.at)||b.revision-a.revision).slice(0,50)};
  }
  return {correct,history};
}
function installBookingCorrectionRoutes({app,service,limiter}){
  const route=action=>async(req,res)=>{try{res.json({ok:true,...await action(req.body||{})});}catch(error){res.status(error.status||500).json({error:error.publicMessage||'更正儲存失敗，原單據已保留',code:error.code||error.message});}};
  app.post('/api/admin/correct-booking',limiter,route(service.correct));
  app.post('/api/admin/booking-corrections',limiter,route(service.history));
}
module.exports={createBookingCorrectionService,installBookingCorrectionRoutes,interval};

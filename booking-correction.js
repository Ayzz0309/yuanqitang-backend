(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();else root.BookingCorrection=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function error(code,message){return Object.assign(new Error(code),{code,publicMessage:message,status:400});}
  function text(value,max){return String(value==null?'':value).replace(/[<>\u0000-\u001f\u007f]/g,'').trim().slice(0,max);}
  function integer(value,min,max,label){
    if(value===''||value===null||typeof value==='boolean'||!Number.isInteger(Number(value))||Number(value)<min||Number(value)>max)throw error('INVALID_NUMBER',label+'格式不正確');
    return Number(value);
  }
  function duration(value,fallback){
    const numbers=String(value||'').match(/\d+/g);
    return numbers&&numbers.length?(String(value).includes('+')?numbers.reduce((sum,n)=>sum+Number(n),0):Number(numbers[0])):(Number(fallback)||60);
  }
  function dateKey(b){
    if(/^\d{4}-\d{2}-\d{2}$/.test(b.dateKey||''))return b.dateKey;
    const match=String(b.date||'').match(/^(?:(\d{4})[-/])?(\d{1,2})[-/](\d{1,2})$/);
    return match?(match[1]||b.year||2026)+'-'+String(match[2]).padStart(2,'0')+'-'+String(match[3]).padStart(2,'0'):'';
  }
  function bookingMinutes(b){return Number(b.durationMinutes)||Number(b.durMins)||duration(b.dur);}
  function itemsFrom(b){
    if(Array.isArray(b.items)&&b.items.length)return b.items.map(item=>({
      id:item.id==null?null:item.id,name:String(item.name||''),durationMinutes:Number(item.durationMinutes)||duration(item.durationLabel,bookingMinutes(b)),
      durationLabel:item.durationLabel||String(Number(item.durationMinutes)||duration(item.durationLabel,bookingMinutes(b)))+'分',price:Number(item.price)||0
    }));
    return [{id:null,name:b.svc||'服務',durationMinutes:bookingMinutes(b),durationLabel:bookingMinutes(b)+'分',price:Number(b.subtotalPrice!==undefined?b.subtotalPrice:b.price)||0}];
  }
  function normalizeItems(input){
    if(!Array.isArray(input)||!input.length||input.length>20)throw error('ITEMS_REQUIRED','請保留 1–20 個服務項目');
    const items=input.map(item=>{
      if(!item||typeof item!=='object')throw error('INVALID_ITEM','服務明細格式不正確');
      const name=text(item.name,100);if(!name)throw error('ITEM_NAME_REQUIRED','服務名稱不可空白');
      const mins=integer(item.durationMinutes,1,1440,'服務分鐘'),price=integer(item.price,0,1000000,'服務金額');
      const id=item.id==null||item.id===''?null:(/^custom_\d+$/.test(String(item.id))?String(item.id):integer(item.id,1,1000000,'服務編號'));
      return {id,name,durationMinutes:mins,durationLabel:mins+'分',price};
    });
    if(items.reduce((sum,row)=>sum+row.price,0)>1000000||items.reduce((sum,row)=>sum+row.durationMinutes,0)>1440)throw error('ITEM_TOTAL_TOO_LARGE','服務總額或總時數超過限制');
    return items;
  }
  function eligibleSubtotal(coupon,items){
    const subtotal=items.reduce((sum,row)=>sum+row.price,0);
    if(!coupon||!coupon.serviceScope||coupon.serviceScope==='all')return subtotal;
    const ids=new Set((coupon.applicableServiceIds||[]).map(Number)),names=new Set((coupon.applicableServiceNames||[]).map(String));
    if(coupon.serviceScope==='singing_bowl_course')ids.add(20);
    return items.reduce((sum,row)=>sum+((ids.size?ids.has(Number(row.id)):names.has(row.name))?row.price:0),0);
  }
  function discountFor(coupon,items,key){
    const subtotal=items.reduce((sum,row)=>sum+row.price,0),eligible=eligibleSubtotal(coupon,items);
    if(!coupon||subtotal<Number(coupon.minSpend||0)||(coupon.validFrom&&key<coupon.validFrom)||(coupon.validUntil&&key>coupon.validUntil))return 0;
    let discount=coupon.type==='percent'?Math.floor(eligible*Number(coupon.value||0)/100):Math.round(Number(coupon.value||0));
    if(coupon.type==='percent'&&Number(coupon.maxDiscount)>0)discount=Math.min(discount,Number(coupon.maxDiscount));
    return Math.max(0,Math.min(eligible,discount));
  }
  function stable(value){
    if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
    if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key]===undefined?null:value[key])).join(',')+'}';
    return JSON.stringify(value===undefined?null:value);
  }
  function state(b){
    const fields=['status','svc','items','price','subtotalPrice','originalPrice','payablePrice','discountAmount','finalPrice','note','extraMins','startTime','startTimestamp','endTime','endTimestamp','actualMins','completedMins','actualElapsedMins','acceptedBy','therapistId','bed','time','coupon','couponStatus','custId','correctionRevision','lastCorrection','_updated'];
    const data={};fields.forEach(key=>data[key]=b[key]===undefined?null:b[key]);
    data.dateKey=dateKey(b);data.durationMinutes=bookingMinutes(b);
    return data;
  }
  function stateString(b){return stable(state(b));}
  async function fingerprint(b){
    const digest=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(stateString(b)));
    return [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
  }
  function plan(current,input){
    if(!['new','accepted','done'].includes(current.status))throw error('BOOKING_NOT_EDITABLE','已取消或婉拒的預約不能改單');
    const reason=text(input.reason,300);if(reason.length<2)throw error('REASON_REQUIRED','請填寫至少兩個字的更正原因');
    const items=normalizeItems(input.items),subtotal=items.reduce((sum,row)=>sum+row.price,0),minutes=items.reduce((sum,row)=>sum+row.durationMinutes,0);
    if(minutes+Number(current.extraMins||0)>1440)throw error('DURATION_TOO_LARGE','含加時的總分鐘超過限制');
    let coupon=current.coupon?JSON.parse(JSON.stringify(current.coupon)):null,discount=0,releaseCoupon=false,couponOverride=false;
    if(current.status==='done'){
      discount=integer(input.discountAmount,0,subtotal,'優惠折抵');
      if(coupon){couponOverride=discount!==discountFor(coupon,items,dateKey(current));coupon.discountAmount=discount;coupon.eligibleSubtotal=eligibleSubtotal(coupon,items);}
    }else if(coupon&&current.couponStatus!=='released'&&coupon.status!=='released'){
      discount=discountFor(coupon,items,dateKey(current));
      if(discount<=0){
        if(input.releaseCoupon!==true)throw error('COUPON_RELEASE_REQUIRED','新服務不符合優惠券條件，請勾選確認退回此券');
        coupon=null;releaseCoupon=true;
      }else{coupon.discountAmount=discount;coupon.eligibleSubtotal=eligibleSubtotal(coupon,items);}
    }
    const next={...current,items,svc:items.map(row=>row.name).join(' ＋ '),dur:minutes+'分',durationMinutes:minutes,durMins:minutes,
      price:subtotal,subtotalPrice:subtotal,originalPrice:subtotal,discountAmount:discount,payablePrice:subtotal-discount,note:text(input.note,500)};
    if(current.coupon){next.coupon=coupon;next.couponStatus=releaseCoupon?'released':current.couponStatus||current.coupon.status||'reserved';}
    if(current.status==='done'){
      next.finalPrice=integer(input.finalPrice,0,1000000,'實收金額');
      next.priceDiff=next.finalPrice-subtotal;next.actualMins=minutes+Number(current.extraMins||0);next.completedMins=next.actualMins;
    }
    return {booking:next,reason,releaseCoupon,couponOverride};
  }
  function issues(b){
    const result=[],items=Array.isArray(b.items)?b.items:[];
    if(items.length){
      if(items.map(row=>row.name).join(' ＋ ')!==String(b.svc||''))result.push('服務名稱與明細不一致');
      const subtotal=items.reduce((sum,row)=>sum+Number(row.price||0),0),mins=items.reduce((sum,row)=>sum+(Number(row.durationMinutes)||duration(row.durationLabel)),0);
      if(subtotal!==Number(b.subtotalPrice!==undefined?b.subtotalPrice:b.price))result.push('服務小計與明細不一致');
      if(mins!==bookingMinutes(b))result.push('服務分鐘與明細不一致');
    }
    if(b.status==='done'&&(!Number.isInteger(Number(b.finalPrice))||b.finalPrice==null||b.finalPrice===''||Number(b.finalPrice)<0))result.push('已完成但實收金額異常');
    if(Number(b.discountAmount||0)>Number(b.subtotalPrice!==undefined?b.subtotalPrice:b.price))result.push('優惠折抵超過服務小計');
    if(b.status==='done'&&b.coupon&&(b.couponStatus||b.coupon.status)!=='used')result.push('已完成但優惠券核銷狀態待查');
    return result;
  }
  return {text,integer,duration,dateKey,bookingMinutes,itemsFrom,normalizeItems,eligibleSubtotal,discountFor,stable,state,stateString,fingerprint,plan,issues};
});

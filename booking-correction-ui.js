'use strict';
let correctionDraft=null;

function correctionButtonHtml(id,label='更正單據'){
  const encoded=encodeURIComponent(String(id)).replace(/'/g,'%27');
  return '<button class="mini-btn primary" style="margin-top:6px" onclick="openBookingCorrection(decodeURIComponent(\''+encoded+'\'))">'+esc(label)+'</button>';
}

function correctionActor(){return {id:cur.user.id,password:cur.user.pw};}
function correctionModal(){
  let el=document.getElementById('booking-correction-modal');
  if(!el){
    el=document.createElement('div');el.id='booking-correction-modal';el.className='modal-overlay hidden';el.style.zIndex='10100';
    el.setAttribute('role','dialog');el.setAttribute('aria-modal','true');el.setAttribute('aria-labelledby','rc-title');
    el.innerHTML='<div class="modal-box" style="max-width:520px" id="rc-body"></div>';
    el.addEventListener('click',event=>{if(event.target===el)closeBookingCorrection();});document.body.appendChild(el);
  }
  return el;
}
function correctionOptions(){
  const options=[];
  SVCS.forEach(service=>service.prices.forEach((price,index)=>options.push({key:'svc_'+service.id+'_'+index,id:service.id,name:service.name,
    durationMinutes:selectedSvcDurationMinutes({...service,selectedPrice:price}),price:Number(price.p),label:service.name+' '+price.l+'／$'+price.p})));
  customSvcs.filter(service=>Number.isInteger(Number(service.id))&&Number(service.id)>0).forEach(service=>options.push({key:'custom_'+Number(service.id),id:'custom_'+Number(service.id),name:service.name,durationMinutes:Number(service.dur),price:Number(service.price),label:service.name+' '+service.dur+'分／$'+service.price}));
  return options;
}
async function openBookingCorrection(id){
  const b=bookings.find(row=>row.id===id);if(!b)return;
  if(b.status==='done'){if(!requireBoss('更正完成單據'))return;}
  else if(!requireBookingManager('更換服務項目'))return;
  if(!['new','accepted','done'].includes(b.status)){alert('此預約狀態不能改單');return;}
  if(!globalThis.BookingCorrection){alert('改單程式尚未載入，請確認已上傳完整版本後重新整理');return;}
  const original=JSON.parse(JSON.stringify(b));
  correctionDraft={bookingId:id,original,items:BookingCorrection.itemsFrom(original),requestId:crypto.randomUUID(),
    fingerprint:BookingCorrection.fingerprint(original),returnFocus:document.activeElement};
  const done=b.status==='done',modal=correctionModal();
  document.getElementById('rc-body').innerHTML='<div class="modal-title"><span id="rc-title">'+(done?'更正已完成單據':'更換服務項目')+'</span><button class="modal-close" onclick="closeBookingCorrection()">✕ 關閉</button></div>'
    +'<div style="font-size:12px;line-height:1.8;color:var(--text2);margin-bottom:12px"><strong>'+esc(b.name)+'</strong> ・ '+esc(displayBookingDate(b))+' '+esc(b.time)+'<br>原單服務：'+esc(b.svc)+' '+esc(b.dur)+'<br>'
    +(done?'已切單的原實收金額會先保留，請核對後儲存。優惠券維持原核銷狀態，不退券、不重發。':'更換後會重算應收與優惠券，並檢查同床位是否有時段衝突。服務中也可改單，開始時間會保留。')+'</div>'
    +'<div id="rc-error" role="alert" style="color:var(--red);font-size:12px;line-height:1.7;margin-bottom:10px"></div><div id="rc-items"></div>'
    +'<button class="sbtn" onclick="addCorrectionItem()" style="margin:4px 0 12px">＋ 加一個服務</button>'
    +'<div id="rc-summary" style="padding:12px;background:var(--pu-pale);border-radius:10px;font-size:12px;line-height:1.9;margin-bottom:14px"></div>'
    +(done?'<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><div class="fg"><label class="flbl" for="rc-discount">優惠折抵金額</label><input id="rc-discount" class="finp" type="number" min="0" step="1" value="'+Number(b.discountAmount||0)+'" oninput="updateCorrectionSummary()"></div><div class="fg"><label class="flbl" for="rc-final">實收金額</label><input id="rc-final" class="finp" type="number" min="0" step="1" value="'+effectivePrice(b)+'" oninput="updateCorrectionSummary()"></div></div>':'')
    +(!done&&b.coupon?'<label style="display:block;font-size:12px;line-height:1.8;margin-bottom:14px"><input id="rc-release" type="checkbox" onchange="updateCorrectionSummary()"> 新服務不符合優惠條件時，確認退回此券</label>':'')
    +'<div class="fg"><label class="flbl" for="rc-note">單據備註</label><textarea id="rc-note" class="finp" rows="2" maxlength="500">'+esc(b.note||'')+'</textarea></div>'
    +'<div class="fg"><label class="flbl" for="rc-reason">更正原因（必填）</label><input id="rc-reason" class="finp" maxlength="300" placeholder="例如：客人現場更換服務、原單項目誤植"></div>'
    +(isBossSession()?'<div class="fg"><label class="flbl" for="rc-code">店長管理碼'+(done?'（必填）':'（查看修改紀錄時填寫）')+'</label><input id="rc-code" class="finp" type="password" autocomplete="off" placeholder="與帳號管理使用相同管理碼"></div>':'')
    +'<button id="rc-save" class="auth-submit" onclick="saveBookingCorrection()">確認儲存'+(done?'更正':'改單')+'</button>'
    +(isBossSession()?'<button class="sbtn" style="margin-top:10px" onclick="loadBookingCorrectionHistory()">查看這筆單據的修改紀錄</button><div id="rc-history" style="margin-top:12px"></div>':'');
  renderCorrectionItems();modal.classList.remove('hidden');setTimeout(()=>document.getElementById('rc-reason')?.focus(),0);
}
function renderCorrectionItems(){
  if(!correctionDraft)return;
  const options=correctionOptions(),boss=isBossSession();
  document.getElementById('rc-items').innerHTML=correctionDraft.items.map((row,index)=>{
    const selected=options.find(option=>option.id===row.id&&option.price===Number(row.price)&&option.durationMinutes===Number(row.durationMinutes)&&option.name===row.name);
    return '<div style="border:1px solid var(--border);padding:12px;border-radius:12px;margin-bottom:12px">'
      +'<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><strong style="font-size:12px">服務 '+(index+1)+'</strong><button class="mini-btn danger" onclick="removeCorrectionItem('+index+')" aria-label="移除服務 '+(index+1)+'">移除</button></div>'
      +'<label class="flbl" for="rc-preset-'+index+'">選擇服務</label><select class="finp" id="rc-preset-'+index+'" onchange="chooseCorrectionService('+index+',this.value)"><option value="manual" '+(!selected?'selected':'')+'>自訂／歷史品項</option>'
      +options.map(option=>'<option value="'+option.key+'" '+(selected&&selected.key===option.key?'selected':'')+'>'+esc(option.label)+'</option>').join('')+'</select>'
      +'<label class="flbl" style="margin-top:8px" for="rc-name-'+index+'">服務名稱</label><input class="finp" id="rc-name-'+index+'" value="'+esc(row.name)+'" maxlength="100" '+(row.id!==null||!boss?'readonly':'')+' oninput="setCorrectionItem('+index+',\'name\',this.value)">'
      +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px"><div><label class="flbl" for="rc-minutes-'+index+'">分鐘</label><input class="finp" id="rc-minutes-'+index+'" type="number" min="1" step="1" value="'+Number(row.durationMinutes)+'" '+(!boss?'readonly':'')+' oninput="setCorrectionItem('+index+',\'durationMinutes\',this.value)"></div>'
      +'<div><label class="flbl" for="rc-price-'+index+'">服務金額</label><input class="finp" id="rc-price-'+index+'" type="number" min="0" step="1" value="'+Number(row.price)+'" '+(!boss?'readonly':'')+' oninput="setCorrectionItem('+index+',\'price\',this.value)"></div></div></div>';
  }).join('');
  updateCorrectionSummary();
}
function addCorrectionItem(){if(!correctionDraft)return;if(correctionDraft.items.length>=20){alert('最多 20 個服務');return;}correctionDraft.items.push({id:null,name:'',durationMinutes:60,price:0});renderCorrectionItems();}
function removeCorrectionItem(index){if(!correctionDraft)return;if(correctionDraft.items.length<=1){alert('至少保留一個服務');return;}correctionDraft.items.splice(index,1);renderCorrectionItems();}
function chooseCorrectionService(index,key){
  if(!correctionDraft)return;
  if(key==='manual'){
    if(!isBossSession()){alert('自訂品項請由店長操作');renderCorrectionItems();return;}
    correctionDraft.items[index].id=null;
  }else{
    const option=correctionOptions().find(row=>row.key===key);if(!option)return;
    correctionDraft.items[index]={id:option.id,name:option.name,durationMinutes:option.durationMinutes,durationLabel:option.durationMinutes+'分',price:option.price};
  }
  renderCorrectionItems();
}
function setCorrectionItem(index,key,value){if(correctionDraft){correctionDraft.items[index][key]=value;updateCorrectionSummary();}}
function correctionInput(){
  return {items:correctionDraft.items,note:document.getElementById('rc-note')?.value||'',reason:document.getElementById('rc-reason')?.value||'',
    discountAmount:document.getElementById('rc-discount')?.value,finalPrice:document.getElementById('rc-final')?.value,releaseCoupon:document.getElementById('rc-release')?.checked===true};
}
function updateCorrectionSummary(){
  if(!correctionDraft||!document.getElementById('rc-summary'))return;
  const el=document.getElementById('rc-summary'),b=correctionDraft.original;
  try{
    const result=BookingCorrection.plan(b,{...correctionInput(),reason:'改單預覽'}),next=result.booking;
    el.innerHTML='服務共 '+next.items.length+' 項／'+next.durationMinutes+' 分'+(Number(b.extraMins)>0?'，另保留加時 '+Number(b.extraMins)+' 分':'')+'<br>小計 NT$'+next.subtotalPrice.toLocaleString()+' − 折抵 NT$'+next.discountAmount.toLocaleString()+' ＝ 應收 NT$'+next.payablePrice.toLocaleString()
      +(b.status==='done'?'<br><strong>實收 NT$'+next.finalPrice.toLocaleString()+'</strong>（修改服務不會自動改掉實收）':'')
      +(result.releaseCoupon?'<br><strong style="color:var(--red)">本次儲存將退回原優惠券</strong>':'')
      +(result.couponOverride?'<br><span style="color:var(--red)">本次折抵與原券條件不同，將記錄為店長人工更正；不改變優惠券核銷狀態。</span>':'');
  }catch(error){el.textContent=error.publicMessage||'請填寫完整服務資料';}
}
function closeBookingCorrection(){
  const draft=correctionDraft;correctionDraft=null;
  const modal=document.getElementById('booking-correction-modal');if(modal)modal.classList.add('hidden');
  const body=document.getElementById('rc-body');if(body)body.innerHTML='';
  if(draft?.returnFocus?.isConnected)draft.returnFocus.focus();
}
async function correctionRequest(path,payload){
  const response=await fetch(LINE_CONFIG.backendUrl+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(25000)});
  const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.error||'更正儲存失敗');return result;
}
async function saveBookingCorrection(){
  const draft=correctionDraft;if(!draft||!canManageBookingsSession())return;
  const action='correction_'+draft.bookingId;if(!beginAction(action))return;
  const button=document.getElementById('rc-save');if(button){button.disabled=true;button.textContent='儲存中…';}
  try{
    const input=correctionInput();BookingCorrection.plan(draft.original,input);
    const code=document.getElementById('rc-code')?.value||'';
    if(draft.original.status==='done'&&!code)throw new Error('請輸入店長管理碼');
    const actor=correctionActor();
    const result=await correctionRequest('/api/admin/correct-booking',{...input,actor,recoveryCode:code,bookingId:draft.bookingId,requestId:draft.requestId,expectedFingerprint:await draft.fingerprint});
    if(!cur.user||cur.type!=='emp'||cur.user.id!==actor.id)return;
    const index=bookings.findIndex(b=>b.id===draft.bookingId);if(index>=0)bookings[index]=migrateBookingInMemory(result.booking);
    if(result.customer){const c=customers.find(row=>row.id===result.customer.id);if(c)c.coupons=result.customer.coupons;}
    if(correctionDraft===draft)closeBookingCorrection();
    renderStaffNav();renderStaffContent();if(typeof startTimerLoop==='function')startTimerLoop();
    toast(result.alreadyApplied?'這次更正已完成，已載入最新單據':'服務明細、金額與相關紀錄已同步更新','sys','單據更正完成');
  }catch(error){if(correctionDraft===draft){const el=document.getElementById('rc-error');if(el)el.textContent=error.name==='TimeoutError'?'連線逾時，請先重新整理確認單據，避免重複修改。':error.message||'儲存失敗，原單據已保留';}}
  finally{endAction(action);if(correctionDraft===draft&&button){button.disabled=false;button.textContent='確認儲存';}}
}
async function loadBookingCorrectionHistory(){
  const draft=correctionDraft;if(!draft||!requireBoss('查看修改紀錄')||!beginAction('correction-history'))return;
  try{
    const code=document.getElementById('rc-code')?.value;if(!code)throw new Error('請先填入店長管理碼');
    const result=await correctionRequest('/api/admin/booking-corrections',{actor:correctionActor(),recoveryCode:code,bookingId:draft.bookingId});
    if(correctionDraft!==draft)return;
    const el=document.getElementById('rc-history');
    el.innerHTML=result.history.length?result.history.map(log=>'<div style="padding:10px 0;border-top:1px solid var(--border);font-size:11px;line-height:1.8"><strong>第 '+log.revision+' 次 ・ '+esc(log.byName)+'</strong><br>'+esc(new Date(log.at).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'}))+'<br>原因：'+esc(log.reason)+'<br>原：'+esc(log.before.svc)+' '+esc(log.before.durationMinutes)+'分／實收 '+esc(log.before.finalPrice==null?'未切單':log.before.finalPrice)+'<br>新：'+esc(log.after.svc)+' '+esc(log.after.durationMinutes)+'分／實收 '+esc(log.after.finalPrice==null?'未切單':log.after.finalPrice)+'</div>').join(''):'<div style="font-size:12px;color:var(--text3)">這筆單據尚無本版的修改紀錄。</div>';
  }catch(error){if(correctionDraft===draft)document.getElementById('rc-error').textContent=error.message;}
  finally{endAction('correction-history');}
}
function openServiceFromBookingEdit(){
  const id=editingBookId,b=bookings.find(row=>row.id===id);if(!b)return;
  const dirty=document.getElementById('em-name').value!==(b.name||'')||document.getElementById('em-phone').value!==(b.phone||'')||document.getElementById('em-note').value!==(b.note||'')
    ||document.getElementById('em-date').value!==(b.dateKey||b.date||'')||document.getElementById('em-time').value!==(b.time||'')
    ||Number(document.getElementById('em-bed').value||0)!==Number(b.bed||0)||document.getElementById('em-therapist').value!==(b.therapistId||'');
  if(dirty&&!confirm('其他資料尚未儲存，是否先離開並更換服務？'))return;
  closeEditModal();openBookingCorrection(id);
}
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&correctionDraft)closeBookingCorrection();});

function setReportQuery(value){reportQuery=String(value||'').trim();reportDoneLimit=30;renderStaffContent();}
function showMoreReportDone(){reportDoneLimit+=30;renderStaffContent();}
function toggleReportChecks(){reportChecksVisible=!reportChecksVisible;renderStaffContent();}
function renderReportChecks(list){
  if(!isBossSession()||!reportChecksVisible)return '';
  const candidates=list.filter(b=>b.status!=='declined').map(b=>({booking:b,issues:BookingCorrection.issues(b)})).filter(row=>row.issues.length);
  let out='<div style="margin:0 .9rem 1rem;padding:12px;border:1px solid var(--border);border-radius:12px;background:#fff"><strong style="font-size:13px">本次單據檢查：'+candidates.length+' 筆待核對</strong><div style="font-size:11px;color:var(--text2);line-height:1.8;margin:6px 0">檢查服務名稱、明細金額、分鐘與已完成單據的實收／優惠券狀態；不會自動更動帳款。</div>';
  if(!candidates.length)out+='<div style="font-size:12px;color:var(--green)">目前期間未發現上述資料不一致。</div>';
  candidates.slice(0,100).forEach(row=>{const b=row.booking;out+='<div style="padding:8px 0;border-top:1px solid var(--border);font-size:12px;line-height:1.8"><strong>'+esc(b.name)+' ・ '+esc(displayBookingDate(b))+'</strong><br>'+row.issues.map(esc).join('、')+'<br>'+correctionButtonHtml(b.id,'開啟單據核對')+'</div>';});
  if(candidates.length>100)out+='<div style="font-size:11px;color:var(--text3)">先列前 100 筆，可切換月份縮小範圍。</div>';
  return out+'</div>';
}

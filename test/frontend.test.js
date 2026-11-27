'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const C=require('../booking-correction');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const ui=fs.readFileSync(path.join(__dirname,'../booking-correction-ui.js'),'utf8');
function source(name){const match=new RegExp('^(?:async )?function '+name+'\\(','m').exec(html);assert.ok(match,name+' exists');const end=html.indexOf('\n}',match.index);return html.slice(match.index,end+2);}
const esc=value=>String(value==null?'':value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
test('all inline and local browser scripts parse and required files exist',()=>{
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
    const external=/src="([^"]+)"/.exec(match[1]);if(external){const filename=path.join(__dirname,'..',external[1].split('?')[0]);assert.ok(fs.existsSync(filename));new vm.Script(fs.readFileSync(filename,'utf8'));continue;}
    if(/type="module"/.test(match[1])){const r=spawnSync(process.execPath,['--input-type=module','--check'],{input:match[2],encoding:'utf8'});assert.equal(r.status,0,r.stderr);}
    else new vm.Script(match[2]);
  }
});
test('report and customer history both render correction buttons and use corrected item allocations',()=>{
  const rows=[{id:'B001',name:'測試客人',phone:'0912345678',dateKey:'2026-10-20',time:'14:00',status:'done',svc:'新服務',items:[{name:'新服務',price:900}],subtotalPrice:900,payablePrice:900,finalPrice:700,acceptedBy:'boss'}];
  const context=vm.createContext({cur:{user:{id:'boss'}},isBossSession:()=>true,bossOnlyMessage:()=>'',bookings:rows,employees:[{id:'boss',name:'店長',role:'boss'}],reportMonth:'all',reportQuery:'',reportDoneLimit:30,reportChecksVisible:false,
    todayKey:()=> '2026-10-20',bookingDateKey:C.dateKey,bookingPayablePrice:b=>b.payablePrice,displayBookingDate:C.dateKey,esc,document:{addEventListener(){}},BookingCorrection:C});
  vm.runInContext(ui,context);
  for(const name of ['effectivePrice','reportMonthText','renderStats','customerHistoryHtml'])vm.runInContext(source(name),context);
  const report=context.renderStats();assert.match(report,/更正單據/);assert.match(report,/openBookingCorrection/);assert.match(report,/檢查本期單據/);assert.match(report,/新服務/);assert.match(report,/\$700/);
  const customer=context.customerHistoryHtml({doneBooks:rows});assert.match(customer,/更正單據/);assert.match(customer,/NT\$700/);
  context.reportQuery='不存在的人';assert.ok(!context.renderStats().includes('onclick="openBookingCorrection'));
});
test('completed correction cannot be opened by ordinary employees or managers',async()=>{
  let denials=0;
  const context=vm.createContext({bookings:[{id:'B001',status:'done'}],requireBoss:()=>{denials++;return false;},document:{addEventListener(){}}});
  vm.runInContext(ui,context);await context.openBookingCorrection('B001');assert.equal(denials,1);
});
test('completed-service preview preserves the original receipt until the boss edits it',()=>{
  const nodes={'rc-summary':{innerHTML:''},'rc-final':{value:'700'},'rc-discount':{value:'0'},'rc-note':{value:''},'rc-reason':{value:'客人更換項目'}};
  const context=vm.createContext({document:{addEventListener(){},getElementById:id=>nodes[id]||null},BookingCorrection:C,esc});
  vm.runInContext(ui,context);
  vm.runInContext("correctionDraft={original:{status:'done',finalPrice:700,price:800,dateKey:'2026-10-20',extraMins:0},items:[{id:7,name:'腳底按摩筋膜調理放鬆',durationMinutes:120,price:1800}]}",context);
  context.updateCorrectionSummary();assert.match(nodes['rc-summary'].innerHTML,/實收 NT\$700/);assert.match(nodes['rc-summary'].innerHTML,/小計 NT\$1,800/);
});
test('inspection output escapes customer names and never mutates the records',()=>{
  const rows=[{id:'B1',name:'<img src=x onerror=alert(1)>',status:'done',svc:'服務',price:800}];
  const context=vm.createContext({document:{addEventListener(){}},BookingCorrection:C,isBossSession:()=>true,reportChecksVisible:true,displayBookingDate:()=> '10/20',esc});
  vm.runInContext(ui,context);const original=JSON.stringify(rows),result=context.renderReportChecks(rows);assert.ok(!result.includes('<img src=x'));assert.match(result,/&lt;img/);assert.equal(JSON.stringify(rows),original);
});

test('correction action IDs are encoded before interpolation into inline handlers',()=>{
  const context=vm.createContext({document:{addEventListener(){}},esc});vm.runInContext(ui,context);
  const attack="B');alert(1)//";const result=context.correctionButtonHtml(attack);
  assert.ok(!result.includes(attack));assert.match(result,/%27/);assert.match(result,/decodeURIComponent/);
});

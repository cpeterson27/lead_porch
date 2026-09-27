const assert = require('node:assert/strict');
const { normalizeTimeOff, timeOffWindows, overlapsTimeOff } = require('./services/discoveryTimeOff');
const period = (startDate,endDate=startDate,extra={}) => ({startDate,endDate,allDay:true,...extra});
const zone='America/Los_Angeles';
let windows=timeOffWindows([period('2026-10-01','2026-10-03')],zone);
assert.equal(new Date(windows[0].start).toISOString(),'2026-10-01T07:00:00.000Z');
assert.equal(new Date(windows[0].end).toISOString(),'2026-10-04T07:00:00.000Z');
assert.equal(overlapsTimeOff(windows,Date.parse('2026-10-03T23:00Z'),Date.parse('2026-10-03T23:30Z')),true);
assert.equal(overlapsTimeOff(windows,windows[0].end,windows[0].end+1800000),false);
windows=timeOffWindows([period('2026-10-01',undefined,{allDay:false,startTime:'12:00',endTime:'13:00'})],zone);
assert.equal(overlapsTimeOff(windows,Date.parse('2026-10-01T18:45Z'),Date.parse('2026-10-01T19:15Z')),true);
assert.equal(overlapsTimeOff(windows,Date.parse('2026-10-01T18:30Z'),Date.parse('2026-10-01T19:00Z')),false);
for(const [date,hours] of [['2026-03-08',23],['2026-11-01',25]]) { const [w]=timeOffWindows([period(date)],zone);assert.equal((w.end-w.start)/3600000,hours); }
assert.throws(()=>normalizeTimeOff([period('2026-02-30')]),/valid/);
assert.throws(()=>normalizeTimeOff([period('2026-10-03','2026-10-01')]),/valid/);
assert.throws(()=>normalizeTimeOff([period('2026-10-01',undefined,{allDay:false,startTime:'13:00',endTime:'12:00'})]),/after/);
assert.throws(()=>normalizeTimeOff([period('2026-10-01',undefined,{allDay:false,startTime:'25:00',endTime:'26:00'})]),/after/);
assert.deepEqual(timeOffWindows([],zone),[]);
const model=require('./models/WorkspaceConfig');
const doc=new model({publicSite:{discoveryCallAvailability:{timeOff:normalizeTimeOff([period('2026-10-01')])}}});
assert.equal(doc.publicSite.discoveryCallAvailability.timeOff[0].startDate,'2026-10-01');
console.log('PASS: time-off ranges, partial overlaps, boundaries, DST, invalid dates and model persistence shape.');
// Exercise both HTTP paths with an empty Google Calendar: local time off must still win.
(async()=>{
 const service=require('./services/publicSiteService');
 const calendar=require('./services/googleCalendarService');
 const originals={workspace:service.workspace,findOne:model.findOne,busyWindow:calendar.busyWindow,availability:calendar.availability,schedule:calendar.scheduleDiscoveryCall};
 let server;
 try {
  service.workspace=async()=>({_id:'507f1f77bcf86cd799439011'});
  const start=new Date(Date.now()+86400000*2);start.setUTCHours(17,0,0,0);
  const date=start.toISOString().slice(0,10);
  model.findOne=()=>({lean:async()=>({publicSite:{discoveryCallEnabled:true,discoveryCallAvailability:{coachProfileId:'507f1f77bcf86cd799439012',days:[0,1,2,3,4,5,6],horizonDays:4,timeOff:[period(date)]}}})});
  calendar.busyWindow=async()=>({timezone:'UTC',busy:[]});
  calendar.availability=async()=>({timezone:'UTC',available:true});
  calendar.scheduleDiscoveryCall=async()=>{throw Error('Blocked slot reached calendar creation');};
  const app=require('express')();app.use(require('express').json());app.use(require('./routes/publicSite'));
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const url=`http://127.0.0.1:${server.address().port}`;
  const slots=await fetch(url+'/discovery-call/availability').then(r=>r.json());
  assert.ok(slots.data.slots.length);assert.equal(slots.data.slots.some(s=>s.startsWith(date)),false);
  const booking=await fetch(url+'/discovery-call/book',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Test',email:'test@example.com',startsAt:start.toISOString()})});
  assert.equal(booking.status,409);
  console.log('PASS: HTTP availability excludes time off and stale booking requests return 409 before calendar creation.');
 }finally{server?.close();service.workspace=originals.workspace;model.findOne=originals.findOne;calendar.busyWindow=originals.busyWindow;calendar.availability=originals.availability;calendar.scheduleDiscoveryCall=originals.schedule;}
})().catch(e=>{console.error(e);process.exitCode=1;});

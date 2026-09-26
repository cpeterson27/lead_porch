const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const service = require('./services/searchReportingService');
const imports = require('./services/aiVisibilityImport');
assert.equal(service.bingDate('/Date(1316156400000-0700)/'),'2011-09-16');
assert.equal(service.bingDate('bad'),'');
assert.deepEqual(service.period(7,new Date('2026-09-26T15:00:00Z')),{startDate:'2026-09-19',endDate:'2026-09-25'});
assert.deepEqual(service.sumSearch([{clicks:2,impressions:10},{clicks:3,impressions:90}]),{clicks:5,impressions:100,ctr:.05});
const input={provider:'bing_ai',property:'https://example.test/',filename:'daily.csv',rows:[{date:'2026-01-01',value:'1,000'},{date:'2026-01-02',value:'0'}]};
assert.equal(imports.validate(input).total,1000);
for(const rows of [[...input.rows,input.rows[0]],[{date:'2026-01-01',value:'12%' }],[{date:'2026-02-30',value:'1'}],[{date:'2026-01-01',value:'1,2'}],[{date:'2026-01-01',value:'1'},{date:'2026-01-03',value:'1'}]])assert.throws(()=>imports.validate({...input,rows}));
console.log('PASS: dates, weighted CTR, strict imports, duplicate and missing-day rejection.');
if(process.env.SEARCH_REPORT_TEST_DB!=='local'){console.log('Set SEARCH_REPORT_TEST_DB=local for isolated MongoDB/provider/router integration tests.');process.exit(0);}
(async()=>{
 const dbName=`test_search_reporting_${process.pid}`;let server;const originalFetch=global.fetch;
 process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY=crypto.randomBytes(32).toString('base64');
 process.env.SEARCH_GOOGLE_CLIENT_ID='test-client';process.env.SEARCH_GOOGLE_CLIENT_SECRET='test-secret';process.env.SEARCH_GOOGLE_REDIRECT_URI='http://127.0.0.1/oauth/search-reporting/callback';
 await mongoose.connect('mongodb://127.0.0.1:27029',{dbName});
 const Connection=require('./models/IntegrationConnection'),Report=require('./models/SearchReport');await Promise.all([Connection.init(),Report.init(),require('./models/SocialOAuthState').init()]);
 const ws=new mongoose.Types.ObjectId(),other=new mongoose.Types.ObjectId(),user=new mongoose.Types.ObjectId();let calls=0,fail=false,submitted;
 const end=service.period(30).endDate;
 global.fetch=async(url,options={})=>{
  if(String(url).startsWith('http://127.0.0.1:'))return originalFetch(url,options);
  calls++;if(fail)return new Response(JSON.stringify({error:{message:'SECRET apiKey=test-secret'}}),{status:503});
  const u=new URL(url);let data;
  if(u.pathname.endsWith('GetUserSites'))data={d:[{Url:'https://example.test/',IsVerified:true}]};
  else if(u.pathname.endsWith('GetRankAndTrafficStats'))data={d:[{Date:end,Clicks:3,Impressions:20},{Date:'2000-01-01',Clicks:999,Impressions:999}]};
  else if(u.pathname.endsWith('GetQueryStats'))data={d:[{Date:end,Query:'example brand',Clicks:2,Impressions:10}]};
  else if(u.pathname.endsWith('SubmitFeed')){submitted=JSON.parse(options.body);data={d:null};}
  else if(u.hostname==='oauth2.googleapis.com')data={access_token:'test-access',refresh_token:'test-refresh',expires_in:3600,scope:'https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly'};
  else if(u.pathname.endsWith('/sites'))data={siteEntry:[{siteUrl:'sc-domain:example.test',permissionLevel:'siteOwner'}]};
  else if(u.pathname.endsWith('/accountSummaries'))data={accountSummaries:[{propertySummaries:[{property:'properties/123',displayName:'Example'}]}]};
  else if(u.pathname.endsWith('/searchAnalytics/query')){const q=JSON.parse(options.body);data={rows:[{keys:[q.dimensions[0]==='date'?end:'example'],clicks:4,impressions:40,position:2}]};}
  else if(u.pathname.endsWith(':runReport'))data={rows:[{dimensionValues:[{value:'google / organic'}],metricValues:[{value:'5'},{value:'3'},{value:'10'},{value:'1'}]}],metadata:{timeZone:'America/Los_Angeles'}};
  else throw Error('Unexpected external URL '+u.hostname+u.pathname);
  return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
 };
 try{
  const disconnected=await service.reports(ws,30);assert.equal(disconnected.googleSearch.state,'not_connected');assert.equal(disconnected.googleSearch.totals,undefined);
  await assert.rejects(service.connectBing(ws,{apiKey:'secret',siteUrl:'https://other.test/'}));
  await service.connectBing(ws,{apiKey:'secret',siteUrl:'https://example.test/'});
  assert.equal((await Connection.findOne({workspaceId:ws})).credentialsEncrypted,undefined);
  const url=await service.start(ws,user),state=await service.consumeState(new URL(url).searchParams.get('state'));await assert.rejects(service.consumeState(new URL(url).searchParams.get('state')));
  await service.finish(state,'code');await service.selectGoogle(ws,{siteUrl:'sc-domain:example.test',property:'properties/123'});
  await assert.rejects(service.selectGoogle(ws,{siteUrl:'sc-domain:unauthorized.test'}));
  const result=await service.reports(ws,30);assert.equal(result.bingSearch.totals.clicks,3);assert.equal(result.googleSearch.totals.impressions,40);assert.deepEqual(result.ga4.totals,[5,3,10,1]);
  const before=calls;await service.reports(ws,30);assert.equal(calls,before,'reports should use cached provider results');
  assert.equal((await service.reports(other,30)).bingSearch.state,'not_connected');
  await service.submitSitemap(ws);assert.deepEqual(submitted,{siteUrl:'https://example.test/',feedUrl:'https://example.test/sitemap.xml'});
  await imports.save(ws,user,input);await imports.save(ws,user,input);assert.equal((await imports.list(ws)).length,1);assert.equal((await imports.list(other)).length,0);
  await Report.updateMany({workspaceId:ws,key:/^bing:/},{$set:{fetchedAt:new Date(0)}});fail=true;const stale=await service.reports(ws,30);assert.equal(stale.bingSearch.state,'stale');assert.equal(stale.bingSearch.totals.clicks,3);assert(!JSON.stringify(stale).includes('test-secret'));fail=false;
  const app=require('express')();app.use(require('express').json());app.use((req,res,next)=>{req.auth={workspaceId:req.headers['x-other']?other:ws,user:{_id:user},roles:req.headers['x-admin']?['owner']:['viewer'],effectivePermissions:req.headers['x-view']?['analytics.view']:[]};next();});app.use('/report',require('./routes/searchReporting'));server=app.listen(4193,'127.0.0.1');
  const req=(path,opts={})=>originalFetch('http://127.0.0.1:4193/report'+path,opts);
  assert.equal((await req('/reports')).status,403);
  assert.equal((await req('/bing/sitemap',{method:'POST',headers:{'x-view':'1'}})).status,403);
  assert.equal((await req('/visibility',{method:'POST',headers:{'x-view':'1','Content-Type':'application/json'},body:JSON.stringify(input)})).status,403);
  const safe=await req('/status',{headers:{'x-view':'1'}}).then(r=>r.json());assert(!JSON.stringify(safe).includes('test-access'));assert(!JSON.stringify(safe).includes('apiKey'));
  await service.disconnect(ws,'bing');assert.equal((await service.reports(ws,30)).bingSearch.state,'not_connected');assert.equal(await Report.countDocuments({workspaceId:ws,key:/^bing:/}),0);
  console.log('PASS: real MongoDB, encrypted connections, verified-site validation, OAuth replay prevention, Google/GA4/Bing adapters, cache, stale-data handling, tenant isolation, report replacement, RBAC and sitemap submission payload.');
 }finally{global.fetch=originalFetch;server?.close();assert(mongoose.connection.name.startsWith('test_search_reporting_'));await mongoose.connection.dropDatabase();await mongoose.disconnect();}
})().catch(e=>{console.error(e);process.exitCode=1;});

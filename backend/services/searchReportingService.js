const crypto = require('crypto');
const Connection = require('../models/IntegrationConnection');
const Report = require('../models/SearchReport');
const State = require('../models/SocialOAuthState');
const { encryptCredentials, decryptCredentials } = require('../utils/credentialEncryption');
const SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly', 'https://www.googleapis.com/auth/analytics.readonly'];
const filter = (workspaceId, provider) => ({ workspaceId, provider: `search_${provider}`, accountScope: 'workspace', ownerUserId: null });
const fail = (message) => Object.assign(new Error(message), { status: 400 });
const hash = (v) => crypto.createHash('sha256').update(v).digest('hex');
const config = () => ({ clientId: process.env.SEARCH_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.SEARCH_GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET, redirect: process.env.SEARCH_GOOGLE_REDIRECT_URI || ((process.env.PUBLIC_BACKEND_URL || process.env.RENDER_EXTERNAL_URL) ? `${String(process.env.PUBLIC_BACKEND_URL || process.env.RENDER_EXTERNAL_URL).replace(/\/$/,'')}/oauth/search-reporting/callback` : '') });
const configured = () => Boolean(config().clientId && config().clientSecret && config().redirect && process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY);
const daysValue = v => [7, 30, 90].includes(Number(v)) ? Number(v) : 30;
function period(days, now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 86400000);
  return { startDate: new Date(end.getTime() - (days - 1) * 86400000).toISOString().slice(0,10), endDate: end.toISOString().slice(0,10) };
}
async function request(url, options = {}) {
  let response;
  try { response = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) }); }
  catch { throw fail('The provider could not be reached. Try again later.'); }
  let data; try { data = await response.json(); } catch { throw fail('The provider returned an unreadable response.'); }
  // Never surface raw provider errors: request URLs may contain a Bing secret.
  if (!response.ok || data?.ErrorCode || data?.d?.ErrorCode) throw fail(`Provider request failed (${response.status}). Check account access, API enablement, and reconnect if needed.`);
  return data;
}
const google = (token, url, body) => request(url, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
async function tokenRequest(values) {
  const c = config();
  return request('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...values }) });
}
async function start(workspaceId, userId) {
  if (!configured()) throw fail('Google reporting setup is required: configure the OAuth client, redirect URL and encryption key on the server.');
  const nonce = crypto.randomBytes(32).toString('base64url');
  await State.create({ provider: 'search_google', workspaceId, userId, nonceHash: hash(nonce), expiresAt: new Date(Date.now() + 600000) });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ client_id: config().clientId, redirect_uri: config().redirect, response_type: 'code', access_type: 'offline', prompt: 'consent', scope: SCOPES.join(' '), state: nonce });
}
async function consumeState(value) {
  if (typeof value !== 'string' || value.length > 100) throw fail('Invalid connection request.');
  const state = await State.findOneAndUpdate({ provider: 'search_google', nonceHash: hash(value), consumedAt: null, expiresAt: { $gt: new Date() } }, { $set: { consumedAt: new Date() } }, { new: true });
  if (!state) throw fail('Connection request expired or was already used.');
  return state;
}
async function finish(state, code) {
  const tokens = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: config().redirect });
  if (!tokens.access_token || !tokens.refresh_token || !SCOPES.every(s => String(tokens.scope || '').split(' ').includes(s))) throw fail('Grant both read-only permissions and offline access to connect reporting.');
  await Connection.findOneAndUpdate(filter(state.workspaceId, 'google'), { $set: { status: 'connected', credentialsEncrypted: encryptCredentials(tokens), settings: {}, oauth: { expiresAt: new Date(Date.now() + tokens.expires_in * 1000), scopes: SCOPES }, connectedAt: new Date() } }, { upsert: true });
  await Report.deleteMany({ workspaceId: state.workspaceId, key: /^google:/ });
}
async function connection(workspaceId, provider) {
  const row = await Connection.findOne({ ...filter(workspaceId, provider), status: 'connected' }).select('+credentialsEncrypted');
  if (!row) throw fail(`Connect ${provider} first.`);
  return row;
}
async function access(row) {
  const tokens = decryptCredentials(row.credentialsEncrypted);
  if (new Date(row.oauth?.expiresAt || 0).getTime() > Date.now() + 60000) return tokens.access_token;
  const next = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
  if (!next.access_token) throw fail('Reconnect Google reporting.');
  row.credentialsEncrypted = encryptCredentials({ ...tokens, ...next });
  row.oauth.expiresAt = new Date(Date.now() + Number(next.expires_in || 3600) * 1000);
  await Connection.updateOne({ _id:row._id, workspaceId:row.workspaceId }, {$set:{credentialsEncrypted:row.credentialsEncrypted, 'oauth.expiresAt':row.oauth.expiresAt}});
  return next.access_token;
}
async function status(workspaceId) {
  const rows = await Connection.find({ workspaceId, provider: { $in: ['search_google', 'search_bing'] }, accountScope: 'workspace' });
  return { googleConfigured: configured(), googleRedirectUri: config().redirect || '', encryptionConfigured: Boolean(process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY), ...Object.fromEntries(['google','bing'].map(p => {
    const r = rows.find(r => r.provider === `search_${p}`);
    return [p, { connected: r?.status === 'connected', settings: { siteUrl:r?.settings?.siteUrl || '', ...(p==='google'?{property:r?.settings?.property || ''}:{}) } }];
  })) };
}
async function properties(workspaceId) {
  const token = await access(await connection(workspaceId, 'google'));
  const results = await Promise.allSettled([
    google(token, 'https://www.googleapis.com/webmasters/v3/sites'),
    (async () => { const all = []; let next = ''; do { const r = await google(token, 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries?' + new URLSearchParams({ pageSize: '200', ...(next ? { pageToken: next } : {}) })); for (const a of r.accountSummaries || []) all.push(...(a.propertySummaries || [])); next = r.nextPageToken; } while (next); return all; })(),
  ]);
  return { sites: results[0].status === 'fulfilled' ? (results[0].value.siteEntry || []).filter(s => s.permissionLevel !== 'siteUnverifiedUser').map(s => s.siteUrl) : [], properties: results[1].status === 'fulfilled' ? results[1].value.map(p => ({ id: p.property, name: p.displayName })) : [], errors: results.filter(r => r.status === 'rejected').map(r => r.reason.message) };
}
async function selectGoogle(workspaceId, input) {
  const available = await properties(workspaceId);
  if (input.siteUrl && !available.sites.includes(input.siteUrl)) throw fail('Choose a verified Search Console property from your connected account.');
  if (input.property && !available.properties.some(p => p.id === input.property)) throw fail('Choose an Analytics property from your connected account.');
  await Connection.updateOne(filter(workspaceId,'google'), { $set: { settings: { siteUrl: input.siteUrl || '', property: input.property || '' } } });
  await Report.deleteMany({ workspaceId, key: /^google:/ });
}
async function bing(apiKey, method, params = {}, post = false) {
  const query = new URLSearchParams({ apikey: apiKey, ...(post ? {} : params) });
  const data = await request(`https://ssl.bing.com/webmaster/api.svc/json/${method}?${query}`, post ? { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(params) } : {});
  if (!Object.prototype.hasOwnProperty.call(data, 'd')) throw fail('Bing returned an unexpected report format.');
  return data.d;
}
async function connectBing(workspaceId, input) {
  const key = String(input.apiKey || '').trim(), siteUrl = String(input.siteUrl || '').trim();
  if (!key || key.length > 500) throw fail('Enter your Bing Webmaster API key.');
  const sites = await bing(key, 'GetUserSites');
  if (!Array.isArray(sites) || !sites.some(s => s.Url === siteUrl && s.IsVerified === true)) throw fail('The site URL must exactly match a verified site in this Bing account, including its trailing slash.');
  await Connection.findOneAndUpdate(filter(workspaceId,'bing'), { $set: { status:'connected', credentialsEncrypted:encryptCredentials({ apiKey:key }), settings:{siteUrl}, connectedAt:new Date() } }, {upsert:true});
  await Report.deleteMany({workspaceId,key:/^bing:/});
}
async function submitSitemap(workspaceId) {
  const c = await connection(workspaceId,'bing'), siteUrl = c.settings.siteUrl;
  const u = new URL(siteUrl); if (!['http:','https:'].includes(u.protocol)) throw fail('Invalid site URL.');
  const feedUrl = new URL('/sitemap.xml', u).href;
  await bing(decryptCredentials(c.credentialsEncrypted).apiKey,'SubmitFeed',{siteUrl,feedUrl},true);
  return { feedUrl, message:'Bing accepted the submission. This does not confirm crawling or indexing.' };
}
function bingDate(value) {
  const match = String(value || '').match(/^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/);
  const d = new Date(match ? Number(match[1]) : value); return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0,10);
}
function metric(value) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0) throw fail('The provider returned an invalid metric; no replacement count was saved.');
  return Number(value);
}
function sumSearch(rows) {
  const clicks = rows.reduce((n,r)=>n+metric(r.clicks),0), impressions = rows.reduce((n,r)=>n+metric(r.impressions),0);
  return { clicks, impressions, ctr: impressions ? clicks/impressions : 0 };
}
async function searchGoogle(c, range) {
  if (!c.settings?.siteUrl) return { state:'not_selected', message:'Select a Search Console property.' };
  const token = await access(c), url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(c.settings.siteUrl)}/searchAnalytics/query`;
  const [daily,queries,pages,countries,devices] = await Promise.all([['date'],['query'],['page'],['country'],['device']].map(dimensions=>google(token,url,{ ...range,dimensions,type:'web',dataState:'final',rowLimit:dimensions[0]==='date'?100:1000 })));
  const rows = (daily.rows || []).map(r=>({date:r.keys[0],clicks:r.clicks,impressions:r.impressions,position:r.position}));
  return { state:'ready', property:c.settings.siteUrl, totals:sumSearch(rows), daily:rows, queries:queries.rows || [], pages:pages.rows || [], countries:countries.rows || [], devices:devices.rows || [], note:'Google Web search; dates use Pacific Time. Finalized data may lag. Queries/pages show up to 1,000 top rows; privacy filtering means they do not necessarily sum to the totals. Impressions count appearances, not all searches for your brand.' };
}
async function analyticsGoogle(c, range) {
  if (!c.settings?.property) return {state:'not_selected',message:'Select a GA4 property. Connecting reports does not install a website tracking tag.'};
  const token = await access(c), url = `https://analyticsdata.googleapis.com/v1beta/${c.settings.property}:runReport`;
  const base = {dateRanges:[range],metrics:[{name:'sessions'},{name:'activeUsers'},{name:'screenPageViews'},{name:'keyEvents'}]};
  const [totals, sources] = await Promise.all([google(token,url,base),google(token,url,{...base,dimensions:[{name:'sessionSourceMedium'}],limit:'100',orderBys:[{metric:{metricName:'sessions'},desc:true}]})]);
  return {state:'ready',property:c.settings.property,totals:(totals.rows?.[0]?.metricValues || []).map(v=>metric(v.value)),sources:(sources.rows || []).map(r=>({source:r.dimensionValues[0].value,values:r.metricValues.map(v=>metric(v.value))})),metadata:totals.metadata || {},note:'GA4 property timezone and measurement settings apply. Active users are the provider’s period total, not summed daily users. GA4 key events and Lead Porch confirmed inquiries have different definitions; do not add them together.'};
}
async function searchBing(c, range) {
  const key = decryptCredentials(c.credentialsEncrypted).apiKey, params={siteUrl:c.settings.siteUrl};
  const [daily,queries] = await Promise.all([bing(key,'GetRankAndTrafficStats',params),bing(key,'GetQueryStats',params)]);
  if (!Array.isArray(daily) || !Array.isArray(queries)) throw fail('Bing returned an unexpected report format.');
  const within = r => { const d=bingDate(r.Date);return d && d>=range.startDate && d<=range.endDate; };
  const rows=daily.filter(within).map(r=>({date:bingDate(r.Date),clicks:metric(r.Clicks),impressions:metric(r.Impressions)}));
  return {state:'ready',property:c.settings.siteUrl,totals:sumSearch(rows),daily:rows,queries:queries.filter(within).map(r=>({keys:[r.Query],clicks:r.Clicks,impressions:r.Impressions,position:r.AvgImpressionPosition})),note:'Bing reports all supported search verticals together, including Chat. These are not separate AI citation counts. Daily traffic and query reports can have different update schedules. Only returned dates within this period are counted.'};
}
const inFlight = new Map();
async function cached(workspaceId,key,load) {
  const existing=await Report.findOne({workspaceId,key}).lean();
  if(existing && Date.now()-new Date(existing.fetchedAt).getTime()<3600000)return {...existing.report,fetchedAt:existing.fetchedAt};
  const lock=`${workspaceId}:${key}`;if(inFlight.has(lock))return inFlight.get(lock);
  const task=(async()=>{try{const report=await load(),fetchedAt=new Date();if(report.state==='ready')await Report.findOneAndUpdate({workspaceId,key},{$set:{report,fetchedAt}},{upsert:true});return {...report,fetchedAt};}catch(error){return existing?{...existing.report,state:'stale',fetchedAt:existing.fetchedAt,error:error.message}:{state:'unavailable',message:error.message};}finally{inFlight.delete(lock);}})();
  inFlight.set(lock,task);return task;
}
async function reports(workspaceId,inputDays) {
  const days=daysValue(inputDays),range=period(days);
  const rows=await Connection.find({workspaceId,provider:{$in:['search_google','search_bing']},status:'connected',accountScope:'workspace'}).select('+credentialsEncrypted');
  const g=rows.find(r=>r.provider==='search_google'),b=rows.find(r=>r.provider==='search_bing');
  const missing={state:'not_connected',message:'Connect the provider to see measured data.'};
  const [googleSearch,ga4,bingSearch]=await Promise.all([g?cached(workspaceId,`google:search:${hash(g.settings?.siteUrl || "").slice(0,16)}:${days}:${range.endDate}`,()=>searchGoogle(g,range)):missing,g?cached(workspaceId,`google:ga4:${hash(g.settings?.property || "").slice(0,16)}:${days}:${range.endDate}`,()=>analyticsGoogle(g,range)):missing,b?cached(workspaceId,`bing:search:${hash(b.settings?.siteUrl || "").slice(0,16)}:${days}:${range.endDate}`,()=>searchBing(b,range)):missing]);
  return {days,...range,googleSearch,ga4,bingSearch};
}
async function disconnect(workspaceId,provider) {
  if(!['google','bing'].includes(provider))throw fail('Unknown provider.');
  await Connection.updateOne(filter(workspaceId,provider),{$set:{status:'disconnected',settings:{},credentialsEncrypted:null,oauth:{}}});
  await Report.deleteMany({workspaceId,key:new RegExp(`^${provider}:`)});
}
module.exports={status,start,consumeState,finish,properties,selectGoogle,connectBing,submitSitemap,reports,disconnect,period,daysValue,bingDate,sumSearch,request,searchBing,searchGoogle,analyticsGoogle};

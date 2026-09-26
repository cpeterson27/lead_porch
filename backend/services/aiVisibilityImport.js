const crypto = require('crypto');
const Report = require('../models/SearchReport');
function validate(input) {
  const error = message => { throw Object.assign(new Error(message), { status:400 }); };
  if (!['google_ai','bing_ai'].includes(input.provider)) error('Choose Google AI impressions or Bing AI citations.');
  const property=String(input.property || '').trim();
  if (!/^https:\/\/[^\s]+$/.test(property) && !/^sc-domain:[a-z0-9.-]+$/i.test(property)) error('Enter the property shown in the source report.');
  if (property.length>300)error('Property is too long.');
  if (!Array.isArray(input.rows) || !input.rows.length || input.rows.length>366) error('Import between 1 and 366 daily rows.');
  const seen = new Set();
  const rows=input.rows.map(row=>{
    const date=String(row.date || ''),value=String(row.value ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date || date>new Date().toISOString().slice(0,10)) error('Dates must be valid past or current dates in YYYY-MM-DD format.');
    if(seen.has(date))error('Duplicate dates found. Import a daily total table, not page or query rows, to avoid double counting.');
    seen.add(date);
    if(!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(value) || !Number.isSafeInteger(Number(value.replace(/,/g,''))))error('Counts must be whole, nonnegative numbers.');
    return {date,value:Number(value.replace(/,/g,''))};
  }).sort((a,b)=>a.date.localeCompare(b.date));
  const total=rows.reduce((s,r)=>s+r.value,0);if(!Number.isSafeInteger(total))error('Report total is too large.');
  const span=(Date.parse(rows.at(-1).date)-Date.parse(rows[0].date))/86400000+1;
  if(span!==rows.length)error('Include one row for every day in the period, including reported zero days. Missing days must not be treated as zero.');
  return {provider:input.provider,property,rows,total,startDate:rows[0].date,endDate:rows.at(-1).date,metric:input.provider==='bing_ai'?'Citations':'Impressions',source:'Owner-imported provider report',filename:String(input.filename||'').slice(0,160)};
}
async function save(workspaceId,userId,input) {
  const report=validate(input); report.importedBy=String(userId); report.checksum=crypto.createHash('sha256').update(JSON.stringify(report.rows)).digest('hex');
  // A provider has one current snapshot: importing it again replaces it rather than adding counts.
  await Report.findOneAndUpdate({workspaceId,key:`visibility:${report.provider}`},{$set:{report,fetchedAt:new Date()}},{upsert:true});
  return report;
}
async function list(workspaceId) {return Report.find({workspaceId,key:{$in:['visibility:google_ai','visibility:bing_ai']}}).select('report fetchedAt').lean();}
async function remove(workspaceId,provider){if(!['google_ai','bing_ai'].includes(provider))throw Object.assign(new Error('Unknown provider.'),{status:400});await Report.deleteOne({workspaceId,key:`visibility:${provider}`});}
module.exports={validate,save,list,remove};

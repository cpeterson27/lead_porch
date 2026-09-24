const Contact = require("../models/Contact"); const SalesOpportunity = require("../models/SalesOpportunity"); const Enrollment = require("../models/Enrollment"); const CoachAssignment = require("../models/CoachAssignment"); const CoachingSession = require("../models/CoachingSession"); const CoachingHandoff = require("../models/CoachingHandoff"); const CoachingProgram = require("../models/CoachingProgram"); const CoachProfile = require("../models/CoachProfile"); const ReferralAttribution = require("../models/ReferralAttribution"); const CommissionLedger = require("../models/CommissionLedger"); const SkoolPurchase = require("../models/SkoolPurchase"); const ConversationMessage = require("../models/ConversationMessage"); const MessageDeliveryEvent = require("../models/MessageDeliveryEvent"); const CommunicationJob = require("../models/CommunicationJob"); const MarketingCampaign = require("../models/MarketingCampaign"); const SocialAutomation = require("../models/SocialAutomation"); const ConversationThread = require("../models/ConversationThread"); const SocialProviderEvent = require("../models/SocialProviderEvent"); const ContentBrief = require("../models/ContentBrief");
const deps={Contact,SalesOpportunity,Enrollment,CoachAssignment,CoachingSession,CoachingHandoff,CoachingProgram,CoachProfile,ReferralAttribution,CommissionLedger,SkoolPurchase,ConversationMessage,MessageDeliveryEvent,CommunicationJob,MarketingCampaign,SocialAutomation,ConversationThread,SocialProviderEvent,ContentBrief};
const SOCIAL_PROVIDERS=["instagram","facebook"];
const money=(value)=>Math.round((Number(value)||0)*100)/100; const rate=(a,b)=>b?Math.round(a/b*1000)/10:0;
function sourceFor(contact){return contact?.socialAttribution?.first?.provider||contact?.sourceProvider||contact?.sources?.[0]||"organic/direct";}
function group(rows,keyFn,valueFn=()=>1){const map=new Map();for(const row of rows){const key=keyFn(row)||"unknown";map.set(String(key),(map.get(String(key))||0)+valueFn(row));}return[...map].map(([key,value])=>({key,value})).sort((a,b)=>b.value-a.value);}
async function getAnalytics(workspaceId,models=deps,filters={}){
 const scope=workspaceId?{workspaceId}:{};
 const contactScope={...scope};
 if(filters.startDate||filters.endDate){
  contactScope.createdAt={};
  if(filters.startDate)contactScope.createdAt.$gte=new Date(filters.startDate);
  if(filters.endDate){const end=new Date(filters.endDate);end.setUTCHours(23,59,59,999);contactScope.createdAt.$lte=end;}
 }
 let [contacts,opportunities,enrollments,assignments,sessions,handoffs,programs,coaches,referrals,commissions,purchases,messages,deliveryEvents,jobs,campaigns,automations,socialThreads,providerEvents,socialContentBriefs]=await Promise.all([
  models.Contact.find(contactScope).lean(),models.SalesOpportunity.find(scope).lean(),models.Enrollment.find(scope).lean(),models.CoachAssignment.find(scope).lean(),models.CoachingSession.find(scope).lean(),models.CoachingHandoff.find(scope).lean(),models.CoachingProgram.find(scope).lean(),models.CoachProfile.find(scope).lean(),models.ReferralAttribution.find(scope).lean(),models.CommissionLedger.find(scope).lean(),models.SkoolPurchase.find(scope).lean(),models.ConversationMessage.find(scope).lean(),models.MessageDeliveryEvent.find(scope).lean(),models.CommunicationJob.find(scope).lean(),models.MarketingCampaign.find(scope).lean(),
  models.SocialAutomation.find(scope).lean(),models.ConversationThread.find({...scope,channel:{$in:SOCIAL_PROVIDERS}}).lean(),models.SocialProviderEvent.find(scope).lean(),models.ContentBrief.find({...scope,type:"social"}).lean(),
 ]);
 // Date range narrows the Contact query itself (contactScope above, the
 // cheapest and most direct filter). "source" is a derived value (see
 // sourceFor) with no single indexed field, and "offer" needs the
 // just-fetched enrollments to know which contacts are on that program, so
 // both run in memory against the contacts just fetched. Every other
 // collection below is then cut down to this same contact cohort's ids, so
 // every line of arithmetic further down this function — funnel, revenue,
 // attribution, social funnel, coaching stats — runs completely unchanged;
 // only what feeds into it narrows. Pure lookup/reference data (programs,
 // coaches, campaigns, automations, content briefs) is deliberately left
 // unfiltered since those are name lookups, not dated events, and
 // commissions/assignments are left unfiltered too since they're workspace-
 // level operational figures rather than per-lead cohort ones.
 if(filters.source)contacts=contacts.filter(c=>sourceFor(c)===filters.source);
 if(filters.coachingProgramId){
  const programContactIds=new Set(enrollments.filter(e=>String(e.coachingProgramId)===String(filters.coachingProgramId)).map(e=>String(e.contactId)));
  contacts=contacts.filter(c=>programContactIds.has(String(c._id)));
 }
 if(filters.startDate||filters.endDate||filters.source||filters.coachingProgramId){
  const cohortIds=new Set(contacts.map(c=>String(c._id)));
  opportunities=opportunities.filter(o=>cohortIds.has(String(o.primaryContactId)));
  enrollments=enrollments.filter(e=>cohortIds.has(String(e.contactId)));
  sessions=sessions.filter(s=>cohortIds.has(String(s.contactId)));
  purchases=purchases.filter(p=>cohortIds.has(String(p.contactId)));
  messages=messages.filter(m=>cohortIds.has(String(m.contactId)));
  jobs=jobs.filter(j=>cohortIds.has(String(j.contactId)));
  referrals=referrals.filter(r=>cohortIds.has(String(r.contactId)));
 }
 const contactMap=new Map(contacts.map(c=>[String(c._id),c])); const programMap=new Map(programs.map(p=>[String(p._id),p])); const coachMap=new Map(coaches.map(c=>[String(c._id),c])); const campaignMap=new Map(campaigns.map(c=>[String(c._id),c]));
 const won=opportunities.filter(o=>o.wonAt||o.stageKey==="won"),lost=opportunities.filter(o=>o.lostAt||o.stageKey==="lost"); const applications=contacts.filter(c=>c.additionalFields?.applicationCompletedAt||c.tags?.includes("application-completed")); const qualified=contacts.filter(c=>c.qualifyContact||["qualified","proposal"].includes(c.stage)); const booked=sessions.filter(s=>s.status!=="cancelled"); const attended=sessions.filter(s=>s.zoom?.attendance?.state==="attended");
 const funnel=[{key:"leads",value:contacts.length},{key:"applications",value:applications.length},{key:"qualified",value:qualified.length},{key:"calls_booked",value:booked.length},{key:"calls_attended",value:attended.length},{key:"closed_won",value:won.length},{key:"closed_lost",value:lost.length},{key:"enrollments",value:enrollments.length},{key:"active_students",value:enrollments.filter(e=>e.status==="active").length},{key:"alumni",value:enrollments.filter(e=>e.status==="completed").length}];
 const conversions=funnel.slice(1).map((item,index)=>({from:funnel[index].key,to:item.key,rate:rate(item.value,funnel[index].value)})); const closedWonRevenue=won.reduce((s,o)=>s+Number(o.value||0),0); const cashCollectedTotal=won.reduce((s,o)=>s+Number(o.cashCollected||0),0); const outstandingBalance=Math.max(0,closedWonRevenue-cashCollectedTotal); const coachingOpportunityIds=new Set(enrollments.map(e=>String(e.sourceOpportunityId||"")).filter(Boolean)); const programRevenue=won.filter(o=>coachingOpportunityIds.has(String(o._id))).reduce((s,o)=>s+Number(o.value||0),0); const addonRevenue=purchases.reduce((s,p)=>s+Number(p.amountMinor||0)/100,0); const referralContactIds=new Set(referrals.map(r=>String(r.contactId))); const referralRevenue=won.filter(o=>referralContactIds.has(String(o.primaryContactId))).reduce((s,o)=>s+Number(o.value||0),0); const commissionExpense=commissions.filter(c=>c.status!=="reversed").reduce((s,c)=>s+Number(c.commissionAmountMinor||0)/100,0); const uniqueCustomers=new Set(won.map(o=>String(o.primaryContactId)).filter(Boolean)).size;
 // Monthly/YTD rollups the checklist calls for, tracked against Ellie's own
 // stated 2027 $650K operating target — bucketed by wonAt (when the deal
 // actually closed), not createdAt, so a deal won this month counts toward
 // this month's revenue even if the opportunity itself is older.
 const REVENUE_TARGET_YEAR=2027, REVENUE_TARGET_AMOUNT=650000;
 const monthKey=(date)=>{const d=new Date(date);return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`;};
 const monthlyMap=new Map();
 for(const o of won){if(!o.wonAt)continue;const key=monthKey(o.wonAt);const row=monthlyMap.get(key)||{month:key,contracted:0,cashCollected:0,deals:0};row.contracted+=Number(o.value||0);row.cashCollected+=Number(o.cashCollected||0);row.deals+=1;monthlyMap.set(key,row);}
 const monthlyRevenue=[...monthlyMap.values()].map(row=>({...row,contracted:money(row.contracted),cashCollected:money(row.cashCollected)})).sort((a,b)=>a.month<b.month?1:-1);
 const currentYear=new Date().getUTCFullYear();
 const ytdRevenue=monthlyRevenue.filter(row=>row.month.startsWith(`${currentYear}-`)).reduce((s,row)=>s+row.contracted,0);
 const sourceRows=contacts.map(c=>({source:sourceFor(c),contact:c})); const attribution=group(sourceRows,r=>r.source).map(row=>{const ids=new Set(sourceRows.filter(r=>r.source===row.key).map(r=>String(r.contact._id)));const sourceWon=won.filter(o=>ids.has(String(o.primaryContactId)));return{source:row.key,leads:row.value,percentOfLeads:rate(row.value,contacts.length),applications:applications.filter(c=>ids.has(String(c._id))).length,sales:sourceWon.length,revenue:money(sourceWon.reduce((s,o)=>s+Number(o.value||0),0)),conversionRate:rate(sourceWon.length,row.value)};});
 const byCampaign=group(won,o=>campaignMap.get(String(o.campaignId))?.name||contactMap.get(String(o.primaryContactId))?.socialAttribution?.first?.contentId||"unattributed",o=>Number(o.value||0)).map(r=>({campaign:r.key,revenue:money(r.value),sales:won.filter(o=>(campaignMap.get(String(o.campaignId))?.name||contactMap.get(String(o.primaryContactId))?.socialAttribution?.first?.contentId||"unattributed")===r.key).length}));
 const contentRows=contacts.filter(c=>c.socialAttribution?.first?.contentId).map(c=>({contentId:c.socialAttribution.first.contentId,provider:c.socialAttribution.first.provider||"",contact:c})); const byContent=group(contentRows,r=>r.contentId).map(row=>{const ids=new Set(contentRows.filter(r=>r.contentId===row.key).map(r=>String(r.contact._id)));const contentWon=won.filter(o=>ids.has(String(o.primaryContactId)));return{contentId:row.key,provider:contentRows.find(r=>r.contentId===row.key)?.provider||"",leads:row.value,percentOfLeads:rate(row.value,contacts.length),applications:applications.filter(c=>ids.has(String(c._id))).length,sales:contentWon.length,revenue:money(contentWon.reduce((s,o)=>s+Number(o.value||0),0)),conversionRate:rate(contentWon.length,row.value)};});
 const byReferral=group(won.filter(o=>referralContactIds.has(String(o.primaryContactId))),o=>{const ref=referrals.find(r=>String(r.contactId)===String(o.primaryContactId));return coachMap.get(String(ref?.coachProfileId))?.displayName||ref?.referralCode||"unknown";},o=>Number(o.value||0)).map(r=>({coach:r.key,revenue:money(r.value)}));
 // Social funnel: the "interactions"/"conversations" stages below are built from SocialProviderEvent —
 // the same raw record every real inbound Facebook/Instagram comment and DM is stored as (identical
 // source the "Known social attribution" panel uses), so the top-line counts always match what that
 // panel shows. "Leads" below is the same socialAttribution-based provider match attribution.social
 // already uses, not narrowed to automation-matched contacts only — a contact is a real social lead the
 // moment their first attributed touch was instagram/facebook, whether or not a keyword ever matched.
 // byCta is a narrower, separate slice: SocialProviderEvent.automationId is set only when a comment/DM
 // matched one of your configured SocialAutomation triggers (keyword or otherwise), so it is naturally
 // smaller than total interactions until real CTA keywords are configured and used.
 const automationMap=new Map(automations.map(a=>[String(a._id),a])); const conversedContactIds=new Set(socialThreads.flatMap(t=>(t.contactIds||[]).map(String))); const contentBriefMap=new Map(socialContentBriefs.map(c=>[String(c._id),c]));
 const socialEvents=providerEvents.filter(e=>SOCIAL_PROVIDERS.includes(e.provider));
 const socialContactIds=new Set(contacts.filter(c=>SOCIAL_PROVIDERS.includes(sourceFor(c))).map(c=>String(c._id))); const socialWon=won.filter(o=>socialContactIds.has(String(o.primaryContactId)));
 // A contact who FIRST ever touched the business through some other channel can still comment/DM in
 // response to a specific CTA or post later — their socialAttribution.first would point elsewhere, but
 // they are still a completely real lead who engaged with THIS CTA/post. So leads here are every distinct
 // contact behind these events (existingIds), not only contacts whose historical first touch matches —
 // and only contacts that still exist are counted, since a SocialProviderEvent can outlive a since-deleted
 // Contact record.
 const existingIds=(rows)=>[...new Set(rows.map(r=>String(r.contactId)))].filter(id=>contactMap.has(id));
 const ctaRow=(automationId,rows)=>{ const leadIds=existingIds(rows); const leadIdSet=new Set(leadIds); const ctaWon=won.filter(o=>leadIdSet.has(String(o.primaryContactId))); const automation=automationMap.get(automationId);
  return {automationId,label:automation?.cta?.label||automation?.keywords?.[0]?.toUpperCase()||automation?.name||"Unlabeled CTA",provider:automation?.provider||"",interactions:rows.length,conversations:leadIds.filter(id=>conversedContactIds.has(id)).length,leads:leadIds.length,applications:applications.filter(c=>leadIdSet.has(String(c._id))).length,bookedCalls:sessions.filter(s=>leadIdSet.has(String(s.contactId))&&s.status!=="cancelled").length,enrollments:enrollments.filter(e=>leadIdSet.has(String(e.contactId))).length,sales:ctaWon.length,revenue:money(ctaWon.reduce((s,o)=>s+Number(o.value||0),0)),interactionToLeadRate:rate(leadIds.length,rows.length)};
 };
 const ctaEvents=socialEvents.filter(e=>e.automationId);
 const byCta=group(ctaEvents,e=>String(e.automationId)).filter(r=>r.key&&automationMap.has(r.key)).map(r=>ctaRow(r.key,ctaEvents.filter(e=>String(e.automationId)===r.key))).sort((a,b)=>b.interactions-a.interactions);
 const socialFunnelStages=[{key:"interactions",value:socialEvents.length},{key:"conversations",value:existingIds(socialEvents).filter(id=>conversedContactIds.has(id)).length},{key:"leads",value:socialContactIds.size},{key:"applications",value:applications.filter(c=>socialContactIds.has(String(c._id))).length},{key:"calls_booked",value:sessions.filter(s=>socialContactIds.has(String(s.contactId))&&s.status!=="cancelled").length},{key:"enrollments",value:enrollments.filter(e=>socialContactIds.has(String(e.contactId))).length}];
 const postRows=socialEvents.filter(e=>e.contentBriefId).map(e=>({id:String(e.contentBriefId),event:e}));
 const byPost=group(postRows,r=>r.id).map(row=>{
  const rows=postRows.filter(r=>r.id===row.key).map(r=>r.event); const providersOnPost=[...new Set(rows.map(e=>e.provider))];
  const leadIds=existingIds(rows); const leadIdSet=new Set(leadIds); const postWon=won.filter(o=>leadIdSet.has(String(o.primaryContactId)));
  return {contentBriefId:row.key,title:contentBriefMap.get(row.key)?.title||"Deleted or unknown post",providers:providersOnPost,interactions:rows.length,conversations:leadIds.filter(id=>conversedContactIds.has(id)).length,leads:leadIds.length,applications:applications.filter(c=>leadIdSet.has(String(c._id))).length,sales:postWon.length,revenue:money(postWon.reduce((s,o)=>s+Number(o.value||0),0))};
 }).sort((a,b)=>b.interactions-a.interactions);
 const socialFunnel={stages:socialFunnelStages,conversions:socialFunnelStages.slice(1).map((item,index)=>({from:socialFunnelStages[index].key,to:item.key,rate:rate(item.value,socialFunnelStages[index].value)})),revenue:money(socialWon.reduce((s,o)=>s+Number(o.value||0),0)),byCta,byPost};
 const communication={email:{sent:messages.filter(m=>m.channel==="email"&&m.direction==="outbound").length,delivered:deliveryEvents.filter(e=>e.provider==="resend"&&e.status==="delivered").length,opened:deliveryEvents.filter(e=>e.provider==="resend"&&["opened","email.opened"].includes(e.status)).length,clicked:deliveryEvents.filter(e=>e.provider==="resend"&&["clicked","email.clicked"].includes(e.status)).length,bounced:deliveryEvents.filter(e=>e.provider==="resend"&&e.status.includes("bounce")).length},sms:{sent:messages.filter(m=>m.channel==="sms"&&m.direction==="outbound").length,delivered:deliveryEvents.filter(e=>e.provider==="twilio"&&e.status==="delivered").length,replies:messages.filter(m=>m.channel==="sms"&&m.direction==="inbound").length},blocked:jobs.filter(j=>j.status==="blocked").length,reminders:{sent:jobs.filter(j=>j.kind==="session_reminder"&&j.status==="sent").length,blocked:jobs.filter(j=>j.kind==="session_reminder"&&j.status==="blocked").length},campaigns:campaigns.map(c=>({id:c._id,name:c.name,status:c.status,...(c.metrics||{})}))};
 const noShowSessions=sessions.filter(s=>s.zoom?.attendance?.state==="no_show"); const coaching={activeStudents:enrollments.filter(e=>e.status==="active").length,studentsPerCoach:group(assignments.filter(a=>["active","scheduled"].includes(a.status)),a=>coachMap.get(String(a.coachProfileId))?.displayName||"unknown"),upcomingAssignments:assignments.filter(a=>a.status==="scheduled").length,completedAssignments:assignments.filter(a=>a.status==="completed").length,handoffs:handoffs.length,attendance:{attended:attended.length,noShows:noShowSessions.length,unknown:sessions.filter(s=>s.zoom?.attendance?.state==="unknown").length},noShowStudents:noShowSessions.slice(0,25).map(s=>({contactId:s.contactId,name:contactMap.get(String(s.contactId))?.name||"Unknown student",startsAt:s.startsAt})),programEnrollments:group(enrollments,e=>programMap.get(String(e.coachingProgramId))?.name||e.programSnapshot?.name||"unknown"),programCompletions:group(enrollments.filter(e=>e.status==="completed"),e=>programMap.get(String(e.coachingProgramId))?.name||e.programSnapshot?.name||"unknown")};
 communication.failures=jobs.filter(j=>["failed","blocked"].includes(j.status)).slice(0,25).map(j=>({id:j._id,status:j.status,channel:j.channel,reason:j.blockReason||"",contactId:j.contactId}));
 return{generatedAt:new Date(),appliedFilters:{startDate:filters.startDate||null,endDate:filters.endDate||null,coachingProgramId:filters.coachingProgramId||null,source:filters.source||null},filterOptions:{programs:programs.map(p=>({id:String(p._id),name:p.name})),sources:attribution.map(r=>r.source)},funnel:{stages:funnel,conversions},socialFunnel,attribution:{bySource:attribution,byCampaign,byContent,byCoachReferral:byReferral,social:attribution.filter(r=>["instagram","facebook","tiktok","linkedin","x"].includes(r.source))},revenue:{closedWon:money(closedWonRevenue),contractedRevenue:money(closedWonRevenue),cashCollected:money(cashCollectedTotal),outstandingBalance:money(outstandingBalance),programRevenue:money(programRevenue),addonRevenue:money(addonRevenue),referralGenerated:money(referralRevenue),commissionExpense:money(commissionExpense),customerLifetimeValue:uniqueCustomers?money((closedWonRevenue+addonRevenue)/uniqueCustomers):0,total:money(closedWonRevenue+addonRevenue),monthly:monthlyRevenue,ytd:money(ytdRevenue),target:{year:REVENUE_TARGET_YEAR,amount:REVENUE_TARGET_AMOUNT,progressPercent:REVENUE_TARGET_AMOUNT?Math.round((ytdRevenue/REVENUE_TARGET_AMOUNT)*1000)/10:0}},coaching,referrals:{total:referrals.length,pendingCommission:money(commissions.filter(c=>c.status==="pending").reduce((s,c)=>s+Number(c.commissionAmountMinor||0)/100,0)),paidCommission:money(commissions.filter(c=>c.status==="paid").reduce((s,c)=>s+Number(c.commissionAmountMinor||0)/100,0)),byCoach:byReferral},communication};
}
module.exports={getAnalytics,group,sourceFor,_deps:deps};

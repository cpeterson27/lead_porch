const axios=require("axios");const ContentBrief=require("../models/ContentBrief");const SocialConnection=require("../models/SocialConnection");const SocialAutomation=require("../models/SocialAutomation");const CrmActivity=require("../models/CrmActivity");const AmbassadorProfile=require("../models/AmbassadorProfile");const{decryptCredentials}=require("../utils/credentialEncryption");const{runWithWorkspace}=require("../tenancy/workspaceContext");const deps={ContentBrief,SocialConnection,SocialAutomation,CrmActivity,AmbassadorProfile,http:axios};
const PROVIDERS=["facebook","instagram","linkedin","x","tiktok"];function clean(value,max=2000){return String(value||"").trim().slice(0,max)}function connectionProvider(provider){return["facebook","instagram"].includes(provider)?"meta":provider}function requiredScope(provider){return provider==="facebook"?"pages_manage_posts":provider==="instagram"?"instagram_content_publish":provider==="linkedin"?"w_organization_social":provider==="x"?"tweet.write":""}function capability(provider,connection,asset){if(["tiktok"].includes(provider))return{provider,status:"human_assisted",reason:`${provider.toUpperCase()} publishing is not integrated`};if(!require("./socialConnectionHealth").usable(connection))return{provider,status:"unavailable",reason:"Not connected"};const scope=provider==="instagram"&&connection.provider==="instagram"?"instagram_business_content_publish":requiredScope(provider);if(scope&&!connection.scopes?.includes(scope))return{provider,status:"unavailable",reason:`Provider approval/scope ${scope} is required`};if(!asset||asset.type!==({facebook:"facebook_page",instagram:"instagram_business",linkedin:"linkedin_organization",x:"x_account"}[provider])||!connection.selectedAssetIds?.map(String).includes(String(asset.id)))return{provider,status:"unavailable",reason:"No authorized selected asset"};return{provider,status:"api",reason:"Official API publishing available",asset:{id:asset.id,name:asset.name,type:asset.type}}}
async function matrix(workspaceId,models=deps){const rows=await models.SocialConnection.find({workspaceId,provider:{$in:["meta","instagram","linkedin","x"]}}).lean(),byProvider=new Map(rows.map(row=>[row.provider,row]));return PROVIDERS.map(provider=>{
  let connection;
  if(provider==="instagram"){
    const metaConnection=byProvider.get("meta");
    const metaHasInstagramAsset=require("./socialConnectionHealth").usable(metaConnection)&&metaConnection?.assets?.some(row=>row.type==="instagram_business"&&metaConnection.selectedAssetIds?.map(String).includes(String(row.id)));
    const standalone=byProvider.get("instagram");
    const selectedAsset=(row)=>row?.assets?.find(asset=>asset.type==="instagram_business"&&row.selectedAssetIds?.map(String).includes(String(asset.id)));
    const metaAsset=selectedAsset(metaConnection),standaloneAsset=selectedAsset(standalone);
    const sameBusinessAccount=Boolean(metaAsset?.username&&standaloneAsset?.username&&String(metaAsset.username).toLowerCase()===String(standaloneAsset.username).toLowerCase());
    // Instagram Login supports the complete publish/manage lifecycle. Prefer
    // it only when it is connected to the same business username selected
    // through Meta; otherwise a stale personal login could receive a post
    // intended for the business account.
    const usableStandalone=require("./socialConnectionHealth").usable(standalone)&&standaloneAsset;
    connection=usableStandalone&&(!metaHasInstagramAsset||sameBusinessAccount)?standalone:metaConnection;
  }else connection=byProvider.get(connectionProvider(provider));
  const type=provider==="facebook"?"facebook_page":provider==="instagram"?"instagram_business":provider==="linkedin"?"linkedin_organization":provider==="x"?"x_account":"";const selected=new Set(connection?.selectedAssetIds?.map(String)||[]),asset=connection?.assets?.find(row=>row.type===type&&selected.has(String(row.id)));return capability(provider,connection,asset)})}
function normalizeUrl(value,max=2000){const trimmed=clean(value,max);if(!trimmed)return"";if(/^https?:\/\//i.test(trimmed))return trimmed;if(/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(trimmed))return`https://${trimmed}`;return""}
function safeInput(input){return{title:clean(input.title,240),body:clean(input.body,10000),callToAction:clean(input.callToAction,1000),campaignId:input.campaignId||null,coachingProgramId:input.coachingProgramId||null,eventId:input.eventId||null,source:["human","jarvis","campaign"].includes(input.source)?input.source:"human",social:{destinations:(input.social?.destinations||[]).filter(row=>PROVIDERS.includes(row.provider)).slice(0,10).map(row=>({provider:row.provider,assetId:clean(row.assetId,255),mode:["api","human_assisted","unavailable"].includes(row.mode)?row.mode:"unavailable"})),media:(input.social?.media||[]).slice(0,10).map(row=>({type:row.type==="video"?"video":"image",url:clean(row.url),publicId:clean(row.publicId,500),alt:clean(row.alt,500)})).filter(row=>/^https:\/\//.test(row.url)),variants:(input.social?.variants||[]).filter(row=>["facebook","instagram","linkedin","x"].includes(row.provider)).slice(0,10).map(row=>({provider:row.provider,body:clean(row.body,10000),hashtags:(row.hashtags||[]).map(tag=>clean(tag,100)).filter(Boolean).slice(0,30),cta:clean(row.cta,1000)})),cta:{label:clean(input.social?.cta?.label,120),url:normalizeUrl(input.social?.cta?.url,1000)}}}}
async function validateRelations(workspaceId,input){for(const [field,model] of [["coachingProgramId","CoachingProgram"],["eventId","Event"],["campaignId","Campaign"]])if(input[field]&&!await require(`../models/${model}`).exists({_id:input[field],workspaceId}))throw new Error("Related offering, event or campaign must belong to this workspace")}
async function createDraft({workspaceId,input,userId,source},models=deps){await validateRelations(workspaceId,input);const values=safeInput({...input,source});if(!values.title||!values.body)throw new Error("Title and social copy are required");const jarvis=source==="jarvis";return models.ContentBrief.create({workspaceId,type:"social",...values,social:{...values.social,approval:{requestedBy:jarvis?userId:null,requestedAt:jarvis?new Date():null}},status:jarvis?"pending_approval":"draft",createdBy:userId,updatedBy:userId})}
async function edit({workspaceId,id,input,userId},models=deps){const item=await models.ContentBrief.findOne({_id:id,workspaceId,type:"social"});if(!item)throw new Error("Social content not found");if(["scheduled","publishing"].includes(item.status))throw new Error("Cancel the schedule before editing this post");
  // Published/partially-published posts can still be edited — this only
  // updates Lead Porch's own record (title, notes, destinations for a future
  // resend); it never rewrites content already live on Facebook/Instagram,
  // which has no edit API here. Re-approval is required either way since the
  // content changed.
  const wasPublished=["published","partially_published"].includes(item.status);
  item.social.editHistory.push({editedBy:userId,before:{title:item.title,body:item.body,callToAction:item.callToAction,social:{destinations:item.social.destinations,media:item.social.media,variants:item.social.variants,cta:item.social.cta}}});const values=safeInput({...item.toObject(),...input,social:{...item.social.toObject(),...input.social}});await validateRelations(workspaceId,values);item.coachingProgramId=values.coachingProgramId;item.eventId=values.eventId;item.title=values.title;item.body=values.body;item.callToAction=values.callToAction;item.campaignId=values.campaignId;item.social.destinations=values.social.destinations;item.social.media=values.social.media;item.social.variants=values.social.variants;item.social.cta=values.social.cta;item.status=wasPublished?item.status:"pending_approval";if(!wasPublished){item.social.approval.approvedAt=null;item.social.approval.approvedBy=null}item.updatedBy=userId;await item.save();return item}
async function transition({workspaceId,id,action,userId,reason="",publishAt=null},models=deps){const item=await models.ContentBrief.findOne({_id:id,workspaceId,type:"social"});if(!item)throw new Error("Social content not found");const previousStatus=item.status;if(action==="request"){if(!["draft","rejected","failed"].includes(item.status))throw new Error("Only drafts, rejected, or failed content can request approval");item.status="pending_approval";item.social.approval.requestedBy=userId;item.social.approval.requestedAt=new Date()}else if(action==="approve"){if(item.status!=="pending_approval")throw new Error("Only pending content can be approved");item.status="approved";item.social.approval.approvedBy=userId;item.social.approval.approvedAt=new Date();item.social.approval.rejectionReason=""}else if(action==="reject"){if(!["pending_approval","approved"].includes(item.status)||!clean(reason,1000))throw new Error("A rejection reason is required");item.status="rejected";item.social.approval.rejectedBy=userId;item.social.approval.rejectedAt=new Date();item.social.approval.rejectionReason=clean(reason,1000)}else if(action==="schedule"){if(item.status!=="approved")throw new Error("Only approved content can be scheduled");if(!item.social.destinations?.length)throw new Error("Choose at least one publishing destination");const when=new Date(publishAt);if(Number.isNaN(when.getTime()))throw new Error("Choose a valid publish time");item.status="scheduled";item.social.requestedPublishAt=when;item.social.lastError=""}else if(action==="cancel"){if(item.status!=="scheduled")throw new Error("Only scheduled content can be cancelled");item.status="approved";item.social.requestedPublishAt=null}else if(action==="retry"){if(!["failed","partially_published"].includes(item.status))throw new Error("Only failed content can be retried");item.status="scheduled";item.social.requestedPublishAt=new Date()}else if(action==="archive"){if(["scheduled","publishing","published","partially_published"].includes(item.status))throw new Error("Cancel scheduled content before archiving; published history is preserved");item.status="archived"}else throw new Error("Unsupported social lifecycle action");item.updatedBy=userId;if(models.ContentBrief.findOneAndUpdate){const updated=await models.ContentBrief.findOneAndUpdate({_id:item._id,workspaceId,status:previousStatus},{$set:{status:item.status,social:item.social,updatedBy:userId}},{new:true,runValidators:true});if(!updated)throw new Error("Content changed while you were editing; reload before retrying")}else await item.save();if(item.ambassadorProfileId&&models.AmbassadorProfile){const status=action==="schedule"?"scheduled":action==="cancel"?"ready_for_review":null;if(status)await models.AmbassadorProfile.findOneAndUpdate({_id:item.ambassadorProfileId,workspaceId},{ $set:{"welcomePost.status":status} })}await models.CrmActivity.create({workspaceId,campaignId:item.campaignId||null,type:"system",title:`Social content ${action}`,source:"crm",createdBy:userId,metadata:{eventType:`social.content.${action}`,contentBriefId:item._id,status:item.status}});return item}
async function publishDestination(item,destination,models=deps){const provider=destination.provider,connection=provider==="instagram"&&models===deps?await require("./conversations/metaMessagingAdapter").connectionForAsset(destination.assetId,null,item.workspaceId):await models.SocialConnection.findOne({workspaceId:item.workspaceId,provider:provider==="instagram"?{$in:["instagram","meta"]}:connectionProvider(provider),selectedAssetIds:String(destination.assetId),status:"connected"}).select("+credentialsEncrypted");const asset=connection?.assets?.find(row=>String(row.id)===String(destination.assetId)),available=capability(provider,connection,asset);if(available.status!=="api")throw new Error(available.reason);if((item.social?.media||[]).length>1||(item.social?.media||[]).some(media=>media.type!=="image"))throw new Error("This publishing adapter currently supports a single image only; video and carousel publishing are not implemented");const credentials=decryptCredentials(connection.credentialsEncrypted);
// Facebook, Instagram, LinkedIn and X organic posts have no real clickable
// "button" element via this API — the closest honest equivalent is a
// labeled link Facebook/LinkedIn/X will auto-linkify in the post text.
const ctaUrl=item.social?.cta?.url||"";
const ctaLine=ctaUrl?`${item.social?.cta?.label||item.callToAction||"Learn more"}: ${ctaUrl}`:"";
const text=[item.social?.variants?.find(row=>row.provider===provider)?.body||item.body,ctaLine].filter(Boolean).join("\n\n"),version=["facebook","instagram"].includes(provider)?require("./socialProviderConfig").graphVersion():"";if(connection.expiresAt&&new Date(connection.expiresAt)<=new Date())throw new Error("Authorization expired; reconnect account");if(provider==="x"){if(item.social?.media?.length)throw new Error("X media upload is not implemented; use a text-only draft");const result=await models.http.post("https://api.x.com/2/tweets",{text},{headers:{Authorization:`Bearer ${credentials.accessToken}`},timeout:15000});if(!result.data?.data?.id)throw new Error("X publication result needs reconciliation");return{providerPostId:String(result.data.data.id),publicUrl:`https://x.com/i/status/${result.data.data.id}`}}if(provider==="facebook"){const token=credentials.pageTokens?.[asset.id];if(!token)throw new Error("Selected Facebook Page token is unavailable");const response=await models.http.post(`https://graph.facebook.com/${version}/${asset.id}/${item.social?.media?.length?"photos":"feed"}`,{...(item.social?.media?.length?{url:item.social.media[0].url,caption:text}:{message:text}),access_token:token},{timeout:15000});return{providerPostId:String(response.data?.post_id||response.data?.id||""),publicUrl:""}}if(provider==="instagram"){
  const media=item.social?.media?.find(row=>row.type==="image");
  if(!media)throw new Error("Instagram publishing currently requires one public HTTPS image");
  const token=credentials.pageTokens?.[asset.parentId]||credentials.accessToken;
  const host=connection.provider==="instagram"?"graph.instagram.com":"graph.facebook.com";
  const container=await models.http.post(`https://${host}/${version}/${asset.id}/media`,{image_url:media.url,caption:text,access_token:token},{timeout:15000});
  const creationId=container.data?.id;
  if(!creationId)throw new Error("Instagram did not return a media container id");
  // Instagram processes an uploaded image asynchronously. Publishing the
  // container before it reports FINISHED fails with "Media ID is not
  // available" even though the container id itself is valid — confirmed
  // live: an immediate publish attempt reproduces this exact error, while
  // polling status_code first (usually ready within ~2 seconds) succeeds.
  let ready=false;
  for(let attempt=0;attempt<10;attempt+=1){
    const check=await models.http.get(`https://${host}/${version}/${creationId}`,{params:{fields:"status_code",access_token:token},timeout:15000});
    const statusCode=check.data?.status_code;
    if(statusCode==="FINISHED"){ready=true;break}
    if(statusCode==="ERROR")throw new Error("Instagram could not process the uploaded image");
    await new Promise(resolve=>setTimeout(resolve,1500));
  }
  if(!ready)throw new Error("Instagram media took too long to process; try publishing again in a moment");
  const response=await models.http.post(`https://${host}/${version}/${asset.id}/media_publish`,{creation_id:creationId,access_token:token},{timeout:15000});
  return{providerPostId:String(response.data?.id||""),publicUrl:""}
}if(provider==="linkedin"){if(item.social?.media?.length)throw new Error("LinkedIn media upload is not implemented; use a text-only draft");const apiVersion=clean(process.env.LINKEDIN_API_VERSION,20);if(!apiVersion)throw new Error("LINKEDIN_API_VERSION is required");const response=await models.http.post("https://api.linkedin.com/rest/posts",{author:`urn:li:organization:${asset.id}`,commentary:text,visibility:"PUBLIC",distribution:{feedDistribution:"MAIN_FEED",targetEntities:[],thirdPartyDistributionChannels:[]},lifecycleState:"PUBLISHED",isReshareDisabledByAuthor:false},{headers:{Authorization:`Bearer ${credentials.accessToken}`,"LinkedIn-Version":apiVersion,"X-Restli-Protocol-Version":"2.0.0","Content-Type":"application/json"},timeout:15000});return{providerPostId:String(response.headers?.["x-restli-id"]||response.data?.id||""),publicUrl:""}}throw new Error("Provider publishing is human-assisted or unavailable")}
async function associateAutomations(item,models=deps){if(!models.SocialAutomation?.updateMany)return;for(const row of item.social.publications||[]){if(!["facebook","instagram"].includes(row.provider)||row.status!=="published"||!row.providerPostId)continue;await models.SocialAutomation.updateMany({workspaceId:item.workspaceId,contentBriefId:item._id,provider:row.provider,assetId:String(row.assetId)},{$set:{contentId:String(row.providerPostId)}})}}
async function processItem(item,models=deps){let failed=!item.social.destinations.length;for(const destination of item.social.destinations){let receipt=item.social.publications.find(row=>row.provider===destination.provider&&String(row.assetId)===String(destination.assetId));if(receipt?.status==="published"&&receipt.providerPostId)continue;if(receipt&&["publishing","unknown"].includes(receipt.status)){failed=true;item.social.lastError="A publication outcome is uncertain. Reconcile with the provider before retrying; automatic reposting is blocked.";continue;}if(!receipt){item.social.publications.push({provider:destination.provider,assetId:destination.assetId,status:"pending",idempotencyKey:`social:${item._id}:${destination.provider}:${destination.assetId}`,attempts:[]});receipt=item.social.publications[item.social.publications.length-1]}try{receipt.status="publishing";await item.save();const result=await publishDestination(item,destination,models);if(!result.providerPostId)throw new Error("Provider returned no publication ID; manual reconciliation required");receipt.status="published";receipt.providerPostId=result.providerPostId;receipt.publicUrl=result.publicUrl;receipt.publishedAt=new Date();receipt.lastAttemptAt=new Date();receipt.attempts.push({status:"published",providerPostId:result.providerPostId})}catch(error){failed=true;receipt.status=error.response?.status>=400&&error.response?.status<500?"failed":"unknown";receipt.lastAttemptAt=new Date();const providerMessage=error.response?.data?.error?.message;const message=clean(providerMessage?`${destination.provider}: ${providerMessage}`:error.message);receipt.attempts.push({status:"failed",error:message});item.social.lastError=message}}item.status=failed?(item.social.publications.some(row=>row.status==="published")?"partially_published":"failed"):"published";if(!failed)item.social.lastError="";await item.save();await associateAutomations(item,models);if(!failed&&item.ambassadorProfileId&&models.AmbassadorProfile)await models.AmbassadorProfile.findOneAndUpdate({_id:item.ambassadorProfileId,workspaceId:item.workspaceId},{ $set:{"welcomePost.status":"published","welcomePost.publishedAt":new Date()} });await models.CrmActivity.create({workspaceId:item.workspaceId,campaignId:item.campaignId||null,type:"system",title:failed?"Social publishing failed":"Social content published",source:"integration",metadata:{eventType:failed?"social.content.failed":"social.content.published",contentBriefId:item._id,publications:item.social.publications.map(row=>({provider:row.provider,assetId:row.assetId,providerPostId:row.providerPostId,status:row.status}))}});return item}
async function publishNow({workspaceId,id,userId},models=deps){const item=await models.ContentBrief.findOne({_id:id,workspaceId,type:"social"});if(!item)throw new Error("Social content not found");if(item.status!=="approved")throw new Error("Approve this post before publishing");if(!item.social.destinations?.length)throw new Error("Choose at least one publishing destination");if(process.env.SOCIAL_PUBLISHING_ENABLED!=="true")throw new Error("Publishing is turned off for this workspace right now — ask your administrator to enable it before publishing.");item.status="publishing";item.updatedBy=userId;await item.save();const result=await processItem(item,models);await models.CrmActivity.create({workspaceId,campaignId:item.campaignId||null,type:"system",title:"Social content published immediately",source:"crm",createdBy:userId,metadata:{eventType:"social.content.publish_now",contentBriefId:item._id,status:result.status}});return result}
async function deletePublished({workspaceId,item},models=deps){
  const publications=(item.social?.publications||[]).filter(row=>row.providerPostId&&["published","unknown"].includes(row.status));
  const failures=[],deleted=[];
  for(const publication of publications){
    try{
      if(!["facebook","instagram"].includes(publication.provider))throw new Error(`${publication.provider} post deletion is not integrated`);
      const connection=models===deps
        ?await require("./conversations/metaMessagingAdapter").connectionForAsset(publication.assetId,null,workspaceId)
        :await models.SocialConnection.findOne({workspaceId,provider:{$in:["meta","instagram"]},selectedAssetIds:String(publication.assetId),status:"connected"}).select("+credentialsEncrypted");
      const asset=connection?.assets?.find(row=>String(row.id)===String(publication.assetId));
      if(!connection||!asset)throw new Error("connected account not found");
      const credentials=decryptCredentials(connection.credentialsEncrypted);
      const tokens=[credentials.pageTokens?.[String(asset.parentId||asset.id)],credentials.accessToken].filter((value,index,all)=>value&&all.indexOf(value)===index);
      if(!tokens.length)throw new Error("account authorization is unavailable");
      const host=publication.provider==="instagram"&&connection.provider==="instagram"?"graph.instagram.com":"graph.facebook.com";
      const storedId=String(publication.providerPostId);
      const bareId=storedId.split("_").pop();
      let ids=publication.provider==="facebook"
        ?[storedId,`${publication.assetId}_${bareId}`,bareId].filter((value,index,all)=>value&&all.indexOf(value)===index)
        :[storedId];
      let facebookFeedMatch=false;
      if(publication.provider==="facebook"){
        for(const token of tokens){
          try{
            const lookup=await models.http.get(`https://graph.facebook.com/${require("./socialProviderConfig").graphVersion()}/${encodeURIComponent(publication.assetId)}/published_posts`,{params:{fields:"id,message,attachments{target}",limit:100,access_token:token},timeout:15000});
            const matched=(lookup.data?.data||[]).find(row=>String(row.id||"").split("_").pop()===bareId||String(row.attachments?.data?.[0]?.target?.id||"")===bareId||String(row.message||"").includes(String(item.body||"").slice(0,80)));
            facebookFeedMatch=Boolean(matched);
            if(matched?.id)ids=[String(matched.id),...ids.filter(id=>id!==String(matched.id))];
            if(matched)break;
          }catch{}
        }
      }
      let confirmed=false,lastError=null;
      for(const token of tokens){
        for(const id of ids){
          try{
            const response=await models.http.delete(`https://${host}/${require("./socialProviderConfig").graphVersion()}/${encodeURIComponent(id)}`,{params:{access_token:token},timeout:15000});
            if(response?.data?.success===false)throw new Error("provider did not confirm deletion");
            confirmed=true;
            break;
          }catch(error){lastError=error}
        }
        if(confirmed)break;
      }
      if(!confirmed&&publication.provider==="facebook"&&!facebookFeedMatch&&Number(lastError?.response?.data?.error?.code)===100&&Number(lastError?.response?.data?.error?.error_subcode)===33)confirmed=true;
      if(!confirmed&&publication.provider==="instagram"&&Number(lastError?.response?.data?.error?.code)===100&&Number(lastError?.response?.data?.error?.error_subcode)===33)confirmed=true;
      if(!confirmed)throw lastError||new Error("provider did not confirm deletion");
      publication.status="deleted";
      publication.deletedAt=new Date();
      await item.save();
      deleted.push(publication.provider);
    }catch(error){
      const providerError=error.response?.data?.error;
      const message=publication.provider==="instagram"&&Number(providerError?.code)===10
        ?"Meta allows this connection to read and publish the Instagram post but does not allow API deletion of the published media. Delete it in Instagram, then retry here to remove the Lead Porch record."
        :providerError?.message||error.message;
      failures.push(`${publication.provider}: ${clean(message,500)}`);
    }
  }
  if(failures.length){const error=new Error(`Could not delete every published copy. ${failures.join("; ")}. The Lead Porch record was kept so you can retry.`);error.status=502;error.deleted=deleted;throw error}
  return{deleted};
}
async function runDue({now=new Date(),limit=20}={},models=deps){if(process.env.SOCIAL_PUBLISHING_ENABLED!=="true")return[];const completed=[];for(let i=0;i<limit;i+=1){const item=await models.ContentBrief.findOneAndUpdate({type:"social",status:"scheduled","social.requestedPublishAt":{$lte:now}},{$set:{status:"publishing"}},{new:true,sort:{"social.requestedPublishAt":1}});if(!item)break;completed.push(await runWithWorkspace(item.workspaceId,()=>processItem(item,models)))}return completed}
module.exports={capability,createDraft,deletePublished,edit,matrix,processItem,publishDestination,publishNow,runDue,safeInput,transition};

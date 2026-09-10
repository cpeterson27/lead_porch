const express=require("express");const ContentBrief=require("../models/ContentBrief");const service=require("../services/socialPublishingService");const mediaVariantService=require("../services/mediaVariantService");const imageGenerationService=require("../services/imageGenerationService");const{requireCapability}=require("../middleware/auth");const router=express.Router();router.use(requireCapability("social.manage","campaigns.manage"));
router.get("/",async(req,res)=>{try{const query=req.query.type?{type:req.query.type}:{};if(req.query.status)query.status=req.query.status;const items=await ContentBrief.find(query).sort({createdAt:-1}).limit(500).populate("campaignId","name").populate("createdBy","name email");res.json({success:true,data:items})}catch{res.status(500).json({success:false,error:"Unable to load content drafts"})}});
router.get("/social/capabilities",requireCapability("social.manage"),async(req,res)=>res.json({success:true,data:await service.matrix(req.auth.workspaceId)}));
router.post("/",async(req,res)=>{try{if(req.body.type==="social"){const item=await service.createDraft({workspaceId:req.auth.workspaceId,input:req.body,userId:req.auth.user._id,source:req.body.source==="jarvis"?"jarvis":req.body.source==="campaign"?"campaign":"human"});return res.status(201).json({success:true,data:item})}const{title,type="brief",body,subject="",callToAction="",campaignId=null}=req.body;if(!title?.trim()||!body?.trim())return res.status(400).json({success:false,error:"A title and draft are required"});const item=await ContentBrief.create({workspaceId:req.auth.workspaceId,title,type,body,subject,callToAction,campaignId,source:"human",createdBy:req.auth.user._id,updatedBy:req.auth.user._id});return res.status(201).json({success:true,data:item})}catch(error){return res.status(400).json({success:false,error:error.message})}});
router.patch("/:id",async(req,res)=>{try{const existing=await ContentBrief.findOne({_id:req.params.id,workspaceId:req.auth.workspaceId});if(!existing)return res.status(404).json({success:false,error:"Content draft not found"});if(existing.type==="social")return res.json({success:true,data:await service.edit({workspaceId:req.auth.workspaceId,id:existing._id,input:req.body,userId:req.auth.user._id})});for(const key of["title","body","subject","callToAction","campaignId"])if(req.body[key]!==undefined)existing[key]=req.body[key];existing.updatedBy=req.auth.user._id;await existing.save();return res.json({success:true,data:existing})}catch(error){return res.status(400).json({success:false,error:error.message})}});
for(const action of["request","approve","cancel","retry","archive"])router.post(`/:id/${action==="request"?"request-approval":action}`,requireCapability("social.manage"),async(req,res)=>{try{res.json({success:true,data:await service.transition({workspaceId:req.auth.workspaceId,id:req.params.id,action,userId:req.auth.user._id})})}catch(error){res.status(400).json({error:error.message})}});
router.post("/:id/reject",requireCapability("social.manage"),async(req,res)=>{try{res.json({success:true,data:await service.transition({workspaceId:req.auth.workspaceId,id:req.params.id,action:"reject",reason:req.body.reason,userId:req.auth.user._id})})}catch(error){res.status(400).json({error:error.message})}});
router.post("/:id/schedule",requireCapability("social.manage"),async(req,res)=>{try{res.json({success:true,data:await service.transition({workspaceId:req.auth.workspaceId,id:req.params.id,action:"schedule",publishAt:req.body.publishAt,userId:req.auth.user._id})})}catch(error){res.status(400).json({error:error.message})}});
router.post("/:id/publish-now",requireCapability("social.manage"),async(req,res)=>{try{res.json({success:true,data:await service.publishNow({workspaceId:req.auth.workspaceId,id:req.params.id,userId:req.auth.user._id})})}catch(error){res.status(400).json({error:error.message})}});
router.delete("/:id",requireCapability("social.manage"),async(req,res)=>{try{const item=await ContentBrief.findOne({_id:req.params.id,workspaceId:req.auth.workspaceId});if(!item)return res.status(404).json({error:"Content not found"});if(["scheduled","publishing"].includes(item.status))return res.status(400).json({error:"Cancel the scheduled post before deleting it"});const result=item.type==="social"?await service.deletePublished({workspaceId:req.auth.workspaceId,item}):{deleted:[]};await ContentBrief.deleteOne({_id:item._id,workspaceId:req.auth.workspaceId});res.json({success:true,providerDeleted:result.deleted,warnings:result.warnings||[]})}catch(error){res.status(error.status||400).json({error:error.message,providerDeleted:error.deleted||[]})}});
router.post("/:id/duplicate",requireCapability("social.manage"),async(req,res)=>{try{const source=await ContentBrief.findOne({_id:req.params.id,workspaceId:req.auth.workspaceId,type:"social"}).lean();if(!source)return res.status(404).json({error:"Social content not found"});const item=await service.createDraft({workspaceId:req.auth.workspaceId,input:{...source,title:`${source.title} copy`},userId:req.auth.user._id,source:"human"});res.status(201).json({success:true,data:item})}catch(error){res.status(400).json({error:error.message})}});
// Non-destructive per-platform variant preview/generation. Never touches the original media
// entry's url/publicId — only adds/replaces derived entries in platformVariants.
router.post("/:id/media/:mediaIndex/variants",requireCapability("social.manage"),async(req,res)=>{
  try{
    const item=await ContentBrief.findOne({_id:req.params.id,workspaceId:req.auth.workspaceId,type:"social"});
    if(!item)return res.status(404).json({success:false,error:"Content not found"});
    const media=item.social?.media?.[Number(req.params.mediaIndex)];
    if(!media)return res.status(404).json({success:false,error:"Media item not found"});
    const platforms=Array.isArray(req.body?.platforms)&&req.body.platforms.length?req.body.platforms.filter(p=>["facebook","instagram","linkedin","x"].includes(p)):["facebook","instagram","linkedin","x"];
    const variants=mediaVariantService.generatePlatformVariants({media,platforms,mode:req.body?.mode});
    media.platformVariants=variants;
    await item.save();
    return res.json({success:true,data:media});
  }catch(error){return res.status(error.code?400:500).json({success:false,error:error.message,code:error.code||""});}
});
router.patch("/:id/media/:mediaIndex/variants/:provider",requireCapability("social.manage"),async(req,res)=>{
  try{
    const item=await ContentBrief.findOne({_id:req.params.id,workspaceId:req.auth.workspaceId,type:"social"});
    if(!item)return res.status(404).json({success:false,error:"Content not found"});
    const media=item.social?.media?.[Number(req.params.mediaIndex)];
    if(!media)return res.status(404).json({success:false,error:"Media item not found"});
    const replaced=mediaVariantService.replaceVariant({media,provider:req.params.provider,placement:req.body?.placement,mode:req.body?.mode,width:req.body?.width,height:req.body?.height});
    media.platformVariants=[...(media.platformVariants||[]).filter(v=>v.provider!==req.params.provider),replaced];
    await item.save();
    return res.json({success:true,data:media});
  }catch(error){return res.status(error.code?400:500).json({success:false,error:error.message,code:error.code||""});}
});
/** Real OpenAI image generation, disabled until its own flag + chat flag + key are all set. */
router.post("/generate-image",requireCapability("social.manage","campaigns.manage"),async(req,res)=>{
  try{
    const result=await imageGenerationService.generateImage({workspaceId:req.auth.workspaceId,userId:req.auth.user._id,prompt:req.body?.prompt,size:req.body?.size,quality:req.body?.quality,campaignId:req.body?.campaignId||null,correlationId:req.get("x-request-id")||""});
    return res.status(201).json({success:true,data:result});
  }catch(error){
    const status=error.code==="IMAGE_GENERATION_DISABLED"?503:error.code==="IMAGE_PROMPT_REQUIRED"?400:502;
    return res.status(status).json({success:false,error:error.message,code:error.code||""});
  }
});
module.exports=router;

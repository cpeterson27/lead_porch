const express=require("express");const mongoose=require("mongoose");const{requireCapability}=require("../middleware/auth");const analytics=require("../services/growthAnalyticsService");const router=express.Router();router.use(requireCapability("analytics.view"));
function validId(value){return mongoose.Types.ObjectId.isValid(String(value||""));}
function validDate(value){return !Number.isNaN(new Date(value).getTime());}
router.get("/growth",async(req,res,next)=>{
  try{
    const filters={};
    if(req.query.startDate&&validDate(req.query.startDate))filters.startDate=req.query.startDate;
    if(req.query.endDate&&validDate(req.query.endDate))filters.endDate=req.query.endDate;
    if(req.query.coachingProgramId&&validId(req.query.coachingProgramId))filters.coachingProgramId=req.query.coachingProgramId;
    if(req.query.source)filters.source=String(req.query.source).slice(0,120);
    res.json({success:true,data:await analytics.getAnalytics(req.auth.workspaceId,undefined,filters)});
  }catch(error){next(error);}
});
router.get("/ai-traffic", async (req, res, next) => {
  try { res.set("Cache-Control", "no-store").json({ success: true, data: await require("../services/siteTrafficService").report(req.auth.workspaceId, req.query.days) }); } catch (error) { next(error); }
});
module.exports=router;

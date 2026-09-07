const service=require("./socialPublishingService");let timer=null,running=false;async function runDueSocialPublishing(){if(running)return[];running=true;try{return await service.runDue()}finally{running=false}}
// Matches the opt-out pattern every other background runner in this app
// uses (research/communication/automation): runs in-process on the main web
// server by default, and only skips that if a dedicated worker service sets
// SOCIAL_PUBLISHING_WORKER_MODE=external. This runner previously required an
// explicit opt-in env var that server.js never set and never even called
// this function, so scheduled posts silently never published no matter what
// SOCIAL_PUBLISHING_ENABLED was set to.
function startSocialPublishingRunner({force=false}={}){if(timer||(!force&&process.env.SOCIAL_PUBLISHING_WORKER_MODE==="external"))return timer;timer=setInterval(()=>runDueSocialPublishing().catch(error=>console.error("Social publishing runner failed:",error.message)),30000);timer.unref?.();return timer}module.exports={runDueSocialPublishing,startSocialPublishingRunner};

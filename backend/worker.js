require("dotenv").config();
const { connectDatabase } = require("./config/database");
const { startResearchMonitorRunner, runDueResearchMonitors } = require("./services/researchMonitorService");
const { startCommunicationJobRunner, runDueCommunicationJobs } = require("./services/communicationJobRunner");
const { startAutomationRunner, runDueAutomations } = require("./services/automationRunner");
const { startSocialPublishingRunner, runDueSocialPublishing } = require("./services/socialPublishingRunner");
const { startLinkedinSequenceRunner, runDueEnrollments } = require("./services/linkedinSequenceService");
const { startCampaignSendScheduler, runDueCampaignSends, startApprovedOutreachSweep, runApprovedOutreachSweep } = require("./services/campaignSendScheduler");
const { startCommentSyncRunner, runDueSocialSync } = require("./services/socialCommentSyncRunner");

const mongoUri = process.env.MONGO_URI;
if (!mongoUri) {
  console.error("Missing MONGO_URI for the research worker.");
  process.exit(1);
}

connectDatabase(mongoUri)
  .then(async () => {
    console.log("Research worker connected to MongoDB.");
    await runDueResearchMonitors();
    await runDueCommunicationJobs();
    await runDueAutomations();
    await runDueSocialPublishing();
    await runDueEnrollments();
    // Confirmed live: COMMUNICATION_WORKER_MODE=external is set in
    // production specifically so the main web process defers scheduled
    // campaign sends to this dedicated worker instead of running its own
    // in-process timer — but this file never actually started that
    // scheduler, so campaign.scheduledSendAt was never being polled by
    // *either* process. A campaign scheduled to send stayed unclaimed and
    // unsent indefinitely, silently, with no error anywhere to notice.
    await runDueCampaignSends();
    await runApprovedOutreachSweep();
    await runDueSocialSync();
    startResearchMonitorRunner();
    startCommunicationJobRunner({ force: true });
    startAutomationRunner({ force: true });
    startSocialPublishingRunner({ force: true });
    startLinkedinSequenceRunner();
    startCampaignSendScheduler({ force: true });
    startApprovedOutreachSweep({ force: true });
    startCommentSyncRunner({ force: true });
  })
  .catch((error) => {
    console.error("Research worker failed to start:", error.message || error);
    process.exit(1);
  });

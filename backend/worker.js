require("dotenv").config();
const { connectDatabase } = require("./config/database");
const { startResearchMonitorRunner, runDueResearchMonitors } = require("./services/researchMonitorService");
const { startCommunicationJobRunner, runDueCommunicationJobs } = require("./services/communicationJobRunner");
const { startAutomationRunner, runDueAutomations } = require("./services/automationRunner");
const { startSocialPublishingRunner, runDueSocialPublishing } = require("./services/socialPublishingRunner");
const { startLinkedinSequenceRunner, runDueEnrollments } = require("./services/linkedinSequenceService");

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
    startResearchMonitorRunner();
    startCommunicationJobRunner({ force: true });
    startAutomationRunner({ force: true });
    startSocialPublishingRunner({ force: true });
    startLinkedinSequenceRunner();
  })
  .catch((error) => {
    console.error("Research worker failed to start:", error.message || error);
    process.exit(1);
  });

/**
 * A recurring Public Web Discovery schedule for one approved program —
 * the "actual scheduler" the engine needs, mirroring
 * services/researchMonitorService.js's ResearchMonitor lease/due-query
 * pattern exactly (same enabled+nextRunAt+lease fields, same runner shape
 * in services/publicWebDiscoveryEngineService.js's startPublicWebDiscoveryRunner()).
 *
 * `enabled` DEFAULTS FALSE and is never flipped true by anything in this
 * codebase — an owner must explicitly turn a schedule on. The underlying
 * poller (started once per process, like every other runner in
 * server.js) always ticks, but its due-query only ever matches
 * `enabled: true` schedules, so a fresh install with zero schedules
 * enabled spends nothing and crawls nothing on its own.
 */
const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const discoveryScheduleSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 200 },
  programNoteId: { type: mongoose.Schema.Types.ObjectId, ref: "JarvisMemoryNote", default: null },
  programName: { type: String, default: "", trim: true, maxlength: 200 },
  enabled: { type: Boolean, default: false },
  intervalMinutes: { type: Number, default: 1440, min: 60, max: 43200 },
  // The run configuration applied each time this schedule fires — same
  // fields/limits as PublicWebDiscoveryRun's own owner-editable controls.
  dailyCandidateTarget: { type: Number, default: 25, min: 1, max: 500 },
  pageLimitPerQuery: { type: Number, default: 2, min: 1, max: 10 },
  queryLimitPerRun: { type: Number, default: 40, min: 1, max: 500 },
  providerCreditCapUsd: { type: Number, default: 5, min: 0, max: 1000 },
  sources: { type: [String], enum: ["vertex", "openai_web_search"], default: ["vertex", "openai_web_search"] },
  includePdlCrossReference: { type: Boolean, default: true },
  maxAttemptsPerJob: { type: Number, default: 3, min: 1, max: 10 },
  nextRunAt: { type: Date, default: null },
  runRequestedAt: { type: Date, default: null },
  lastRunAt: { type: Date, default: null },
  lastRunStatus: { type: String, enum: ["", "running", "completed", "partial", "failed"], default: "" },
  lastRunMessage: { type: String, default: "", trim: true, maxlength: 1000 },
  currentRunId: { type: mongoose.Schema.Types.ObjectId, ref: "PublicWebDiscoveryRun", default: null },
  leaseOwner: { type: String, default: "" },
  leaseExpiresAt: { type: Date, default: null },
  createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
}, { timestamps: true, collection: "discovery_schedules" });

discoveryScheduleSchema.index({ workspaceId: 1, enabled: 1, nextRunAt: 1 });
discoveryScheduleSchema.plugin(workspacePlugin);

module.exports = mongoose.model("DiscoverySchedule", discoveryScheduleSchema);

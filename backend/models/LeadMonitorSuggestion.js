/**
 * An editable, disabled-by-default monitor SUGGESTION produced after a
 * successful DiscoverySearch — never a live, schedulable ResearchMonitor.
 *
 * Deliberately a separate, new model rather than reusing ResearchMonitor:
 * ResearchMonitor's existing `sources` enum and its execution runner
 * (services/researchMonitorService.js and whatever schedules it) are built
 * entirely around the legacy web-scraping-style source adapters
 * (bing_web, reddit_rss, etc. — see services/intentSourceService.js) and
 * have no code path that knows how to execute a Vertex/OpenAI/PDL/Apollo
 * search on a schedule. Storing this suggestion on ResearchMonitor would
 * either require loosening its `sources` enum to accept values its own
 * runner cannot act on (silently misrepresenting a working capability), or
 * building a new scheduled-execution engine for these four providers —
 * both out of scope for this change. This model exists so the suggestion
 * itself (query, providers, schedule, cap, estimated credit use,
 * destination) can be created, shown, and edited honestly, with `enabled`
 * always defaulting to false and no runner anywhere that would act on it
 * even if flipped true. Wiring real scheduled execution is flagged as
 * follow-up work, not silently faked here.
 */
const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const leadMonitorSuggestionSchema = new mongoose.Schema({
  discoverySearchId: { type: mongoose.Schema.Types.ObjectId, ref: "DiscoverySearch", required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  query: { type: String, required: true, trim: true, maxlength: 2000 },
  programNoteId: { type: mongoose.Schema.Types.ObjectId, ref: "JarvisMemoryNote", default: null },
  icp: { type: mongoose.Schema.Types.Mixed, default: {} },
  sources: { type: [String], default: [] },
  scheduleDescription: { type: String, default: "weekly", trim: true, maxlength: 80 },
  intervalMinutes: { type: Number, default: 10080, min: 60, max: 43200 },
  capPerRun: { type: Number, default: 10, min: 1, max: 25 },
  estimatedCreditUsePerRun: { type: mongoose.Schema.Types.Mixed, default: {} },
  destination: { type: String, default: "review_queue", enum: ["review_queue"] },
  // Always created disabled. No runner in this codebase executes this
  // model's contents — see the module header. Flipping this true is safe
  // (it changes nothing) but does not itself create scheduled execution.
  enabled: { type: Boolean, default: false },
  createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
}, { timestamps: true, collection: "lead_monitor_suggestions" });

leadMonitorSuggestionSchema.index({ workspaceId: 1, createdAt: -1 });
leadMonitorSuggestionSchema.plugin(workspacePlugin);

module.exports = mongoose.model("LeadMonitorSuggestion", leadMonitorSuggestionSchema);

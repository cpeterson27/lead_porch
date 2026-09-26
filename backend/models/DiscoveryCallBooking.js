const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const discoveryCallBookingSchema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
  coachProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "CoachProfile", required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 180 },
  email: { type: String, required: true, trim: true, lowercase: true, maxlength: 320 },
  phone: { type: String, default: "", trim: true, maxlength: 80 },
  notes: { type: String, default: "", trim: true, maxlength: 2000 },
  coachingProgramId: { type: mongoose.Schema.Types.ObjectId, ref: "CoachingProgram", default: null, index: true },
  programSnapshot: {
    name: { type: String, default: "", trim: true, maxlength: 180 },
    slug: { type: String, default: "", trim: true, maxlength: 120 },
  },
  siteAttribution: require("./siteAttributionFields"),
  qualification: {
    experience: { type: String, default: "", trim: true, maxlength: 160 },
    primaryGoal: { type: String, default: "", trim: true, maxlength: 500 },
    timeline: { type: String, default: "", trim: true, maxlength: 160 },
  },
  startsAt: { type: Date, required: true, index: true },
  durationMinutes: { type: Number, required: true, min: 15, max: 180, default: 30 },
  timezone: { type: String, default: "UTC", trim: true, maxlength: 100 },
  status: { type: String, enum: ["scheduled", "cancelled", "completed", "no_show"], default: "scheduled", index: true },
  calendar: {
    connectionId: { type: mongoose.Schema.Types.ObjectId, ref: "IntegrationConnection", default: null },
    calendarId: { type: String, default: "", trim: true, maxlength: 1024 },
    eventId: { type: String, default: "", trim: true, maxlength: 1024 },
    htmlLink: { type: String, default: "", trim: true, maxlength: 2048 },
    meetUrl: { type: String, default: "", trim: true, maxlength: 2048 },
  },
}, { timestamps: true, collection: "discovery_call_bookings" });

discoveryCallBookingSchema.index({ workspaceId: 1, startsAt: 1, status: 1 });
discoveryCallBookingSchema.index({ workspaceId: 1, "calendar.eventId": 1 }, { unique: true, partialFilterExpression: { "calendar.eventId": { $gt: "" } } });
discoveryCallBookingSchema.plugin(workspacePlugin);

module.exports = mongoose.model("DiscoveryCallBooking", discoveryCallBookingSchema);

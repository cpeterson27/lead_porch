const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

// A week's worth of curriculum content for one Coaching Program. Release
// timing is computed per-student off Enrollment.startsAt (weekNumber - 1
// weeks after their own start date) rather than a shared "cohort" start
// date — this handles rolling admissions naturally without a separate
// Cohort model, at the cost of not (yet) grouping students who started
// together for shared live sessions. Worth revisiting if Ellie starts
// running fixed-start cohorts rather than rolling enrollment.
const resourceSchema = new mongoose.Schema({
  type: { type: String, enum: ["video", "pdf", "worksheet", "script", "template", "link"], required: true },
  title: { type: String, required: true, trim: true, maxlength: 200 },
  url: { type: String, required: true, trim: true, maxlength: 2000 },
}, { _id: false });

const courseModuleSchema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
  coachingProgramId: { type: mongoose.Schema.Types.ObjectId, ref: "CoachingProgram", required: true, index: true },
  weekNumber: { type: Number, required: true, min: 1 },
  title: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, default: "", trim: true, maxlength: 3000 },
  resources: { type: [resourceSchema], default: [] },
  homeworkPrompt: { type: String, default: "", trim: true, maxlength: 3000 },
  sortOrder: { type: Number, default: 0 },
}, { timestamps: true, collection: "course_modules" });

courseModuleSchema.index({ workspaceId: 1, coachingProgramId: 1, weekNumber: 1 }, { unique: true });
courseModuleSchema.plugin(workspacePlugin);

module.exports = mongoose.model("CourseModule", courseModuleSchema);

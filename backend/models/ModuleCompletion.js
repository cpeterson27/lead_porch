const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const moduleCompletionSchema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
  enrollmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Enrollment", required: true, index: true },
  courseModuleId: { type: mongoose.Schema.Types.ObjectId, ref: "CourseModule", required: true, index: true },
  completedAt: { type: Date, default: Date.now },
}, { timestamps: true, collection: "module_completions" });

moduleCompletionSchema.index({ workspaceId: 1, enrollmentId: 1, courseModuleId: 1 }, { unique: true });
moduleCompletionSchema.plugin(workspacePlugin);

module.exports = mongoose.model("ModuleCompletion", moduleCompletionSchema);

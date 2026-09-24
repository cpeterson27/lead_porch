const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
  contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", required: true, index: true },
  salesOpportunityId: { type: mongoose.Schema.Types.ObjectId, ref: "SalesOpportunity", default: null, index: true },
  enrollmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Enrollment", default: null, index: true },
  provider: { type: String, enum: ["docusign"], default: "docusign" },
  status: { type: String, enum: ["draft", "sent", "delivered", "signed", "declined", "voided"], default: "draft", index: true },
  documentName: { type: String, required: true, trim: true, maxlength: 200 },
  signerName: { type: String, default: "", trim: true, maxlength: 180 },
  signerEmail: { type: String, default: "", trim: true, maxlength: 200 },
  envelopeId: { type: String, default: "", trim: true, maxlength: 100, index: true },
  signedDocumentUrl: { type: String, default: "", maxlength: 1000 },
  sentAt: { type: Date, default: null },
  viewedAt: { type: Date, default: null },
  signedAt: { type: Date, default: null },
  declinedAt: { type: Date, default: null },
  voidedAt: { type: Date, default: null },
  lastError: { type: String, default: "", maxlength: 1000 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true, collection: "contracts" });

schema.index({ workspaceId: 1, status: 1, createdAt: -1 });
schema.index({ provider: 1, envelopeId: 1 }, { unique: true, partialFilterExpression: { envelopeId: { $type: "string", $gt: "" } } });
schema.plugin(workspacePlugin);
module.exports = mongoose.model("Contract", schema);

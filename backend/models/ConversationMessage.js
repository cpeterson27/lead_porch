const mongoose = require("mongoose");
const workspacePlugin = require("../tenancy/workspacePlugin");

const conversationMessageSchema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
  threadId: { type: mongoose.Schema.Types.ObjectId, ref: "ConversationThread", required: true, index: true },
  channel: { type: String, enum: ["email", "sms", "mms", "phone", "chat", "whatsapp", "facebook", "instagram", "linkedin", "manual"], required: true },
  provider: { type: String, default: "", trim: true, lowercase: true },
  providerMessageId: { type: String, default: "", trim: true },
  direction: { type: String, enum: ["inbound", "outbound", "internal"], required: true, index: true },
  kind: { type: String, enum: ["message", "note", "status", "assignment", "system"], default: "message" },
  subject: { type: String, default: "", trim: true, maxlength: 500 },
  body: { type: String, default: "", maxlength: 50000 },
  html: { type: String, default: "", maxlength: 200000 },
  sender: { name: { type: String, default: "" }, address: { type: String, default: "", lowercase: true, trim: true } },
  recipients: [{ name: { type: String, default: "" }, address: { type: String, default: "", lowercase: true, trim: true }, role: { type: String, enum: ["to", "cc", "bcc"], default: "to" } }],
  attachments: [{ name: String, contentType: String, size: { type: Number, default: 0 }, url: String, providerId: String }],
  deliveryStatus: { type: String, enum: ["draft", "queued", "sent", "delivered", "read", "failed", "received"], default: "received" },
  sentAt: { type: Date, default: null },
  receivedAt: { type: Date, default: null },
  deliveredAt: { type: Date, default: null },
  readAt: { type: Date, default: null },
  contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", default: null, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  deletedAt: { type: Date, default: null },
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
}, { timestamps: true, collection: "conversation_messages" });

conversationMessageSchema.index({ workspaceId: 1, threadId: 1, createdAt: 1 });
conversationMessageSchema.index(
  { workspaceId: 1, provider: 1, providerMessageId: 1 },
  { unique: true, partialFilterExpression: { providerMessageId: { $type: "string", $gt: "" } } },
);
conversationMessageSchema.plugin(workspacePlugin);

module.exports = mongoose.model("ConversationMessage", conversationMessageSchema);

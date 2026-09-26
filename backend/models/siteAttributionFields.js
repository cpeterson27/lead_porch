// Only source evidence and anonymous visit context, never form answers or URLs with queries.
module.exports = {
  sessionId: { type: String, maxlength: 80 },
  source: { type: String, maxlength: 30 },
  sourceGroup: { type: String, enum: ["ai", "other"] },
  evidence: { type: String, enum: ["utm", "referrer", "unknown"] },
  landingPath: { type: String, maxlength: 300 },
  referrerHost: { type: String, maxlength: 253 },
};

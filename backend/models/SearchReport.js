const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  key: { type: String, required: true },
  report: { type: mongoose.Schema.Types.Mixed, required: true },
  fetchedAt: { type: Date, default: Date.now },
}, { timestamps: true });
schema.plugin(require('../tenancy/workspacePlugin'));
schema.index({ workspaceId: 1, key: 1 }, { unique: true });
module.exports = mongoose.model('SearchReport', schema);

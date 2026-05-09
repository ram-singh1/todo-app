const mongoose = require('mongoose');

const TOOL_KINDS = ['decision', 'cbt', 'worry', 'pros-cons', 'five-whys', 'eisenhower'];

// One generic schema for every problem-solving tool. Each kind defines its
// own payload shape (validated lightly at the route layer rather than via
// Mongoose enums so adding a new tool only touches the route + UI).
//
//  decision    → { options: [{name,score,notes}], criteria: [{name,weight}],
//                  scores: { [optionId]: { [criterionId]: number } }, winner }
//  cbt         → { situation, automaticThought, evidenceFor, evidenceAgainst,
//                  balancedThought, moodBefore, moodAfter, distortions: [] }
//  worry       → { worry, severity, reviewAt, outcome, didItHappen }
//  pros-cons   → { pros: [{text,weight}], cons: [{text,weight}], verdict }
//  five-whys   → { problem, whys: [string,string,string,string,string], rootCause }
//  eisenhower  → cached view, no payload needed (computed from todos)
const toolSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  kind: { type: String, enum: TOOL_KINDS, required: true },
  title: { type: String, required: true, trim: true, maxlength: 140 },
  payload: { type: mongoose.Schema.Types.Mixed, default: {} },
  // Worry log uses this — date when the user should review the worry.
  reviewAt: { type: Date },
  reviewSent: { type: Boolean, default: false },
  archived: { type: Boolean, default: false },
  deletedAt: { type: Date, default: null },
}, { timestamps: true });

toolSchema.index({ user: 1, kind: 1, createdAt: -1 });
toolSchema.index({ reviewAt: 1, reviewSent: 1 });

module.exports = mongoose.model('Tool', toolSchema);
module.exports.TOOL_KINDS = TOOL_KINDS;

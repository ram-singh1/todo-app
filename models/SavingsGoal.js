const mongoose = require('mongoose');

const contributionSchema = new mongoose.Schema({
  amount: { type: Number, required: true, min: 0 },
  date: { type: Date, default: Date.now },
  note: { type: String, maxlength: 120, trim: true },
}, { _id: true });

const goalSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  target: { type: Number, required: true, min: 1 },
  saved: { type: Number, default: 0, min: 0 },
  currency: { type: String, default: 'USD', maxlength: 4 },
  deadline: { type: Date },
  emoji: { type: String, default: '🎯', maxlength: 4 },
  color: { type: String, default: '#10B981' },
  contributions: { type: [contributionSchema], default: [] },
  // Optional auto-saving rule: cron deposits this much each month.
  monthlyAuto: { type: Number, default: 0, min: 0 },
  archived: { type: Boolean, default: false },
  deletedAt: { type: Date, default: null },
}, { timestamps: true });

goalSchema.index({ user: 1, archived: 1 });

module.exports = mongoose.model('SavingsGoal', goalSchema);

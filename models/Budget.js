const mongoose = require('mongoose');

// One budget document per user per month. `categoryLimits` is a flat map so
// users can set per-category caps without an extra collection. `month`
// stores `YYYY-MM` so date math stays string-comparable and timezone-safe.
const budgetSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  month: { type: String, required: true }, // 'YYYY-MM'
  totalLimit: { type: Number, default: 0, min: 0 },
  currency: { type: String, default: 'USD', maxlength: 4 },
  categoryLimits: { type: Map, of: Number, default: {} },
  // Percentage threshold (1-100) at which to alert. 80 = warn at 80%.
  alertThreshold: { type: Number, default: 80, min: 1, max: 100 },
  carryOver: { type: Boolean, default: false },
}, { timestamps: true });

budgetSchema.index({ user: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('Budget', budgetSchema);

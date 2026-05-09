const mongoose = require('mongoose');

const HEALTH_TYPES = ['water', 'sleep', 'weight', 'workout', 'steps', 'mood', 'meals', 'medication'];

// One row per measurement. dateKey is yyyy-mm-dd for timezone-safe daily
// rollups (mirrors the Habit model approach). `value` is numeric;
// `metadata` carries type-specific fields (e.g. workout.kind, sleep.quality).
const healthLogSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: HEALTH_TYPES, required: true },
  dateKey: { type: String, required: true },
  value: { type: Number, required: true },
  unit: { type: String, default: '', maxlength: 12 },
  note: { type: String, maxlength: 200, trim: true },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  deletedAt: { type: Date, default: null },
}, { timestamps: true });

healthLogSchema.index({ user: 1, type: 1, dateKey: -1 });
healthLogSchema.index({ user: 1, dateKey: -1 });

module.exports = mongoose.model('HealthLog', healthLogSchema);
module.exports.HEALTH_TYPES = HEALTH_TYPES;

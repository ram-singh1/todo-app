const mongoose = require('mongoose');

// Tracks both fixed bills (rent, internet) and SaaS subscriptions
// (Netflix, Spotify) — `kind` flips downstream UI. nextDueAt is rolled
// forward atomically when a bill is auto-logged so we never double-charge.
const recurringSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  amount: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'USD', maxlength: 4 },
  category: { type: String, default: 'bills', maxlength: 30 },
  kind: { type: String, enum: ['bill', 'subscription'], default: 'bill' },
  frequency: {
    type: String,
    enum: ['daily', 'weekly', 'monthly', 'yearly'],
    default: 'monthly',
  },
  // Used as anchor for monthly/yearly: 1..31 for monthly, 1..366 for yearly.
  // Weekly frequency uses dayOfWeek (0=Sun..6=Sat) instead.
  dayOfMonth: { type: Number, min: 1, max: 31 },
  dayOfWeek: { type: Number, min: 0, max: 6 },
  nextDueAt: { type: Date, required: true },
  reminderDaysBefore: { type: Number, default: 3, min: 0, max: 30 },
  // When true, the daily cron auto-creates an Expense on nextDueAt and
  // rolls the date forward. When false, we just notify and let the user log.
  autoLog: { type: Boolean, default: false },
  active: { type: Boolean, default: true },
  color: { type: String, default: '#6C63FF' },
  emoji: { type: String, default: '💸', maxlength: 4 },
  lastReminderAt: { type: Date },
  lastChargedAt: { type: Date },
  deletedAt: { type: Date, default: null },
}, { timestamps: true });

recurringSchema.index({ user: 1, active: 1, nextDueAt: 1 });
recurringSchema.index({ active: 1, nextDueAt: 1 });

module.exports = mongoose.model('RecurringBill', recurringSchema);

const mongoose = require('mongoose');

// Default categories ship with the app; users can also create custom ones
// (stored as free strings on this field, with their labels saved on the
// User doc so the picker can re-surface them).
const EXPENSE_CATEGORIES = [
  'food', 'transport', 'shopping', 'bills', 'entertainment',
  'health', 'education', 'travel', 'rent', 'subscriptions',
  'savings', 'gifts', 'investment', 'other',
];

const expenseSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  amount: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'USD', maxlength: 4 },
  // 'expense' (default) reduces balance; 'income' increases it. Letting
  // both share one collection keeps trend/cashflow aggregations one query.
  kind: { type: String, enum: ['expense', 'income'], default: 'expense' },
  // Free string (slug-style: lowercase, hyphens) to allow user-defined
  // categories. Validated server-side for length + character set.
  category: { type: String, default: 'other', maxlength: 32, lowercase: true, trim: true },
  date: { type: Date, default: Date.now, required: true },
  note: { type: String, trim: true, maxlength: 240 },
  receipt: {
    url: String,
    path: String,
    name: String,
  },
  // Tagging back to the recurring template that produced this entry, so
  // bulk-deleting a bill cleans up its auto-logged history.
  recurringSourceId: { type: mongoose.Schema.Types.ObjectId, ref: 'RecurringBill' },
  paymentMethod: { type: String, enum: ['cash', 'card', 'upi', 'bank', 'wallet', 'other'], default: 'card' },
  // Optional per-transaction overrides. When present, the UI renders these
  // instead of the category defaults — handy for one-off entries like a
  // birthday gift that should stand out from generic "Gifts".
  emoji: { type: String, maxlength: 4 },
  color: { type: String, maxlength: 9 },
  deletedAt: { type: Date, default: null, index: true },
}, { timestamps: true });

expenseSchema.index({ user: 1, date: -1 });
expenseSchema.index({ user: 1, category: 1, date: -1 });
expenseSchema.index({ user: 1, deletedAt: 1, date: -1 });

module.exports = mongoose.model('Expense', expenseSchema);
module.exports.EXPENSE_CATEGORIES = EXPENSE_CATEGORIES;

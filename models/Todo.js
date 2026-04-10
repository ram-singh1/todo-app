const mongoose = require('mongoose');

const subtaskSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  completed: { type: Boolean, default: false },
});

const todoSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  title: {
    type: String,
    required: [true, 'Task title is required'],
    trim: true,
    maxlength: 200,
  },
  description: {
    type: String,
    trim: true,
    maxlength: 1000,
  },
  category: {
    type: String,
    default: 'general',
    enum: ['general', 'work', 'personal', 'health', 'shopping', 'study', 'finance', 'travel', 'social', 'urgent'],
  },
  priority: {
    type: String,
    default: 'medium',
    enum: ['low', 'medium', 'high', 'critical'],
  },
  completed: {
    type: Boolean,
    default: false,
  },
  completedAt: {
    type: Date,
  },
  dueDate: {
    type: Date,
  },
  dueTime: {
    type: String,
  },
  tags: [{
    type: String,
    trim: true,
  }],
  subtasks: [subtaskSchema],
  reminder: {
    enabled: { type: Boolean, default: false },
    time: { type: Date },
    type: { type: String, enum: ['once', 'daily', 'weekly', 'custom'], default: 'once' },
    customDays: [{ type: Number }],
    sent: { type: Boolean, default: false },
    advanceMinutes: { type: Number, default: 15 },
  },
  recurring: {
    enabled: { type: Boolean, default: false },
    pattern: { type: String, enum: ['daily', 'weekly', 'monthly', 'yearly'], default: 'daily' },
    endDate: { type: Date },
  },
  notes: {
    type: String,
    maxlength: 2000,
  },
  emoji: {
    type: String,
    default: '📝',
  },
  color: {
    type: String,
    default: '#6C63FF',
  },
  aiGenerated: {
    type: Boolean,
    default: false,
  },
  aiSuggestions: {
    type: String,
  },
  order: {
    type: Number,
    default: 0,
  },
}, {
  timestamps: true,
});

todoSchema.index({ user: 1, completed: 1, dueDate: 1 });
todoSchema.index({ user: 1, category: 1 });
todoSchema.index({ 'reminder.enabled': 1, 'reminder.time': 1, 'reminder.sent': 1 });

module.exports = mongoose.model('Todo', todoSchema);

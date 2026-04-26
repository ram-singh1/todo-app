const mongoose = require('mongoose');

const subtaskSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  completed: { type: Boolean, default: false },
});

const attachmentSchema = new mongoose.Schema({
  // kind distinguishes images from other files for UI treatment (thumbnail vs icon).
  kind: { type: String, enum: ['image', 'file'], required: true },
  // Path relative to the uploads dir; served at /uploads/<path>.
  path: { type: String, required: true },
  url: { type: String, required: true },
  name: { type: String, required: true },
  mimeType: { type: String },
  size: { type: Number },
  uploadedAt: { type: Date, default: Date.now },
}, { _id: true });

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
    pattern: { type: String, enum: ['daily', 'weekly', 'monthly', 'yearly', 'custom'], default: 'daily' },
    // For pattern='custom': repeat every N days. For 'weekly' it acts as
    // an extra multiplier so users can do "every 2 weeks" if needed.
    interval: { type: Number, default: 1, min: 1, max: 365 },
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
  attachments: {
    type: [attachmentSchema],
    default: [],
    validate: [
      (arr) => arr.length <= 10,
      'A task can have at most 10 attachments',
    ],
  },
}, {
  timestamps: true,
});

todoSchema.index({ user: 1, completed: 1, dueDate: 1 });
todoSchema.index({ user: 1, category: 1 });
todoSchema.index({ 'reminder.enabled': 1, 'reminder.time': 1, 'reminder.sent': 1 });

module.exports = mongoose.model('Todo', todoSchema);

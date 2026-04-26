const mongoose = require('mongoose');

// One habit per user. `checkIns` stores ISO yyyy-mm-dd date strings (not Date
// objects) so a check-in is unambiguously "this calendar day in the user's
// timezone". The client passes the date it wants to record/clear.
const habitSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  name: {
    type: String,
    required: [true, 'Habit name is required'],
    trim: true,
    maxlength: 80,
  },
  description: {
    type: String,
    trim: true,
    maxlength: 240,
  },
  emoji: {
    type: String,
    default: '🎯',
    maxlength: 4,
  },
  color: {
    type: String,
    default: '#10B981',
  },
  frequency: {
    type: String,
    enum: ['daily', 'weekly'],
    default: 'daily',
  },
  // For weekly habits: which weekdays count (0=Sun..6=Sat). Empty = any day.
  weekDays: [{ type: Number, min: 0, max: 6 }],
  // Target check-ins per week — used to render progress on weekly habits.
  weeklyTarget: {
    type: Number,
    default: 7,
    min: 1,
    max: 7,
  },
  reminder: {
    enabled: { type: Boolean, default: false },
    type: { type: String, enum: ['daily', 'interval'], default: 'daily' },
    dailyHour: { type: Number, default: 8 },
    intervalMinutes: { type: Number, default: 60 },
    voice: { type: Boolean, default: false },
  },
  // Each check-in is a date string yyyy-mm-dd. We dedupe in handlers so
  // multiple check-ins on the same day collapse to one.
  checkIns: [{ type: String }],
  archived: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
}, {
  timestamps: true,
});

habitSchema.index({ user: 1, archived: 1 });

// Compute current/longest streak from sorted check-in dates. We treat an
// unbroken run of consecutive days ending at "today or yesterday" as the
// current streak — yesterday counts so the user doesn't lose their streak
// before their evening check-in window.
habitSchema.methods.computeStreak = function () {
  if (!this.checkIns || this.checkIns.length === 0) {
    return { current: 0, longest: 0, lastCheckIn: null };
  }
  const sorted = [...new Set(this.checkIns)].sort(); // ascending
  const dayMs = 86400000;

  // Build set for O(1) lookup
  const set = new Set(sorted);

  // Longest streak: walk sorted list
  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1]).getTime();
    const cur = new Date(sorted[i]).getTime();
    if (cur - prev === dayMs) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 1;
    }
  }

  // Current streak: walk back from today/yesterday
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayKey = today.toISOString().slice(0, 10);
  const yesterday = new Date(today.getTime() - dayMs);
  const yesterdayKey = yesterday.toISOString().slice(0, 10);

  let cursorKey = set.has(todayKey) ? todayKey : (set.has(yesterdayKey) ? yesterdayKey : null);
  let current = 0;
  while (cursorKey && set.has(cursorKey)) {
    current += 1;
    const prev = new Date(new Date(cursorKey).getTime() - dayMs);
    cursorKey = prev.toISOString().slice(0, 10);
  }

  return {
    current,
    longest,
    lastCheckIn: sorted[sorted.length - 1],
  };
};

module.exports = mongoose.model('Habit', habitSchema);

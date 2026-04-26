const express = require('express');
const { body, validationResult } = require('express-validator');
const Habit = require('../models/Habit');
const { protect } = require('../middleware/auth');
const { getLimitsForPlan } = require('../middleware/premium');

const router = express.Router();
router.use(protect);

// Helper: keep yyyy-mm-dd date strings (not Date objects) so timezone-edge
// edits round-trip cleanly between client and server.
function normalizeDate(input) {
  if (!input) return new Date().toISOString().slice(0, 10);
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  return new Date(input).toISOString().slice(0, 10);
}

// @route   GET /api/habits
// Returns active habits with computed streak so the list view can render
// without a second round-trip per habit.
router.get('/', async (req, res) => {
  try {
    const { archived } = req.query;
    const filter = { user: req.user._id };
    if (archived !== undefined) filter.archived = archived === 'true';
    else filter.archived = false;

    const habits = await Habit.find(filter).sort({ order: 1, createdAt: 1 });
    const enriched = habits.map((h) => ({
      ...h.toObject(),
      streak: h.computeStreak(),
    }));

    res.json({ success: true, habits: enriched });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route   GET /api/habits/stats
// Aggregate dashboard numbers: total active, streak king, today's completions.
router.get('/stats', async (req, res) => {
  try {
    const habits = await Habit.find({ user: req.user._id, archived: false });
    const today = new Date().toISOString().slice(0, 10);
    let doneToday = 0;
    let bestStreak = 0;
    for (const h of habits) {
      const s = h.computeStreak();
      if (s.current > bestStreak) bestStreak = s.current;
      if (h.checkIns.includes(today)) doneToday += 1;
    }
    res.json({
      success: true,
      stats: {
        total: habits.length,
        doneToday,
        bestStreak,
        completionRate: habits.length > 0 ? Math.round((doneToday / habits.length) * 100) : 0,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route   GET /api/habits/:id
router.get('/:id', async (req, res) => {
  try {
    const habit = await Habit.findOne({ _id: req.params.id, user: req.user._id });
    if (!habit) return res.status(404).json({ success: false, message: 'Habit not found' });
    res.json({
      success: true,
      habit: { ...habit.toObject(), streak: habit.computeStreak() },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route   POST /api/habits
router.post(
  '/',
  [
    body('name').trim().notEmpty().withMessage('Name is required').isLength({ max: 80 }),
    body('frequency').optional().isIn(['daily', 'weekly']),
    body('weeklyTarget').optional().isInt({ min: 1, max: 7 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    try {
      // Free-tier habit cap. Pro/Trial/Ultimate get unlimited.
      const limits = getLimitsForPlan(req.user.subscription?.plan || 'free');
      if (Number.isFinite(limits.maxHabits)) {
        const existing = await Habit.countDocuments({ user: req.user._id, archived: false });
        if (existing >= limits.maxHabits) {
          return res.status(402).json({
            success: false,
            code: 'PREMIUM_REQUIRED',
            message: `Free plan allows up to ${limits.maxHabits} habits. Upgrade for unlimited.`,
            upgradeUrl: '/upgrade',
          });
        }
      }

      const habit = await Habit.create({ ...req.body, user: req.user._id });
      res.status(201).json({
        success: true,
        habit: { ...habit.toObject(), streak: habit.computeStreak() },
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// @route   PUT /api/habits/:id
router.put('/:id', async (req, res) => {
  try {
    // Disallow direct mutation of checkIns from a generic update — use
    // /checkin endpoints so we can dedupe, validate dates, and keep semantics.
    const { checkIns, user, _id, ...updates } = req.body;
    const habit = await Habit.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      updates,
      { new: true, runValidators: true },
    );
    if (!habit) return res.status(404).json({ success: false, message: 'Habit not found' });
    res.json({
      success: true,
      habit: { ...habit.toObject(), streak: habit.computeStreak() },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route   POST /api/habits/:id/checkin
// Body: { date?: 'yyyy-mm-dd' } — defaults to today. Idempotent: re-checking
// the same day is a no-op.
router.post('/:id/checkin', async (req, res) => {
  try {
    const date = normalizeDate(req.body?.date);
    const habit = await Habit.findOne({ _id: req.params.id, user: req.user._id });
    if (!habit) return res.status(404).json({ success: false, message: 'Habit not found' });

    if (!habit.checkIns.includes(date)) {
      habit.checkIns.push(date);
      await habit.save();
    }

    res.json({
      success: true,
      habit: { ...habit.toObject(), streak: habit.computeStreak() },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route   DELETE /api/habits/:id/checkin
// Body: { date: 'yyyy-mm-dd' } — removes that day's check-in.
router.delete('/:id/checkin', async (req, res) => {
  try {
    const date = normalizeDate(req.body?.date);
    const habit = await Habit.findOne({ _id: req.params.id, user: req.user._id });
    if (!habit) return res.status(404).json({ success: false, message: 'Habit not found' });

    habit.checkIns = habit.checkIns.filter((d) => d !== date);
    await habit.save();

    res.json({
      success: true,
      habit: { ...habit.toObject(), streak: habit.computeStreak() },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route   DELETE /api/habits/:id
router.delete('/:id', async (req, res) => {
  try {
    const result = await Habit.deleteOne({ _id: req.params.id, user: req.user._id });
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: 'Habit not found' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;

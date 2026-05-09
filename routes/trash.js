const express = require('express');
const Todo = require('../models/Todo');
const Diary = require('../models/Diary');
const Expense = require('../models/Expense');
const Tool = require('../models/Tool');
const Habit = require('../models/Habit');
const { protect } = require('../middleware/auth');

const router = express.Router();
router.use(protect);

const TRASH_TTL_DAYS = 30;

// GET /api/trash  — items soft-deleted in the last 30 days
router.get('/', async (req, res) => {
  try {
    const since = new Date(Date.now() - TRASH_TTL_DAYS * 86400000);
    const [todos, diaries, expenses, tools, habits] = await Promise.all([
      Todo.find({ user: req.user._id, deletedAt: { $gte: since, $ne: null } })
        .sort({ deletedAt: -1 }).limit(100).select('title category emoji color deletedAt'),
      Diary.find({ user: req.user._id, deletedAt: { $gte: since, $ne: null } })
        .sort({ deletedAt: -1 }).limit(100).select('title mood deletedAt'),
      Expense.find({ user: req.user._id, deletedAt: { $gte: since, $ne: null } })
        .sort({ deletedAt: -1 }).limit(100).select('amount category note kind deletedAt'),
      Tool.find({ user: req.user._id, deletedAt: { $gte: since, $ne: null } })
        .sort({ deletedAt: -1 }).limit(100).select('title kind deletedAt'),
      Habit.find({ user: req.user._id, deletedAt: { $gte: since, $ne: null } })
        .sort({ deletedAt: -1 }).limit(100).select('name emoji color deletedAt'),
    ]);
    res.json({
      success: true,
      ttlDays: TRASH_TTL_DAYS,
      items: {
        todos, diaries, expenses, tools, habits,
        total: todos.length + diaries.length + expenses.length + tools.length + habits.length,
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not load trash' });
  }
});

const MODELS = { todos: Todo, diaries: Diary, expenses: Expense, tools: Tool, habits: Habit };

// POST /api/trash/:type/:id/restore
router.post('/:type/:id/restore', async (req, res) => {
  const Model = MODELS[req.params.type];
  if (!Model) return res.status(400).json({ success: false, message: 'Bad type' });
  try {
    const doc = await Model.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { $set: { deletedAt: null } },
      { new: true }
    );
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not restore' });
  }
});

// DELETE /api/trash/:type/:id  — permanently remove
router.delete('/:type/:id', async (req, res) => {
  const Model = MODELS[req.params.type];
  if (!Model) return res.status(400).json({ success: false, message: 'Bad type' });
  try {
    await Model.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not delete' });
  }
});

// DELETE /api/trash  — empty trash
router.delete('/', async (req, res) => {
  try {
    await Promise.all(
      Object.values(MODELS).map((M) =>
        M.deleteMany({ user: req.user._id, deletedAt: { $ne: null } })
      )
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not empty trash' });
  }
});

module.exports = router;
module.exports.TRASH_TTL_DAYS = TRASH_TTL_DAYS;

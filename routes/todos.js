const express = require('express');
const { body, validationResult } = require('express-validator');
const Todo = require('../models/Todo');
const { protect } = require('../middleware/auth');
const { getLimitsForPlan } = require('../middleware/premium');

const router = express.Router();
router.use(protect);

// @route   GET /api/todos
router.get('/', async (req, res) => {
  try {
    const {
      category, priority, completed, search,
      sortBy = 'createdAt', order = 'desc',
      page = 1, limit = 50,
    } = req.query;

    const filter = { user: req.user._id };
    if (category) filter.category = category;
    if (priority) filter.priority = priority;
    if (completed !== undefined) filter.completed = completed === 'true';
    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { tags: { $regex: search, $options: 'i' } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sortOrder = order === 'asc' ? 1 : -1;

    const [todos, total] = await Promise.all([
      Todo.find(filter)
        .sort({ [sortBy]: sortOrder })
        .skip(skip)
        .limit(parseInt(limit)),
      Todo.countDocuments(filter),
    ]);

    res.json({
      success: true,
      todos,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   GET /api/todos/stats
router.get('/stats', async (req, res) => {
  try {
    const userId = req.user._id;
    const [total, completed, pending, overdue, byCategory, byPriority] = await Promise.all([
      Todo.countDocuments({ user: userId }),
      Todo.countDocuments({ user: userId, completed: true }),
      Todo.countDocuments({ user: userId, completed: false }),
      Todo.countDocuments({ user: userId, completed: false, dueDate: { $lt: new Date() } }),
      Todo.aggregate([
        { $match: { user: userId } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
      ]),
      Todo.aggregate([
        { $match: { user: userId } },
        { $group: { _id: '$priority', count: { $sum: 1 } } },
      ]),
    ]);

    res.json({
      success: true,
      stats: {
        total, completed, pending, overdue,
        completionRate: total > 0 ? Math.round((completed / total) * 100) : 0,
        byCategory: byCategory.reduce((acc, c) => ({ ...acc, [c._id]: c.count }), {}),
        byPriority: byPriority.reduce((acc, p) => ({ ...acc, [p._id]: p.count }), {}),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   POST /api/todos
router.post('/', [
  body('title').trim().notEmpty().withMessage('Title is required').isLength({ max: 200 }),
  body('category').optional().isIn(['general', 'work', 'personal', 'health', 'shopping', 'study', 'finance', 'travel', 'social', 'urgent']),
  body('priority').optional().isIn(['low', 'medium', 'high', 'critical']),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const limits = getLimitsForPlan(req.user.subscription?.plan || 'free');
    if (limits.maxTodos !== Infinity) {
      const count = await Todo.countDocuments({ user: req.user._id });
      if (count >= limits.maxTodos) {
        return res.status(402).json({
          success: false,
          code: 'TODO_LIMIT_REACHED',
          message: `Free plan allows ${limits.maxTodos} tasks. Upgrade for unlimited tasks.`,
        });
      }
    }

    const todoData = { ...req.body, user: req.user._id };
    const todo = await Todo.create(todoData);
    res.status(201).json({ success: true, todo });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Compute the next due date for a recurring todo. Returns null if the
// recurrence has hit its end date (caller should NOT spawn another instance).
function nextDueDate(todo) {
  const r = todo.recurring || {};
  const interval = Math.max(1, r.interval || 1);
  const base = todo.dueDate ? new Date(todo.dueDate) : new Date();
  let next;
  switch (r.pattern) {
    case 'daily':   next = new Date(base.getTime() + interval * 86400000); break;
    case 'weekly':  next = new Date(base.getTime() + interval * 7 * 86400000); break;
    case 'monthly': next = new Date(base); next.setMonth(next.getMonth() + interval); break;
    case 'yearly':  next = new Date(base); next.setFullYear(next.getFullYear() + interval); break;
    case 'custom':  next = new Date(base.getTime() + interval * 86400000); break;
    default:        return null;
  }
  if (r.endDate && next > new Date(r.endDate)) return null;
  return next;
}

// @route   PUT /api/todos/:id
router.put('/:id', async (req, res) => {
  try {
    let todo = await Todo.findOne({ _id: req.params.id, user: req.user._id });
    if (!todo) {
      return res.status(404).json({ success: false, message: 'Todo not found' });
    }

    const wasCompleting = req.body.completed && !todo.completed;
    if (wasCompleting) {
      req.body.completedAt = new Date();
    }
    if (req.body.completed === false) {
      req.body.completedAt = null;
    }

    todo = await Todo.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });

    // Auto-spawn next occurrence on completion of a recurring task.
    // We create a fresh, uncompleted clone with the next due date — keeps
    // history intact (the completed one stays as a record) and the new one
    // shows up in the user's list immediately.
    let spawned = null;
    if (wasCompleting && todo.recurring?.enabled) {
      const next = nextDueDate(todo);
      if (next) {
        const clone = todo.toObject();
        delete clone._id;
        delete clone.createdAt;
        delete clone.updatedAt;
        clone.completed = false;
        clone.completedAt = null;
        clone.dueDate = next;
        // Reset reminder.sent so notifications re-fire for the new instance.
        if (clone.reminder?.enabled && clone.reminder?.time) {
          // Shift the reminder by the same delta the due date moved.
          const delta = next.getTime() - new Date(todo.dueDate || next).getTime();
          clone.reminder = {
            ...clone.reminder,
            time: new Date(new Date(clone.reminder.time).getTime() + delta),
            sent: false,
          };
        }
        clone.subtasks = (clone.subtasks || []).map((s) => ({ title: s.title, completed: false }));
        spawned = await Todo.create(clone);
      }
    }

    res.json({ success: true, todo, spawned });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   DELETE /api/todos/:id
router.delete('/:id', async (req, res) => {
  try {
    const todo = await Todo.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    if (!todo) {
      return res.status(404).json({ success: false, message: 'Todo not found' });
    }
    res.json({ success: true, message: 'Todo deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   PUT /api/todos/:id/subtask
router.put('/:id/subtask', [
  body('title').trim().notEmpty().withMessage('Subtask title is required'),
], async (req, res) => {
  try {
    const todo = await Todo.findOne({ _id: req.params.id, user: req.user._id });
    if (!todo) {
      return res.status(404).json({ success: false, message: 'Todo not found' });
    }

    todo.subtasks.push({ title: req.body.title });
    await todo.save();
    res.json({ success: true, todo });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   PUT /api/todos/:id/subtask/:subtaskId/toggle
router.put('/:id/subtask/:subtaskId/toggle', async (req, res) => {
  try {
    const todo = await Todo.findOne({ _id: req.params.id, user: req.user._id });
    if (!todo) {
      return res.status(404).json({ success: false, message: 'Todo not found' });
    }

    const subtask = todo.subtasks.id(req.params.subtaskId);
    if (!subtask) {
      return res.status(404).json({ success: false, message: 'Subtask not found' });
    }

    subtask.completed = !subtask.completed;
    await todo.save();
    res.json({ success: true, todo });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   DELETE /api/todos/completed/clear
router.delete('/completed/clear', async (req, res) => {
  try {
    const result = await Todo.deleteMany({ user: req.user._id, completed: true });
    res.json({ success: true, deleted: result.deletedCount });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   POST /api/todos/reorder
// Body: { ids: [todoId, ...] } — array in the new desired order.
// We assign `order` = index so a sort by `order` ASC produces the same
// list on the next fetch. Bulk write keeps it to one round-trip.
router.post('/reorder', async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: 'ids array required' });
    }
    const ops = ids.map((id, i) => ({
      updateOne: {
        // Scope by user so a malicious payload can't reorder another
        // person's tasks.
        filter: { _id: id, user: req.user._id },
        update: { order: i },
      },
    }));
    const result = await Todo.bulkWrite(ops);
    res.json({ success: true, modified: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;

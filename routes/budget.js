const express = require('express');
const { body, validationResult } = require('express-validator');
const mongoose = require('mongoose');
const Expense = require('../models/Expense');
const Budget = require('../models/Budget');
const RecurringBill = require('../models/RecurringBill');
const SavingsGoal = require('../models/SavingsGoal');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const { requirePremium } = require('../middleware/premium');

const router = express.Router();
router.use(protect);

const { EXPENSE_CATEGORIES } = Expense;
const oid = (v) => new mongoose.Types.ObjectId(v);

// Slug-style validator: lowercase letters, digits, hyphen, underscore.
// Lets users have their own categories without inviting weird display strings.
const CATEGORY_SLUG_RE = /^[a-z0-9_-]{1,32}$/;

function monthKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}
function monthRange(key) {
  const [y, m] = key.split('-').map(Number);
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 1);
  return { start, end };
}

// ─── EXPENSES ───────────────────────────────────────────────

// GET /api/budget/expenses?month=YYYY-MM&category=&kind=&search=
router.get('/expenses', async (req, res) => {
  try {
    const { month, category, kind, search, from, to, limit = 200 } = req.query;
    const q = { user: req.user._id, deletedAt: null };
    if (month) {
      const { start, end } = monthRange(month);
      q.date = { $gte: start, $lt: end };
    } else if (from || to) {
      q.date = {};
      if (from) q.date.$gte = new Date(from);
      if (to) q.date.$lte = new Date(to);
    }
    if (category) q.category = category;
    if (kind) q.kind = kind;
    if (search) q.note = { $regex: search, $options: 'i' };

    const expenses = await Expense.find(q)
      .sort({ date: -1, createdAt: -1 })
      .limit(Math.min(parseInt(limit, 10) || 200, 1000));

    res.json({ success: true, expenses });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not load expenses' });
  }
});

// POST /api/budget/expenses
router.post('/expenses', [
  body('amount').isFloat({ min: 0.01 }),
  // Accept any slug (built-in or user-defined). Format-checked rather than
  // enum-locked so users can create their own categories.
  body('category').optional().matches(CATEGORY_SLUG_RE)
    .withMessage('category must be lowercase letters, digits, - or _'),
  body('kind').optional().isIn(['expense', 'income']),
  body('note').optional().isString().isLength({ max: 240 }),
  body('paymentMethod').optional().isIn(['cash', 'card', 'upi', 'bank', 'wallet', 'other']),
  body('currency').optional().isString().isLength({ min: 1, max: 4 }),
  body('emoji').optional().isString().isLength({ max: 4 }),
  body('color').optional().isString().matches(/^#[0-9A-Fa-f]{3,8}$/),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const exp = await Expense.create({ ...req.body, user: req.user._id });
    res.status(201).json({ success: true, expense: exp });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not save expense' });
  }
});

// PUT /api/budget/expenses/:id
router.put('/expenses/:id', async (req, res) => {
  try {
    const exp = await Expense.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id, deletedAt: null },
      { $set: req.body },
      { new: true }
    );
    if (!exp) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, expense: exp });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not update' });
  }
});

// DELETE /api/budget/expenses/:id (soft)
router.delete('/expenses/:id', async (req, res) => {
  try {
    const exp = await Expense.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id, deletedAt: null },
      { $set: { deletedAt: new Date() } },
      { new: true }
    );
    if (!exp) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not delete' });
  }
});

// ─── BUDGETS (per-month limits) ─────────────────────────────

// GET /api/budget/budgets?month=YYYY-MM
router.get('/budgets', async (req, res) => {
  try {
    const month = req.query.month || monthKey();
    const budget = await Budget.findOne({ user: req.user._id, month })
      || { user: req.user._id, month, totalLimit: 0, categoryLimits: {}, alertThreshold: 80 };
    res.json({ success: true, budget });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not load budget' });
  }
});

// PUT /api/budget/budgets — upsert for a given month
router.put('/budgets', [
  body('month').matches(/^\d{4}-\d{2}$/),
  body('totalLimit').optional().isFloat({ min: 0 }),
  body('alertThreshold').optional().isInt({ min: 1, max: 100 }),
  body('categoryLimits').optional().isObject(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const { month, totalLimit, alertThreshold, categoryLimits, currency, carryOver } = req.body;
    const update = {};
    if (totalLimit !== undefined) update.totalLimit = totalLimit;
    if (alertThreshold !== undefined) update.alertThreshold = alertThreshold;
    if (categoryLimits !== undefined) update.categoryLimits = categoryLimits;
    if (currency !== undefined) update.currency = currency;
    if (carryOver !== undefined) update.carryOver = carryOver;

    const budget = await Budget.findOneAndUpdate(
      { user: req.user._id, month },
      { $set: update, $setOnInsert: { user: req.user._id, month } },
      { new: true, upsert: true }
    );
    res.json({ success: true, budget });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not save budget' });
  }
});

// ─── ANALYTICS ──────────────────────────────────────────────

// GET /api/budget/summary?month=YYYY-MM
router.get('/summary', async (req, res) => {
  try {
    const month = req.query.month || monthKey();
    const { start, end } = monthRange(month);

    const [agg, budget, recurring, goals] = await Promise.all([
      Expense.aggregate([
        { $match: { user: req.user._id, deletedAt: null, date: { $gte: start, $lt: end } } },
        {
          $group: {
            _id: '$kind',
            total: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        },
      ]),
      Budget.findOne({ user: req.user._id, month }),
      RecurringBill.find({ user: req.user._id, active: true, deletedAt: null })
        .sort({ nextDueAt: 1 })
        .limit(10),
      SavingsGoal.find({ user: req.user._id, archived: false, deletedAt: null }).limit(20),
    ]);

    const spend = agg.find((a) => a._id === 'expense')?.total || 0;
    const income = agg.find((a) => a._id === 'income')?.total || 0;
    const limit = budget?.totalLimit || 0;
    const remaining = Math.max(0, limit - spend);
    const overBudget = limit > 0 && spend > limit;
    const percentUsed = limit > 0 ? Math.min(999, Math.round((spend / limit) * 100)) : 0;
    const savingsRate = income > 0 ? Math.max(0, Math.round(((income - spend) / income) * 100)) : 0;

    // Bills falling in next 7 days
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + 7);
    const upcoming = recurring.filter((r) => r.nextDueAt && r.nextDueAt <= horizon);

    res.json({
      success: true,
      month,
      summary: {
        spend, income, balance: income - spend,
        limit, remaining, overBudget, percentUsed, savingsRate,
        budget: budget || null,
        upcomingBills: upcoming,
        goals,
        currency: budget?.currency || 'USD',
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not load summary' });
  }
});

// GET /api/budget/by-category?month=YYYY-MM
router.get('/by-category', async (req, res) => {
  try {
    const month = req.query.month || monthKey();
    const { start, end } = monthRange(month);
    const data = await Expense.aggregate([
      { $match: { user: req.user._id, deletedAt: null, kind: 'expense', date: { $gte: start, $lt: end } } },
      { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { total: -1 } },
    ]);
    res.json({
      success: true,
      month,
      categories: data.map((d) => ({ category: d._id, total: d.total, count: d.count })),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not load categories' });
  }
});

// GET /api/budget/trend?days=30
router.get('/trend', async (req, res) => {
  try {
    const days = Math.min(365, parseInt(req.query.days, 10) || 30);
    const since = new Date(Date.now() - days * 86400000);
    since.setHours(0, 0, 0, 0);

    const data = await Expense.aggregate([
      { $match: { user: req.user._id, deletedAt: null, date: { $gte: since } } },
      {
        $group: {
          _id: {
            d: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
            kind: '$kind',
          },
          total: { $sum: '$amount' },
        },
      },
      { $sort: { '_id.d': 1 } },
    ]);

    // Build dense series with zero-fills
    const seriesByDay = {};
    data.forEach((row) => {
      seriesByDay[row._id.d] = seriesByDay[row._id.d] || { date: row._id.d, expense: 0, income: 0 };
      seriesByDay[row._id.d][row._id.kind] = row.total;
    });

    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const dt = new Date();
      dt.setHours(0, 0, 0, 0);
      dt.setDate(dt.getDate() - i);
      const key = dt.toISOString().slice(0, 10);
      const row = seriesByDay[key] || { date: key, expense: 0, income: 0 };
      out.push(row);
    }
    res.json({ success: true, days, trend: out });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not load trend' });
  }
});

// GET /api/budget/cashflow?months=6  — last N months
router.get('/cashflow', async (req, res) => {
  try {
    const months = Math.min(24, parseInt(req.query.months, 10) || 6);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(1);
    start.setMonth(start.getMonth() - (months - 1));

    const rows = await Expense.aggregate([
      { $match: { user: req.user._id, deletedAt: null, date: { $gte: start } } },
      {
        $group: {
          _id: {
            m: { $dateToString: { format: '%Y-%m', date: '$date' } },
            kind: '$kind',
          },
          total: { $sum: '$amount' },
        },
      },
    ]);
    const byMonth = {};
    rows.forEach((r) => {
      byMonth[r._id.m] = byMonth[r._id.m] || { month: r._id.m, expense: 0, income: 0 };
      byMonth[r._id.m][r._id.kind] = r.total;
    });
    const out = [];
    for (let i = 0; i < months; i++) {
      const dt = new Date(start);
      dt.setMonth(start.getMonth() + i);
      const key = monthKey(dt);
      out.push(byMonth[key] || { month: key, expense: 0, income: 0 });
    }
    res.json({ success: true, cashflow: out });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not load cashflow' });
  }
});

// ─── RECURRING BILLS / SUBSCRIPTIONS ────────────────────────

router.get('/bills', async (req, res) => {
  try {
    const { kind } = req.query;
    const q = { user: req.user._id, deletedAt: null };
    if (kind) q.kind = kind;
    const bills = await RecurringBill.find(q).sort({ nextDueAt: 1 });

    // Total monthly burn for subscription summary widget
    const monthlyBurn = bills
      .filter((b) => b.active && b.kind === 'subscription')
      .reduce((s, b) => {
        if (b.frequency === 'monthly') return s + b.amount;
        if (b.frequency === 'yearly') return s + b.amount / 12;
        if (b.frequency === 'weekly') return s + (b.amount * 52) / 12;
        if (b.frequency === 'daily') return s + b.amount * 30;
        return s;
      }, 0);

    res.json({ success: true, bills, monthlyBurn });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not load bills' });
  }
});

router.post('/bills', [
  body('name').trim().notEmpty().isLength({ max: 80 }),
  body('amount').isFloat({ min: 0 }),
  body('frequency').optional().isIn(['daily', 'weekly', 'monthly', 'yearly']),
  body('nextDueAt').isISO8601(),
  body('kind').optional().isIn(['bill', 'subscription']),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const bill = await RecurringBill.create({ ...req.body, user: req.user._id });
    res.status(201).json({ success: true, bill });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not create bill' });
  }
});

router.put('/bills/:id', async (req, res) => {
  try {
    const bill = await RecurringBill.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id, deletedAt: null },
      { $set: req.body },
      { new: true }
    );
    if (!bill) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, bill });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not update' });
  }
});

router.delete('/bills/:id', async (req, res) => {
  try {
    await RecurringBill.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { $set: { deletedAt: new Date(), active: false } }
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not delete' });
  }
});

// POST /api/budget/bills/:id/log — manually log a bill payment now
router.post('/bills/:id/log', async (req, res) => {
  try {
    const bill = await RecurringBill.findOne({ _id: req.params.id, user: req.user._id, deletedAt: null });
    if (!bill) return res.status(404).json({ success: false, message: 'Not found' });
    const exp = await Expense.create({
      user: req.user._id,
      amount: bill.amount,
      currency: bill.currency,
      category: bill.category || 'bills',
      kind: 'expense',
      date: new Date(),
      note: `${bill.name}`,
      recurringSourceId: bill._id,
    });
    bill.lastChargedAt = new Date();
    bill.nextDueAt = advanceNextDue(bill.nextDueAt, bill.frequency);
    await bill.save();
    res.json({ success: true, expense: exp, bill });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not log payment' });
  }
});

function advanceNextDue(date, frequency) {
  const d = new Date(date);
  if (frequency === 'daily') d.setDate(d.getDate() + 1);
  else if (frequency === 'weekly') d.setDate(d.getDate() + 7);
  else if (frequency === 'yearly') d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

// ─── SAVINGS GOALS ──────────────────────────────────────────

router.get('/goals', async (req, res) => {
  try {
    const goals = await SavingsGoal.find({
      user: req.user._id, deletedAt: null,
    }).sort({ archived: 1, createdAt: -1 });
    res.json({ success: true, goals });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not load goals' });
  }
});

router.post('/goals', [
  body('name').trim().notEmpty().isLength({ max: 80 }),
  body('target').isFloat({ min: 1 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const goal = await SavingsGoal.create({ ...req.body, user: req.user._id });
    res.status(201).json({ success: true, goal });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not create goal' });
  }
});

router.post('/goals/:id/contribute', [
  body('amount').isFloat({ min: 0.01 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const goal = await SavingsGoal.findOne({ _id: req.params.id, user: req.user._id, deletedAt: null });
    if (!goal) return res.status(404).json({ success: false, message: 'Not found' });
    goal.contributions.push({ amount: req.body.amount, note: req.body.note });
    goal.saved = Math.min(goal.target * 1.5, goal.saved + req.body.amount);
    await goal.save();
    res.json({ success: true, goal });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not contribute' });
  }
});

router.put('/goals/:id', async (req, res) => {
  try {
    const goal = await SavingsGoal.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id, deletedAt: null },
      { $set: req.body },
      { new: true }
    );
    if (!goal) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, goal });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not update' });
  }
});

router.delete('/goals/:id', async (req, res) => {
  try {
    await SavingsGoal.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { $set: { deletedAt: new Date() } }
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not delete' });
  }
});

// ─── EXPORT (Premium) ───────────────────────────────────────
router.get('/export', requirePremium, async (req, res) => {
  try {
    const { from, to, format = 'csv' } = req.query;
    const q = { user: req.user._id, deletedAt: null };
    if (from || to) {
      q.date = {};
      if (from) q.date.$gte = new Date(from);
      if (to) q.date.$lte = new Date(to);
    }
    const expenses = await Expense.find(q).sort({ date: -1 });

    if (format === 'json') {
      return res.json({ success: true, expenses });
    }
    // CSV
    const header = 'Date,Kind,Category,Amount,Currency,Method,Note\n';
    const rows = expenses.map((e) => [
      e.date.toISOString().slice(0, 10),
      e.kind,
      e.category,
      e.amount,
      e.currency,
      e.paymentMethod,
      `"${(e.note || '').replace(/"/g, '""')}"`,
    ].join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="expenses.csv"');
    res.send(header + rows);
  } catch (e) {
    res.status(500).json({ success: false, message: 'Export failed' });
  }
});

// ─── CUSTOM CATEGORIES ──────────────────────────────────────

// GET /api/budget/categories  — built-in + user-defined
router.get('/categories', async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('customExpenseCategories');
    res.json({
      success: true,
      builtIn: EXPENSE_CATEGORIES,
      custom: user?.customExpenseCategories || [],
    });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not load categories' });
  }
});

// POST /api/budget/categories  — { label, emoji?, color? }
// Auto-derives the slug from the label (lowercase, hyphenated). If a slug
// would collide with a built-in or existing custom one, returns 409.
router.post('/categories', [
  body('label').trim().notEmpty().isLength({ max: 40 }),
  body('emoji').optional().isString().isLength({ max: 4 }),
  body('color').optional().isString().isLength({ max: 9 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const { label, emoji = '🔸', color = '#94A3B8' } = req.body;
    const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
    if (!id || !CATEGORY_SLUG_RE.test(id)) {
      return res.status(400).json({ success: false, message: 'Invalid label' });
    }
    if (EXPENSE_CATEGORIES.includes(id)) {
      return res.status(409).json({ success: false, message: 'That name is already a built-in category' });
    }
    const user = await User.findById(req.user._id);
    if ((user.customExpenseCategories || []).some((c) => c.id === id)) {
      return res.status(409).json({ success: false, message: 'You already have a category with that name' });
    }
    user.customExpenseCategories.push({ id, label, emoji, color });
    await user.save();
    res.status(201).json({ success: true, category: { id, label, emoji, color } });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not create category' });
  }
});

// DELETE /api/budget/categories/:id  — remove a custom one (built-ins can't be deleted)
router.delete('/categories/:id', async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const before = user.customExpenseCategories.length;
    user.customExpenseCategories = user.customExpenseCategories.filter((c) => c.id !== req.params.id);
    if (user.customExpenseCategories.length === before) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }
    await user.save();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not delete category' });
  }
});

module.exports = router;
module.exports.advanceNextDue = advanceNextDue;

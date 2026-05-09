const express = require('express');
const { body, validationResult } = require('express-validator');
const HealthLog = require('../models/HealthLog');
const { protect } = require('../middleware/auth');

const router = express.Router();
router.use(protect);

const { HEALTH_TYPES } = HealthLog;

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}
function dateKeyOf(d) {
  return new Date(d).toISOString().slice(0, 10);
}

// GET /api/health/summary  — today + 7-day rollup for each tracked type
router.get('/summary', async (req, res) => {
  try {
    const today = todayKey();
    const since = new Date();
    since.setDate(since.getDate() - 6);
    const sinceKey = dateKeyOf(since);

    const rows = await HealthLog.aggregate([
      { $match: { user: req.user._id, deletedAt: null, dateKey: { $gte: sinceKey } } },
      {
        $group: {
          _id: { type: '$type', dateKey: '$dateKey' },
          total: { $sum: '$value' },
          count: { $sum: 1 },
        },
      },
    ]);

    const byType = {};
    rows.forEach((r) => {
      const t = r._id.type;
      byType[t] = byType[t] || { type: t, total7d: 0, today: 0, days: {} };
      byType[t].days[r._id.dateKey] = r.total;
      byType[t].total7d += r.total;
      if (r._id.dateKey === today) byType[t].today = r.total;
    });

    res.json({ success: true, summary: { today, byType: Object.values(byType) } });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not load summary' });
  }
});

// GET /api/health?type=water&days=30
router.get('/', async (req, res) => {
  try {
    const { type, days = 30 } = req.query;
    const q = { user: req.user._id, deletedAt: null };
    if (type) q.type = type;
    if (days) {
      const since = new Date();
      since.setDate(since.getDate() - parseInt(days, 10));
      q.dateKey = { $gte: dateKeyOf(since) };
    }
    const logs = await HealthLog.find(q).sort({ dateKey: -1, createdAt: -1 });

    // Build dense daily series for charting
    const num = Math.min(365, parseInt(days, 10) || 30);
    const seriesMap = {};
    logs.forEach((l) => {
      seriesMap[l.dateKey] = (seriesMap[l.dateKey] || 0) + l.value;
    });
    const series = [];
    const today = new Date();
    for (let i = num - 1; i >= 0; i--) {
      const dt = new Date(today);
      dt.setDate(today.getDate() - i);
      const key = dateKeyOf(dt);
      series.push({ date: key, value: seriesMap[key] || 0 });
    }

    res.json({ success: true, logs, series });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not load logs' });
  }
});

// POST /api/health
router.post('/', [
  body('type').isIn(HEALTH_TYPES),
  body('value').isFloat(),
  body('dateKey').optional().matches(/^\d{4}-\d{2}-\d{2}$/),
  body('unit').optional().isString().isLength({ max: 12 }),
  body('note').optional().isString().isLength({ max: 200 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const log = await HealthLog.create({
      ...req.body,
      dateKey: req.body.dateKey || todayKey(),
      user: req.user._id,
    });
    res.status(201).json({ success: true, log });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not save log' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await HealthLog.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { $set: { deletedAt: new Date() } }
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not delete' });
  }
});

module.exports = router;

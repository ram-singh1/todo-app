const express = require('express');
const { body, validationResult } = require('express-validator');
const Tool = require('../models/Tool');
const { protect } = require('../middleware/auth');

const router = express.Router();
router.use(protect);

const { TOOL_KINDS } = Tool;

// GET /api/tools?kind=worry
router.get('/', async (req, res) => {
  try {
    const { kind, archived } = req.query;
    const q = { user: req.user._id, deletedAt: null };
    if (kind) q.kind = kind;
    if (archived !== undefined) q.archived = archived === 'true';
    const tools = await Tool.find(q).sort({ createdAt: -1 }).limit(200);
    res.json({ success: true, tools });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not load tools' });
  }
});

// GET /api/tools/:id
router.get('/:id', async (req, res) => {
  try {
    const tool = await Tool.findOne({ _id: req.params.id, user: req.user._id, deletedAt: null });
    if (!tool) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, tool });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not load tool' });
  }
});

// POST /api/tools
router.post('/', [
  body('kind').isIn(TOOL_KINDS),
  body('title').trim().notEmpty().isLength({ max: 140 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const tool = await Tool.create({ ...req.body, user: req.user._id });
    res.status(201).json({ success: true, tool });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not create tool' });
  }
});

// PUT /api/tools/:id
router.put('/:id', async (req, res) => {
  try {
    const tool = await Tool.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id, deletedAt: null },
      { $set: req.body },
      { new: true }
    );
    if (!tool) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, tool });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not update tool' });
  }
});

// DELETE /api/tools/:id
router.delete('/:id', async (req, res) => {
  try {
    await Tool.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { $set: { deletedAt: new Date() } }
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not delete' });
  }
});

// GET /api/tools/worry/due  — worries with reviewAt in the past
router.get('/worry/due', async (req, res) => {
  try {
    const now = new Date();
    const tools = await Tool.find({
      user: req.user._id, deletedAt: null, kind: 'worry',
      reviewAt: { $lte: now },
      'payload.didItHappen': { $exists: false },
    }).sort({ reviewAt: 1 });
    res.json({ success: true, due: tools });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not load worries' });
  }
});

module.exports = router;

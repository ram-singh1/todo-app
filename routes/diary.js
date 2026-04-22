const express = require('express');
const { body, validationResult } = require('express-validator');
const Diary = require('../models/Diary');
const { protect } = require('../middleware/auth');
const { encrypt, decrypt } = require('../utils/encryption');
const { getLimitsForPlan } = require('../middleware/premium');

const router = express.Router();
router.use(protect);

// @route   GET /api/diary
router.get('/', async (req, res) => {
  try {
    const {
      mood, search, favorite,
      startDate, endDate,
      sortBy = 'createdAt', order = 'desc',
      page = 1, limit = 20,
    } = req.query;

    const filter = { user: req.user._id };
    if (mood) filter.mood = mood;
    if (favorite === 'true') filter.isFavorite = true;
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }
    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { tags: { $regex: search, $options: 'i' } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sortOrder = order === 'asc' ? 1 : -1;

    const [entries, total] = await Promise.all([
      Diary.find(filter)
        .select('-content')
        .sort({ [sortBy]: sortOrder })
        .skip(skip)
        .limit(parseInt(limit)),
      Diary.countDocuments(filter),
    ]);

    res.json({
      success: true,
      entries,
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

// @route   GET /api/diary/stats
router.get('/stats', async (req, res) => {
  try {
    const userId = req.user._id;
    const [total, favorites, moodStats] = await Promise.all([
      Diary.countDocuments({ user: userId }),
      Diary.countDocuments({ user: userId, isFavorite: true }),
      Diary.aggregate([
        { $match: { user: userId } },
        { $group: { _id: '$mood', count: { $sum: 1 } } },
      ]),
    ]);

    // Calculate streak
    const recentEntries = await Diary.find({ user: userId })
      .select('createdAt')
      .sort({ createdAt: -1 })
      .limit(365);

    let streak = 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = 0; i < 365; i++) {
      const checkDate = new Date(today);
      checkDate.setDate(checkDate.getDate() - i);
      const hasEntry = recentEntries.some(e => {
        const entryDate = new Date(e.createdAt);
        entryDate.setHours(0, 0, 0, 0);
        return entryDate.getTime() === checkDate.getTime();
      });
      if (hasEntry) streak++;
      else if (i > 0) break;
    }

    res.json({
      success: true,
      stats: {
        total,
        favorites,
        streak,
        moods: moodStats.reduce((acc, m) => ({ ...acc, [m._id]: m.count }), {}),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   GET /api/diary/:id
router.get('/:id', async (req, res) => {
  try {
    const entry = await Diary.findOne({ _id: req.params.id, user: req.user._id });
    if (!entry) {
      return res.status(404).json({ success: false, message: 'Entry not found' });
    }

    const entryObj = entry.toObject();
    if (entry.isEncrypted && entry.content) {
      try {
        entryObj.content = decrypt(entry.content);
      } catch {
        entryObj.content = entry.content;
      }
    }

    res.json({ success: true, entry: entryObj });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   POST /api/diary
router.post('/', [
  body('title').trim().notEmpty().withMessage('Title is required').isLength({ max: 200 }),
  body('content').notEmpty().withMessage('Content is required'),
  body('mood').optional().isIn(['amazing', 'happy', 'neutral', 'sad', 'angry', 'anxious', 'excited', 'grateful', 'tired', 'loved']),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const limits = getLimitsForPlan(req.user.subscription?.plan || 'free');
    if (limits.maxDiaryEntries !== Infinity) {
      const count = await Diary.countDocuments({ user: req.user._id });
      if (count >= limits.maxDiaryEntries) {
        return res.status(402).json({
          success: false,
          code: 'DIARY_LIMIT_REACHED',
          message: `Free plan allows ${limits.maxDiaryEntries} entries. Upgrade for unlimited journaling.`,
        });
      }
    }

    const diaryData = { ...req.body, user: req.user._id };

    const plainContent = diaryData.content;
    diaryData.wordCount = plainContent.split(/\s+/).filter(Boolean).length;
    diaryData.readingTime = Math.ceil(diaryData.wordCount / 200);

    if (diaryData.isEncrypted !== false) {
      diaryData.content = encrypt(plainContent);
      diaryData.isEncrypted = true;
    }

    const entry = await Diary.create(diaryData);
    const entryObj = entry.toObject();
    entryObj.content = plainContent;

    res.status(201).json({ success: true, entry: entryObj });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   PUT /api/diary/:id
router.put('/:id', async (req, res) => {
  try {
    let entry = await Diary.findOne({ _id: req.params.id, user: req.user._id });
    if (!entry) {
      return res.status(404).json({ success: false, message: 'Entry not found' });
    }

    const updates = { ...req.body };
    if (updates.content) {
      updates.wordCount = updates.content.split(/\s+/).filter(Boolean).length;
      updates.readingTime = Math.ceil(updates.wordCount / 200);
      if (entry.isEncrypted) {
        updates.content = encrypt(updates.content);
      }
    }

    entry = await Diary.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
    const entryObj = entry.toObject();
    if (entry.isEncrypted && entry.content) {
      try {
        entryObj.content = decrypt(entry.content);
      } catch {
        entryObj.content = entry.content;
      }
    }

    res.json({ success: true, entry: entryObj });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   DELETE /api/diary/:id
router.delete('/:id', async (req, res) => {
  try {
    const entry = await Diary.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    if (!entry) {
      return res.status(404).json({ success: false, message: 'Entry not found' });
    }
    res.json({ success: true, message: 'Entry deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   PUT /api/diary/:id/favorite
router.put('/:id/favorite', async (req, res) => {
  try {
    const entry = await Diary.findOne({ _id: req.params.id, user: req.user._id });
    if (!entry) {
      return res.status(404).json({ success: false, message: 'Entry not found' });
    }

    entry.isFavorite = !entry.isFavorite;
    await entry.save();
    res.json({ success: true, entry });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;

const express = require('express');
const { protect } = require('../middleware/auth');
const { requirePremium } = require('../middleware/premium');
const Todo = require('../models/Todo');
const Diary = require('../models/Diary');

const router = express.Router();
router.use(protect);

// Lightweight dashboard available to all users
// @route   GET /api/analytics/summary
router.get('/summary', async (req, res) => {
  try {
    const userId = req.user._id;
    const [todoStats, diaryStats] = await Promise.all([
      Todo.aggregate([
        { $match: { user: userId } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            completed: { $sum: { $cond: ['$completed', 1, 0] } },
            overdue: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ['$completed', false] }, { $lt: ['$dueDate', new Date()] }] },
                  1, 0,
                ],
              },
            },
          },
        },
      ]),
      Diary.aggregate([
        { $match: { user: userId } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            favorites: { $sum: { $cond: ['$isFavorite', 1, 0] } },
            totalWords: { $sum: { $ifNull: ['$wordCount', 0] } },
          },
        },
      ]),
    ]);

    const t = todoStats[0] || { total: 0, completed: 0, overdue: 0 };
    const d = diaryStats[0] || { total: 0, favorites: 0, totalWords: 0 };
    const completionRate = t.total > 0 ? Math.round((t.completed / t.total) * 100) : 0;

    res.json({
      success: true,
      summary: {
        todos: { total: t.total, completed: t.completed, overdue: t.overdue, completionRate },
        diary: { total: d.total, favorites: d.favorites, totalWords: d.totalWords },
        streak: req.user.streak,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load summary' });
  }
});

// ── PREMIUM: advanced analytics ──

// @route   GET /api/analytics/productivity (Premium)
router.get('/productivity', requirePremium, async (req, res) => {
  try {
    const userId = req.user._id;
    const days = parseInt(req.query.days, 10) || 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const daily = await Todo.aggregate([
      { $match: { user: userId, completedAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$completedAt' } },
          completed: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const byCategory = await Todo.aggregate([
      { $match: { user: userId, completedAt: { $gte: since } } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    const byPriority = await Todo.aggregate([
      { $match: { user: userId, completedAt: { $gte: since } } },
      { $group: { _id: '$priority', count: { $sum: 1 } } },
    ]);

    const byHour = await Todo.aggregate([
      { $match: { user: userId, completedAt: { $gte: since } } },
      {
        $group: {
          _id: { $hour: '$completedAt' },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.json({
      success: true,
      days,
      productivity: {
        daily: daily.map(d => ({ date: d._id, completed: d.completed })),
        byCategory: byCategory.map(c => ({ category: c._id, count: c.count })),
        byPriority: byPriority.map(p => ({ priority: p._id, count: p.count })),
        byHour: byHour.map(h => ({ hour: h._id, count: h.count })),
        peakHour: byHour.length > 0
          ? byHour.reduce((a, b) => (a.count > b.count ? a : b))._id
          : null,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load productivity analytics' });
  }
});

// @route   GET /api/analytics/mood-trends (Premium)
router.get('/mood-trends', requirePremium, async (req, res) => {
  try {
    const userId = req.user._id;
    const days = parseInt(req.query.days, 10) || 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const trends = await Diary.aggregate([
      { $match: { user: userId, createdAt: { $gte: since } } },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            mood: '$mood',
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.date': 1 } },
    ]);

    const distribution = await Diary.aggregate([
      { $match: { user: userId, createdAt: { $gte: since } } },
      { $group: { _id: '$mood', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    const moodScore = {
      amazing: 5, excited: 4.5, happy: 4, loved: 4.5, grateful: 4,
      neutral: 3, tired: 2.5, anxious: 2, sad: 1.5, angry: 1,
    };

    let totalScore = 0, totalCount = 0;
    distribution.forEach(d => {
      totalScore += (moodScore[d._id] || 3) * d.count;
      totalCount += d.count;
    });
    const averageScore = totalCount > 0 ? (totalScore / totalCount).toFixed(2) : null;

    res.json({
      success: true,
      days,
      moodTrends: {
        byDay: trends.map(t => ({ date: t._id.date, mood: t._id.mood, count: t.count })),
        distribution: distribution.map(d => ({ mood: d._id, count: d.count })),
        averageScore,
        totalEntries: totalCount,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load mood trends' });
  }
});

// @route   GET /api/analytics/insights (Premium - rule-based insights)
router.get('/insights', requirePremium, async (req, res) => {
  try {
    const userId = req.user._id;
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [todos, diaries] = await Promise.all([
      Todo.find({ user: userId, createdAt: { $gte: since } }),
      Diary.find({ user: userId, createdAt: { $gte: since } }).select('-content'),
    ]);

    const completed = todos.filter(t => t.completed).length;
    const pending = todos.length - completed;
    const completionRate = todos.length > 0 ? Math.round((completed / todos.length) * 100) : 0;
    const avgWordsPerEntry = diaries.length > 0
      ? Math.round(diaries.reduce((s, d) => s + (d.wordCount || 0), 0) / diaries.length)
      : 0;

    const insights = [];
    if (completionRate >= 70) {
      insights.push({ emoji: '🏆', title: 'High Performer', description: `You've completed ${completionRate}% of your tasks this month. Outstanding!`, severity: 'positive' });
    } else if (completionRate < 30 && todos.length > 5) {
      insights.push({ emoji: '💪', title: 'Room to Grow', description: `Completion rate is ${completionRate}%. Try breaking tasks into smaller steps.`, severity: 'suggestion' });
    }
    if (diaries.length >= 15) {
      insights.push({ emoji: '📖', title: 'Consistent Journalist', description: `${diaries.length} entries in 30 days — great reflection habit.`, severity: 'positive' });
    } else if (diaries.length < 5 && diaries.length > 0) {
      insights.push({ emoji: '✍️', title: 'Journal More', description: `Only ${diaries.length} entries this month. Daily writing boosts clarity.`, severity: 'suggestion' });
    }
    if (avgWordsPerEntry > 300) {
      insights.push({ emoji: '📖', title: 'Deep Thinker', description: `Avg ${avgWordsPerEntry} words per entry — rich, thoughtful journaling.`, severity: 'positive' });
    }
    if (pending > 20) {
      insights.push({ emoji: '🎯', title: 'Prioritize', description: `You have ${pending} pending tasks. Sort them by urgency and pick the next small action.`, severity: 'warning' });
    }
    if (req.user.streak?.current >= 7) {
      insights.push({ emoji: '🔥', title: `${req.user.streak.current}-Day Streak`, description: 'You are on fire! Keep it up.', severity: 'positive' });
    }

    res.json({
      success: true,
      insights,
      stats: { completed, pending, completionRate, avgWordsPerEntry, diaryCount: diaries.length },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load insights' });
  }
});

// @route   POST /api/analytics/heartbeat (update streak)
router.post('/heartbeat', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const last = req.user.streak?.lastActiveDate
      ? new Date(req.user.streak.lastActiveDate)
      : null;
    if (last) last.setHours(0, 0, 0, 0);

    let current = req.user.streak?.current || 0;
    if (!last) {
      current = 1;
    } else {
      const diff = Math.floor((today - last) / (1000 * 60 * 60 * 24));
      if (diff === 0) {
        // same day — no change
      } else if (diff === 1) {
        current += 1;
      } else {
        current = 1;
      }
    }

    req.user.streak.current = current;
    req.user.streak.longest = Math.max(req.user.streak.longest || 0, current);
    req.user.streak.lastActiveDate = today;
    await req.user.save();

    res.json({ success: true, streak: req.user.streak });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update streak' });
  }
});

module.exports = router;

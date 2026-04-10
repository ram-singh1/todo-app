const express = require('express');
const { body, validationResult } = require('express-validator');
const { protect } = require('../middleware/auth');
const Todo = require('../models/Todo');
const Diary = require('../models/Diary');
const { decrypt } = require('../utils/encryption');

const router = express.Router();
router.use(protect);

// Helper: Call OpenAI (gracefully degrades if no API key)
async function callAI(messages, maxTokens = 500) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === 'your_openai_api_key_here') {
    return null; // Fallback mode
  }

  try {
    const { default: OpenAI } = await import('openai');
    const openai = new OpenAI({ apiKey });

    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages,
      max_tokens: maxTokens,
      temperature: 0.7,
    });

    return response.choices[0].message.content;
  } catch (err) {
    console.error('OpenAI error:', err.message);
    return null;
  }
}

// Fallback AI task generation
function generateFallbackTasks(goal) {
  const templates = {
    work: [
      { title: `Plan ${goal} strategy`, priority: 'high', emoji: '📋' },
      { title: `Research best practices for ${goal}`, priority: 'medium', emoji: '🔍' },
      { title: `Create outline for ${goal}`, priority: 'medium', emoji: '📝' },
      { title: `Execute ${goal} plan`, priority: 'high', emoji: '🚀' },
      { title: `Review and refine ${goal}`, priority: 'low', emoji: '✅' },
    ],
    health: [
      { title: `Set ${goal} daily targets`, priority: 'high', emoji: '🎯' },
      { title: `Track ${goal} progress`, priority: 'medium', emoji: '📊' },
      { title: `Research ${goal} tips`, priority: 'low', emoji: '💡' },
    ],
    default: [
      { title: `Break down ${goal} into steps`, priority: 'high', emoji: '📋' },
      { title: `Gather resources for ${goal}`, priority: 'medium', emoji: '📦' },
      { title: `Start working on ${goal}`, priority: 'high', emoji: '⚡' },
      { title: `Review ${goal} progress`, priority: 'medium', emoji: '🔄' },
      { title: `Complete ${goal}`, priority: 'high', emoji: '🏆' },
    ],
  };

  const lowerGoal = goal.toLowerCase();
  if (lowerGoal.includes('work') || lowerGoal.includes('project') || lowerGoal.includes('meeting')) {
    return templates.work;
  }
  if (lowerGoal.includes('health') || lowerGoal.includes('exercise') || lowerGoal.includes('diet')) {
    return templates.health;
  }
  return templates.default;
}

// @route   POST /api/ai/generate-tasks
router.post('/generate-tasks', [
  body('goal').trim().notEmpty().withMessage('Goal description is required'),
  body('category').optional(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { goal, category = 'general' } = req.body;

    const aiPrompt = [
      {
        role: 'system',
        content: `You are a productivity AI assistant. Generate actionable tasks to help accomplish a goal. Return a JSON array of tasks with fields: title, description, priority (low/medium/high/critical), category, emoji (single emoji), estimatedMinutes (number). Generate 3-7 tasks. Return ONLY valid JSON array.`,
      },
      {
        role: 'user',
        content: `Goal: "${goal}". Category: ${category}. Generate tasks to help me achieve this.`,
      },
    ];

    let tasks;
    const aiResponse = await callAI(aiPrompt, 800);

    if (aiResponse) {
      try {
        tasks = JSON.parse(aiResponse);
      } catch {
        tasks = generateFallbackTasks(goal);
      }
    } else {
      tasks = generateFallbackTasks(goal);
    }

    const createdTodos = [];
    for (const task of tasks) {
      const todo = await Todo.create({
        user: req.user._id,
        title: task.title,
        description: task.description || '',
        category: task.category || category,
        priority: task.priority || 'medium',
        emoji: task.emoji || '📝',
        aiGenerated: true,
        aiSuggestions: `AI generated for goal: "${goal}"`,
      });
      createdTodos.push(todo);
    }

    res.status(201).json({
      success: true,
      message: `Created ${createdTodos.length} tasks for your goal`,
      todos: createdTodos,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to generate tasks' });
  }
});

// @route   POST /api/ai/smart-suggest
router.post('/smart-suggest', async (req, res) => {
  try {
    const { context } = req.body;

    const [recentTodos, recentDiary] = await Promise.all([
      Todo.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(10).select('title category completed'),
      Diary.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(5).select('mood tags'),
    ]);

    const aiPrompt = [
      {
        role: 'system',
        content: `You are a smart productivity assistant. Based on the user's recent activity, suggest helpful tasks or insights. Return a JSON object with: suggestions (array of {title, reason, priority, emoji}), insight (string with a motivational or helpful observation). Return ONLY valid JSON.`,
      },
      {
        role: 'user',
        content: `Recent tasks: ${JSON.stringify(recentTodos.map(t => ({ title: t.title, category: t.category, done: t.completed })))}. Recent moods: ${JSON.stringify(recentDiary.map(d => d.mood))}. Context: ${context || 'general'}`,
      },
    ];

    const aiResponse = await callAI(aiPrompt, 600);

    if (aiResponse) {
      try {
        const parsed = JSON.parse(aiResponse);
        return res.json({ success: true, ...parsed });
      } catch {
        // Fallback
      }
    }

    const pendingCount = recentTodos.filter(t => !t.completed).length;
    res.json({
      success: true,
      suggestions: [
        { title: 'Review pending tasks', reason: `You have ${pendingCount} incomplete tasks`, priority: 'high', emoji: '📋' },
        { title: 'Write in your diary', reason: 'Journaling helps mental clarity', priority: 'medium', emoji: '📖' },
        { title: 'Take a short break', reason: 'Regular breaks improve productivity', priority: 'low', emoji: '☕' },
      ],
      insight: `You have ${pendingCount} pending tasks. Stay focused and tackle them one at a time! 💪`,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get suggestions' });
  }
});

// @route   POST /api/ai/analyze-diary
router.post('/analyze-diary', [
  body('entryId').notEmpty(),
], async (req, res) => {
  try {
    const entry = await Diary.findOne({ _id: req.body.entryId, user: req.user._id });
    if (!entry) {
      return res.status(404).json({ success: false, message: 'Entry not found' });
    }

    let content = entry.content;
    if (entry.isEncrypted) {
      try {
        content = decrypt(entry.content);
      } catch {
        return res.status(400).json({ success: false, message: 'Could not decrypt entry' });
      }
    }

    const aiPrompt = [
      {
        role: 'system',
        content: `You are an empathetic journal analysis AI. Analyze the diary entry and provide: sentiment (positive/negative/neutral/mixed), keywords (array of 5 key themes), summary (2-3 sentence summary), affirmation (a warm, encouraging message). Return ONLY valid JSON.`,
      },
      {
        role: 'user',
        content: `Analyze this diary entry: "${content.substring(0, 1000)}"`,
      },
    ];

    const aiResponse = await callAI(aiPrompt, 400);

    if (aiResponse) {
      try {
        const analysis = JSON.parse(aiResponse);
        entry.aiAnalysis = {
          sentiment: analysis.sentiment,
          keywords: analysis.keywords,
          summary: analysis.summary,
        };
        await entry.save();
        return res.json({ success: true, analysis });
      } catch {
        // Fallback
      }
    }

    const wordCount = content.split(/\s+/).length;
    const analysis = {
      sentiment: 'neutral',
      keywords: ['reflection', 'thoughts', 'daily', 'life', 'personal'],
      summary: `A ${wordCount}-word diary entry capturing your thoughts and experiences.`,
      affirmation: 'Every word you write is a step towards understanding yourself better. Keep writing! ✨',
    };

    res.json({ success: true, analysis });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to analyze entry' });
  }
});

// @route   POST /api/ai/prioritize
router.post('/prioritize', async (req, res) => {
  try {
    const pendingTodos = await Todo.find({
      user: req.user._id,
      completed: false,
    }).sort({ createdAt: -1 }).limit(20);

    if (pendingTodos.length === 0) {
      return res.json({ success: true, message: 'No pending tasks to prioritize', todos: [] });
    }

    const aiPrompt = [
      {
        role: 'system',
        content: `You are a productivity expert. Analyze these tasks and suggest an optimal order. Return a JSON object with: orderedIds (array of task IDs in suggested order), reasoning (brief explanation). Return ONLY valid JSON.`,
      },
      {
        role: 'user',
        content: `Prioritize these tasks: ${JSON.stringify(pendingTodos.map(t => ({
          id: t._id,
          title: t.title,
          priority: t.priority,
          category: t.category,
          dueDate: t.dueDate,
        })))}`,
      },
    ];

    const aiResponse = await callAI(aiPrompt, 400);

    if (aiResponse) {
      try {
        const result = JSON.parse(aiResponse);
        return res.json({ success: true, ...result, todos: pendingTodos });
      } catch {
        // Fallback
      }
    }

    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    const sorted = [...pendingTodos].sort((a, b) => {
      const pa = priorityOrder[a.priority] ?? 2;
      const pb = priorityOrder[b.priority] ?? 2;
      if (pa !== pb) return pa - pb;
      if (a.dueDate && b.dueDate) return new Date(a.dueDate) - new Date(b.dueDate);
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      return 0;
    });

    res.json({
      success: true,
      orderedIds: sorted.map(t => t._id),
      reasoning: 'Prioritized by urgency level and due dates',
      todos: sorted,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to prioritize tasks' });
  }
});

module.exports = router;

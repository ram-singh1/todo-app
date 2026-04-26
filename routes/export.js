const express = require('express');
const { query, validationResult } = require('express-validator');
const { protect } = require('../middleware/auth');
const { requirePremium, checkExportQuota } = require('../middleware/premium');
const Todo = require('../models/Todo');
const Diary = require('../models/Diary');
const Habit = require('../models/Habit');
const { encrypt, decrypt } = require('../utils/encryption');

const router = express.Router();
router.use(protect);
router.use(requirePremium);

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// @route   GET /api/export/diary (markdown)
router.get('/diary', checkExportQuota, [
  query('format').optional().isIn(['markdown', 'html', 'json']),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const format = req.query.format || 'markdown';
    const entries = await Diary.find({ user: req.user._id }).sort({ createdAt: -1 });

    const decrypted = entries.map(e => {
      let content = e.content;
      if (e.isEncrypted) {
        try { content = decrypt(content); } catch { content = '[Could not decrypt]'; }
      }
      return {
        title: e.title,
        mood: e.mood,
        date: e.createdAt,
        content,
        tags: e.tags || [],
        isFavorite: e.isFavorite,
        wordCount: e.wordCount,
      };
    });

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="diary-${Date.now()}.json"`);
      return res.send(JSON.stringify({ exportedAt: new Date(), user: req.user.name, entries: decrypted }, null, 2));
    }

    if (format === 'html') {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Diary Export</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:720px;margin:40px auto;padding:0 24px;color:#222;line-height:1.6}
h1{border-bottom:2px solid #6C63FF;padding-bottom:8px}
.entry{margin:32px 0;padding:20px;border-radius:12px;background:#f8f7ff;border-left:4px solid #6C63FF}
.meta{color:#888;font-size:14px;margin-bottom:12px}
.mood{display:inline-block;padding:3px 10px;border-radius:10px;background:#6C63FF;color:#fff;font-size:12px}
.content{white-space:pre-wrap;margin-top:12px}
.tag{display:inline-block;background:#eee;padding:2px 8px;border-radius:6px;margin:2px;font-size:12px}
</style></head><body>
<h1>📔 ${escapeHtml(req.user.name)}'s Diary</h1>
<p class="meta">Exported on ${new Date().toLocaleString()} · ${decrypted.length} entries</p>
${decrypted.map(e => `
<div class="entry">
<h2>${escapeHtml(e.title)}</h2>
<div class="meta">${new Date(e.date).toLocaleString()} · <span class="mood">${escapeHtml(e.mood)}</span></div>
<div class="content">${escapeHtml(e.content)}</div>
<div>${e.tags.map(t => `<span class="tag">#${escapeHtml(t)}</span>`).join(' ')}</div>
</div>`).join('')}
</body></html>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="diary-${Date.now()}.html"`);
      return res.send(html);
    }

    // markdown
    const md = [
      `# ${req.user.name}'s Diary`,
      `_Exported ${new Date().toLocaleString()} · ${decrypted.length} entries_\n`,
      ...decrypted.map(e => {
        const tags = e.tags.length ? `\n\n**Tags:** ${e.tags.map(t => '#' + t).join(' ')}` : '';
        const fav = e.isFavorite ? ' ⭐' : '';
        return `---\n\n## ${e.title}${fav}\n\n*${new Date(e.date).toLocaleString()} · Mood: ${e.mood}*\n\n${e.content}${tags}\n`;
      }),
    ].join('\n');

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="diary-${Date.now()}.md"`);
    res.send(md);
  } catch (error) {
    console.error('Diary export error:', error.message);
    res.status(500).json({ success: false, message: 'Export failed' });
  }
});

// @route   GET /api/export/todos
router.get('/todos', checkExportQuota, [
  query('format').optional().isIn(['markdown', 'csv', 'json']),
], async (req, res) => {
  try {
    const format = req.query.format || 'markdown';
    const todos = await Todo.find({ user: req.user._id }).sort({ createdAt: -1 });

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="todos-${Date.now()}.json"`);
      return res.send(JSON.stringify({ exportedAt: new Date(), count: todos.length, todos }, null, 2));
    }

    if (format === 'csv') {
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = [
        'Title,Category,Priority,Completed,DueDate,CreatedAt',
        ...todos.map(t => [
          esc(t.title),
          esc(t.category),
          esc(t.priority),
          esc(t.completed),
          esc(t.dueDate || ''),
          esc(t.createdAt),
        ].join(',')),
      ];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="todos-${Date.now()}.csv"`);
      return res.send(lines.join('\n'));
    }

    // markdown
    const md = [
      `# ${req.user.name}'s Tasks`,
      `_${todos.length} tasks · exported ${new Date().toLocaleString()}_\n`,
      ...todos.map(t => {
        const checkbox = t.completed ? '[x]' : '[ ]';
        const due = t.dueDate ? ` — due ${new Date(t.dueDate).toLocaleDateString()}` : '';
        const notes = t.description ? `\n  > ${t.description}` : '';
        return `- ${checkbox} **${t.emoji || ''} ${t.title}** (${t.priority}/${t.category})${due}${notes}`;
      }),
    ].join('\n');

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="todos-${Date.now()}.md"`);
    res.send(md);
  } catch (error) {
    console.error('Todos export error:', error.message);
    res.status(500).json({ success: false, message: 'Export failed' });
  }
});

// @route   GET /api/export/backup
// Full encrypted backup: every todo, diary entry (already-decrypted so the
// backup is self-contained), and habit. The whole payload is then re-
// encrypted with AES-256-GCM using the server's ENCRYPTION_KEY. The user
// can save the resulting blob locally; restoring is a future feature.
router.get('/backup', checkExportQuota, async (req, res) => {
  try {
    const [todos, diaryEntries, habits] = await Promise.all([
      Todo.find({ user: req.user._id }).lean(),
      Diary.find({ user: req.user._id }).lean(),
      Habit.find({ user: req.user._id }).lean(),
    ]);

    const decryptedDiary = diaryEntries.map((e) => {
      let content = e.content;
      if (e.isEncrypted) {
        try { content = decrypt(content); } catch { content = '[Could not decrypt]'; }
      }
      return { ...e, content, isEncrypted: false };
    });

    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      user: { id: String(req.user._id), name: req.user.name, email: req.user.email },
      counts: { todos: todos.length, diary: decryptedDiary.length, habits: habits.length },
      todos,
      diary: decryptedDiary,
      habits,
    };

    const json = JSON.stringify(payload);
    const ciphertext = encrypt(json);

    // The exported file is a small JSON envelope so a future restore route
    // can sniff version + algorithm without trying to decrypt blindly.
    const envelope = {
      app: 'todo-diary-v2',
      format: 'aes-256-gcm-envelope',
      version: 1,
      createdAt: new Date().toISOString(),
      // ciphertext is "iv:authTag:hex" — same format as encrypt() returns.
      ciphertext,
    };

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="backup-${Date.now()}.tdb.json"`,
    );
    res.send(JSON.stringify(envelope, null, 2));
  } catch (err) {
    console.error('Backup export error:', err.message);
    res.status(500).json({ success: false, message: 'Backup failed' });
  }
});

module.exports = router;

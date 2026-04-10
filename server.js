const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const connectDB = require('./config/db');
const cron = require('node-cron');
const Todo = require('./models/Todo');

const app = express();

// Connect to database
connectDB();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const rateLimit = {};
app.use((req, res, next) => {
  const ip = req.ip;
  const now = Date.now();
  if (!rateLimit[ip]) rateLimit[ip] = [];
  rateLimit[ip] = rateLimit[ip].filter(t => now - t < 60000);
  if (rateLimit[ip].length > 100) {
    return res.status(429).json({ success: false, message: 'Too many requests' });
  }
  rateLimit[ip].push(now);
  next();
});

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/todos', require('./routes/todos'));
app.use('/api/diary', require('./routes/diary'));
app.use('/api/ai', require('./routes/ai'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'AI Todo & Diary API is running', timestamp: new Date() });
});

// Cron job: Check reminders every minute
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    const upcoming = new Date(now.getTime() + 60000);
    const todos = await Todo.find({
      'reminder.enabled': true,
      'reminder.time': { $gte: now, $lte: upcoming },
      'reminder.sent': false,
      completed: false,
    });

    for (const todo of todos) {
      todo.reminder.sent = true;
      await todo.save();
      console.log(`Reminder: "${todo.title}" is due soon for user ${todo.user}`);
    }
  } catch (err) {
    console.error('Reminder cron error:', err.message);
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
});

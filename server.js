const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/db');
const cron = require('node-cron');
const Todo = require('./models/Todo');

const app = express();

// Connect to database
connectDB();

// Trust proxy (needed for correct IP behind reverse proxy / rate-limit)
app.set('trust proxy', 1);

// Middleware
// helmet's default CSP blocks cross-origin embedding of images; relax that for
// the /uploads route so the mobile app can render attachments.
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve user uploads statically. Keep this BEFORE the generalLimiter so that
// image rendering isn't rate-limited along with API calls.
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  maxAge: '7d',
  index: false,
  fallthrough: false,
}));

// Production-grade rate limits
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please slow down' },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many auth attempts. Try again later.' },
});

app.use('/api', generalLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/signup', authLimiter);

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/todos', require('./routes/todos'));
app.use('/api/diary', require('./routes/diary'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/subscription', require('./routes/subscription'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/export', require('./routes/export'));
app.use('/api/uploads', require('./routes/uploads'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'AI Todo & Diary API is running',
    version: '2.0.0',
    timestamp: new Date(),
  });
});

// 404 handler
app.use('/api/*', (req, res) => {
  res.status(404).json({ success: false, message: 'Endpoint not found' });
});

// Centralized error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  const status = err.status || 500;
  res.status(status).json({
    success: false,
    message: status === 500 ? 'Server error' : err.message,
  });
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

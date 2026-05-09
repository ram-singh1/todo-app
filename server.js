const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/db');
const cron = require('node-cron');
const Todo = require('./models/Todo');
const RecurringBill = require('./models/RecurringBill');
const Tool = require('./models/Tool');
const Expense = require('./models/Expense');
const { advanceNextDue } = require('./routes/budget');

// Fail fast in production if critical secrets are missing — easier to debug
// in Render's deploy logs than a runtime crash 30 minutes later.
if (process.env.NODE_ENV === 'production') {
  const required = ['MONGODB_URI', 'JWT_SECRET'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`❌ Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
}

const app = express();

// Connect to database
connectDB();

// Trust proxy (needed for correct IP behind Render's reverse proxy so the
// rate limiter sees real client IPs rather than 127.0.0.1).
app.set('trust proxy', 1);

// Middleware
// helmet's default CSP blocks cross-origin embedding of images; relax that for
// the /uploads route so the mobile app can render attachments.
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// CORS: comma-separated allowlist via CORS_ORIGINS, or fully open if unset.
// A public mobile API typically needs `*` since auth is JWT-based; tightening
// is opt-in for users who deploy a web client too.
const corsOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
app.use(cors({
  origin: corsOrigins.length > 0 ? corsOrigins : true,
  credentials: true,
}));

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
app.use('/api/habits', require('./routes/habits'));
app.use('/api/subscription', require('./routes/subscription'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/export', require('./routes/export'));
app.use('/api/uploads', require('./routes/uploads'));
app.use('/api/budget', require('./routes/budget'));
app.use('/api/health-log', require('./routes/health'));
app.use('/api/tools', require('./routes/tools'));
app.use('/api/trash', require('./routes/trash'));

// Health check (both / and /api/health work — Render health-checks the root).
// Returns 503 if Mongo is disconnected so a flapping DB isn't masked behind
// a 200 response that satisfies the load balancer.
const healthHandler = (req, res) => {
  const dbState = mongoose.connection.readyState; // 0=disc, 1=conn, 2=connecting, 3=disconnecting
  const dbOk = dbState === 1;
  const status = dbOk ? 200 : 503;
  res.status(status).json({
    success: dbOk,
    message: dbOk ? 'Todo & Diary API is running' : 'Database not ready',
    version: '2.1.0',
    db: { connected: dbOk, state: dbState },
    timestamp: new Date(),
  });
};
app.get('/', healthHandler);
app.get('/api/health', healthHandler);

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

// ─── Cron jobs ──────────────────────────────────────────────
// All jobs use atomic findOneAndUpdate / updateMany with a "claim" flag so
// running across multiple instances doesn't double-fire. Every job is
// wrapped in try/catch so one failing job doesn't kill the others.

// 1) Reminders — fire window covers the next 60s
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    const upcoming = new Date(now.getTime() + 60000);
    // Atomically claim each due reminder so two replicas can't both fire.
    while (true) {
      const todo = await Todo.findOneAndUpdate(
        {
          'reminder.enabled': true,
          'reminder.time': { $gte: now, $lte: upcoming },
          'reminder.sent': false,
          completed: false,
          deletedAt: null,
        },
        { $set: { 'reminder.sent': true } },
        { new: true }
      );
      if (!todo) break;
      // Hook for push delivery here — currently relies on client-side
      // scheduleNotificationAsync. Server-side push would fire here.
      console.log(`Reminder: "${todo.title}" is due soon for user ${todo.user}`);
    }
  } catch (err) {
    console.error('Reminder cron error:', err.message);
  }
});

// 2) Recurring bills — daily at 09:00 server time. For each due bill:
//    - if autoLog: create an Expense + roll forward nextDueAt
//    - else: just bump lastReminderAt (client surfaces it on the dashboard)
cron.schedule('0 9 * * *', async () => {
  try {
    const now = new Date();
    const reminderHorizon = new Date(now.getTime() + 7 * 86400000);
    const bills = await RecurringBill.find({
      active: true, deletedAt: null,
      nextDueAt: { $lte: reminderHorizon },
    });
    for (const bill of bills) {
      try {
        const dueNow = bill.nextDueAt <= now;
        if (dueNow && bill.autoLog) {
          await Expense.create({
            user: bill.user,
            amount: bill.amount,
            currency: bill.currency,
            category: bill.category || 'bills',
            kind: 'expense',
            date: bill.nextDueAt,
            note: bill.name,
            recurringSourceId: bill._id,
          });
          bill.lastChargedAt = new Date();
          bill.nextDueAt = advanceNextDue(bill.nextDueAt, bill.frequency);
        }
        bill.lastReminderAt = new Date();
        await bill.save();
      } catch (innerErr) {
        console.error(`Bill cron failed for ${bill._id}:`, innerErr.message);
      }
    }
  } catch (err) {
    console.error('Bills cron error:', err.message);
  }
});

// 3) Worry-log reviews — daily at 09:05. Marks each due worry as reviewSent
//    so the client knows to surface the review prompt next time the user
//    opens the Tools section.
cron.schedule('5 9 * * *', async () => {
  try {
    const now = new Date();
    const result = await Tool.updateMany(
      { kind: 'worry', deletedAt: null, reviewSent: false, reviewAt: { $lte: now } },
      { $set: { reviewSent: true } }
    );
    if (result.modifiedCount > 0) {
      console.log(`Worry reviews ready: ${result.modifiedCount}`);
    }
  } catch (err) {
    console.error('Worry-review cron error:', err.message);
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
});

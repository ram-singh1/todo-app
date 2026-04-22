const express = require('express');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const { getLimitsForPlan } = require('../middleware/premium');

const router = express.Router();
router.use(protect);

// Pricing catalog (source of truth for frontend)
const PLANS = [
  {
    id: 'free',
    name: 'Free',
    tagline: 'Get started',
    priceMonthly: 0,
    priceYearly: 0,
    badge: null,
    features: [
      '10 AI requests / month',
      '50 todos & 30 diary entries',
      '6 glass themes',
      'Encrypted diary (AES-256)',
      'Voice reading (TTS)',
      'Basic reminders',
    ],
    featured: false,
  },
  {
    id: 'pro',
    name: 'Pro',
    tagline: 'Unlock creativity',
    priceMonthly: 4.99,
    priceYearly: 39.99,
    badge: 'MOST POPULAR',
    features: [
      '500 AI requests / month',
      'Unlimited todos & entries',
      'All 16 liquid glass themes',
      'Advanced analytics & charts',
      'PDF & Markdown export',
      'Priority AI (GPT-4 class)',
      'Widget-ready dashboard',
      'Custom recurring reminders',
    ],
    featured: true,
  },
  {
    id: 'ultimate',
    name: 'Ultimate',
    tagline: 'Power user',
    priceMonthly: 9.99,
    priceYearly: 79.99,
    badge: 'BEST VALUE',
    features: [
      'Unlimited AI requests',
      'Everything in Pro',
      'Premium voice models',
      'Early access to new features',
      'Cloud backup & sync',
      'Personal AI coach',
      'Priority support',
    ],
    featured: false,
  },
];

// @route   GET /api/subscription/plans
router.get('/plans', (req, res) => {
  res.json({ success: true, plans: PLANS });
});

// @route   GET /api/subscription/status
router.get('/status', async (req, res) => {
  const limits = getLimitsForPlan(req.user.subscription?.plan || 'free');
  res.json({
    success: true,
    subscription: {
      ...req.user.subscription.toObject(),
      isPremium: req.user.isPremium(),
    },
    usage: req.user.usage,
    limits: {
      aiCallsPerMonth: limits.aiCallsPerMonth === Infinity ? null : limits.aiCallsPerMonth,
      exportsPerMonth: limits.exportsPerMonth === Infinity ? null : limits.exportsPerMonth,
      maxTodos: limits.maxTodos === Infinity ? null : limits.maxTodos,
      maxDiaryEntries: limits.maxDiaryEntries === Infinity ? null : limits.maxDiaryEntries,
      allowedThemes: limits.allowedThemes,
      advancedAnalytics: limits.advancedAnalytics,
      pdfExport: limits.pdfExport,
    },
  });
});

// @route   POST /api/subscription/start-trial
router.post('/start-trial', async (req, res) => {
  try {
    if (req.user.subscription.trialUsed) {
      return res.status(400).json({
        success: false,
        message: 'Free trial already used. Please choose a plan.',
      });
    }
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days

    req.user.subscription = {
      ...req.user.subscription.toObject(),
      plan: 'trial',
      status: 'trialing',
      startedAt: now,
      expiresAt,
      trialUsed: true,
      provider: 'manual',
      priceUsd: 0,
    };
    await req.user.save();

    res.json({
      success: true,
      message: 'Your 7-day free trial has started! Enjoy Pro features.',
      subscription: req.user.subscription,
      user: req.user.publicProfile(),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Could not start trial' });
  }
});

// @route   POST /api/subscription/subscribe
// NOTE: This is a stub — in production, verify payment via Stripe/Apple/Google webhooks.
router.post('/subscribe', [
  body('plan').isIn(['pro', 'ultimate']),
  body('billing').isIn(['monthly', 'yearly']),
  body('provider').optional().isIn(['stripe', 'apple', 'google', 'manual']),
  body('externalId').optional().isString(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { plan, billing, provider = 'manual', externalId } = req.body;
    const catalog = PLANS.find(p => p.id === plan);
    if (!catalog) {
      return res.status(400).json({ success: false, message: 'Invalid plan' });
    }

    const now = new Date();
    const durationDays = billing === 'yearly' ? 365 : 30;
    const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);
    const priceUsd = billing === 'yearly' ? catalog.priceYearly : catalog.priceMonthly;

    req.user.subscription = {
      plan,
      status: 'active',
      startedAt: now,
      expiresAt,
      trialUsed: req.user.subscription.trialUsed,
      provider,
      externalId,
      cancelAtPeriodEnd: false,
      lastPaymentAt: now,
      priceUsd,
    };
    await req.user.save();

    res.json({
      success: true,
      message: `Welcome to ${catalog.name}! Your plan is now active.`,
      subscription: req.user.subscription,
      user: req.user.publicProfile(),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Subscription could not be activated' });
  }
});

// @route   POST /api/subscription/cancel
router.post('/cancel', async (req, res) => {
  try {
    if (!req.user.isPremium()) {
      return res.status(400).json({ success: false, message: 'No active subscription to cancel' });
    }
    req.user.subscription.cancelAtPeriodEnd = true;
    await req.user.save();
    res.json({
      success: true,
      message: 'Subscription will end at the current period. You keep access until then.',
      subscription: req.user.subscription,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Could not cancel subscription' });
  }
});

// @route   POST /api/subscription/restore
router.post('/restore', async (req, res) => {
  try {
    if (req.user.subscription.cancelAtPeriodEnd) {
      req.user.subscription.cancelAtPeriodEnd = false;
      await req.user.save();
      return res.json({
        success: true,
        message: 'Subscription restored! You will continue to be billed.',
        subscription: req.user.subscription,
      });
    }
    res.json({ success: true, message: 'No action needed', subscription: req.user.subscription });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Could not restore subscription' });
  }
});

// @route   POST /api/subscription/redeem
router.post('/redeem', [
  body('code').trim().notEmpty(),
], async (req, res) => {
  try {
    const { code } = req.body;
    // Simple promo-code demo — replace with a real Coupon model in production
    const validCodes = {
      'WELCOME30': { plan: 'pro', days: 30, label: '30-day Pro trial' },
      'LAUNCH2026': { plan: 'pro', days: 60, label: '60-day Pro access' },
      'FRIEND7': { plan: 'trial', days: 7, label: '7-day trial extension' },
    };
    const promo = validCodes[code.toUpperCase()];
    if (!promo) {
      return res.status(400).json({ success: false, message: 'Invalid or expired code' });
    }
    const now = new Date();
    const expiresAt = new Date(now.getTime() + promo.days * 24 * 60 * 60 * 1000);
    req.user.subscription.plan = promo.plan;
    req.user.subscription.status = 'active';
    req.user.subscription.startedAt = now;
    req.user.subscription.expiresAt = expiresAt;
    req.user.subscription.provider = 'manual';
    await req.user.save();
    res.json({
      success: true,
      message: `Code redeemed: ${promo.label}`,
      subscription: req.user.subscription,
      user: req.user.publicProfile(),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Could not redeem code' });
  }
});

module.exports = router;

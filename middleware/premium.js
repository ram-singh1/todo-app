const FREE_LIMITS = {
  exportsPerMonth: 0,
  maxTodos: 50,
  maxDiaryEntries: 30,
  maxHabits: 3,
  allowedThemes: ['aurora', 'sunset', 'ocean', 'forest', 'midnight', 'rose', 'daylight'],
  advancedAnalytics: false,
  pdfExport: false,
  customReminders: true,
  voiceTTS: true,
  appLock: false,
};

const TRIAL_LIMITS = {
  exportsPerMonth: 10,
  maxTodos: Infinity,
  maxDiaryEntries: Infinity,
  maxHabits: Infinity,
  allowedThemes: 'all',
  advancedAnalytics: true,
  pdfExport: true,
  customReminders: true,
  voiceTTS: true,
  appLock: true,
};

const PRO_LIMITS = {
  exportsPerMonth: 50,
  maxTodos: Infinity,
  maxDiaryEntries: Infinity,
  maxHabits: Infinity,
  allowedThemes: 'all',
  advancedAnalytics: true,
  pdfExport: true,
  customReminders: true,
  voiceTTS: true,
  appLock: true,
};

const ULTIMATE_LIMITS = {
  exportsPerMonth: Infinity,
  maxTodos: Infinity,
  maxDiaryEntries: Infinity,
  maxHabits: Infinity,
  allowedThemes: 'all',
  advancedAnalytics: true,
  pdfExport: true,
  customReminders: true,
  voiceTTS: true,
  appLock: true,
};

function getLimitsForPlan(plan) {
  switch (plan) {
    case 'ultimate': return ULTIMATE_LIMITS;
    case 'pro': return PRO_LIMITS;
    case 'trial': return TRIAL_LIMITS;
    default: return FREE_LIMITS;
  }
}

function resetMonthlyUsageIfNeeded(user) {
  const now = new Date();
  const resetAt = user.usage?.exportsResetAt ? new Date(user.usage.exportsResetAt) : now;
  const daysSinceReset = (now - resetAt) / (1000 * 60 * 60 * 24);
  if (daysSinceReset >= 30) {
    user.usage.exportsThisMonth = 0;
    user.usage.exportsResetAt = now;
  }
}

// Require a premium plan (trial counts)
const requirePremium = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }
  if (!req.user.isPremium()) {
    return res.status(402).json({
      success: false,
      code: 'PREMIUM_REQUIRED',
      message: 'This feature requires a premium subscription',
      upgradeUrl: '/upgrade',
    });
  }
  next();
};

// Check export quota
const checkExportQuota = async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }
  resetMonthlyUsageIfNeeded(req.user);
  const limits = getLimitsForPlan(req.user.subscription?.plan || 'free');
  const used = req.user.usage?.exportsThisMonth || 0;
  if (used >= limits.exportsPerMonth) {
    return res.status(429).json({
      success: false,
      code: 'EXPORT_QUOTA_EXCEEDED',
      message: 'Export limit reached. Upgrade your plan for more exports.',
      used,
      limit: limits.exportsPerMonth,
    });
  }
  req.user.usage.exportsThisMonth = used + 1;
  await req.user.save();
  next();
};

module.exports = {
  requirePremium,
  checkExportQuota,
  getLimitsForPlan,
  FREE_LIMITS,
  TRIAL_LIMITS,
  PRO_LIMITS,
  ULTIMATE_LIMITS,
};

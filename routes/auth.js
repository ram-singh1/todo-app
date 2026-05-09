const express = require('express');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const { protect } = require('../middleware/auth');

const router = express.Router();

const ALL_THEMES = ['aurora', 'sunset', 'ocean', 'forest', 'lavender', 'midnight', 'rose', 'cosmic',
  'zen', 'rainyDay', 'sakura', 'northern', 'warmCandle', 'deepSea', 'dreamyPastel', 'starryNight',
  'mountainGlass', 'forestGlass', 'spaceGlass', 'cityGlass', 'desertGlass',
  'lakeSunriseGlass', 'rainGardenGlass', 'auroraOceanGlass', 'desertMoonGlass',
  'sunriseScene', 'galaxyScene', 'twilightScene', 'emeraldScene', 'coralScene',
  'cherryBloomScene', 'tropicalBeachScene', 'lavenderFieldsScene', 'mistyMountainScene', 'velvetNightScene',
  'daylight', 'paperMint', 'cream', 'porcelain'];

// @route   POST /api/auth/signup
router.post('/signup', [
  body('name').trim().notEmpty().withMessage('Name is required').isLength({ max: 50 }),
  body('email').isEmail().withMessage('Valid email is required').normalizeEmail(),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('referralCode').optional().trim().isLength({ max: 16 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { name, email, password, referralCode } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'Email already registered' });
    }

    const user = await User.create({
      name,
      email,
      password,
      referredBy: referralCode || undefined,
      lastLoginAt: new Date(),
    });
    const token = user.getSignedJwtToken();

    res.status(201).json({
      success: true,
      token,
      user: user.publicProfile(),
    });
  } catch (error) {
    console.error('Signup error:', error.message);
    res.status(500).json({ success: false, message: 'Could not create account' });
  }
});

// @route   POST /api/auth/login
router.post('/login', [
  body('email').isEmail().withMessage('Valid email is required').normalizeEmail(),
  body('password').notEmpty().withMessage('Password is required'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, password } = req.body;

    const user = await User.findOne({ email }).select('+password');
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    user.lastLoginAt = new Date();
    await user.save();

    const token = user.getSignedJwtToken();

    res.json({
      success: true,
      token,
      user: user.publicProfile(),
    });
  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).json({ success: false, message: 'Login failed' });
  }
});

// @route   GET /api/auth/me
router.get('/me', protect, async (req, res) => {
  res.json({ success: true, user: req.user.publicProfile() });
});

// @route   PUT /api/auth/profile
router.put('/profile', protect, [
  body('name').optional().trim().isLength({ max: 50 }),
  body('theme').optional().isIn(ALL_THEMES),
  // Avatar can be an emoji (1–4 chars) or `__photo_<url>` / `__icon_<id>`
  // — the schema allows up to 1024 chars to fit photo URLs.
  body('avatar').optional().isString().isLength({ max: 1024 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { name, avatar, theme, notificationsEnabled } = req.body;
    if (name !== undefined) req.user.name = name;
    if (avatar !== undefined) req.user.avatar = avatar;
    if (theme !== undefined) req.user.theme = theme;
    if (typeof notificationsEnabled === 'boolean') req.user.notificationsEnabled = notificationsEnabled;

    await req.user.save();
    res.json({ success: true, user: req.user.publicProfile() });
  } catch (error) {
    console.error('Profile update error:', error.message);
    res.status(500).json({ success: false, message: 'Could not update profile' });
  }
});

// @route   PUT /api/auth/password
router.put('/password', protect, [
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 6 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user._id).select('+password');

    const isMatch = await user.matchPassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Current password is incorrect' });
    }

    user.password = newPassword;
    await user.save();

    const token = user.getSignedJwtToken();
    res.json({ success: true, token, message: 'Password updated successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Could not update password' });
  }
});

// @route   POST /api/auth/forgot-password
// Always returns success even if email isn't registered (prevents email
// enumeration). Returns the reset token in dev so flows work without an
// email provider configured; in production this would only be emailed.
router.post('/forgot-password', [
  body('email').isEmail().normalizeEmail(),
], async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });
    const generic = {
      success: true,
      message: 'If an account exists for that email, a reset link has been sent.',
    };
    if (!user) return res.json(generic);

    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashed = crypto.createHash('sha256').update(rawToken).digest('hex');
    user.passwordResetToken = hashed;
    user.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000); // 60 min
    await user.save();

    // In production wire SendGrid/SES here. The dev-token leak in the
    // response is opt-in via EXPOSE_RESET_TOKEN=1 so simply forgetting to
    // set NODE_ENV=production doesn't leak tokens. Default = never expose.
    const payload = { ...generic };
    if (process.env.EXPOSE_RESET_TOKEN === '1' && process.env.NODE_ENV !== 'production') {
      payload.devToken = rawToken;
      payload.devExpiresAt = user.passwordResetExpires;
    } else if (process.env.NODE_ENV !== 'production') {
      // Log to server console instead so the dev can grab the token from logs
      // without it ever crossing the wire.
      console.log(`[reset-token] ${user.email} → ${rawToken} (expires ${user.passwordResetExpires.toISOString()})`);
    }
    res.json(payload);
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not initiate reset' });
  }
});

// @route   POST /api/auth/reset-password
router.post('/reset-password', [
  body('token').trim().isLength({ min: 32 }),
  body('newPassword').isLength({ min: 6 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
    const { token, newPassword } = req.body;
    const hashed = crypto.createHash('sha256').update(token).digest('hex');
    const user = await User.findOne({
      passwordResetToken: hashed,
      passwordResetExpires: { $gt: new Date() },
    }).select('+password +passwordResetToken +passwordResetExpires');
    if (!user) return res.status(400).json({ success: false, message: 'Invalid or expired token' });

    user.password = newPassword;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();

    const jwt = user.getSignedJwtToken();
    res.json({ success: true, token: jwt, message: 'Password reset. You are signed in.' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Could not reset password' });
  }
});

// @route   DELETE /api/auth/account
router.delete('/account', protect, async (req, res) => {
  try {
    await User.findByIdAndDelete(req.user._id);
    res.json({ success: true, message: 'Account deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Could not delete account' });
  }
});

module.exports = router;

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const SUBSCRIPTION_PLANS = ['free', 'trial', 'pro', 'ultimate'];

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true,
    maxlength: 50,
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email'],
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: 6,
    select: false,
  },
  avatar: {
    type: String,
    default: '😀',
    maxlength: 4,
  },
  theme: {
    type: String,
    default: 'aurora',
    enum: ['aurora', 'sunset', 'ocean', 'forest', 'lavender', 'midnight', 'rose', 'cosmic',
           'zen', 'rainyDay', 'sakura', 'northern', 'warmCandle', 'deepSea', 'dreamyPastel', 'starryNight'],
  },
  notificationsEnabled: {
    type: Boolean,
    default: true,
  },

  // ── Subscription & monetization ──
  subscription: {
    plan: { type: String, enum: SUBSCRIPTION_PLANS, default: 'free' },
    status: { type: String, enum: ['active', 'trialing', 'expired', 'canceled'], default: 'active' },
    startedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date },
    trialUsed: { type: Boolean, default: false },
    provider: { type: String, enum: ['stripe', 'apple', 'google', 'manual', null], default: null },
    externalId: { type: String },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    lastPaymentAt: { type: Date },
    priceUsd: { type: Number, default: 0 },
  },

  // ── Usage tracking (for free-tier limits) ──
  usage: {
    aiCallsThisMonth: { type: Number, default: 0 },
    aiCallsResetAt: { type: Date, default: Date.now },
    exportsThisMonth: { type: Number, default: 0 },
    exportsResetAt: { type: Date, default: Date.now },
    diaryEntries: { type: Number, default: 0 },
    todoCount: { type: Number, default: 0 },
  },

  // ── Streak and engagement ──
  streak: {
    current: { type: Number, default: 0 },
    longest: { type: Number, default: 0 },
    lastActiveDate: { type: Date },
  },

  referralCode: { type: String, unique: true, sparse: true },
  referredBy: { type: String },

  lastLoginAt: { type: Date },
}, {
  timestamps: true,
});

userSchema.pre('save', async function (next) {
  if (this.isModified('password')) {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
  }
  if (!this.referralCode) {
    this.referralCode = Math.random().toString(36).substring(2, 10).toUpperCase();
  }
  next();
});

userSchema.methods.matchPassword = async function (enteredPassword) {
  return bcrypt.compare(enteredPassword, this.password);
};

userSchema.methods.getSignedJwtToken = function () {
  return jwt.sign({ id: this._id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE || '30d',
  });
};

userSchema.methods.isPremium = function () {
  const { plan, status, expiresAt } = this.subscription || {};
  if (!plan || plan === 'free') return false;
  if (status === 'canceled' || status === 'expired') return false;
  if (expiresAt && new Date(expiresAt) < new Date()) return false;
  return ['trial', 'pro', 'ultimate'].includes(plan);
};

userSchema.methods.publicProfile = function () {
  return {
    id: this._id,
    name: this.name,
    email: this.email,
    avatar: this.avatar,
    theme: this.theme,
    notificationsEnabled: this.notificationsEnabled,
    subscription: {
      plan: this.subscription.plan,
      status: this.subscription.status,
      expiresAt: this.subscription.expiresAt,
      trialUsed: this.subscription.trialUsed,
      isPremium: this.isPremium(),
      cancelAtPeriodEnd: this.subscription.cancelAtPeriodEnd,
    },
    usage: this.usage,
    streak: this.streak,
    referralCode: this.referralCode,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model('User', userSchema);
module.exports.SUBSCRIPTION_PLANS = SUBSCRIPTION_PLANS;

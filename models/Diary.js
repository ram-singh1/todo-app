const mongoose = require('mongoose');

const diarySchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  title: {
    type: String,
    required: [true, 'Diary title is required'],
    trim: true,
    maxlength: 200,
  },
  content: {
    type: String,
    required: [true, 'Content is required'],
  },
  isEncrypted: {
    type: Boolean,
    default: true,
  },
  mood: {
    type: String,
    default: 'neutral',
    enum: ['amazing', 'happy', 'neutral', 'sad', 'angry', 'anxious', 'excited', 'grateful', 'tired', 'loved'],
  },
  moodEmoji: {
    type: String,
    default: '😐',
  },
  weather: {
    type: String,
    enum: ['sunny', 'cloudy', 'rainy', 'snowy', 'windy', 'stormy', 'foggy', null],
    default: null,
  },
  tags: [{
    type: String,
    trim: true,
  }],
  emojis: [{
    type: String,
  }],
  color: {
    type: String,
    default: '#6C63FF',
  },
  backgroundColor: {
    type: String,
    default: '#1a1a2e',
  },
  fontStyle: {
    type: String,
    default: 'default',
    enum: ['default', 'serif', 'handwriting', 'monospace'],
  },
  images: [{
    uri: String,
    caption: String,
  }],
  isFavorite: {
    type: Boolean,
    default: false,
  },
  isPrivate: {
    type: Boolean,
    default: true,
  },
  wordCount: {
    type: Number,
    default: 0,
  },
  readingTime: {
    type: Number,
    default: 0,
  },
  aiAnalysis: {
    sentiment: String,
    keywords: [String],
    summary: String,
  },
}, {
  timestamps: true,
});

diarySchema.index({ user: 1, createdAt: -1 });
diarySchema.index({ user: 1, mood: 1 });
diarySchema.index({ user: 1, isFavorite: 1 });

module.exports = mongoose.model('Diary', diarySchema);

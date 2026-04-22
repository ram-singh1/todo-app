const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { protect } = require('../middleware/auth');

const router = express.Router();

// ── Config ──────────────────────────────────────────────────
const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;       // 10 MB
const MAX_FILE_BYTES = 20 * 1024 * 1024;        // 20 MB
const MAX_BATCH = 5;                            // per request

const ALLOWED_IMAGE_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
]);
const ALLOWED_FILE_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/zip',
  'application/x-zip-compressed',
  'application/json',
]);

// Ensure upload root exists.
if (!fs.existsSync(UPLOAD_ROOT)) {
  fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
}

// Multer storage: per-user folder, random filename preserving extension.
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const userDir = path.join(UPLOAD_ROOT, String(req.user._id));
    fs.mkdirSync(userDir, { recursive: true });
    cb(null, userDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().slice(0, 10);
    const safeExt = /^\.[a-z0-9]+$/.test(ext) ? ext : '';
    const rand = crypto.randomBytes(10).toString('hex');
    cb(null, `${Date.now()}-${rand}${safeExt}`);
  },
});

function fileFilter(req, file, cb) {
  const isImage = ALLOWED_IMAGE_MIME.has(file.mimetype);
  const isDoc = ALLOWED_FILE_MIME.has(file.mimetype);
  if (!isImage && !isDoc) {
    cb(new Error(`Unsupported file type: ${file.mimetype}`));
    return;
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_BYTES,      // max across file/image; image check runs post-upload
    files: MAX_BATCH,
  },
});

// @route   POST /api/uploads
// Accepts multipart/form-data with field "files" (multiple). Up to 5 files per call.
router.post('/', protect, (req, res) => {
  upload.array('files', MAX_BATCH)(req, res, (err) => {
    if (err) {
      // Clean up any partially-written files on error.
      return res.status(400).json({ success: false, message: err.message });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: 'No files uploaded' });
    }

    // Enforce per-kind size limits that multer can't express (image ≤ 10MB).
    for (const f of req.files) {
      if (f.mimetype.startsWith('image/') && f.size > MAX_IMAGE_BYTES) {
        req.files.forEach((x) => fs.unlink(x.path, () => {}));
        return res.status(413).json({
          success: false,
          message: `Image "${f.originalname}" exceeds the 10 MB limit`,
        });
      }
    }

    // Build public payload.
    const host = `${req.protocol}://${req.get('host')}`;
    const attachments = req.files.map((f) => {
      const rel = path.relative(UPLOAD_ROOT, f.path).split(path.sep).join('/');
      return {
        kind: f.mimetype.startsWith('image/') ? 'image' : 'file',
        path: rel,
        url: `${host}/uploads/${rel}`,
        name: f.originalname,
        mimeType: f.mimetype,
        size: f.size,
      };
    });

    res.status(201).json({ success: true, attachments });
  });
});

// @route   DELETE /api/uploads
// Body: { path: "<relativePath>" } — deletes the file if it belongs to the caller.
router.delete('/', protect, express.json(), (req, res) => {
  const rel = String(req.body?.path || '');
  if (!rel) return res.status(400).json({ success: false, message: 'Missing path' });

  // Prevent traversal. The path must live under the caller's folder.
  const userPrefix = `${req.user._id}/`;
  if (rel.includes('..') || !rel.startsWith(userPrefix)) {
    return res.status(403).json({ success: false, message: 'Forbidden' });
  }

  const abs = path.join(UPLOAD_ROOT, rel);
  fs.unlink(abs, (err) => {
    if (err && err.code !== 'ENOENT') {
      return res.status(500).json({ success: false, message: 'Could not delete file' });
    }
    res.json({ success: true });
  });
});

router.get('/limits', protect, (_req, res) => {
  res.json({
    success: true,
    limits: {
      maxImageBytes: MAX_IMAGE_BYTES,
      maxFileBytes: MAX_FILE_BYTES,
      maxBatch: MAX_BATCH,
      maxPerTask: 10,
      allowedImages: Array.from(ALLOWED_IMAGE_MIME),
      allowedFiles: Array.from(ALLOWED_FILE_MIME),
    },
  });
});

module.exports = router;

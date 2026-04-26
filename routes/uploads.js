const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { cloudinary, isCloudinaryEnabled } = require('../config/cloudinary');
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

// ── Storage selection ───────────────────────────────────────
// In production (Render free tier) the local filesystem is ephemeral, so we
// stream uploads to Cloudinary instead. Locally — when Cloudinary creds are
// not configured — we keep the legacy disk path so dev keeps working with
// no extra setup.
let storage;
if (isCloudinaryEnabled()) {
  storage = new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => {
      const isImage = ALLOWED_IMAGE_MIME.has(file.mimetype);
      // Per-user folder keeps things tidy; non-image files are stored as
      // resource_type "raw" so Cloudinary doesn't try to transcode them.
      return {
        folder: `todo-diary/${req.user._id}`,
        resource_type: isImage ? 'image' : 'raw',
        // Random public_id, retain extension for raw files.
        public_id: `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`,
      };
    },
  });
} else {
  if (!fs.existsSync(UPLOAD_ROOT)) {
    fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
  }
  storage = multer.diskStorage({
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
}

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

// Build the public response payload from a multer File (works for both
// CloudinaryStorage and diskStorage — the shape of `file` differs).
function fileToAttachment(file, req) {
  const isImage = file.mimetype.startsWith('image/');

  if (isCloudinaryEnabled()) {
    // CloudinaryStorage decorates `file` with `path` (secure URL) and
    // `filename` (public_id). `file.size` may be missing for raw files.
    return {
      kind: isImage ? 'image' : 'file',
      path: file.filename,         // public_id, used by DELETE handler
      url: file.path,              // already a fully-qualified https URL
      name: file.originalname,
      mimeType: file.mimetype,
      size: file.size || 0,
      provider: 'cloudinary',
    };
  }

  const host = `${req.protocol}://${req.get('host')}`;
  const rel = path.relative(UPLOAD_ROOT, file.path).split(path.sep).join('/');
  return {
    kind: isImage ? 'image' : 'file',
    path: rel,
    url: `${host}/uploads/${rel}`,
    name: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
    provider: 'local',
  };
}

// @route   POST /api/uploads
// Accepts multipart/form-data with field "files" (multiple). Up to 5 files per call.
router.post('/', protect, (req, res) => {
  upload.array('files', MAX_BATCH)(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: 'No files uploaded' });
    }

    // Enforce per-kind size limits that multer can't express (image ≤ 10MB).
    // For Cloudinary uploads this is a best-effort post-check — the file is
    // already uploaded; we delete oversized ones to keep storage clean.
    for (const f of req.files) {
      if (f.mimetype.startsWith('image/') && f.size > MAX_IMAGE_BYTES) {
        if (isCloudinaryEnabled()) {
          req.files.forEach((x) => {
            const isImg = x.mimetype.startsWith('image/');
            cloudinary.uploader.destroy(x.filename, {
              resource_type: isImg ? 'image' : 'raw',
            }).catch(() => {});
          });
        } else {
          req.files.forEach((x) => fs.unlink(x.path, () => {}));
        }
        return res.status(413).json({
          success: false,
          message: `Image "${f.originalname}" exceeds the 10 MB limit`,
        });
      }
    }

    const attachments = req.files.map((f) => fileToAttachment(f, req));
    res.status(201).json({ success: true, attachments });
  });
});

// @route   DELETE /api/uploads
// Body: { path: "<relativePath>" } — deletes the file if it belongs to the caller.
//   - Local: relative path under uploads/<userId>/
//   - Cloudinary: public_id under todo-diary/<userId>/
router.delete('/', protect, express.json(), async (req, res) => {
  const rel = String(req.body?.path || '');
  if (!rel) return res.status(400).json({ success: false, message: 'Missing path' });

  if (isCloudinaryEnabled()) {
    // Cloudinary public_ids look like "todo-diary/<userId>/<id>"
    const userPrefix = `todo-diary/${req.user._id}/`;
    if (!rel.startsWith(userPrefix)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    try {
      // We don't know image vs raw here — try image first, fall back to raw.
      const r = await cloudinary.uploader.destroy(rel, { resource_type: 'image' });
      if (r?.result !== 'ok' && r?.result !== 'not found') {
        await cloudinary.uploader.destroy(rel, { resource_type: 'raw' });
      }
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Could not delete file' });
    }
  }

  // Local-disk path. Prevent traversal and confine to caller's folder.
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
      provider: isCloudinaryEnabled() ? 'cloudinary' : 'local',
    },
  });
});

module.exports = router;

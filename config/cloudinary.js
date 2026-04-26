// Centralised Cloudinary configuration. The rest of the app calls
// `isCloudinaryEnabled()` to decide between Cloudinary and local-disk uploads.
// Configuring Cloudinary requires three env vars; if any is missing, the
// app silently falls back to local disk so dev workflows keep working.

const cloudinary = require('cloudinary').v2;

const {
  CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET,
} = process.env;

const enabled = Boolean(
  CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET,
);

if (enabled) {
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
    secure: true,
  });
}

module.exports = {
  cloudinary,
  isCloudinaryEnabled: () => enabled,
};

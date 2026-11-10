const multer = require("multer");
const path = require("path");
const fs = require("fs");

const MAX_LOGO_SIZE_MB = 6;
const MAX_LOGO_SIZE_BYTES = MAX_LOGO_SIZE_MB * 1024 * 1024;

const uploadDir = path.join(__dirname, "..", "uploads", "logos");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const safeBaseName = path
      .basename(file.originalname || "logo", ext)
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase();

    const uniqueName = `${Date.now()}-${safeBaseName || "logo"}${ext}`;
    cb(null, uniqueName);
  },
});

const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/svg+xml",
  ];

  const allowedExtensions = [".jpg", ".jpeg", ".png", ".webp", ".svg"];
  const ext = path.extname(file.originalname || "").toLowerCase();

  if (
    !allowedMimeTypes.includes(file.mimetype) ||
    !allowedExtensions.includes(ext)
  ) {
    return cb(
      new Error("Only JPG, JPEG, PNG, WEBP, and SVG logo files are allowed"),
    );
  }

  cb(null, true);
};

const uploadRegionLogo = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_LOGO_SIZE_BYTES,
    files: 1,
  },
});

module.exports = uploadRegionLogo;

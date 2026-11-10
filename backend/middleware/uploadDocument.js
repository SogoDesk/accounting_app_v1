const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Supporting documents (approved timesheets on invoices, vendor invoices on
// bills) can be sensitive, so they are stored OUTSIDE the public /uploads dir
// and only served back through an authenticated download endpoint.
const STORAGE_DIR = path.join(__dirname, "..", "storage", "attachments");

if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

const MAX_FILE_SIZE_MB = 15;
const MAX_FILES = 20;

const ALLOWED_EXTENSIONS = [
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".xls",
  ".xlsx",
  ".csv",
  ".doc",
  ".docx",
];

const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  // some browsers send a generic type for office files
  "application/octet-stream",
];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, STORAGE_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const base = path
      .basename(file.originalname || "document", ext)
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase();
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}-${base || "document"}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname || "").toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return cb(new Error("Unsupported file type. Allowed: PDF, images, Excel, CSV, Word."));
  }
  if (file.mimetype && !ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return cb(new Error("Unsupported file type. Allowed: PDF, images, Excel, CSV, Word."));
  }
  cb(null, true);
};

const uploadDocument = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024, files: MAX_FILES },
});

module.exports = { uploadDocument, STORAGE_DIR };

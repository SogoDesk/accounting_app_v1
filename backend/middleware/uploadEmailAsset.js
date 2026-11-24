
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const MAX_SIZE_BYTES = 4 * 1024 * 1024;

const uploadDir = path.join(__dirname, "..", "uploads", "email");

const ROLES = ["logo", "banner", "footer", "other"];

const roleOf = (value) => {
  const role = String(value || "other").trim().toLowerCase();
  return ROLES.includes(role) ? role : "other";
};

const roleFromFilename = (filename) => {
  const prefix = String(filename || "").split("__")[0];
  return ROLES.includes(prefix) ? prefix : "other";
};

const getTenantUploadDir = (tenantId) => {
  const id = Number(tenantId);

  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("Valid tenant ID is required for email image upload");
  }

  return path.join(uploadDir, `tenant-${id}`);
};

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    try {
      const tenantDir = getTenantUploadDir(req.user?.tenant_id);
      fs.mkdirSync(tenantDir, { recursive: true });
      cb(null, tenantDir);
    } catch (err) {
      cb(err);
    }
  },

  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();

    const base = path
      .basename(file.originalname || "image", ext)
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase();

    cb(
      null,
      `${roleOf(req.query.role)}__${Date.now()}-${base || "image"}${ext}`
    );
  },
});

const ALLOWED_MIME = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
];

const ALLOWED_EXT = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

const fileFilter = (_req, file, cb) => {
  const ext = path.extname(file.originalname || "").toLowerCase();

  if (!ALLOWED_MIME.includes(file.mimetype) || !ALLOWED_EXT.includes(ext)) {
    return cb(
      new Error("Only PNG, JPG, WEBP and GIF images can be used in emails")
    );
  }

  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_SIZE_BYTES,
    files: 1,
  },
});

module.exports = upload;
module.exports.uploadDir = uploadDir;
module.exports.getTenantUploadDir = getTenantUploadDir;
module.exports.MAX_SIZE_BYTES = MAX_SIZE_BYTES;
module.exports.ROLES = ROLES;
module.exports.roleOf = roleOf;
module.exports.roleFromFilename = roleFromFilename;

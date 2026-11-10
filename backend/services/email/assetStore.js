const fs = require("fs");
const path = require("path");
const uploadEmailAsset = require("../../middleware/uploadEmailAsset");
const { publicBase } = require("./renderer");

const { uploadDir, roleFromFilename } = uploadEmailAsset;

const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;

let cache = null;

const assetPath = (filename) => `/uploads/email/${filename}`;

const assetUrl = (filename) => {
  const base = publicBase();
  return base ? `${base}${assetPath(filename)}` : assetPath(filename);
};

const scan = () => {
  if (!fs.existsSync(uploadDir)) return [];
  return fs.readdirSync(uploadDir)
    .filter((f) => IMAGE_RE.test(f))
    .map((f) => {
      const { size, mtime } = fs.statSync(path.join(uploadDir, f));
      return {
        filename: f,
        role: roleFromFilename(f),
        url: assetUrl(f),
        path: assetPath(f),
        size,
        uploaded_at: mtime,
      };
    })
    .sort((a, b) => b.uploaded_at - a.uploaded_at);
};

const readAssets = () => {
  if (!cache) cache = scan();
  return cache;
};

const invalidate = () => { cache = null; };

const byRole = (role) => readAssets().find((a) => a.role === role) || null;

const brandTokens = () => ({
  email_logo_url: byRole("logo")?.url || "",
  header_banner_url: byRole("banner")?.url || "",
});

module.exports = { readAssets, byRole, brandTokens, invalidate, assetUrl, assetPath, uploadDir };

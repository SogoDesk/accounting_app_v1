
const fs = require("fs");
const path = require("path");
const uploadEmailAsset = require("../../middleware/uploadEmailAsset");
const { publicBase } = require("./renderer");
const { getTenantId } = require("../../config/tenantContext");

const { uploadDir, getTenantUploadDir, roleFromFilename } = uploadEmailAsset;

const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;

const getTenantDir = () => getTenantUploadDir(getTenantId());

const assetPath = (filename) => {
  const tenantId = Number(getTenantId());

  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new Error("Valid tenant context is required for email assets");
  }

  return `/uploads/email/tenant-${tenantId}/${filename}`;
};

const assetUrl = (filename) => {
  const base = publicBase();
  const filePath = assetPath(filename);
  return base ? `${base}${filePath}` : filePath;
};

const scan = () => {
  const tenantDir = getTenantDir();

  if (!fs.existsSync(tenantDir)) return [];

  return fs.readdirSync(tenantDir)
    .filter((filename) => IMAGE_RE.test(filename))
    .map((filename) => {
      const fullPath = path.join(tenantDir, filename);
      const { size, mtime } = fs.statSync(fullPath);

      return {
        filename,
        role: roleFromFilename(filename),
        url: assetUrl(filename),
        path: assetPath(filename),
        size,
        uploaded_at: mtime,
      };
    })
    .sort((a, b) => b.uploaded_at - a.uploaded_at);
};

const cache = new Map();

const readAssets = () => {
  const tenantId = Number(getTenantId());

  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new Error("Valid tenant context is required for email assets");
  }

  if (!cache.has(tenantId)) {
    cache.set(tenantId, scan());
  }

  return cache.get(tenantId);
};

const invalidate = () => {
  const tenantId = Number(getTenantId());
  if (Number.isInteger(tenantId) && tenantId > 0) {
    cache.delete(tenantId);
  }
};

const byRole = (role) =>
  readAssets().find((asset) => asset.role === role) || null;

const brandTokens = () => ({
  email_logo_url: byRole("logo")?.url || "",
  header_banner_url: byRole("banner")?.url || "",
});

module.exports = {
  readAssets,
  byRole,
  brandTokens,
  invalidate,
  assetUrl,
  assetPath,
  uploadDir,
  getTenantDir,
};

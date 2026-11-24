
const fs = require("fs");
const path = require("path");
const renderer = require("../services/email/renderer");
const assetStore = require("../services/email/assetStore");

const safeAssetName = (name) => {
  const clean = path.basename(String(name || ""));
  return /^[a-zA-Z0-9._-]+$/.test(clean) ? clean : null;
};

const list = async (_req, res) => {
  try {
    return res.json({
      success: true,
      data: assetStore.readAssets(),
      base_url: renderer.publicBase(),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

const upload = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No image uploaded",
      });
    }

    assetStore.invalidate();

    const uploaded = assetStore
      .readAssets()
      .find((asset) => asset.filename === req.file.filename);

    const role = uploaded?.role || "other";

    // Keep only one logo, banner or footer per tenant.
    if (role !== "other") {
      for (const asset of assetStore.readAssets()) {
        if (asset.role !== role || asset.filename === req.file.filename) {
          continue;
        }

        const target = path.join(assetStore.getTenantDir(), asset.filename);

        try {
          fs.unlinkSync(target);
        } catch (err) {
          if (err.code !== "ENOENT") throw err;
        }
      }

      assetStore.invalidate();
    }

    return res.status(201).json({
      success: true,
      message: "Image uploaded",
      data: {
        filename: req.file.filename,
        role,
        url: assetStore.assetUrl(req.file.filename),
        path: assetStore.assetPath(req.file.filename),
        size: req.file.size,
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

const remove = async (req, res) => {
  try {
    const name = safeAssetName(req.params.filename);

    if (!name) {
      return res.status(400).json({
        success: false,
        message: "Invalid file name",
      });
    }

    const target = path.join(assetStore.getTenantDir(), name);

    if (!fs.existsSync(target)) {
      return res.status(404).json({
        success: false,
        message: "Image not found",
      });
    }

    fs.unlinkSync(target);
    assetStore.invalidate();

    return res.json({
      success: true,
      message: "Image deleted",
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

module.exports = { list, upload, remove };

const express = require("express");
const router = express.Router();

const c = require("../controllers/emailController");
const assets = require("../controllers/emailAssetController");
const { authenticate } = require("../middleware/authMiddleware");
const { permit } = require("../middleware/permissionMiddleware");
const { scopeAccess } = require("../middleware/scopeMiddleware");
const uploadEmailAsset = require("../middleware/uploadEmailAsset");

const guard = permit("invoices", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN");

const uploadOne = (req, res, next) =>
  uploadEmailAsset.single("file")(req, res, (err) => {
    if (!err) return next();
    const message = err.code === "LIMIT_FILE_SIZE"
      ? "Image must be 4MB or smaller"
      : err.message || "Upload failed";
    return res.status(400).json({ success: false, message });
  });

router.use(authenticate, scopeAccess);

router.get("/", guard, c.listTemplates);
router.get("/preview-invoices", guard, c.previewInvoiceOptions);
router.post("/preview", guard, c.previewTemplate);
router.get("/schedule", guard, c.getSchedule);
router.put("/schedule", guard, c.updateSchedule);
router.get("/assets", guard, assets.list);
router.post("/assets", guard, uploadOne, assets.upload);
router.delete("/assets/:filename", guard, assets.remove);
router.put("/:key", guard, c.updateTemplate);
router.post("/:key/reset", guard, c.resetTemplate);

module.exports = router;

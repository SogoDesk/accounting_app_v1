
const express = require("express");
const router = express.Router();

const attachmentController = require("../controllers/attachmentController");
const { authenticate, authorize } = require("../middleware/authMiddleware");
const { scopeAccess } = require("../middleware/scopeMiddleware");
const { uploadDocument } = require("../middleware/uploadDocument");
const tenantMiddleware = require("../middleware/tenantMiddleware");

// Tenant isolation and row-level access
router.use(authenticate, tenantMiddleware, scopeAccess);

const finance = authorize("SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN");

// Specific route first so it isn't shadowed by "/:entityType/:entityId".
router.get("/file/:id", finance, attachmentController.downloadAttachment);
router.get("/:entityType/:entityId", finance, attachmentController.listAttachments);
router.post(
  "/:entityType/:entityId",
  finance,
  uploadDocument.array("files", 20),
  attachmentController.uploadAttachments,
);
router.delete("/:id", finance, attachmentController.deleteAttachment);

module.exports = router;

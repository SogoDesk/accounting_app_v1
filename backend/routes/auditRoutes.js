
const express = require("express");
const router = express.Router();

const auditController = require("../controllers/auditController");
const { authenticate } = require("../middleware/authMiddleware");
const { permit } = require("../middleware/permissionMiddleware");
const tenantMiddleware = require("../middleware/tenantMiddleware");

// Authenticate the user and establish tenant context.
router.use(authenticate, tenantMiddleware);

// Get audit logs.
router.get(
  "/",
  permit("auditLogs", "SUPER_ADMIN", "ADMIN"),
  auditController.getAuditLogs
);

module.exports = router;

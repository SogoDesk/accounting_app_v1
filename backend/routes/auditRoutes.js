const express = require("express");
const router = express.Router();

const auditController = require("../controllers/auditController");
const { authenticate } = require("../middleware/authMiddleware");
const { permit } = require("../middleware/permissionMiddleware");

router.get(
  "/",
  authenticate,
  permit("auditLogs", "SUPER_ADMIN", "ADMIN"),
  auditController.getAuditLogs,
);

module.exports = router;

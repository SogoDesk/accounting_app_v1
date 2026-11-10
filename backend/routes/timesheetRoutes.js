const express = require("express");
const router = express.Router();

const timesheetController = require("../controllers/timesheetController");
const { authenticate } = require("../middleware/authMiddleware");
const { permit } = require("../middleware/permissionMiddleware");
const { scopeAccess } = require("../middleware/scopeMiddleware");

// Row-level RBAC scope (req.allowedEntityIds) on every timesheet route.
router.use(authenticate, scopeAccess);

const finance = permit("timesheets", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN");

router.get("/", finance, timesheetController.listTimesheets);
router.post("/", finance, timesheetController.createTimesheet);
router.post("/:id/create-invoice", finance, timesheetController.createInvoiceFromTimesheet);
router.patch("/:id/status", finance, timesheetController.setStatus);
router.put("/:id", finance, timesheetController.updateTimesheet);
router.delete("/:id", finance, timesheetController.deleteTimesheet);

module.exports = router;

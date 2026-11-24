
const express = require("express");
const billController = require("../controllers/billController");
const { authenticate, authorize } = require("../middleware/authMiddleware");
const { permit } = require("../middleware/permissionMiddleware");
const { scopeAccess } = require("../middleware/scopeMiddleware");
const tenantMiddleware = require("../middleware/tenantMiddleware");

const router = express.Router();

// Tenant isolation and row-level access
router.use(authenticate, tenantMiddleware, scopeAccess);

router.get("/", authenticate, permit("bills", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"), billController.getAllBills);
router.get("/export", authenticate, permit("bills", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"), billController.exportBills);
router.get("/:id/pdf", authenticate, permit("bills", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"), billController.downloadBillPdf);
router.get("/:id", authenticate, permit("bills", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"), billController.getBillById);
router.post("/", authenticate, permit("bills", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"), billController.createBill);
router.put("/:id", authenticate, permit("bills", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"), billController.updateBill);
router.patch("/:id/status", authenticate, permit("bills", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"), billController.updateBillStatus);
router.delete("/:id", authenticate, authorize("SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"), billController.deleteBill);

module.exports = router;

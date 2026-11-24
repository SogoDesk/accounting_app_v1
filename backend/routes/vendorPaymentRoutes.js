
const express = require("express");
const vendorPaymentController = require("../controllers/vendorPaymentController");
const { authenticate, authorize } = require("../middleware/authMiddleware");
const { permit } = require("../middleware/permissionMiddleware");
const { scopeAccess } = require("../middleware/scopeMiddleware");
const tenantMiddleware = require("../middleware/tenantMiddleware");

const router = express.Router();

// Tenant isolation and row-level access
router.use(authenticate, tenantMiddleware, scopeAccess);

router.get("/", authenticate, permit("vendorPayments", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"), vendorPaymentController.getAllVendorPayments);
router.get("/bill-options", authenticate, permit("vendorPayments", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"), vendorPaymentController.getVendorPaymentBillOptions);
router.get("/next-code", authenticate, permit("vendorPayments", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"), vendorPaymentController.getNextVendorPaymentCode);
router.get("/:id/receipt", authenticate, permit("vendorPayments", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"), vendorPaymentController.downloadVendorPaymentReceipt);
router.get("/:id", authenticate, permit("vendorPayments", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"), vendorPaymentController.getVendorPaymentById);
router.post("/", authenticate, permit("vendorPayments", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"), vendorPaymentController.createVendorPayment);
router.put("/:id", authenticate, permit("vendorPayments", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"), vendorPaymentController.updateVendorPayment);
router.delete("/:id", authenticate, authorize("SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"), vendorPaymentController.deleteVendorPayment);

module.exports = router;


const express = require("express");
const router = express.Router();

const paymentController = require("../controllers/paymentController");
const { authenticate, authorize } = require("../middleware/authMiddleware");
const { permit } = require("../middleware/permissionMiddleware");
const { scopeAccess } = require("../middleware/scopeMiddleware");
const tenantMiddleware = require("../middleware/tenantMiddleware");

// Tenant isolation and row-level access
router.use(authenticate, tenantMiddleware, scopeAccess);

// Get all payments
router.get(
  "/",
  authenticate,
  permit("payments", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  paymentController.getAllPayments,
);

// Get invoice options
router.get(
  "/invoice-options",
  authenticate,
  permit("payments", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  paymentController.getPaymentInvoiceOptions,
);

// Get next payment code
router.get(
  "/next-code",
  authenticate,
  permit("payments", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  paymentController.getNextPaymentCode,
);

// Export payments
router.get(
  "/export",
  authenticate,
  permit("payments", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  paymentController.exportPayments,
);

// Download payment receipt
router.get(
  "/:id/receipt",
  authenticate,
  permit("payments", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  paymentController.downloadReceiptPdf,
);

// Get payment by ID
router.get(
  "/:id",
  authenticate,
  permit("payments", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  paymentController.getPaymentById,
);

// Create payment
router.post(
  "/",
  authenticate,
  permit("payments", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  paymentController.createPayment,
);

// Update payment
router.put(
  "/:id",
  authenticate,
  permit("payments", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  paymentController.updatePayment,
);

// Delete payment
router.delete(
  "/:id",
  authenticate,
  authorize("SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  paymentController.deletePayment,
);

module.exports = router;

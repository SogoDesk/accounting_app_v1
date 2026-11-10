const express = require("express");
const router = express.Router();

const paymentController = require("../controllers/paymentController");
const { authenticate, authorize } = require("../middleware/authMiddleware");
const { permit } = require("../middleware/permissionMiddleware");
const { scopeAccess } = require("../middleware/scopeMiddleware");

// Attach row-level RBAC scope (req.allowedEntityIds) to every payment route.
router.use(authenticate, scopeAccess);

router.get(
  "/",
  authenticate,
  permit("payments", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  paymentController.getAllPayments,
);

router.get(
  "/invoice-options",
  authenticate,
  permit("payments", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  paymentController.getPaymentInvoiceOptions,
);

router.get(
  "/next-code",
  authenticate,
  permit("payments", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  paymentController.getNextPaymentCode,
);

router.get(
  "/export",
  authenticate,
  permit("payments", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  paymentController.exportPayments,
);

router.get(
  "/:id/receipt",
  authenticate,
  permit("payments", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  paymentController.downloadReceiptPdf,
);

router.get(
  "/:id",
  authenticate,
  permit("payments", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  paymentController.getPaymentById,
);

router.post(
  "/",
  authenticate,
  permit("payments", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  paymentController.createPayment,
);

router.put(
  "/:id",
  authenticate,
  permit("payments", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  paymentController.updatePayment,
);

router.delete(
  "/:id",
  authenticate,
  authorize("SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  paymentController.deletePayment,
);

module.exports = router;

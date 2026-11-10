const express = require("express");
const router = express.Router();

const invoiceController = require("../controllers/invoiceController");
const emailController = require("../controllers/emailController");
const { authenticate, authorize } = require("../middleware/authMiddleware");
const { permit } = require("../middleware/permissionMiddleware");
const { scopeAccess } = require("../middleware/scopeMiddleware");

// Attach row-level RBAC scope (req.allowedEntityIds) to every invoice route.
router.use(authenticate, scopeAccess);

router.get(
  "/",
  authenticate,
  permit("invoices", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  invoiceController.getAllInvoices,
);

router.get(
  "/export",
  authenticate,
  permit("invoices", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  invoiceController.exportInvoices,
);

router.get(
  "/placement-options",
  authenticate,
  permit("invoices", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  invoiceController.getInvoicePlacementOptions,
);

router.get(
  "/next-number-preview",
  authenticate,
  permit("invoices", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  invoiceController.getNextInvoiceNumberPreview,
);

router.get(
  "/:id/print",
  authenticate,
  permit("invoices", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  invoiceController.getInvoicePrintData,
);

router.get(
  "/:id/pdf",
  authenticate,
  permit("invoices", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  invoiceController.downloadInvoicePdf,
);

router.get(
  "/:id",
  authenticate,
  permit("invoices", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  invoiceController.getInvoiceById,
);

router.post(
  "/:id/send-email",
  authenticate,
  permit("invoices", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  emailController.sendInvoiceEmail,
);

router.get(
  "/:id/email-history",
  authenticate,
  permit("invoices", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  emailController.invoiceEmailHistory,
);

router.post(
  "/",
  authenticate,
  permit("invoices", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  invoiceController.createInvoice,
);

router.put(
  "/:id",
  authenticate,
  permit("invoices", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  invoiceController.updateInvoice,
);

router.patch(
  "/:id/status",
  authenticate,
  permit("invoices", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  invoiceController.updateInvoiceStatus,
);

router.delete(
  "/:id",
  authenticate,
  authorize("SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  invoiceController.deleteInvoice,
);

module.exports = router;

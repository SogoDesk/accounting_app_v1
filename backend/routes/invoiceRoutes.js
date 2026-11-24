
const express = require("express");
const router = express.Router();

const invoiceController = require("../controllers/invoiceController");
const emailController = require("../controllers/emailController");

const { authenticate, authorize } = require("../middleware/authMiddleware");
const { permit } = require("../middleware/permissionMiddleware");
const { scopeAccess } = require("../middleware/scopeMiddleware");
const tenantMiddleware = require("../middleware/tenantMiddleware");

// Authentication, tenant isolation, and row-level access
router.use(authenticate, tenantMiddleware, scopeAccess);

// Get all invoices
router.get(
  "/",
  permit("invoices", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  invoiceController.getAllInvoices,
);

// Export invoices
router.get(
  "/export",
  permit("invoices", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  invoiceController.exportInvoices,
);

// Get placement options
router.get(
  "/placement-options",
  permit("invoices", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  invoiceController.getInvoicePlacementOptions,
);

// Preview next invoice number
router.get(
  "/next-number-preview",
  permit("invoices", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  invoiceController.getNextInvoiceNumberPreview,
);

// Get invoice print data
router.get(
  "/:id/print",
  permit("invoices", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  invoiceController.getInvoicePrintData,
);

// Download invoice PDF
router.get(
  "/:id/pdf",
  permit("invoices", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  invoiceController.downloadInvoicePdf,
);

// Get invoice by ID
router.get(
  "/:id",
  permit("invoices", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  invoiceController.getInvoiceById,
);

// Send invoice email
router.post(
  "/:id/send-email",
  permit("invoices", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  emailController.sendInvoiceEmail,
);

// Get invoice email history
router.get(
  "/:id/email-history",
  permit("invoices", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  emailController.invoiceEmailHistory,
);

// Create invoice
router.post(
  "/",
  permit("invoices", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  invoiceController.createInvoice,
);

// Update invoice
router.put(
  "/:id",
  permit("invoices", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  invoiceController.updateInvoice,
);

// Update invoice status
router.patch(
  "/:id/status",
  permit("invoices", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  invoiceController.updateInvoiceStatus,
);

// Delete invoice
router.delete(
  "/:id",
  authorize("SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  invoiceController.deleteInvoice,
);

module.exports = router;

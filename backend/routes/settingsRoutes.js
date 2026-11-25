
const express = require("express");
const router = express.Router();

const settingsController = require("../controllers/settingsController");
const { authenticate } = require("../middleware/authMiddleware");
const { permit } = require("../middleware/permissionMiddleware");
const tenantMiddleware = require("../middleware/tenantMiddleware");

const FINANCE = ["SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"];

// Settings permission guard
const settingsGuard = permit("settings", ...FINANCE);

// Tenant isolation for all authenticated settings routes
router.use(authenticate, tenantMiddleware);

// Every authenticated user can read their own effective permissions
router.get("/my-permissions", authenticate, settingsController.getMyPermissions);
router.get("/permission-catalog", authenticate, settingsController.getPermissionCatalog);

// Company / reporting currency
// Company name, logo and colours for the app shell: every signed-in user.
router.get("/branding", settingsController.getCompanyBranding);

router.get("/company", authenticate, settingsGuard, settingsController.getCompanySettings);
router.put("/company", authenticate, settingsGuard, settingsController.updateCompanySettings);

// Exchange rates
router.get("/exchange-rates", authenticate, settingsGuard, settingsController.listExchangeRates);
router.post("/exchange-rates", authenticate, settingsGuard, settingsController.upsertManualRate);

// Invoice reminders / notifications
router.get("/reminders", authenticate, settingsGuard, settingsController.getReminderSettings);
router.put("/reminders", authenticate, settingsGuard, settingsController.updateReminderSettings);

// Document numbering
router.get("/numbering", authenticate, settingsGuard, settingsController.listNumbering);
router.put("/numbering/:doc_type", authenticate, settingsGuard, settingsController.updateNumbering);

// Fiscal year overview
router.get("/fiscal", authenticate, settingsGuard, settingsController.getFiscalOverview);

// Tax rates
router.get("/tax-rates", authenticate, settingsGuard, settingsController.listTaxRates);
router.post("/tax-rates", authenticate, settingsGuard, settingsController.createTaxRate);
router.put("/tax-rates/:id", authenticate, settingsGuard, settingsController.updateTaxRate);
router.delete("/tax-rates/:id", authenticate, settingsGuard, settingsController.deleteTaxRate);

module.exports = router;

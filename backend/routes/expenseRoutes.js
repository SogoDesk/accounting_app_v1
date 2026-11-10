const express = require("express");
const c = require("../controllers/expenseController");
const { authenticate } = require("../middleware/authMiddleware");
const { permit } = require("../middleware/permissionMiddleware");
const { scopeAccess } = require("../middleware/scopeMiddleware");

const router = express.Router();
const finance = permit("expenses", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN");

// Attach row-level RBAC scope (req.allowedEntityIds) to every expense route.
router.use(authenticate, scopeAccess);

router.get("/categories", authenticate, finance, c.listCategories);
router.post("/categories", authenticate, finance, c.createCategory);
router.get("/categories/:id/overview", authenticate, finance, c.categoryOverview);
router.put("/categories/:id", authenticate, finance, c.updateCategory);
router.get("/payment-methods", authenticate, finance, c.listPaymentMethods);
router.post("/payment-methods", authenticate, finance, c.createPaymentMethod);

router.get("/export", authenticate, finance, c.exportExpenses);
router.get("/", authenticate, finance, c.listExpenses);
router.post("/", authenticate, finance, c.createExpense);
router.put("/:id", authenticate, finance, c.updateExpense);
router.delete("/:id", authenticate, finance, c.deleteExpense);
router.post("/:id/reimburse", authenticate, finance, c.reimburseExpense);

router.get("/recurring", authenticate, finance, c.listRecurring);
router.post("/recurring", authenticate, finance, c.createRecurring);
router.get("/recurring/status", authenticate, finance, c.recurringStatus);
router.post("/recurring/run", authenticate, finance, c.runRecurring);

router.get("/reports/by-category", authenticate, finance, c.reportByCategory);
router.get("/reports/summary", authenticate, finance, c.reportSummary);

module.exports = router;

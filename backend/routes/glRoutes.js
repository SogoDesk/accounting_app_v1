const express = require("express");
const glController = require("../controllers/glController");
const { authenticate } = require("../middleware/authMiddleware");
const { permit } = require("../middleware/permissionMiddleware");
const { scopeAccess } = require("../middleware/scopeMiddleware");

const router = express.Router();
const finance = permit("accounting", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN");

// Attach row-level RBAC scope (req.allowedEntityIds) to every GL route.
router.use(authenticate, scopeAccess);

router.get("/chart-of-accounts", finance, glController.getChartOfAccounts);
router.post("/chart-of-accounts", finance, glController.createAccount);
router.put("/chart-of-accounts/:id", finance, glController.updateAccount);
router.get("/journal-entries", finance, glController.getJournalEntries);
router.post("/journal-entries", finance, glController.createManualJournalEntry);
router.get("/journal-entries/:id", finance, glController.getJournalEntryById);
router.get("/accounts/:id/register", finance, glController.getAccountRegister);
router.get("/reports/trial-balance", finance, glController.getTrialBalance);
router.get("/reports/profit-and-loss", finance, glController.getProfitAndLoss);
router.get("/reports/balance-sheet", finance, glController.getBalanceSheet);
router.get("/reports/consolidated", finance, glController.getConsolidated);
router.get("/reports/general-ledger", finance, glController.getGeneralLedger);
router.get("/reports/cash-flow", finance, glController.getCashFlow);
router.get("/reports/:type/export", finance, glController.exportReport);

// Period close — FX revaluation + accrual/deferral recognition (manual "run now")
router.post("/fx-revalue", finance, glController.postFxRevalue);
router.get("/recognition/schedules", finance, glController.listRecognitionSchedules);
router.post("/recognition/schedules", finance, glController.createRecognitionSchedule);
router.post("/recognition/run", finance, glController.runRecognition);
router.post("/period-close/run", finance, glController.runPeriodClose);
router.post("/period-close/reopen", finance, glController.reopenPeriod);

module.exports = router;

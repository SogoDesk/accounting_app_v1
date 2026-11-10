const express = require("express");
const multer = require("multer");
const bank = require("../controllers/bankController");
const { authenticate } = require("../middleware/authMiddleware");
const { scopeAccess } = require("../middleware/scopeMiddleware");

const router = express.Router();

// Statement files are parsed in-memory (no disk persistence). 10 MB cap.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Row-level RBAC on every banking request.
router.use(authenticate, scopeAccess);

// Bank accounts
router.get("/accounts", bank.listAccounts);
router.post("/accounts", bank.createAccount);
router.put("/accounts/:id", bank.updateAccount);
router.delete("/accounts/:id", bank.deleteAccount);

// Statement import (auto bank feed) + transactions
router.post("/accounts/:id/import", upload.single("file"), bank.importStatement);
router.get("/accounts/:id/transactions", bank.listTransactions);
router.post("/accounts/:id/auto-match", bank.autoMatch);
router.get("/accounts/:id/summary", bank.summary);

// Transaction-level matching
router.get("/transactions/:txnId/suggestions", bank.suggestMatches);
router.post("/transactions/:txnId/match", bank.matchTransaction);
router.post("/transactions/:txnId/unmatch", bank.unmatchTransaction);
router.post("/transactions/:txnId/book", bank.bookTransaction);

// Reconciliation
router.get("/accounts/:id/reconciliations", bank.listReconciliations);
router.post("/accounts/:id/reconciliations", bank.openReconciliation);
router.post("/reconciliations/:recId/complete", bank.completeReconciliation);

module.exports = router;

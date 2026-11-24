
const express = require("express");
const intercompanyController = require("../controllers/intercompanyController");
const { authenticate } = require("../middleware/authMiddleware");
const { permit } = require("../middleware/permissionMiddleware");
const { scopeAccess } = require("../middleware/scopeMiddleware");
const tenantMiddleware = require("../middleware/tenantMiddleware");

const router = express.Router();
const finance = permit("accounting", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN");

// Tenant isolation and row-level access
router.use(authenticate, tenantMiddleware, scopeAccess);

router.get("/transfers", finance, intercompanyController.listTransfers);
router.post("/transfers", finance, intercompanyController.createTransfer);

module.exports = router;


const express = require("express");
const orgController = require("../controllers/orgController");
const { authenticate } = require("../middleware/authMiddleware");
const { scopeAccess } = require("../middleware/scopeMiddleware");
const tenantMiddleware = require("../middleware/tenantMiddleware");

const router = express.Router();

// Tenant isolation and row-level access
router.use(authenticate, tenantMiddleware, scopeAccess);

router.get("/", orgController.listOrgUnits);

module.exports = router;


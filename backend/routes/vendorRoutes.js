
const express = require("express");
const vendorController = require("../controllers/vendorController");
const { authenticate, authorize } = require("../middleware/authMiddleware");
const { permit } = require("../middleware/permissionMiddleware");
const { scopeAccess } = require("../middleware/scopeMiddleware");
const tenantMiddleware = require("../middleware/tenantMiddleware");

const router = express.Router();

// Tenant isolation and row-level access
router.use(authenticate, tenantMiddleware, scopeAccess);

router.get("/", authenticate, permit("vendors", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"), vendorController.getAllVendors);
router.get("/:id/overview", authenticate, permit("vendors", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"), vendorController.getVendorOverview);
router.get("/:id", authenticate, permit("vendors", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"), vendorController.getVendorById);
router.post("/", authenticate, permit("vendors", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"), vendorController.createVendor);
router.put("/:id", authenticate, permit("vendors", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"), vendorController.updateVendor);
router.delete("/:id", authenticate, authorize("SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"), vendorController.deleteVendor);

module.exports = router;

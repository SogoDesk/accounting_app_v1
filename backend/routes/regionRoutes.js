
const express = require("express");
const router = express.Router();

const regionController = require("../controllers/regionController");
const { authenticate, authorize } = require("../middleware/authMiddleware");
const { permit } = require("../middleware/permissionMiddleware");
const { scopeAccess } = require("../middleware/scopeMiddleware");
const tenantMiddleware = require("../middleware/tenantMiddleware");
const uploadRegionLogo = require("../middleware/uploadRegionLogo");

// Row-level RBAC and tenant isolation
router.use(authenticate, tenantMiddleware, scopeAccess);

// Get all regions
router.get("/", authenticate, regionController.getAllRegions);

// Create region
router.post(
  "/",
  authenticate,
  permit("regions", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  uploadRegionLogo.single("logo"),
  regionController.createRegion,
);

// Update region
router.put(
  "/:id",
  authenticate,
  permit("regions", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  uploadRegionLogo.single("logo"),
  regionController.updateRegion,
);

// Delete region
router.delete(
  "/:id",
  authenticate,
  authorize("SUPER_ADMIN"),
  regionController.deleteRegion,
);

module.exports = router;

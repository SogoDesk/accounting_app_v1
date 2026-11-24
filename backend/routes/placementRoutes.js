
const express = require("express");
const router = express.Router();

const placementController = require("../controllers/placementController");
const { authenticate, authorize } = require("../middleware/authMiddleware");
const { permit } = require("../middleware/permissionMiddleware");
const { scopeAccess } = require("../middleware/scopeMiddleware");
const tenantMiddleware = require("../middleware/tenantMiddleware");

// Tenant isolation and row-level access
router.use(authenticate, tenantMiddleware, scopeAccess);

// Get all placements
router.get(
  "/",
  authenticate,
  permit("placements", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  placementController.getAllPlacements,
);

// Get placement overview
router.get(
  "/:id/overview",
  authenticate,
  permit("placements", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  placementController.getPlacementOverview,
);

// Get placement by ID
router.get(
  "/:id",
  authenticate,
  permit("placements", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  placementController.getPlacementById,
);

// Create placement
router.post(
  "/",
  authenticate,
  permit("placements", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  placementController.createPlacement,
);

// Update placement
router.put(
  "/:id",
  authenticate,
  permit("placements", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  placementController.updatePlacement,
);

// Delete placement
router.delete(
  "/:id",
  authenticate,
  authorize("SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  placementController.deletePlacement,
);

module.exports = router;

const express = require("express");
const router = express.Router();

const placementController = require("../controllers/placementController");
const { authenticate, authorize } = require("../middleware/authMiddleware");
const { permit } = require("../middleware/permissionMiddleware");
const { scopeAccess } = require("../middleware/scopeMiddleware");

// Row-level RBAC: attach the caller's allowed entities to every placement request.
router.use(authenticate, scopeAccess);

router.get(
  "/",
  authenticate,
  permit("placements", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  placementController.getAllPlacements,
);
router.get(
  "/:id/overview",
  authenticate,
  permit("placements", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  placementController.getPlacementOverview,
);
router.get(
  "/:id",
  authenticate,
  permit("placements", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  placementController.getPlacementById,
);

router.post(
  "/",
  authenticate,
  permit("placements", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  placementController.createPlacement,
);

router.put(
  "/:id",
  authenticate,
  permit("placements", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  placementController.updatePlacement,
);

router.delete(
  "/:id",
  authenticate,
  authorize("SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  placementController.deletePlacement,
);

module.exports = router;

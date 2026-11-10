const express = require("express");
const router = express.Router();

const regionController = require("../controllers/regionController");
const { authenticate, authorize } = require("../middleware/authMiddleware");
const { permit } = require("../middleware/permissionMiddleware");
const { scopeAccess } = require("../middleware/scopeMiddleware");
const uploadRegionLogo = require("../middleware/uploadRegionLogo");

// Row-level RBAC: a region is the legal entity; attach the caller's allowed set.
router.use(authenticate, scopeAccess);

router.get("/", authenticate, regionController.getAllRegions);

router.post(
  "/",
  authenticate,
  permit("regions", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  uploadRegionLogo.single("logo"),
  regionController.createRegion,
);

router.put(
  "/:id",
  authenticate,
  permit("regions", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  uploadRegionLogo.single("logo"),
  regionController.updateRegion,
);

router.delete(
  "/:id",
  authenticate,
  authorize("SUPER_ADMIN"),
  regionController.deleteRegion,
);

module.exports = router;

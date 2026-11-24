
const express = require("express");
const router = express.Router();

const candidateController = require("../controllers/candidateController");
const { authenticate, authorize } = require("../middleware/authMiddleware");
const { permit } = require("../middleware/permissionMiddleware");
const tenantMiddleware = require("../middleware/tenantMiddleware");

// Tenant isolation
router.use(authenticate, tenantMiddleware);

// Get all candidates
router.get("/", authenticate, candidateController.getAllCandidates);

// Get candidate overview
router.get("/:id/overview", authenticate, candidateController.getCandidateOverview);

// Get candidate by ID
router.get("/:id", authenticate, candidateController.getCandidateById);

// Create candidate
router.post(
  "/",
  authenticate,
  permit("candidates", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  candidateController.createCandidate,
);

// Update candidate
router.put(
  "/:id",
  authenticate,
  permit("candidates", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  candidateController.updateCandidate,
);

// Delete candidate
router.delete(
  "/:id",
  authenticate,
  authorize("SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  candidateController.deleteCandidate,
);

module.exports = router;

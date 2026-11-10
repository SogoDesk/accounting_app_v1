const express = require("express");
const router = express.Router();

const candidateController = require("../controllers/candidateController");
const { authenticate, authorize } = require("../middleware/authMiddleware");
const { permit } = require("../middleware/permissionMiddleware");

router.get("/", authenticate, candidateController.getAllCandidates);
router.get("/:id/overview", authenticate, candidateController.getCandidateOverview);
router.get("/:id", authenticate, candidateController.getCandidateById);

router.post(
  "/",
  authenticate,
  permit("candidates", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  candidateController.createCandidate,
);

router.put(
  "/:id",
  authenticate,
  permit("candidates", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  candidateController.updateCandidate,
);

router.delete(
  "/:id",
  authenticate,
  authorize("SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  candidateController.deleteCandidate,
);

module.exports = router;

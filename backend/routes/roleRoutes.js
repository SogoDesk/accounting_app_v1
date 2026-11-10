const express = require("express");
const router = express.Router();

const roleController = require("../controllers/roleController");
const { authenticate, authorize } = require("../middleware/authMiddleware");

// Any authenticated user may read the role list (needed by the Users form).
router.get("/", authenticate, roleController.getAllRoles);

// Managing roles + their permissions is restricted to the highest tier.
router.post("/", authenticate, authorize("SUPER_ADMIN"), roleController.createRole);
router.put("/:id", authenticate, authorize("SUPER_ADMIN"), roleController.updateRole);
router.delete("/:id", authenticate, authorize("SUPER_ADMIN"), roleController.deleteRole);

module.exports = router;

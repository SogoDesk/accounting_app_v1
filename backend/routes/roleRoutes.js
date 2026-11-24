
const express = require("express");
const router = express.Router();

const roleController = require("../controllers/roleController");
const { authenticate, authorize } = require("../middleware/authMiddleware");
const tenantMiddleware = require("../middleware/tenantMiddleware");

// Tenant isolation
router.use(authenticate, tenantMiddleware);

// Get all roles
router.get("/", authenticate, roleController.getAllRoles);

// Create role
router.post("/", authenticate, authorize("SUPER_ADMIN"), roleController.createRole);

// Update role
router.put("/:id", authenticate, authorize("SUPER_ADMIN"), roleController.updateRole);

// Delete role
router.delete("/:id", authenticate, authorize("SUPER_ADMIN"), roleController.deleteRole);

module.exports = router;

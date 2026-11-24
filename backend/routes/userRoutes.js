
const express = require("express");
const router = express.Router();

const userController = require("../controllers/userController");
const { authenticate, authorize } = require("../middleware/authMiddleware");
const { permit } = require("../middleware/permissionMiddleware");
const tenantMiddleware = require("../middleware/tenantMiddleware");

// Get all users
router.get(
  "/",
  authenticate,
  tenantMiddleware,
  permit("users", "SUPER_ADMIN", "ADMIN"),
  userController.getAllUsers,
);

// Create user
router.post(
  "/",
  authenticate,
  tenantMiddleware,
  authorize("SUPER_ADMIN"),
  userController.createUser,
);

// Update user
router.put(
  "/:id",
  authenticate,
  tenantMiddleware,
  authorize("SUPER_ADMIN"),
  userController.updateUser,
);

// Delete user
router.delete(
  "/:id",
  authenticate,
  tenantMiddleware,
  authorize("SUPER_ADMIN"),
  userController.deleteUser,
);

module.exports = router;

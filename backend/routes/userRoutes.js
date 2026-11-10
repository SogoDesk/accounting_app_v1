const express = require("express");
const router = express.Router();

const userController = require("../controllers/userController");
const { authenticate, authorize } = require("../middleware/authMiddleware");
const { permit } = require("../middleware/permissionMiddleware");

// Reading the user list is permission-gated (so a custom role can be granted it);
// creating/updating/deleting users stays a hard SUPER_ADMIN floor below.
router.get(
  "/",
  authenticate,
  permit("users", "SUPER_ADMIN", "ADMIN"),
  userController.getAllUsers,
);

router.post(
  "/",
  authenticate,
  authorize("SUPER_ADMIN"),
  userController.createUser,
);

router.put(
  "/:id",
  authenticate,
  authorize("SUPER_ADMIN"),
  userController.updateUser,
);

router.delete(
  "/:id",
  authenticate,
  authorize("SUPER_ADMIN"),
  userController.deleteUser,
);

module.exports = router;

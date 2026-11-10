const express = require("express");
const router = express.Router();

const authController = require("../controllers/authController");
const { authenticate } = require("../middleware/authMiddleware");

router.post("/login", authController.login);
router.get("/me", authenticate, authController.getMe);
router.patch("/change-password", authenticate, authController.changePassword);

module.exports = router;

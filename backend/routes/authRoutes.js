
const express = require("express");
const router = express.Router();

// Import controller
const authController = require("../controllers/authController");

// Import middleware
const { authenticate } = require("../middleware/authMiddleware");
const tenantMiddleware = require("../middleware/tenantMiddleware");
const inviteController = require("../controllers/inviteController");
const rateLimit = require("express-rate-limit");

const inviteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many attempts. Try again later." },
});


// 1. Public login route (no authentication required)
router.post("/login", authController.login);

// Public invitation endpoints: a newly onboarded client admin sets a password.
router.get("/invite/:token", inviteLimiter, inviteController.getInvite);
router.post("/invite/accept", inviteLimiter, inviteController.accept);

// 2. Protected route - get logged-in user
router.get(
  "/me",
  authenticate,
  tenantMiddleware,
  authController.getMe
);

// 3. Protected route - change password
router.patch(
  "/change-password",
  authenticate,
  tenantMiddleware,
  authController.changePassword
);

// Export router
module.exports = router;

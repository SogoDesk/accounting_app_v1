const express = require("express");
const rateLimit = require("express-rate-limit");

const { authenticatePlatform } = require("../middleware/platformAuthMiddleware");
const platformAuthController = require("../controllers/platformAuthController");
const platformController = require("../controllers/platformController");

const router = express.Router();

// Platform login is public but tightly rate limited.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many login attempts. Try again in 15 minutes." },
});

router.post("/auth/login", loginLimiter, platformAuthController.login);

// Everything below requires a platform token (not a tenant token).
router.use(authenticatePlatform);

router.get("/auth/me", platformAuthController.me);

// Create a new tenant
router.post("/tenants", platformController.createTenant);

// Get all tenants
router.get("/tenants", platformController.getTenants);

// Check whether a company code is valid and free (before /tenants/:id)
router.get("/tenants/check-code", platformController.checkTenantCode);

// Client detail
router.get("/tenants/:id", platformController.getTenant);

// Re-send the set-password invitation to a client admin
router.post("/tenants/:id/admins/:userId/resend-invite", platformController.resendInvite);

// Suspend or reactivate a tenant
router.patch("/tenants/:id", platformController.updateTenantStatus);

module.exports = router;

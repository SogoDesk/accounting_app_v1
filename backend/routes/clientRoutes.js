const express = require("express");
const router = express.Router();

const clientController = require("../controllers/clientController");
const { authenticate, authorize } = require("../middleware/authMiddleware");
const { permit } = require("../middleware/permissionMiddleware");
const { scopeAccess } = require("../middleware/scopeMiddleware");

// Row-level RBAC: attach the caller's allowed entities/locations to every
// client request so the controller can scope reads and validate writes.
router.use(authenticate, scopeAccess);

router.get("/", authenticate, clientController.getAllClients);
router.get("/:id/overview", authenticate, clientController.getClientOverview);
router.get("/:id", authenticate, clientController.getClientById);

router.post(
  "/",
  authenticate,
  permit("clients", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  clientController.createClient,
);

router.put(
  "/:id",
  authenticate,
  permit("clients", "SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  clientController.updateClient,
);

router.delete(
  "/:id",
  authenticate,
  authorize("SUPER_ADMIN", "ADMIN", "FINANCE_ADMIN"),
  clientController.deleteClient,
);

module.exports = router;

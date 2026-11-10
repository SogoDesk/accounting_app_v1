const express = require("express");
const orgController = require("../controllers/orgController");
const { authenticate } = require("../middleware/authMiddleware");
const { scopeAccess } = require("../middleware/scopeMiddleware");

const router = express.Router();

router.use(authenticate, scopeAccess);

router.get("/", orgController.listOrgUnits);

module.exports = router;

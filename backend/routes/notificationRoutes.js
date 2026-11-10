const express = require("express");
const router = express.Router();

const notificationController = require("../controllers/notificationController");
const { authenticate } = require("../middleware/authMiddleware");

router.get("/", authenticate, notificationController.getNotifications);
router.patch(
  "/mark-all-read",
  authenticate,
  notificationController.markAllRead,
);
router.patch("/read-all", authenticate, notificationController.markAllRead);
router.put("/read-all", authenticate, notificationController.markAllRead);

module.exports = router;

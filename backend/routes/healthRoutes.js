const express = require("express");
const { dbHealthCheck } = require("../controllers/healthController");

const router = express.Router();

router.get("/db", dbHealthCheck);

module.exports = router;

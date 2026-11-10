const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const pool = require("./config/db");
const apiRoutes = require("./routes/index");
const closeScheduler = require("./services/gl/closeScheduler");
const rateScheduler = require("./services/currency/rateScheduler");
const outboxWorker = require("./services/email/outboxWorker");
const reminderScanner = require("./services/email/reminderScanner");

const app = express();

const PORT = process.env.PORT || 5050;
const CLIENT_ORIGIN =
  process.env.CLIENT_ORIGIN || process.env.CLIENT_URL || "http://localhost:5173";

app.use(
  cors({
    origin: CLIENT_ORIGIN,
    credentials: true,
  }),
);

app.use(helmet());
app.use(morgan("dev"));

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

const uploadsDir = path.join(__dirname, "uploads");
const logosDir = path.join(uploadsDir, "logos");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
if (!fs.existsSync(logosDir)) {
  fs.mkdirSync(logosDir, { recursive: true });
}

app.use(
  "/uploads",
  express.static(uploadsDir, {
    setHeaders: (res) => {
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    },
  }),
);

app.get("/", (req, res) => {
  return res.json({
    success: true,
    message: "Accounting backend is running",
  });
});

app.use("/api", apiRoutes);

app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

app.use((err, req, res, next) => {
  console.error("Unhandled server error:", err);

  if (err.name === "MulterError") {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        success: false,
        message: "Logo must be 6MB or smaller",
      });
    }

    return res.status(400).json({
      success: false,
      message: err.message || "File upload error",
    });
  }

  return res.status(500).json({
    success: false,
    message: "Internal server error",
    error: err.message,
  });
});

const startServer = async () => {
  try {
    await pool.testDbConnection();

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });

    // Opt-in monthly period-close automation (OFF unless GL_CLOSE_SCHEDULER=on).
    closeScheduler.start();

    // Opt-in daily FX rate refresh (OFF unless FX_RATE_SCHEDULER=on).
    rateScheduler.start();

    // Opt-in email delivery (OFF unless EMAIL_WORKER=on / EMAIL_REMINDERS=on).
    outboxWorker.start();
    reminderScanner.start();

  } catch (error) {
    console.error("Failed to start server due to database error:", error.message);
    process.exit(1);
  }
};

startServer();

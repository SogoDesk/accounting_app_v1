// Runs in every test file before any app module loads. config/db.js and the
// server read backend/.env with dotenv, which never overrides variables that
// are already set, so setting them here keeps every test off the dev database.

const { appEnv } = require("./testDb");

Object.assign(process.env, appEnv(), {
  NODE_ENV: "test",
  JWT_SECRET: "test-jwt-secret-at-least-32-characters-long",
  PLATFORM_JWT_SECRET: "test-platform-secret-at-least-32-characters",
  // Background jobs and outside services stay off in tests.
  FX_RATE_SCHEDULER: "off",
  GL_CLOSE_SCHEDULER: "off",
  EMAIL_WORKER: "off",
  EMAIL_REMINDERS: "off",
  MAIL_DRIVER: "console", // never send real mail
  EMAIL_FROM: "",
  EMAIL_HOST: "",
  EMAIL_USER: "",
  EMAIL_PASS: "",
  EXCHANGE_RATE_API_KEY: "",
});

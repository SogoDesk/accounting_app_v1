// pg turns DATE columns into local-midnight Dates, so response bodies depend on
// the machine's time zone. Pin it here: this file runs in the real Node process,
// whereas process.env inside test files is a sandboxed copy Node never reads.
process.env.TZ = "UTC";

module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.js"],
  globalSetup: "<rootDir>/tests/setup/globalSetup.js",
  setupFiles: ["<rootDir>/tests/setup/env.js"],
  setupFilesAfterEnv: ["<rootDir>/tests/setup/afterEnv.js"],
  testTimeout: 30000,
};

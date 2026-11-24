const fs = require("fs");
const path = require("path");
const pool = require("../../config/db");

// Self-healing schema for platform-level tables (same idea as the other
// ensure*Schema modules): applies the idempotent migrations once per process.
const MIGRATIONS = ["024_platform_admins.sql", "025_tenant_invites.sql"];

let ready = null;

const ensurePlatformSchema = () => {
  if (!ready) {
    ready = (async () => {
      for (const file of MIGRATIONS) {
        const sql = fs.readFileSync(
          path.resolve(__dirname, "../../../database/migrations", file),
          "utf8"
        );
        await pool.query(sql);
      }
    })().catch((err) => {
      ready = null; // retry on next call
      throw err;
    });
  }
  return ready;
};

module.exports = { ensurePlatformSchema };

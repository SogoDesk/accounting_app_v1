// Create (or reset) the single platform operator account.
//
// Usage:
//   node utils/createPlatformAdmin.js --email ops@example.com --name "Platform Admin"
//   node utils/createPlatformAdmin.js --reset-password
//
// The password is taken from PLATFORM_ADMIN_PASSWORD if set (min 12 chars);
// otherwise a strong random one is generated and printed once.
// Applies migration 024 first, so it works on a database that lacks the table.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { Client } = require("pg");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const hasFlag = (name) => args.includes(`--${name}`);

const resolvePassword = () => {
  const fromEnv = process.env.PLATFORM_ADMIN_PASSWORD;
  if (fromEnv) {
    if (fromEnv.length < 12) {
      throw new Error("PLATFORM_ADMIN_PASSWORD must be at least 12 characters.");
    }
    return { password: fromEnv, generated: false };
  }
  return { password: crypto.randomBytes(12).toString("base64url"), generated: true };
};

const main = async () => {
  const client = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: process.env.PGSSLMODE ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();

  try {
    const migration = fs.readFileSync(
      path.resolve(__dirname, "../../database/migrations/024_platform_admins.sql"),
      "utf8"
    );
    await client.query(migration);

    const existing = await client.query(
      "SELECT id, email FROM platform_admins LIMIT 1"
    );

    if (hasFlag("reset-password")) {
      if (!existing.rows.length) {
        throw new Error("No platform admin exists yet. Create one with --email and --name.");
      }
      const { password, generated } = resolvePassword();
      const hash = await bcrypt.hash(password, 12);
      await client.query(
        "UPDATE platform_admins SET password_hash = $1, updated_at = now() WHERE id = $2",
        [hash, existing.rows[0].id]
      );
      console.log(`Password reset for platform admin ${existing.rows[0].email}.`);
      if (generated) console.log(`New password (shown once): ${password}`);
      return;
    }

    if (existing.rows.length) {
      throw new Error(
        `A platform admin already exists (${existing.rows[0].email}). ` +
        "Only one is allowed. Use --reset-password to change its password."
      );
    }

    const email = String(argValue("email") || "").trim().toLowerCase();
    const name = String(argValue("name") || "Platform Admin").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new Error('Provide a valid --email, e.g. --email ops@example.com');
    }

    const { password, generated } = resolvePassword();
    const hash = await bcrypt.hash(password, 12);
    await client.query(
      `INSERT INTO platform_admins (full_name, email, password_hash)
       VALUES ($1, $2, $3)`,
      [name, email, hash]
    );

    console.log(`Platform admin created: ${email}`);
    if (generated) console.log(`Password (shown once, store it safely): ${password}`);
    console.log("Sign in at /platform/login");
  } finally {
    await client.end();
  }
};

main().catch((err) => {
  console.error(`[createPlatformAdmin] ${err.message}`);
  process.exit(1);
});

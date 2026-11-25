#!/usr/bin/env node
// Runs node-pg-migrate against the database configured in backend/.env.
//
//   npm run migrate:up                 apply pending migrations
//   npm run migrate -- up --fake       mark migrations as applied without running them
//   npm run migrate:new -- <name>      create a new SQL migration
//
// Connection: DATABASE_URL if set, otherwise built from DB_HOST, DB_PORT,
// DB_NAME and DB_USER / DB_PASSWORD. MIGRATE_DB_USER / MIGRATE_DB_PASSWORD,
// when set, take precedence so migrations can run as the table-owner role
// while the server uses a restricted role (workflow step 1.7).

const path = require("path");
const { spawnSync } = require("child_process");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const MIGRATIONS_DIR = path.resolve(__dirname, "../../database/migrations/pgm");

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const user = process.env.MIGRATE_DB_USER || process.env.DB_USER;
  const password = process.env.MIGRATE_DB_USER
    ? process.env.MIGRATE_DB_PASSWORD
    : process.env.DB_PASSWORD;
  const { DB_HOST, DB_PORT, DB_NAME } = process.env;

  if (!DB_HOST || !DB_NAME || !user) {
    console.error(
      "Missing database settings: set DATABASE_URL, or DB_HOST, DB_NAME and DB_USER in backend/.env"
    );
    process.exit(1);
  }

  const auth = password
    ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}`
    : encodeURIComponent(user);
  const ssl = process.env.PGSSLMODE ? `?sslmode=${process.env.PGSSLMODE}` : "";
  return `postgres://${auth}@${DB_HOST}:${DB_PORT || 5432}/${DB_NAME}${ssl}`;
}

// The package's "exports" map hides bin/, so resolve it from the package root.
const pkgDir = path.dirname(require.resolve("node-pg-migrate/package.json"));
const bin = path.join(pkgDir, require("node-pg-migrate/package.json").bin["node-pg-migrate"]);
const args = [
  bin,
  ...process.argv.slice(2),
  "--migrations-dir", MIGRATIONS_DIR,
  "--migration-file-language", "sql",
  "--check-order",
];

const result = spawnSync(process.execPath, args, {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: databaseUrl() },
});

process.exit(result.status === null ? 1 : result.status);

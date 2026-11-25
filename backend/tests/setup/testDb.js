// Shared settings for the test database.
//
// Tests never touch the database named in DB_* (the shared dev database).
// They use TEST_DATABASE_URL (from the environment, or backend/.env) only to
// find a local Postgres server and an admin login, then work in their own
// databases on it:
//
//   books_test_template  built once per `npm test` by running every migration
//   books_test           cloned from the template before each test file
//
// The app connects as books_test_app, a plain role (not a superuser, no
// BYPASSRLS), so row-level security applies exactly as it does in production.

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { Client } = require("pg");

const ENV_FILE = path.resolve(__dirname, "../../.env");
const fileEnv = fs.existsSync(ENV_FILE)
  ? dotenv.parse(fs.readFileSync(ENV_FILE))
  : {};

const TEST_DB = process.env.TEST_DB_NAME || "books_test";
const TEMPLATE_DB = `${TEST_DB}_template`;
const APP_ROLE = "books_test_app";
const APP_PASSWORD = "books_test_app";

function baseUrl() {
  const raw = process.env.TEST_DATABASE_URL || fileEnv.TEST_DATABASE_URL;
  if (!raw) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Point it at a local Postgres admin login, " +
        "e.g. postgres://postgres:secret@localhost:5432/postgres?sslmode=disable",
    );
  }
  const url = new URL(raw);
  const localHosts = ["localhost", "127.0.0.1", "::1", "[::1]"];
  if (!localHosts.includes(url.hostname) && process.env.TEST_DB_ALLOW_REMOTE !== "1") {
    throw new Error(
      `Refusing to run tests against ${url.hostname}: the test suite drops and ` +
        "recreates databases. Use a local server, or set TEST_DB_ALLOW_REMOTE=1.",
    );
  }
  if (!/test/.test(TEST_DB)) {
    throw new Error(`Test database name must contain "test" (got ${TEST_DB}).`);
  }
  return url;
}

// Admin connection string for a database on the test server.
function adminUrl(database) {
  const url = baseUrl();
  url.pathname = `/${database}`;
  url.searchParams.set("sslmode", "disable");
  return url.toString();
}

async function withAdmin(database, fn) {
  const client = new Client({ connectionString: adminUrl(database) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// Connection settings the app's pool (config/db.js) reads from DB_*.
function appEnv() {
  const url = baseUrl();
  return {
    DB_HOST: url.hostname,
    DB_PORT: url.port || "5432",
    DB_NAME: TEST_DB,
    DB_USER: APP_ROLE,
    DB_PASSWORD: APP_PASSWORD,
    PGSSLMODE: "disable",
  };
}

// Replace books_test with a fresh copy of the migrated template.
async function resetDatabase() {
  await withAdmin("postgres", async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB} TEMPLATE ${TEMPLATE_DB}`);
  });
}

module.exports = {
  TEST_DB,
  TEMPLATE_DB,
  APP_ROLE,
  APP_PASSWORD,
  adminUrl,
  withAdmin,
  appEnv,
  resetDatabase,
};


const { Pool } = require("pg");
const path = require("path");

const { getTenantClient } = require("./tenantContext");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 30,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("Unexpected database pool error:", err);
});

const originalQuery = pool.query.bind(pool);

pool.query = (...args) => {
  const tenantClient = getTenantClient();

  if (tenantClient) {
    return tenantClient.query(...args);
  }

  return originalQuery(...args);
};

const testDbConnection = async () => {
  await originalQuery("SELECT 1");
  console.log("Database connected successfully.");
};

pool.testDbConnection = testDbConnection;

module.exports = pool;

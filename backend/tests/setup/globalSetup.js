// Runs once per `npm test`: builds books_test_template from the migrations
// and grants the app role what the server needs. Each test file then gets a
// fresh clone of it (see afterEnv.js).

const path = require("path");
const { spawnSync } = require("child_process");
const {
  TEMPLATE_DB,
  APP_ROLE,
  APP_PASSWORD,
  adminUrl,
  withAdmin,
} = require("./testDb");

module.exports = async () => {
  await withAdmin("postgres", async (admin) => {
    await admin.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
          CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'
            NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
        END IF;
      END $$`);
    await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  });

  const migrate = spawnSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/migrate.js"), "up"],
    {
      env: { ...process.env, DATABASE_URL: adminUrl(TEMPLATE_DB), PGSSLMODE: "disable" },
      encoding: "utf8",
    },
  );
  if (migrate.status !== 0) {
    throw new Error(
      `Migrations failed on ${TEMPLATE_DB}:\n${migrate.stdout}\n${migrate.stderr}`,
    );
  }

  await withAdmin(TEMPLATE_DB, async (db) => {
    // CREATE on the schema: ledgerEngine creates one entry-number sequence per
    // entity on first post (CREATE SEQUENCE IF NOT EXISTS je_seq_<id>).
    await db.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${APP_ROLE}`);
    await db.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);
    await db.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);
    await db.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${APP_ROLE}`);
  });
};

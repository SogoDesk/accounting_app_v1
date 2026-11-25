// Every test file starts on a fresh copy of the migrated database and closes
// the app's connection pool when it finishes.

const { resetDatabase } = require("./testDb");

beforeAll(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await require("../../config/db").end();
});

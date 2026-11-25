// Run fn inside one transaction on db (a pg client). Services never BEGIN or
// COMMIT themselves, so a caller can combine several of them in one transaction.

async function withTransaction(db, fn) {
  await db.query("BEGIN");
  try {
    const result = await fn();
    await db.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await db.query("ROLLBACK");
    } catch (_) {
      // The original error is the useful one.
    }
    throw error;
  }
}

module.exports = { withTransaction };

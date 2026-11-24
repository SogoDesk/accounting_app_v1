
const pool = require("../config/db");
const { runWithTenant } = require("../config/tenantContext");

const tenantMiddleware = async (req, res, next) => {
  let client;
  let released = false;

  const releaseClient = async () => {
    if (!client || released) return;

    released = true;

    try {
      await client.query(
  "SELECT set_config('app.tenant_id', '', false)"
);
      client.release();
    } catch (error) {
      console.error(
        "[TENANT] Failed to reset tenant context:",
        error.message
      );

      // Destroy connection if session state cannot be reset safely
      client.release(error);
    }
  };

  try {
    // STEP 1: Get tenant ID from authenticated user
    const tenantId = req.user?.tenant_id;

    if (!Number.isInteger(tenantId) || tenantId <= 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid tenant information.",
      });
    }

    // STEP 2: Get dedicated PostgreSQL connection
    client = await pool.connect();

    // STEP 3: Set tenant ID in PostgreSQL session
    await client.query(
      "SELECT set_config('app.tenant_id', $1, false)",
      [String(tenantId)]
    );

    // STEP 4: Release connection when response finishes
    res.once("finish", releaseClient);
    res.once("close", releaseClient);

    // STEP 5: Establish tenant context for request
    runWithTenant(client, tenantId, () => {
      next();
    });
  } catch (error) {
    if (client && !released) {
      released = true;
      client.release(error);
    }

    next(error);
  }
};

module.exports = tenantMiddleware;

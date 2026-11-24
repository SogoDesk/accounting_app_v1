

// =============================================================================
// closeScheduler.js - monthly period-close automation
//
// Manual close:
// Uses the tenant connection created by tenantMiddleware.
//
// Automatic close:
// Reads all tenant IDs and runs the close separately for each tenant.
// =============================================================================

const pool = require("../../config/db");

const {
  getTenantClient,
  runWithTenant,
} = require("../../config/tenantContext");

const fxRevaluationService = require("./fxRevaluationService");
const recognitionService = require("./recognitionService");

// Last day of the month immediately before isoDate.
function priorMonthEnd(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

// Get the current tenant's database connection.
function getDbClient() {
  const client = getTenantClient();

  if (!client) {
    throw new Error("Tenant database connection not found.");
  }

  return client;
}

/**
 * Run the close for the current tenant.
 * Used by the manual API endpoint and scheduled tenant runner.
 */
async function runMonthlyClose({ asOfDate, userId } = {}) {
  if (!asOfDate) {
    throw new Error("asOfDate is required");
  }

  // Get the current tenant's database connection.
  const db = getDbClient();

  // Read legal entities only from the current tenant.
  const { rows: entities } = await db.query(
    `SELECT DISTINCT region_id
       FROM org_units
      WHERE is_legal_entity = true
        AND region_id IS NOT NULL
      ORDER BY region_id`
  );

  const results = [];

  for (const entity of entities) {
    const entityId = entity.region_id;
    const result = { entityId };

    try {
      result.fx = await fxRevaluationService.revalue({
        entityId,
        asOfDate,
        userId,
      });
    } catch (error) {
      result.fxError = error.message;
    }

    results.push(result);
  }

  // Run recognition schedules for this tenant.
  let recognition;

  try {
    recognition = await recognitionService.runDue({
      asOfDate,
      userId,
    });
  } catch (error) {
    recognition = {
      error: error.message,
    };
  }

  // Close this tenant's accounting period.
  let period = null;

  try {
    period = await closePeriodFor(asOfDate);
  } catch (error) {
    period = {
      error: error.message,
    };
  }

  return {
    asOfDate,
    entities: results,
    recognition,
    period,
  };
}

// Run the monthly close separately for every tenant.
async function runMonthlyCloseForAllTenants({
  asOfDate,
  userId,
} = {}) {
  if (!asOfDate) {
    throw new Error("asOfDate is required");
  }

  // The tenants table is global.
  // This query runs outside a tenant context.
  const { rows: tenants } = await pool.query(
    "SELECT id FROM tenants ORDER BY id"
  );

  const results = [];

  for (const tenant of tenants) {
    const tenantId = Number(tenant.id);
    let client;

    try {
      if (!Number.isInteger(tenantId) || tenantId <= 0) {
        throw new Error("Invalid tenant ID.");
      }

      // Get a dedicated database connection for this tenant.
      client = await pool.connect();

      // Set tenant context on this database connection.
      await client.query(
        "SELECT set_config('app.tenant_id', $1, false)",
        [String(tenantId)]
      );

      // Run all operations inside this tenant's context.
      const result = await runWithTenant(
        client,
        tenantId,
        () => runMonthlyClose({
          asOfDate,
          userId,
        })
      );

      results.push({
        tenantId,
        success: true,
        result,
      });
    } catch (error) {
      results.push({
        tenantId,
        success: false,
        error: error.message,
      });
    } finally {
      if (client) {
        try {
          await client.query("RESET app.tenant_id");
          client.release();
        } catch (error) {
          console.error(
            `[closeScheduler] Failed to reset tenant ${tenantId}:`,
            error.message
          );

          // Discard connection if tenant state cannot be reset.
          client.release(error);
        }
      }
    }
  }

  return {
    asOfDate,
    tenants: results,
  };
}

// Mark the current tenant's accounting period CLOSED.
async function closePeriodFor(asOfDate) {
  const db = getDbClient();

  const { rows } = await db.query(
    `UPDATE accounting_periods
        SET status = 'CLOSED',
            updated_at = CURRENT_TIMESTAMP
      WHERE $1 BETWEEN start_date AND end_date
      RETURNING id, period_label, status`,
    [asOfDate]
  );

  return rows[0] || null;
}

// Reopen the current tenant's accounting period.
async function reopenPeriodFor(asOfDate) {
  const db = getDbClient();

  const { rows } = await db.query(
    `UPDATE accounting_periods
        SET status = 'OPEN',
            updated_at = CURRENT_TIMESTAMP
      WHERE $1 BETWEEN start_date AND end_date
      RETURNING id, period_label, status`,
    [asOfDate]
  );

  return rows[0] || null;
}

let timer = null;

function start() {
  if (
    String(process.env.GL_CLOSE_SCHEDULER || "").toLowerCase() !== "on"
  ) {
    return;
  }

  const dom = Math.min(
    28,
    Math.max(1, Number(process.env.GL_CLOSE_DOM) || 1)
  );

  const DAY_MS = 24 * 60 * 60 * 1000;
  let lastRunMonth = null;

  const tick = async () => {
    const now = new Date();

    const monthKey =
      `${now.getUTCFullYear()}-${now.getUTCMonth()}`;

    if (
      now.getUTCDate() === dom &&
      lastRunMonth !== monthKey
    ) {
      lastRunMonth = monthKey;

      const asOfDate = priorMonthEnd(
        now.toISOString().slice(0, 10)
      );

      try {
        const result = await runMonthlyCloseForAllTenants({
          asOfDate,
          userId: null,
        });

        console.log(
          `[closeScheduler] Monthly close completed for ${asOfDate}:`,
          JSON.stringify(result).slice(0, 500)
        );
      } catch (error) {
        console.error(
          "[closeScheduler] Monthly close failed:",
          error.message
        );
      }
    }
  };

  timer = setInterval(tick, DAY_MS);

  if (timer.unref) {
    timer.unref();
  }

  console.log(
    `[closeScheduler] enabled (day-of-month ${dom})`
  );
}

function stop() {
  if (timer) {
    clearInterval(timer);
  }

  timer = null;
}

module.exports = {
  runMonthlyClose,
  runMonthlyCloseForAllTenants,
  closePeriodFor,
  reopenPeriodFor,
  start,
  stop,
  priorMonthEnd,
};

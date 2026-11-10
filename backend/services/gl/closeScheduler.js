// =============================================================================
// closeScheduler — monthly period-close automation (Blueprint Step 5)
//
// Runs the two period-close engines across every legal entity for an as-of
// date: fxRevaluationService.revalue + recognitionService.runDue. Exposed as
// runMonthlyClose() for the manual "run now" endpoint, and as an opt-in daily
// timer (start()) that fires once on the configured day-of-month.
//
// The timer is OFF by default (no surprise postings); enable by setting
// GL_CLOSE_SCHEDULER=on (and optionally GL_CLOSE_DOM=<1-28>, default 1 -> runs
// the close for the just-ended prior month on the 1st). server.js calls start()
// which no-ops unless enabled.
// =============================================================================

const pool = require("../../config/db");
const fxRevaluationService = require("./fxRevaluationService");
const recognitionService = require("./recognitionService");

// last day of the month immediately before `isoDate` (typical close as-of).
function priorMonthEnd(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(1);                 // first of current month
  d.setUTCDate(0);                 // -> last day of previous month
  return d.toISOString().slice(0, 10);
}

/**
 * Run FX revaluation + recognition for every legal entity as of a date.
 * @param params { asOfDate (YYYY-MM-DD), userId? }
 */
async function runMonthlyClose({ asOfDate, userId } = {}) {
  if (!asOfDate) throw new Error("asOfDate is required");
  const { rows: entities } = await pool.query(
    `SELECT DISTINCT region_id FROM org_units
      WHERE is_legal_entity = true AND region_id IS NOT NULL ORDER BY region_id`,
  );

  const results = [];
  for (const e of entities) {
    const entityId = e.region_id;
    const out = { entityId };
    try { out.fx = await fxRevaluationService.revalue({ entityId, asOfDate, userId }); }
    catch (err) { out.fxError = err.message; }
    results.push(out);
  }
  // recognition schedules carry their own entity/location; run once for all.
  let recognition;
  try { recognition = await recognitionService.runDue({ asOfDate, userId }); }
  catch (err) { recognition = { error: err.message }; }

  // Lock the period once FX + recognition have run. Postings into a CLOSED
  // period are then rejected by ledgerEngine's period guard. Reopen if needed.
  let period = null;
  try { period = await closePeriodFor(asOfDate); }
  catch (err) { period = { error: err.message }; }

  return { asOfDate, entities: results, recognition, period };
}

// Mark the accounting period covering `asOfDate` CLOSED (idempotent).
async function closePeriodFor(asOfDate) {
  const { rows } = await pool.query(
    `UPDATE accounting_periods SET status = 'CLOSED', updated_at = CURRENT_TIMESTAMP
      WHERE $1 BETWEEN start_date AND end_date
      RETURNING id, period_label, status`,
    [asOfDate],
  );
  return rows[0] || null;
}

// Reopen the accounting period covering `asOfDate` (escape hatch after a close).
async function reopenPeriodFor(asOfDate) {
  const { rows } = await pool.query(
    `UPDATE accounting_periods SET status = 'OPEN', updated_at = CURRENT_TIMESTAMP
      WHERE $1 BETWEEN start_date AND end_date
      RETURNING id, period_label, status`,
    [asOfDate],
  );
  return rows[0] || null;
}

let timer = null;
function start() {
  if (String(process.env.GL_CLOSE_SCHEDULER || "").toLowerCase() !== "on") return;
  const dom = Math.min(28, Math.max(1, Number(process.env.GL_CLOSE_DOM) || 1));
  const DAY_MS = 24 * 60 * 60 * 1000;
  let lastRunMonth = null;

  const tick = async () => {
    const now = new Date();
    const monthKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}`;
    if (now.getUTCDate() === dom && lastRunMonth !== monthKey) {
      lastRunMonth = monthKey;
      const asOfDate = priorMonthEnd(now.toISOString().slice(0, 10));
      try {
        const res = await runMonthlyClose({ asOfDate, userId: null });
        console.log(`[closeScheduler] monthly close run for ${asOfDate}:`, JSON.stringify(res).slice(0, 300));
      } catch (err) {
        console.error("[closeScheduler] monthly close failed:", err.message);
      }
    }
  };

  timer = setInterval(tick, DAY_MS);
  if (timer.unref) timer.unref();
  console.log(`[closeScheduler] enabled (day-of-month ${dom})`);
}

function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { runMonthlyClose, closePeriodFor, reopenPeriodFor, start, stop, priorMonthEnd };

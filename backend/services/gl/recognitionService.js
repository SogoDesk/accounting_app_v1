// =============================================================================
// recognitionService — straight-line accrual / deferral recognition
//                      (Blueprint Step 5 / audit §3.5)
//
// One generic engine serves both directions:
//   PREPAID_EXPENSE:  Dr P&L expense  / Cr balance (prepaid asset 1300)
//   DEFERRED_REVENUE: Dr balance (deferred liab 2700) / Cr P&L revenue
// runDue() posts one entry per ACTIVE schedule period whose date ≤ asOf and is
// not yet run — idempotent on (schedule_id, period_no), tagged with the
// schedule's location_id. Straight-line, integer minor units, last period
// absorbs the rounding residual.
// =============================================================================

const pool = require("../../config/db");
const ledger = require("./ledgerEngine");
const currency = require("../currency/currencyService");
const posting = require("./postingService");

const DEFAULT_BALANCE_CODE = { PREPAID_EXPENSE: "1300", DEFERRED_REVENUE: "2700" };

const addMonths = (isoDate, n) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};
const dateKey = (v) => (v instanceof Date
  ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`
  : String(v).slice(0, 10));

// minor-unit straight-line split: equal periods, last absorbs the residual.
function periodAmountMinor(totalMinor, periods, periodNo) {
  const base = Math.floor(totalMinor / periods);
  return periodNo === periods ? totalMinor - base * (periods - 1) : base;
}

/**
 * Create a recognition schedule.
 * @param params { entityId, locationId?, kind, sourceRef?, totalAmount, currency,
 *                 balanceAccountCode?|balanceAccountId?, pnlAccountCode|pnlAccountId,
 *                 startDate, periods, method?, userId }
 */
async function createSchedule(params, db = pool) {
  const {
    entityId, locationId, kind, sourceRef, totalAmount, currency: ccy,
    balanceAccountCode, balanceAccountId, pnlAccountCode, pnlAccountId,
    startDate, periods, method, userId,
  } = params;

  if (!entityId) throw new Error("entityId is required");
  if (!["PREPAID_EXPENSE", "DEFERRED_REVENUE"].includes(kind))
    throw new Error("kind must be PREPAID_EXPENSE or DEFERRED_REVENUE");
  if (!(Number(totalAmount) > 0)) throw new Error("totalAmount must be > 0");
  if (!ccy) throw new Error("currency is required");
  if (!startDate) throw new Error("startDate is required");
  if (!(Number(periods) > 0)) throw new Error("periods must be > 0");
  if (!pnlAccountCode && !pnlAccountId) throw new Error("pnlAccount is required");

  const balanceId = balanceAccountId
    || (await ledger.accountIdByCode(balanceAccountCode || DEFAULT_BALANCE_CODE[kind], db));
  const pnlId = pnlAccountId || (await ledger.accountIdByCode(pnlAccountCode, db));

  const { rows } = await db.query(
    `INSERT INTO recognition_schedules
       (entity_id, location_id, kind, source_ref, total_amount, currency,
        balance_account_id, pnl_account_id, start_date, periods, method, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ACTIVE',$12) RETURNING *`,
    [entityId, locationId || null, kind, sourceRef || null, Number(totalAmount), ccy,
     balanceId, pnlId, dateKey(startDate), Number(periods), method || "STRAIGHT_LINE", userId || null],
  );
  return rows[0];
}

async function listSchedules({ entityId } = {}, db = pool) {
  const params = [];
  let where = "";
  if (entityId) { params.push(entityId); where = "WHERE entity_id = $1"; }
  const { rows } = await db.query(
    `SELECT s.*, ba.account_code AS balance_account_code, pa.account_code AS pnl_account_code,
            (SELECT COUNT(*) FROM recognition_runs r WHERE r.schedule_id = s.id)::int AS runs_count
       FROM recognition_schedules s
       JOIN chart_of_accounts ba ON ba.id = s.balance_account_id
       JOIN chart_of_accounts pa ON pa.id = s.pnl_account_id
       ${where} ORDER BY s.id DESC`,
    params,
  );
  return rows;
}

/**
 * Post every due, not-yet-run recognition period for all ACTIVE schedules.
 * @param params { asOfDate (YYYY-MM-DD), userId }
 * @returns { asOfDate, recognitions:[...], count }
 */
async function runDue(params) {
  const { asOfDate, userId } = params;
  if (!asOfDate) throw new Error("asOfDate is required");
  const asOf = dateKey(asOfDate);

  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const { rows: schedules } = await db.query(
      "SELECT * FROM recognition_schedules WHERE status = 'ACTIVE' ORDER BY id",
    );

    const recognitions = [];
    for (const s of schedules) {
      const totalMinor = ledger.toMinor(s.total_amount);
      const start = dateKey(s.start_date);
      const locationId = await posting.resolveLocationId(s.entity_id, s.location_id, db);
      let ranAll = true;

      for (let n = 1; n <= s.periods; n++) {
        const periodDate = addMonths(start, n - 1);
        if (periodDate > asOf) { ranAll = false; break; } // not due yet (and later ones aren't either)

        const exists = await db.query(
          "SELECT 1 FROM recognition_runs WHERE schedule_id = $1 AND period_no = $2 LIMIT 1",
          [s.id, n],
        );
        if (exists.rows.length) continue; // idempotent

        const amtMinor = periodAmountMinor(totalMinor, s.periods, n);
        const amount = amtMinor / 100;
        const { amountBase } = await currency.toFunctional(amount, s.currency, s.entity_id, periodDate, db);

        const balLeg = { accountId: s.balance_account_id, currency: s.currency, exchangeRate: 1, memo: `${s.kind} recognition` };
        const pnlLeg = { accountId: s.pnl_account_id, currency: s.currency, exchangeRate: 1, memo: `${s.kind} recognition` };
        // PREPAID: Dr P&L / Cr balance ;  DEFERRED_REVENUE: Dr balance / Cr P&L
        const lines = s.kind === "PREPAID_EXPENSE"
          ? [ { ...pnlLeg, debit: amount, debitBase: amountBase }, { ...balLeg, credit: amount, creditBase: amountBase } ]
          : [ { ...balLeg, debit: amount, debitBase: amountBase }, { ...pnlLeg, credit: amount, creditBase: amountBase } ];

        const entry = await ledger.postEntry(db, {
          entityId: s.entity_id, locationId, entryDate: periodDate, source: "RECOGNITION",
          sourceRef: `${s.id}-${n}`,
          description: `${s.kind} recognition ${n}/${s.periods} (schedule ${s.id})`,
          userId,
        }, lines);

        await db.query(
          `INSERT INTO recognition_runs (schedule_id, period_no, run_date, amount, entry_id)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (schedule_id, period_no) DO NOTHING`,
          [s.id, n, periodDate, amount, entry.id],
        );
        recognitions.push({ schedule_id: s.id, period_no: n, amount, entry_id: entry.id, run_date: periodDate });
      }

      // mark completed once the final period has been recognized
      const done = await db.query(
        "SELECT COUNT(*)::int AS c FROM recognition_runs WHERE schedule_id = $1", [s.id],
      );
      if (ranAll && done.rows[0].c >= s.periods) {
        await db.query("UPDATE recognition_schedules SET status = 'COMPLETED' WHERE id = $1", [s.id]);
      }
    }

    await db.query("COMMIT");
    return { asOfDate: asOf, recognitions, count: recognitions.length };
  } catch (e) {
    try { await db.query("ROLLBACK"); } catch (_) {}
    throw e;
  } finally {
    db.release();
  }
}

module.exports = { createSchedule, listSchedules, runDue };

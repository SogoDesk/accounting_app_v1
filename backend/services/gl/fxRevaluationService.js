// =============================================================================
// fxRevaluationService — period-end unrealized FX revaluation
//                        (Blueprint Step 5 / audit §3.3)
//
// For each open foreign-currency monetary balance (AR 1100, AP 2000, bank 1000)
// whose transaction currency ≠ the entity's functional currency, remeasure the
// functional carrying value at the as-of rate and post the difference as an
// UNREALIZED gain/loss (4910/5910). The revaluation is then AUTO-REVERSED on
// as_of_date + 1 day so unrealized never compounds with the realized figure
// booked at settlement. Idempotent per (entity, as_of_date, account, currency).
// =============================================================================

const pool = require("../../config/db");
const ledger = require("./ledgerEngine");
const currency = require("../currency/currencyService");
const posting = require("./postingService");

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
// AR, AP, Bank, and the intercompany Due From / Due To pair. 1600/2600 are
// foreign-currency monetary balances whenever an inter-company invoice is
// denominated outside the entity's functional currency, so they must be
// remeasured like any other — otherwise glReports.consolidated() eliminates a
// closing-rate 2600 against an issue-rate 1600 and never nets to zero.
const MONETARY_CODES = ["1100", "2000", "1000", "1600", "2600"];

const addDays = (isoDate, days) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

async function functionalCurrency(db, entityId) {
  const { rows } = await db.query(
    "SELECT COALESCE(functional_currency, default_currency) AS ccy FROM regions WHERE id = $1",
    [entityId],
  );
  if (!rows.length) throw new Error(`Entity (region) ${entityId} not found`);
  return rows[0].ccy;
}

/**
 * Revalue an entity's open foreign-currency monetary balances as of a date.
 * @param params { entityId, asOfDate (YYYY-MM-DD), userId }
 * @returns { entityId, asOfDate, revaluations:[...], count }
 */
async function revalue(params) {
  const { entityId, asOfDate, userId } = params;
  if (!entityId) throw new Error("entityId is required");
  if (!asOfDate) throw new Error("asOfDate is required");

  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const functional = await functionalCurrency(db, entityId);
    const locationId = await posting.resolveLocationId(entityId, null, db);
    const reversalDate = addDays(asOfDate, 1);

    // open monetary balances by account + foreign currency
    const { rows: balances } = await db.query(
      `SELECT a.id AS account_id, a.account_code, jl.currency,
              SUM(jl.debit - jl.credit)           AS bal_txn,
              SUM(jl.debit_base - jl.credit_base) AS bal_func
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id AND je.status = 'POSTED' AND je.entry_date <= $1
         JOIN chart_of_accounts a ON a.id = jl.account_id
        WHERE jl.entity_id = $2 AND a.account_code = ANY($3) AND jl.currency <> $4
        GROUP BY a.id, a.account_code, jl.currency
        HAVING SUM(jl.debit - jl.credit) <> 0`,
      [asOfDate, entityId, MONETARY_CODES, functional],
    );

    const results = [];
    for (const b of balances) {
      // idempotency guard
      const dup = await db.query(
        `SELECT 1 FROM fx_revaluations
          WHERE entity_id = $1 AND as_of_date = $2 AND account_id = $3 AND currency = $4 LIMIT 1`,
        [entityId, asOfDate, b.account_id, b.currency],
      );
      if (dup.rows.length) { results.push({ account_code: b.account_code, currency: b.currency, skipped: true }); continue; }

      const { rate: rateAsOf } = await currency.getRate(b.currency, functional, asOfDate, db);
      const balTxn = Number(b.bal_txn);
      const bookFunc = round2(Number(b.bal_func));
      const revaluedFunc = round2(balTxn * rateAsOf);
      const adjustment = round2(revaluedFunc - bookFunc); // debit-positive on the monetary account
      if (Math.abs(adjustment) < 0.005) continue;

      // adjustment > 0: Dr account / Cr 4910 (gain); < 0: Dr 5910 / Cr account (loss)
      const a = Math.abs(adjustment);
      const lines = adjustment > 0
        ? [
            { accountId: b.account_id, debit: a, debitBase: a, currency: functional, exchangeRate: 1, memo: `FX reval ${b.currency}` },
            { accountCode: "4910", credit: a, creditBase: a, currency: functional, exchangeRate: 1, memo: "Unrealized FX gain" },
          ]
        : [
            { accountCode: "5910", debit: a, debitBase: a, currency: functional, exchangeRate: 1, memo: "Unrealized FX loss" },
            { accountId: b.account_id, credit: a, creditBase: a, currency: functional, exchangeRate: 1, memo: `FX reval ${b.currency}` },
          ];

      const entry = await ledger.postEntry(db, {
        entityId, locationId, entryDate: asOfDate, source: "FX_REVAL",
        sourceRef: `${entityId}-${asOfDate}-${b.account_code}-${b.currency}`,
        description: `Unrealized FX revaluation ${b.account_code} ${b.currency} @ ${asOfDate}`,
        userId,
      }, lines);

      // auto-reversing entry dated as_of_date + 1 (swap the sides)
      const reversalLines = lines.map((l) => ({
        ...l, debit: l.credit, credit: l.debit, debitBase: l.creditBase, creditBase: l.debitBase,
      }));
      const reversal = await ledger.postEntry(db, {
        entityId, locationId, entryDate: reversalDate, source: "FX_REVAL",
        sourceRef: `${entityId}-${asOfDate}-${b.account_code}-${b.currency}-REV`,
        description: `Reversal of unrealized FX revaluation ${b.account_code} ${b.currency}`,
        userId,
      }, reversalLines);

      await db.query(
        `INSERT INTO fx_revaluations
           (entity_id, as_of_date, account_id, currency, book_base, revalued_base, gain_loss,
            entry_id, reversal_entry_id, reversed)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
         ON CONFLICT (entity_id, as_of_date, account_id, currency) DO NOTHING`,
        [entityId, asOfDate, b.account_id, b.currency, bookFunc, revaluedFunc, adjustment, entry.id, reversal.id],
      );

      results.push({
        account_code: b.account_code, currency: b.currency,
        book_base: bookFunc, revalued_base: revaluedFunc, gain_loss: adjustment,
        entry_id: entry.id, reversal_entry_id: reversal.id, reversal_date: reversalDate,
      });
    }

    await db.query("COMMIT");
    return { entityId, asOfDate, revaluations: results, count: results.filter((r) => !r.skipped).length };
  } catch (e) {
    try { await db.query("ROLLBACK"); } catch (_) {}
    throw e;
  } finally {
    db.release();
  }
}

module.exports = { revalue };

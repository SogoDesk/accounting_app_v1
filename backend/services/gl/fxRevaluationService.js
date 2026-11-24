
// =============================================================================
// fxRevaluationService — period-end unrealized FX revaluation
// =============================================================================

const { getTenantClient } = require("../../config/tenantContext");
const ledger = require("./ledgerEngine");
const currency = require("../currency/currencyService");
const posting = require("./postingService");

const round2 = (n) =>
  Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const MONETARY_CODES = ["1100", "2000", "1000", "1600", "2600"];

const addDays = (isoDate, days) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

async function functionalCurrency(db, entityId) {
  const { rows } = await db.query(
    `SELECT COALESCE(functional_currency, default_currency) AS ccy
       FROM regions
      WHERE id = $1`,
    [entityId],
  );

  if (!rows.length) {
    throw new Error(`Entity (region) ${entityId} not found`);
  }

  return rows[0].ccy;
}

async function revalue(params) {
  const { entityId, asOfDate, userId } = params;

  if (!entityId) throw new Error("entityId is required");
  if (!asOfDate) throw new Error("asOfDate is required");

  // Reuse the connection established by tenantMiddleware.
  const db = getTenantClient();

  if (!db) {
    throw new Error("Tenant database connection not found.");
  }

  try {
    await db.query("BEGIN");

    const functional = await functionalCurrency(db, entityId);
    const locationId = await posting.resolveLocationId(entityId, null, db);
    const reversalDate = addDays(asOfDate, 1);

    const { rows: balances } = await db.query(
      `SELECT a.id AS account_id, a.account_code, jl.currency,
              SUM(jl.debit - jl.credit) AS bal_txn,
              SUM(jl.debit_base - jl.credit_base) AS bal_func
         FROM journal_lines jl
         JOIN journal_entries je
           ON je.id = jl.entry_id
          AND je.status = 'POSTED'
          AND je.entry_date <= $1
         JOIN chart_of_accounts a ON a.id = jl.account_id
        WHERE jl.entity_id = $2
          AND a.account_code = ANY($3)
          AND jl.currency <> $4
        GROUP BY a.id, a.account_code, jl.currency
        HAVING SUM(jl.debit - jl.credit) <> 0`,
      [asOfDate, entityId, MONETARY_CODES, functional],
    );

    const results = [];

    for (const b of balances) {
      const dup = await db.query(
        `SELECT 1
           FROM fx_revaluations
          WHERE entity_id = $1
            AND as_of_date = $2
            AND account_id = $3
            AND currency = $4
          LIMIT 1`,
        [entityId, asOfDate, b.account_id, b.currency],
      );

      if (dup.rows.length) {
        results.push({
          account_code: b.account_code,
          currency: b.currency,
          skipped: true,
        });
        continue;
      }

      const { rate: rateAsOf } = await currency.getRate(
        b.currency,
        functional,
        asOfDate,
        db,
      );

      const balTxn = Number(b.bal_txn);
      const bookFunc = round2(Number(b.bal_func));
      const revaluedFunc = round2(balTxn * rateAsOf);
      const adjustment = round2(revaluedFunc - bookFunc);

      if (Math.abs(adjustment) < 0.005) continue;

      const a = Math.abs(adjustment);

      const lines = adjustment > 0
        ? [
            {
              accountId: b.account_id,
              debit: a,
              debitBase: a,
              currency: functional,
              exchangeRate: 1,
              memo: `FX reval ${b.currency}`,
            },
            {
              accountCode: "4910",
              credit: a,
              creditBase: a,
              currency: functional,
              exchangeRate: 1,
              memo: "Unrealized FX gain",
            },
          ]
        : [
            {
              accountCode: "5910",
              debit: a,
              debitBase: a,
              currency: functional,
              exchangeRate: 1,
              memo: "Unrealized FX loss",
            },
            {
              accountId: b.account_id,
              credit: a,
              creditBase: a,
              currency: functional,
              exchangeRate: 1,
              memo: `FX reval ${b.currency}`,
            },
          ];

      const entry = await ledger.postEntry(
        db,
        {
          entityId,
          locationId,
          entryDate: asOfDate,
          source: "FX_REVAL",
          sourceRef: `${entityId}-${asOfDate}-${b.account_code}-${b.currency}`,
          description: `Unrealized FX revaluation ${b.account_code} ${b.currency} @ ${asOfDate}`,
          userId,
        },
        lines,
      );

      const reversalLines = lines.map((l) => ({
        ...l,
        debit: l.credit,
        credit: l.debit,
        debitBase: l.creditBase,
        creditBase: l.debitBase,
      }));

      const reversal = await ledger.postEntry(
        db,
        {
          entityId,
          locationId,
          entryDate: reversalDate,
          source: "FX_REVAL",
          sourceRef: `${entityId}-${asOfDate}-${b.account_code}-${b.currency}-REV`,
          description: `Reversal of unrealized FX revaluation ${b.account_code} ${b.currency}`,
          userId,
        },
        reversalLines,
      );

      await db.query(
        `INSERT INTO fx_revaluations
           (entity_id, as_of_date, account_id, currency, book_base,
            revalued_base, gain_loss, entry_id, reversal_entry_id, reversed)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
         ON CONFLICT (entity_id, as_of_date, account_id, currency)
         DO NOTHING`,
        [
          entityId,
          asOfDate,
          b.account_id,
          b.currency,
          bookFunc,
          revaluedFunc,
          adjustment,
          entry.id,
          reversal.id,
        ],
      );

      results.push({
        account_code: b.account_code,
        currency: b.currency,
        book_base: bookFunc,
        revalued_base: revaluedFunc,
        gain_loss: adjustment,
        entry_id: entry.id,
        reversal_entry_id: reversal.id,
        reversal_date: reversalDate,
      });
    }

    await db.query("COMMIT");

    return {
      entityId,
      asOfDate,
      revaluations: results,
      count: results.filter((r) => !r.skipped).length,
    };
  } catch (e) {
    try {
      await db.query("ROLLBACK");
    } catch (_) {}

    throw e;
  }
}

module.exports = { revalue };

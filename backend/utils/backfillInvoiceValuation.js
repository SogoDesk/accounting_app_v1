// =============================================================================
// backfillInvoiceValuation.js — fill exchange_rate / amount_base on invoices
// that were created without a functional-currency valuation.
//
//   Dry run (default):  cd backend && node utils/backfillInvoiceValuation.js
//   Apply:              cd backend && node utils/backfillInvoiceValuation.js --apply
//
// Cross-currency invoices (e.g. TetriQ-UK bills USD, books GBP) created before
// createInvoice valued them keep exchange_rate at its DEFAULT 1 and a null
// amount_base, so every GBP figure downstream renders the unconverted USD
// number. This restates only the invoice row.
//
// Unlike applyUkInvoiceReval.js this does NOT touch the GL: postingService
// already derives its own rate via currencyService, so journal lines are
// correctly valued. Rates come from the same currencyService lookup the GL and
// createInvoice use, so the backfilled rows agree with the ledger by
// construction.
//
// Idempotent: only rows with a null amount_base are considered, and the rate is
// looked up as-of the unchanged invoice_date. Runs as one transaction.
// =============================================================================

require("dotenv").config();
const pool = require("./../config/db");
const currency = require("../services/currency/currencyService");

const APPLY = process.argv.includes("--apply");

(async () => {
  const db = await pool.connect();
  try {
    const { rows } = await db.query(`
      SELECT i.id, i.invoice_number, to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date,
             i.region_id, i.currency, i.total_amount, i.exchange_rate,
             r.functional_currency, r.region_name
        FROM invoices i
        JOIN regions r ON r.id = i.region_id
       WHERE i.amount_base IS NULL
         AND r.functional_currency IS NOT NULL
         AND r.functional_currency <> i.currency
       ORDER BY i.invoice_date, i.id`);

    if (!rows.length) {
      console.log("Nothing to backfill — every cross-currency invoice is valued.");
      return;
    }

    console.log(
      `${rows.length} invoice(s) missing a functional-currency valuation:\n`,
    );

    await db.query("BEGIN");

    const skipped = [];
    let updated = 0;

    for (const inv of rows) {
      let valuation;
      try {
        valuation = await currency.toFunctional(
          inv.total_amount,
          inv.currency,
          inv.region_id,
          inv.invoice_date,
          db,
        );
      } catch (fxError) {
        skipped.push(`${inv.invoice_number}: ${fxError.message}`);
        continue;
      }

      console.log(
        `  ${inv.region_name} ${inv.invoice_number} (${inv.invoice_date}): ` +
          `${inv.total_amount} ${inv.currency} @ ${valuation.exchangeRate} -> ` +
          `${valuation.amountBase} ${valuation.functionalCurrency}`,
      );

      if (APPLY) {
        await db.query(
          "UPDATE invoices SET exchange_rate = $1, amount_base = $2 WHERE id = $3",
          [valuation.exchangeRate, valuation.amountBase, inv.id],
        );
        updated += 1;
      }
    }

    if (skipped.length) {
      console.log("\nSkipped (no usable rate):");
      skipped.forEach((line) => console.log(`  ${line}`));
    }

    if (!APPLY) {
      await db.query("ROLLBACK");
      console.log("\nDRY RUN — nothing written. Re-run with --apply to commit.");
      return;
    }

    await db.query("COMMIT");
    console.log(`\nUpdated ${updated} invoice row(s).`);
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    console.error("FAILED (nothing committed):", error.message);
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
})();

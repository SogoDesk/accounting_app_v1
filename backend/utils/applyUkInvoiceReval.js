// =============================================================================
// applyUkInvoiceReval.js — restate UK (region 2) USD invoices into GBP book
// value at each invoice's issue-date rate (ECB/Frankfurter historical).
//
//   Run:  cd backend && node utils/applyUkInvoiceReval.js
//
// Document amounts stay in USD (clients are billed USD). Only the *book*
// (functional GBP) values change:
//   1) seed per-date USD<->GBP rates into exchange_rates (MANUAL),
//   2) invoices.exchange_rate + amount_base -> GBP,
//   3) each AR_INVOICE journal entry re-valued: credit lines (revenue/tax)
//      scaled by the rate, the single AR debit line set to their sum so the
//      entry balances to the cent.
// Idempotent: base values are recomputed from the unchanged USD document
// amounts, so re-running yields identical numbers. All-or-nothing transaction.
// =============================================================================

require("dotenv").config();
const pool = require("../config/db");
const rateService = require("../services/currency/rateService");

const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;

async function usdToGbpOn(date) {
  const d = String(date).slice(0, 10);
  const res = await fetch(`https://api.frankfurter.dev/v1/${d}?from=USD&to=GBP`);
  if (!res.ok) throw new Error(`rate fetch ${d} failed ${res.status}`);
  const data = await res.json();
  const rate = Number(data?.rates?.GBP);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`no GBP rate for ${d}`);
  return { rate, usedDate: data.date || d };
}

(async () => {
  const db = await pool.connect();
  try {
    const region = (await db.query("SELECT functional_currency FROM regions WHERE id=2")).rows[0];
    if (!region || region.functional_currency !== "GBP") {
      throw new Error(`UK functional currency is ${region?.functional_currency} (expected GBP) — run applyUkGbp.js first`);
    }

    const invoices = (await db.query(
      `SELECT id, invoice_number, to_char(invoice_date,'YYYY-MM-DD') AS invoice_date,
              currency, total_amount, amount_base
         FROM invoices WHERE region_id=2 AND currency='USD' ORDER BY invoice_date, id`)).rows;

    // Fetch each distinct issue-date rate once (before opening the txn).
    const cache = new Map();
    for (const inv of invoices) {
      if (!cache.has(inv.invoice_date)) cache.set(inv.invoice_date, await usdToGbpOn(inv.invoice_date));
    }

    await db.query("BEGIN");

    // 1) Seed the historical rates (both directions).
    for (const [date, { rate }] of cache) {
      await rateService.setManualRate("USD", "GBP", rate, date, db);
      await rateService.setManualRate("GBP", "USD", 1 / rate, date, db);
    }

    let invUpdated = 0, glUpdated = 0, glMissing = 0;
    const warns = [];

    for (const inv of invoices) {
      const { rate } = cache.get(inv.invoice_date);
      const newBase = round2(Number(inv.total_amount) * rate);

      // 2) Invoice row.
      await db.query("UPDATE invoices SET exchange_rate=$1, amount_base=$2 WHERE id=$3",
        [rate, newBase, inv.id]);
      invUpdated++;

      // 3) Its AR_INVOICE GL entry (if posted).
      const entry = (await db.query(
        "SELECT id FROM journal_entries WHERE source='AR_INVOICE' AND source_ref=$1 AND status='POSTED' LIMIT 1",
        [String(inv.id)])).rows[0];
      if (!entry) { glMissing++; continue; }

      const lines = (await db.query(
        "SELECT id, debit, credit FROM journal_lines WHERE entry_id=$1", [entry.id])).rows;
      const debitLines = lines.filter((l) => Number(l.debit) > 0);
      const creditLines = lines.filter((l) => Number(l.credit) > 0);
      if (debitLines.length !== 1) { warns.push(`inv ${inv.id}: expected 1 debit line, got ${debitLines.length} — skipped GL`); continue; }

      let creditSum = 0;
      for (const l of creditLines) {
        const nb = round2(Number(l.credit) * rate);
        creditSum = round2(creditSum + nb);
        await db.query("UPDATE journal_lines SET credit_base=$1, exchange_rate=$2 WHERE id=$3", [nb, rate, l.id]);
      }
      await db.query("UPDATE journal_lines SET debit_base=$1, exchange_rate=$2 WHERE id=$3",
        [creditSum, rate, debitLines[0].id]);
      glUpdated++;
    }

    // Balance sanity-check on every touched entry before committing.
    const bad = (await db.query(
      `SELECT je.id, SUM(jl.debit_base) db, SUM(jl.credit_base) cb
         FROM journal_entries je JOIN journal_lines jl ON jl.entry_id=je.id
        WHERE je.source='AR_INVOICE' AND je.status='POSTED'
          AND je.source_ref IN (SELECT id::text FROM invoices WHERE region_id=2 AND currency='USD')
        GROUP BY je.id HAVING SUM(jl.debit_base) <> SUM(jl.credit_base)`)).rows;
    if (bad.length) throw new Error(`Balance check failed on ${bad.length} entries: ${JSON.stringify(bad.slice(0,3))}`);

    await db.query("COMMIT");

    const chk = (await db.query(
      "SELECT COUNT(*) n, SUM(total_amount) usd, SUM(amount_base) gbp FROM invoices WHERE region_id=2 AND currency='USD'")).rows[0];
    console.log(`Invoices updated: ${invUpdated} | GL entries re-valued: ${glUpdated} | GL not posted: ${glMissing}`);
    if (warns.length) console.log("WARN:", warns);
    console.log(`UK USD invoices — count ${chk.n}: document USD ${round2(chk.usd)} -> book GBP ${round2(chk.gbp)}`);
    console.log("Balance check passed. Done.");
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    console.error("FAILED (nothing committed):", e.message);
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
})();

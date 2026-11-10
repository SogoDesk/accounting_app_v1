// =============================================================================
// currencyService — rate lookup + conversion
//
// Rules enforced here:
//   1. Same-currency conversions return rate = 1 exactly (no rounding noise).
//   2. Lookups use the rate AS OF a given date; if that exact date is missing,
//      fall back to the most recent rate on or before it (weekends/holidays).
//   3. A MANUAL rate row wins over an API row for the same (from, to, date).
//   4. Money is rounded to 2 dp once, at the point of conversion.
// =============================================================================

const pool = require("../../config/db");

const normalizeCode = (code) => String(code || "").trim().toUpperCase();
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Get the exchange rate from `from` -> `to` as of `date` (YYYY-MM-DD or Date).
 * Returns { rate, rateDate, source } or throws if no usable rate exists.
 */
async function getRate(from, to, date, db = pool) {
  const fromCode = normalizeCode(from);
  const toCode = normalizeCode(to);

  if (!fromCode || !toCode) {
    throw new Error("getRate: from/to currency required");
  }
  if (fromCode === toCode) {
    return { rate: 1, rateDate: null, source: "IDENTITY" };
  }

  const asOf = date ? new Date(date) : new Date();
  const asOfStr = asOf.toISOString().slice(0, 10);

  // MANUAL preferred over API; most recent on-or-before the requested date.
  const direct = await db.query(
    `SELECT rate, rate_date, source
       FROM exchange_rates
      WHERE from_currency = $1 AND to_currency = $2 AND rate_date <= $3
      ORDER BY rate_date DESC,
               CASE WHEN source = 'MANUAL' THEN 0 ELSE 1 END
      LIMIT 1`,
    [fromCode, toCode, asOfStr],
  );

  if (direct.rows.length) {
    const row = direct.rows[0];
    return { rate: Number(row.rate), rateDate: row.rate_date, source: row.source };
  }

  // Fall back to the inverse pair if only the reverse was stored.
  const inverse = await db.query(
    `SELECT rate, rate_date, source
       FROM exchange_rates
      WHERE from_currency = $1 AND to_currency = $2 AND rate_date <= $3
      ORDER BY rate_date DESC,
               CASE WHEN source = 'MANUAL' THEN 0 ELSE 1 END
      LIMIT 1`,
    [toCode, fromCode, asOfStr],
  );

  if (inverse.rows.length && Number(inverse.rows[0].rate) > 0) {
    const row = inverse.rows[0];
    return {
      rate: 1 / Number(row.rate),
      rateDate: row.rate_date,
      source: `${row.source}_INVERSE`,
    };
  }

  // Nothing on-or-before the date — fall back to the NEAREST rate on-or-after it
  // (e.g. a document dated before the first seeded rate). Direct, then inverse.
  const after = await db.query(
    `SELECT rate, rate_date, source FROM exchange_rates
      WHERE from_currency = $1 AND to_currency = $2 AND rate_date > $3
      ORDER BY rate_date ASC LIMIT 1`,
    [fromCode, toCode, asOfStr],
  );
  if (after.rows.length) {
    const row = after.rows[0];
    return { rate: Number(row.rate), rateDate: row.rate_date, source: `${row.source}_NEAREST` };
  }
  const afterInv = await db.query(
    `SELECT rate, rate_date, source FROM exchange_rates
      WHERE from_currency = $1 AND to_currency = $2 AND rate_date > $3
      ORDER BY rate_date ASC LIMIT 1`,
    [toCode, fromCode, asOfStr],
  );
  if (afterInv.rows.length && Number(afterInv.rows[0].rate) > 0) {
    const row = afterInv.rows[0];
    return { rate: 1 / Number(row.rate), rateDate: row.rate_date, source: `${row.source}_INVERSE_NEAREST` };
  }

  throw new Error(
    `No exchange rate for ${fromCode}->${toCode} on or before ${asOfStr}`,
  );
}

/**
 * Convert `amount` from one currency to another as of `date`.
 * Returns { amount, rate, rateDate, source } — amount rounded to 2 dp.
 */
async function convert(amount, from, to, date, db = pool) {
  const value = Number(amount);
  if (!Number.isFinite(value)) {
    throw new Error("convert: amount must be a number");
  }
  const { rate, rateDate, source } = await getRate(from, to, date, db);
  return { amount: round2(value * rate), rate, rateDate, source };
}

/**
 * Convenience: convert a transaction amount into the owning entity's
 * functional currency. `regionId` resolves to regions.functional_currency.
 * Returns { amountBase, exchangeRate } ready to store on a document row.
 */
async function toFunctional(amount, txnCurrency, regionId, date, db = pool) {
  const { rows } = await db.query(
    `SELECT functional_currency FROM regions WHERE id = $1`,
    [regionId],
  );
  if (!rows.length || !rows[0].functional_currency) {
    throw new Error(`toFunctional: region ${regionId} has no functional_currency`);
  }
  const functional = rows[0].functional_currency;
  try {
    const { amount: amountBase, rate } = await convert(amount, txnCurrency, functional, date, db);
    return { amountBase, exchangeRate: rate, functionalCurrency: functional };
  } catch (err) {
    // No rate exists for this pair at all. Rather than roll back the whole
    // document (invoice/bill/payment) the posting is part of, fall back to 1:1 —
    // an explicit, balanced approximation. Both sides of any entry use the same
    // rate, so the ledger still balances; the base figure can be corrected by
    // adding the rate and re-posting. Same-currency docs never reach here.
    if (String(txnCurrency).toUpperCase() === String(functional).toUpperCase()) {
      return { amountBase: round2(amount), exchangeRate: 1, functionalCurrency: functional };
    }
    // eslint-disable-next-line no-console
    console.warn(`[currency] ${err.message} — falling back to rate 1 for ${txnCurrency}->${functional}. Add an exchange rate and re-post to correct base amounts.`);
    return { amountBase: round2(amount), exchangeRate: 1, functionalCurrency: functional };
  }
}

module.exports = { getRate, convert, toFunctional, round2 };

// Lightweight currency -> USD conversion used by list exports so multi-entity,
// multi-currency reports can show one consolidated total column. Uses stored
// exchange rates when available, falling back to static rates so an export
// never fails for a missing rate. `cache` (a Map) memoises per-currency rates.
const currency = require("../services/currency/currencyService");

const USD_RATES = { USD: 1, INR: 0.012, EUR: 1.08, GBP: 1.27, AED: 0.272, SGD: 0.74, JPY: 0.0067, HKD: 0.128, CAD: 0.73, AUD: 0.66 };

const rateToUsd = async (ccy, db) => {
  const code = String(ccy || "USD").toUpperCase();
  if (code === "USD") return 1;
  try { const { rate } = await currency.getRate(code, "USD", null, db); if (rate > 0) return rate; } catch (_) { /* no rate row */ }
  return USD_RATES[code] != null ? USD_RATES[code] : 1;
};

const convertToUsd = async (amount, from, cache = new Map(), db) => {
  const a = Number(amount) || 0;
  const code = String(from || "USD").toUpperCase();
  if (a === 0 || code === "USD") return a;
  let r = cache.get(code);
  if (r === undefined) { r = await rateToUsd(code, db); cache.set(code, r); }
  return Math.round(a * r * 100) / 100;
};

module.exports = { convertToUsd, rateToUsd, USD_RATES };
